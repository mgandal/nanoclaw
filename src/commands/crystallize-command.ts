import type { Database } from 'bun:sqlite';
import type { ScheduledTask } from '../types.js';
import {
  getCrystallizeCandidate,
  updateCrystallizeCandidateStatus,
} from '../db.js';

export interface CrystallizeCommand {
  kind: 'yes' | 'skip';
  ccId: string;
}

// cc-IDs are kebab `cc-` + 6 lowercase alphanumeric chars (matches the format
// emitted by the stop hook / candidate generator). Tight by design — junk like
// "/crystallize-yes garbage" must be rejected so the agent sees natural-language.
const PATTERN = /^\/crystallize-(yes|skip)\s+(cc-[a-z0-9]{6})\b/;

export function extractCrystallizeCommand(
  text: string,
): CrystallizeCommand | null {
  const m = text.trim().match(PATTERN);
  if (!m) return null;
  return { kind: m[1] as 'yes' | 'skip', ccId: m[2] };
}

/**
 * Dependency surface for handleCrystallizeCommand. The `createTask` shape
 * matches the production `createTask` in src/db.ts so Task 11 wires it through
 * without an adapter shim.
 */
export interface CrystallizeDeps {
  db: Database;
  createTask: (task: Omit<ScheduledTask, 'last_run' | 'last_result'>) => void;
  now: () => string;
}

/**
 * Handle a /crystallize-yes or /crystallize-skip command. Returns a short
 * user-facing reply.
 *
 * /yes: marks the candidate accepted and schedules a one-shot agent task in
 * the originating group with a body-gen prompt. The agent hydrates the
 * candidate via mcp__nanoclaw__crystallize_candidate_fetch, then runs the
 * crystallize skill to write the SKILL.md.
 *
 * /skip: marks the candidate skipped. No agent invocation.
 *
 * Both kinds enforce that the candidate row exists and is still pending.
 * /yes additionally enforces expires_at > now; if expired, flips status to
 * 'expired' as a side effect so future commands see the right state.
 */
export async function handleCrystallizeCommand(
  cmd: CrystallizeCommand,
  deps: CrystallizeDeps,
): Promise<string> {
  const row = getCrystallizeCandidate(deps.db, cmd.ccId);
  if (!row) return `Crystallize candidate ${cmd.ccId} not found.`;

  const now = deps.now();

  if (cmd.kind === 'skip') {
    if (row.status !== 'pending') {
      return `Crystallize candidate ${cmd.ccId} status=${row.status}, not pending.`;
    }
    updateCrystallizeCandidateStatus(deps.db, cmd.ccId, 'skipped', now);
    return `Skipped ${cmd.ccId}.`;
  }

  // kind === 'yes'
  if (row.status !== 'pending') {
    return `Crystallize candidate ${cmd.ccId} status=${row.status}, not pending.`;
  }
  // ISO-8601 timestamps sort lexicographically in chronological order, so
  // string comparison is safe and avoids a Date allocation.
  if (row.expires_at < now) {
    updateCrystallizeCandidateStatus(deps.db, cmd.ccId, 'expired', now);
    return `Crystallize candidate ${cmd.ccId} expired (created ${row.created_at.slice(
      0,
      10,
    )}).`;
  }

  updateCrystallizeCandidateStatus(deps.db, cmd.ccId, 'accepted', now);

  // Schedule a one-shot task in the originating group. The task fires at
  // `now`, picked up by the next task-scheduler tick. We tag the task id with
  // the candidate id so triage queries can join task rows to candidate rows.
  const taskId = `crystallize-${cmd.ccId}-${Date.now()}`;
  deps.createTask({
    id: taskId,
    group_folder: row.source_group,
    chat_jid: row.source_jid,
    prompt: bodyGenPrompt(cmd.ccId, row.agent, row.source_group),
    schedule_type: 'once',
    schedule_value: now,
    next_run: now,
    context_mode: 'isolated',
    status: 'active',
    agent_name: row.agent,
    created_at: now,
  });

  return `Scheduled body-gen for ${cmd.ccId} in ${row.source_group}. pa-xxx will appear when done.`;
}

function bodyGenPrompt(
  ccId: string,
  agent: string,
  sourceGroup: string,
): string {
  return [
    `Body-generation for ${ccId}.`,
    ``,
    `Call mcp__nanoclaw__crystallize_candidate_fetch with ccId="${ccId}" to hydrate`,
    `trace_summary + tool_sequence. If the response is success=false with`,
    `not_found, do NOT retry — the candidate is gone (expired, deleted, or`,
    `corrupted) and the user has been notified separately.`,
    ``,
    `Then follow the /crystallize skill steps 1-4:`,
    `  1. Pick a kebab-case name + a "Use when..." description.`,
    `  2. Write the SKILL.md body (When to use / Steps / Context hints).`,
    `  3. Self-report confidence 1-10 (skip if <5).`,
    `  4. Fire crystallize_skill IPC.`,
    ``,
    `You are ${agent} in ${sourceGroup}. The candidate came from your prior session.`,
    `Generalize the recipe, do not replay specifics.`,
  ].join('\n');
}
