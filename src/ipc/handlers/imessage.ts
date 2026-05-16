import {
  imessageListContacts,
  imessageRead,
  imessageSearch,
  imessageSend,
} from '../../imessage-host.js';
import { logger } from '../../logger.js';
import type { ExecuteResult, IpcHandler } from '../handler.js';

/**
 * imessage_* cluster handlers. Four registry entries sharing one results
 * dir (`imessage_results/`, hardcoded at
 * container/agent-runner/src/ipc-mcp-stdio.ts:1373).
 *
 * Migrated from the if-ladder arm at git show 7b25dfc6:src/ipc.ts (the
 * `data.type.startsWith('imessage_')` branch + the inline
 * handleImessageIpc function).
 *
 * Main-only access pattern:
 *   The if-ladder rejected all non-main callers BEFORE any action switch
 *   (early `return true` with a "handled, rejected" comment). authorize()
 *   in each handler returns null when !ctx.isMain, preserving that fence
 *   exactly. The trust gate is not the load-bearing protection here;
 *   the fence is. (gateAndStage still fires for agent callers on main,
 *   which is the right behaviour — a main-group agent calling imessage
 *   should be audited.)
 *
 * skipGate flags:
 *   - imessage_search / imessage_read / imessage_list_contacts: on
 *     SKIP_GATE_ALLOWLIST as read-only. skipGate for non-agent callers
 *     (matches dashboard / kg_query pattern).
 *   - imessage_send: write. Not on the allowlist. Gate fires for agent
 *     callers (autonomous default for non-trust.yaml entries); fine,
 *     since the action is already main-only.
 *
 * Result shape preserved verbatim: {success, message, data?} — different
 * from other clusters' {success, error, ...} but tested by callers.
 */

// --- imessage_search ---

interface SearchInput {
  query: string | undefined;
  contact: string | undefined;
  sinceDays: number | undefined;
  limit: number | undefined;
}

export const imessageSearchHandler: IpcHandler<SearchInput, ExecuteResult> = {
  type: 'imessage_search',
  responseKind: 'result',
  resultsDirName: 'imessage_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      query: typeof r.query === 'string' ? r.query : undefined,
      contact: typeof r.contact === 'string' ? r.contact : undefined,
      sinceDays: typeof r.since_days === 'number' ? r.since_days : undefined,
      limit: typeof r.limit === 'number' ? r.limit : undefined,
    };
  },

  authorize(_input, ctx) {
    if (!ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'Non-main iMessage IPC attempt blocked',
      );
      return null;
    }
    return {
      target: 'imessage',
      auditSummary: 'search',
      notifySummary: 'searched imessage',
      payloadForStaging: { type: 'imessage_search' },
      ...(ctx.agentName === null ? { skipGate: true as const } : {}),
    };
  },

  execute(input): ExecuteResult {
    const results = imessageSearch({
      query: input.query,
      contact: input.contact,
      since_days: input.sinceDays,
      limit: input.limit,
    });
    return {
      executed: true,
      result: {
        success: true,
        message: `Found ${results.length} messages`,
        data: results,
      },
    };
  },
};

// --- imessage_read ---

interface ReadInput {
  contact: string | undefined;
  limit: number | undefined;
  sinceDays: number | undefined;
}

export const imessageReadHandler: IpcHandler<ReadInput, ExecuteResult> = {
  type: 'imessage_read',
  responseKind: 'result',
  resultsDirName: 'imessage_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      contact: typeof r.contact === 'string' ? r.contact : undefined,
      limit: typeof r.limit === 'number' ? r.limit : undefined,
      sinceDays: typeof r.since_days === 'number' ? r.since_days : undefined,
    };
  },

  authorize(_input, ctx) {
    if (!ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'Non-main iMessage IPC attempt blocked',
      );
      return null;
    }
    return {
      target: 'imessage',
      auditSummary: 'read',
      notifySummary: 'read imessage',
      payloadForStaging: { type: 'imessage_read' },
      ...(ctx.agentName === null ? { skipGate: true as const } : {}),
    };
  },

  execute(input): ExecuteResult {
    if (!input.contact) {
      return {
        executed: true,
        result: { success: false, message: 'Missing contact parameter' },
      };
    }
    const conversation = imessageRead({
      contact: input.contact,
      limit: input.limit,
      since_days: input.sinceDays,
    });
    return {
      executed: true,
      result: {
        success: true,
        message: `${conversation.messages.length} messages with ${input.contact}`,
        data: conversation,
      },
    };
  },
};

// --- imessage_send ---

interface SendInput {
  to: string | undefined;
  text: string | undefined;
}

export const imessageSendHandler: IpcHandler<SendInput, ExecuteResult> = {
  type: 'imessage_send',
  responseKind: 'result',
  resultsDirName: 'imessage_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      to: typeof r.to === 'string' ? r.to : undefined,
      text: typeof r.text === 'string' ? r.text : undefined,
    };
  },

  authorize(input, ctx) {
    if (!ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'Non-main iMessage IPC attempt blocked',
      );
      return null;
    }
    return {
      target: 'imessage',
      auditSummary: input.to ? `→ ${input.to}` : '(no recipient)',
      notifySummary: `sent imessage to ${input.to ?? '(unknown)'}`,
      payloadForStaging: {
        type: 'imessage_send',
        to: input.to,
        text: input.text,
      },
    };
  },

  async execute(input): Promise<ExecuteResult> {
    if (!input.to || !input.text) {
      return {
        executed: true,
        result: { success: false, message: 'Missing to or text parameter' },
      };
    }
    const result = await imessageSend({ to: input.to, text: input.text });
    return { executed: true, result };
  },
};

// --- imessage_list_contacts ---

interface ListContactsInput {
  sinceDays: number | undefined;
  limit: number | undefined;
}

export const imessageListContactsHandler: IpcHandler<
  ListContactsInput,
  ExecuteResult
> = {
  type: 'imessage_list_contacts',
  responseKind: 'result',
  resultsDirName: 'imessage_results',

  parse(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return {
      sinceDays: typeof r.since_days === 'number' ? r.since_days : undefined,
      limit: typeof r.limit === 'number' ? r.limit : undefined,
    };
  },

  authorize(_input, ctx) {
    if (!ctx.isMain) {
      logger.warn(
        { sourceGroup: ctx.sourceGroup },
        'Non-main iMessage IPC attempt blocked',
      );
      return null;
    }
    return {
      target: 'imessage',
      auditSummary: 'list_contacts',
      notifySummary: 'listed imessage contacts',
      payloadForStaging: { type: 'imessage_list_contacts' },
      ...(ctx.agentName === null ? { skipGate: true as const } : {}),
    };
  },

  execute(input): ExecuteResult {
    const contacts = imessageListContacts({
      since_days: input.sinceDays,
      limit: input.limit,
    });
    return {
      executed: true,
      result: {
        success: true,
        message: `${contacts.length} contacts`,
        data: contacts,
      },
    };
  },
};
