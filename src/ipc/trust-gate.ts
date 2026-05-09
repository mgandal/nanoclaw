import path from 'path';

import { AGENTS_DIR } from '../config.js';
import { loadAgentTrust } from '../agent-registry.js';
import {
  checkTrustAndStage,
  CheckTrustAndStageResult,
} from '../trust-enforcement.js';
import { firePostHocNotify } from '../trust-notify.js';
import type { RegisteredGroup } from '../types.js';
import type { IpcDeps } from '../ipc.js';

export interface GateAndStageInput {
  agentName: string | null;
  baseGroup: string;
  actionType: string;
  summary: string;
  target: string;
  payloadForStaging: Record<string, unknown>;
}

export interface GateDecision extends CheckTrustAndStageResult {
  /** True when the dispatcher should proceed to handler.execute(). */
  allowed: boolean;
}

const NON_AGENT_DECISION: GateDecision = {
  allowed: true,
  level: 'autonomous',
  notify: false,
  pendingId: null,
};

export function gateAndStage(input: GateAndStageInput): GateDecision {
  if (!input.agentName) return NON_AGENT_DECISION;
  const trust = loadAgentTrust(path.join(AGENTS_DIR, input.agentName));
  return checkTrustAndStage({
    agentName: input.agentName,
    groupFolder: input.baseGroup,
    actionType: input.actionType,
    summary: input.summary,
    target: input.target,
    payloadForStaging: input.payloadForStaging,
    trust,
  });
}

export interface NotifyInput {
  agentName: string | null;
  actionType: string;
  summary: string;
  target: string;
  registeredGroups: Record<string, RegisteredGroup>;
  deps: IpcDeps;
}

export async function fireNotifyIfRequested(
  decision: GateDecision,
  input: NotifyInput,
): Promise<void> {
  if (!decision.notify || !input.agentName) return;
  await firePostHocNotify({
    notify: decision.notify,
    agentName: input.agentName,
    actionType: input.actionType,
    summary: input.summary,
    target: input.target,
    registeredGroups: input.registeredGroups,
    deps: input.deps,
  });
}
