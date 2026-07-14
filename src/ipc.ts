import { DATA_DIR } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  isValidAgentName,
  isFileCredentialLike,
  isSendFileExtensionAllowed,
} from './ipc/file-validation.js';
import {
  deliverSendMessage,
  markIpcSend,
  hasRecentIpcSend,
  clearIpcSend,
  isSenderAllowedForPool,
} from './ipc/delivery.js';
import { buildContext, dispatchIpcAction } from './ipc/handler.js';
import { registerBuiltinHandlers } from './ipc/handlers/index.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  db: import('bun:sqlite').Database;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile?: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendWebAppButton?: (jid: string, label: string, url: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  messageBus?: import('./message-bus.js').MessageBus;
}

// FD-pressure diagnostic + IPC group-folder scan moved to ipc/fd-diagnostic.ts.
// Re-exported here so existing importers (and tests) keep using ./ipc.js.
export {
  logFdPressureDiagnostic,
  scanIpcGroupFolders,
} from './ipc/fd-diagnostic.js';

// recentIpcSends tracker (markIpcSend/hasRecentIpcSend/clearIpcSend) moved
// to ipc/delivery.ts.

// isValidAgentName, isFileCredentialLike, isSendFileExtensionAllowed, and
// resolveContainerFilePathToHost moved to ipc/file-validation.ts.
export { isValidAgentName, isFileCredentialLike, isSendFileExtensionAllowed };

// recentIpcSends tracker + isSenderAllowedForPool + deliverSendMessage moved
// to ipc/delivery.ts. Re-exported so existing importers (index.ts, tests)
// keep resolving via ./ipc.js.
export {
  deliverSendMessage,
  markIpcSend,
  hasRecentIpcSend,
  clearIpcSend,
  isSenderAllowedForPool,
};

// processIpcMessage (the inline message/send_file/set_proactive_pause
// if-ladder) was deleted 2026-07-14. `message` and `send_file` now live on
// the IpcHandler registry (src/ipc/handlers/message.ts, send-file.ts) and
// both IPC queue dirs feed dispatchIpcAction via processTaskIpc.
// `set_proactive_pause` was dropped entirely: no writer ever shipped
// (f9279078 added only the host branch).

// startIpcWatcher + cleanupStaleProcessing + the claim/process loop moved
// to ipc/watcher.ts (the messages/ and tasks/ blocks are now one
// claimAndProcessDir helper). Re-exported so index.ts keeps importing
// startIpcWatcher from ./ipc.js.
export { startIpcWatcher } from './ipc/watcher.js';

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  registerBuiltinHandlers();

  const handlerCtx = buildContext(sourceGroup, isMain, deps);
  const result = await dispatchIpcAction(
    data as { type: string } & Record<string, unknown>,
    handlerCtx,
  );
  if (result.handled) return;

  // Everything that isn't on the IpcHandler registry falls through here.
  // The only live legacy paths are the x-integration and browser-automation
  // skills, which are loaded by dynamic import (the skill code lives outside
  // src/ and may not be installed). All other action types were migrated to
  // src/ipc/handlers/ and were handled by dispatchIpcAction above.
  let handled = false;
  if (typeof data.type === 'string' && data.type.startsWith('x_')) {
    try {
      const modPath = [
        '..',
        '.claude',
        'skills',
        'x-integration',
        'host.js',
      ].join('/');
      const mod = await import(modPath);
      handled = await mod.handleXIpc(
        data as Record<string, unknown>,
        sourceGroup,
        isMain,
        DATA_DIR,
      );
    } catch (err) {
      logger.warn({ err }, 'X integration handler not available');
    }
  }
  if (
    !handled &&
    typeof data.type === 'string' &&
    data.type.startsWith('browser_')
  ) {
    try {
      const modPath = [
        '..',
        '.claude',
        'skills',
        'browser-automation',
        'host.js',
      ].join('/');
      const mod = await import(modPath);
      handled = await mod.handleBrowserIpc(
        data as Record<string, unknown>,
        sourceGroup,
        isMain,
        DATA_DIR,
      );
    } catch (err) {
      logger.warn({ err }, 'Browser automation handler not available');
    }
  }
  if (!handled) {
    logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
