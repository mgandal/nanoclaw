export type TrustLevel = 'ask' | 'draft' | 'notify' | 'autonomous';

const LADDER: TrustLevel[] = ['ask', 'draft', 'notify', 'autonomous'];

export interface ActionRow {
  agent_name: string;
  action_type: string;
  trust_level: string;
  outcome: string;
  created_at: string;
}

export interface PolicyCeilings {
  [action_type: string]: TrustLevel;
}

export interface PromotionProposal {
  agent: string;
  action: string;
  currentLevel: TrustLevel;
  proposedLevel: TrustLevel;
  approvalRate: number;
  sampleSize: number;
  windowDays: number;
}

export interface AnalyzeOptions {
  windowDays?: number;
  minActions?: number;
  minApprovalRate?: number;
  now?: number;
}

const DEFAULTS: Required<Omit<AnalyzeOptions, 'now'>> = {
  windowDays: 30,
  minActions: 30,
  minApprovalRate: 0.95,
};

export function nextTrustLevel(level: string): TrustLevel | null {
  const idx = LADDER.indexOf(level as TrustLevel);
  if (idx === -1 || idx === LADDER.length - 1) return null;
  return LADDER[idx + 1];
}

function levelAtMostCeiling(
  level: TrustLevel,
  ceiling: TrustLevel | undefined,
): boolean {
  if (!ceiling) return true;
  return LADDER.indexOf(level) <= LADDER.indexOf(ceiling);
}

function isApproval(outcome: string): boolean {
  return outcome === 'completed' || outcome === 'approved';
}

export function analyzePromotions(
  rows: ActionRow[],
  ceilings: PolicyCeilings,
  opts: AnalyzeOptions = {},
): PromotionProposal[] {
  const windowDays = opts.windowDays ?? DEFAULTS.windowDays;
  const minActions = opts.minActions ?? DEFAULTS.minActions;
  const minApprovalRate = opts.minApprovalRate ?? DEFAULTS.minApprovalRate;
  const now = opts.now ?? Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

  const inWindow = rows.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });

  const groups = new Map<string, ActionRow[]>();
  for (const row of inWindow) {
    const key = `${row.agent_name}::${row.action_type}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const proposals: PromotionProposal[] = [];
  for (const [key, groupRows] of groups) {
    const [agent, action] = key.split('::');

    const sorted = groupRows
      .slice()
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    const currentLevelRaw = sorted[0]?.trust_level;
    if (!currentLevelRaw) continue;

    const currentLevel = currentLevelRaw as TrustLevel;
    const proposedLevel = nextTrustLevel(currentLevel);
    if (!proposedLevel) continue;

    if (!levelAtMostCeiling(proposedLevel, ceilings[action])) continue;

    const atLevel = groupRows.filter((r) => r.trust_level === currentLevel);
    const sampleSize = atLevel.length;
    if (sampleSize < minActions) continue;

    const approvals = atLevel.filter((r) => isApproval(r.outcome)).length;
    const approvalRate = approvals / sampleSize;
    if (approvalRate < minApprovalRate) continue;

    proposals.push({
      agent,
      action,
      currentLevel,
      proposedLevel,
      approvalRate,
      sampleSize,
      windowDays,
    });
  }

  return proposals;
}
