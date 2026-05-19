import {
  countActiveWakeups,
  createWakeupTask,
  insertAgentAction,
} from '../../db.js';
import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

const WAKEUP_ID_PATTERN = /^wu-[A-Za-z0-9_-]{1,64}$/;
const MIN_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 10080; // 7 days
const MAX_PROMPT_LENGTH = 4000;
const MAX_CONTEXT_BLOB_LENGTH = 8000;

interface Input {
  wakeupId: string;
  prompt: string;
  contextBlob: string | null;
  contextMode: 'group' | 'isolated';
  delayMinutes: number | null;
  fireAt: string | null;
  // Populated by authorize before the gate runs. Same pattern as
  // scheduleTaskHandler's precomputedNextRun — see schedule-task.ts:22-26.
  precomputedNextRun: string | null;
  chatJid: string | null;
}

export const scheduleWakeupHandler: IpcHandler<Input, ExecuteResult> = {
  type: 'schedule_wakeup',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;

    if (typeof r.wakeupId !== 'string' || !WAKEUP_ID_PATTERN.test(r.wakeupId)) {
      return null;
    }
    if (
      typeof r.prompt !== 'string' ||
      r.prompt.length === 0 ||
      r.prompt.length > MAX_PROMPT_LENGTH
    ) {
      return null;
    }

    const hasDelay = r.delay_minutes !== undefined && r.delay_minutes !== null;
    const hasFireAt = r.fire_at !== undefined && r.fire_at !== null;
    if (hasDelay === hasFireAt) {
      // Both absent OR both present — invalid.
      return null;
    }

    let delayMinutes: number | null = null;
    if (hasDelay) {
      if (
        typeof r.delay_minutes !== 'number' ||
        !Number.isInteger(r.delay_minutes)
      ) {
        return null;
      }
      delayMinutes = r.delay_minutes;
    }

    let fireAt: string | null = null;
    if (hasFireAt) {
      if (typeof r.fire_at !== 'string') return null;
      fireAt = r.fire_at;
    }

    let contextBlob: string | null = null;
    if (r.context_blob !== undefined && r.context_blob !== null) {
      if (
        typeof r.context_blob !== 'string' ||
        r.context_blob.length > MAX_CONTEXT_BLOB_LENGTH
      ) {
        return null;
      }
      contextBlob = r.context_blob;
    }

    const contextMode =
      r.context_mode === 'group' || r.context_mode === 'isolated'
        ? r.context_mode
        : 'isolated';

    return {
      wakeupId: r.wakeupId,
      prompt: r.prompt,
      contextBlob,
      contextMode,
      delayMinutes,
      fireAt,
      precomputedNextRun: null, // populated in authorize
      chatJid: null, // populated in authorize
    };
  },

  authorize(input, ctx) {
    // Non-agent callers cannot self-wake. No audit row — non-agent IPC is
    // operator-driven and should use createTask / schedule_task directly.
    if (ctx.agentName === null) {
      return null;
    }

    // Resolve chat_jid from registeredGroups. baseGroup is the calling group.
    // The JID is the map key (see src/index.ts:153 — Record<jid, RegisteredGroup>),
    // not a field on the value. Iterate entries to recover both halves.
    const groupMatch = Object.entries(ctx.registeredGroups).find(
      ([, g]) => g.folder === ctx.baseGroup,
    );
    if (!groupMatch) {
      insertAgentAction({
        agent_name: ctx.agentName,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary: `no chat_jid for group_folder ${ctx.baseGroup}`,
        target: input.wakeupId,
        outcome: 'denied_no_chat_jid',
      });
      return null;
    }
    const [groupJid] = groupMatch;

    // Resolve next_run from delay_minutes XOR fire_at. parse already
    // guaranteed exactly one is non-null.
    let nextRunDate: Date;
    if (input.delayMinutes !== null) {
      nextRunDate = new Date(Date.now() + input.delayMinutes * 60_000);
    } else {
      // fire_at is a local-time ISO string without Z/offset. Date.parse
      // treats it as local time. If unparseable, reject.
      nextRunDate = new Date(input.fireAt!);
      if (isNaN(nextRunDate.getTime())) {
        insertAgentAction({
          agent_name: ctx.agentName,
          group_folder: ctx.baseGroup,
          action_type: 'schedule_wakeup',
          trust_level: 'skipGate',
          summary: `fire_at unparseable: ${input.fireAt}`,
          target: input.wakeupId,
          outcome: 'denied_invalid_delay',
        });
        return null;
      }
    }

    const deltaMs = nextRunDate.getTime() - Date.now();
    const deltaMinutes = deltaMs / 60_000;

    if (deltaMinutes < MIN_DELAY_MINUTES) {
      const summary =
        input.delayMinutes !== null
          ? `delay_minutes ${input.delayMinutes} < 5 (minimum)`
          : `fire_at resolves to ${Math.round(deltaMinutes)}min from now (minimum 5)`;
      insertAgentAction({
        agent_name: ctx.agentName,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary,
        target: input.wakeupId,
        outcome: 'denied_invalid_delay',
      });
      return null;
    }
    if (deltaMinutes > MAX_DELAY_MINUTES) {
      const summary =
        input.delayMinutes !== null
          ? `delay_minutes ${input.delayMinutes} > 10080 (7-day max)`
          : `fire_at resolves to ${Math.round(deltaMinutes / 1440)}d from now (maximum 7)`;
      insertAgentAction({
        agent_name: ctx.agentName,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary,
        target: input.wakeupId,
        outcome: 'denied_invalid_delay',
      });
      return null;
    }

    // Rate-limit check AFTER delay validation — bad delay should not consume
    // a rate slot but should still produce an audit row.
    const active = countActiveWakeups(ctx.baseGroup, ctx.agentName);
    if (active >= 10) {
      insertAgentAction({
        agent_name: ctx.agentName,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary: `rate limit: ${active}/10 active wakeups for ${ctx.agentName} in ${ctx.baseGroup}`,
        target: input.wakeupId,
        outcome: 'denied_rate_limit',
      });
      return null;
    }

    // Pin resolved values onto input for execute(). Same mutation pattern as
    // scheduleTaskHandler — see schedule-task.ts:22-26 and 173.
    input.precomputedNextRun = nextRunDate.toISOString();
    input.chatJid = groupJid;

    return {
      target: input.wakeupId,
      auditSummary: `wakeup ${input.wakeupId} in ${Math.round(deltaMinutes)}min: ${input.prompt.slice(0, 100)}`,
      notifySummary: `wakeup scheduled in ${Math.round(deltaMinutes)} min`,
      payloadForStaging: {
        type: 'schedule_wakeup',
        wakeupId: input.wakeupId,
        prompt: input.prompt,
        delay_minutes: input.delayMinutes,
        fire_at: input.fireAt,
      },
      skipGate: true,
    };
  },

  execute(input, ctx) {
    // Compose the wakeup prompt with optional context envelope.
    const composedPrompt = input.contextBlob
      ? `${input.prompt}\n\n<wakeup-context>\n${input.contextBlob}\n</wakeup-context>`
      : input.prompt;

    const now = new Date().toISOString();

    // Audit-row ordering (round-1 amendment): INSERT first, then audit row.
    // Writing the audit row first would leave a phantom outcome='allowed'
    // entry on PK collision — the bug pattern from [Task id=1 doesn't exist]
    // memory note.
    try {
      createWakeupTask({
        id: input.wakeupId,
        group_folder: ctx.baseGroup,
        chat_jid: input.chatJid!,
        prompt: composedPrompt,
        agent_name: ctx.agentName!,
        context_mode: input.contextMode,
        next_run: input.precomputedNextRun!,
        created_at: now,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      insertAgentAction({
        agent_name: ctx.agentName!,
        group_folder: ctx.baseGroup,
        action_type: 'schedule_wakeup',
        trust_level: 'skipGate',
        summary: `wakeup ${input.wakeupId} INSERT failed: ${message}`,
        target: input.wakeupId,
        outcome: 'denied_collision',
      });
      logger.warn(
        { wakeupId: input.wakeupId, err: message },
        'createWakeupTask INSERT failed (likely PK collision)',
      );
      return { executed: false };
    }

    // INSERT succeeded — write the allowed audit row.
    const deltaMinutes = Math.round(
      (new Date(input.precomputedNextRun!).getTime() - Date.now()) / 60_000,
    );
    insertAgentAction({
      agent_name: ctx.agentName!,
      group_folder: ctx.baseGroup,
      action_type: 'schedule_wakeup',
      trust_level: 'skipGate',
      summary: `wakeup ${input.wakeupId} in ${deltaMinutes}min: ${input.prompt.slice(0, 100)}`,
      target: input.wakeupId,
      outcome: 'allowed',
    });

    logger.info(
      {
        wakeupId: input.wakeupId,
        sourceGroup: ctx.sourceGroup,
        baseGroup: ctx.baseGroup,
        agent: ctx.agentName,
        delayMinutes: deltaMinutes,
        contextMode: input.contextMode,
      },
      'Wakeup scheduled via IPC',
    );
    ctx.deps.onTasksChanged();
  },
};
