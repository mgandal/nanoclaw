import { describe, it, expect } from 'vitest';
import {
  analyzePromotions,
  nextTrustLevel,
  type ActionRow,
  type PolicyCeilings,
} from './analyze-promotions.js';

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function makeRow(
  agent: string,
  action: string,
  level: string,
  outcome: 'completed' | 'blocked' | 'rejected' | 'edited',
  daysAgo: number,
): ActionRow {
  return {
    agent_name: agent,
    action_type: action,
    trust_level: level,
    outcome,
    created_at: new Date(now - daysAgo * DAY).toISOString(),
  };
}

describe('nextTrustLevel', () => {
  it('follows the escalation ladder ask → draft → notify → autonomous', () => {
    expect(nextTrustLevel('ask')).toBe('draft');
    expect(nextTrustLevel('draft')).toBe('notify');
    expect(nextTrustLevel('notify')).toBe('autonomous');
  });

  it('returns null at the top of the ladder', () => {
    expect(nextTrustLevel('autonomous')).toBeNull();
  });

  it('returns null for unknown levels', () => {
    expect(nextTrustLevel('wat')).toBeNull();
  });
});

describe('analyzePromotions', () => {
  const emptyCeilings: PolicyCeilings = {};

  it('proposes promotion when approval rate >=95% over >=30 rows in window', () => {
    const rows: ActionRow[] = Array.from({ length: 30 }, (_, i) =>
      makeRow('einstein', 'send_slack_dm', 'ask', 'completed', i),
    );
    const proposals = analyzePromotions(rows, emptyCeilings, {
      windowDays: 30,
      minActions: 30,
      minApprovalRate: 0.95,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      agent: 'einstein',
      action: 'send_slack_dm',
      currentLevel: 'ask',
      proposedLevel: 'draft',
      approvalRate: 1,
      sampleSize: 30,
    });
  });

  it('does not propose when sample size is below threshold', () => {
    const rows: ActionRow[] = Array.from({ length: 29 }, (_, i) =>
      makeRow('einstein', 'send_slack_dm', 'ask', 'completed', i),
    );
    expect(analyzePromotions(rows, emptyCeilings)).toHaveLength(0);
  });

  it('does not propose when approval rate is below threshold', () => {
    const rows: ActionRow[] = [
      ...Array.from({ length: 28 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'completed', i),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'rejected', i),
      ),
    ];
    // 28/30 = 93.3%, below 95%
    expect(analyzePromotions(rows, emptyCeilings)).toHaveLength(0);
  });

  it('ignores rows outside the window', () => {
    const rows: ActionRow[] = [
      ...Array.from({ length: 30 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'completed', 40 + i),
      ),
    ];
    expect(analyzePromotions(rows, emptyCeilings)).toHaveLength(0);
  });

  it('respects policy ceilings — does not promote past max level', () => {
    const rows: ActionRow[] = Array.from({ length: 30 }, (_, i) =>
      makeRow('einstein', 'send_slack_dm', 'notify', 'completed', i),
    );
    const ceilings: PolicyCeilings = {
      send_slack_dm: 'notify',
    };
    // would otherwise promote notify → autonomous, but ceiling blocks it
    expect(analyzePromotions(rows, ceilings)).toHaveLength(0);
  });

  it('allows promotion up to but not past ceiling', () => {
    const rows: ActionRow[] = Array.from({ length: 30 }, (_, i) =>
      makeRow('einstein', 'send_slack_dm', 'draft', 'completed', i),
    );
    const ceilings: PolicyCeilings = {
      send_slack_dm: 'notify',
    };
    // draft → notify is OK (notify == ceiling)
    const proposals = analyzePromotions(rows, ceilings);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposedLevel).toBe('notify');
  });

  it('never proposes promotion from autonomous', () => {
    const rows: ActionRow[] = Array.from({ length: 30 }, (_, i) =>
      makeRow('einstein', 'search_literature', 'autonomous', 'completed', i),
    );
    expect(analyzePromotions(rows, emptyCeilings)).toHaveLength(0);
  });

  it('treats rejected and edited outcomes as non-approvals', () => {
    const rows: ActionRow[] = [
      ...Array.from({ length: 25 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'completed', i),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'rejected', i),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'edited', i),
      ),
    ];
    // 25/30 = 83%, below 95%
    expect(analyzePromotions(rows, emptyCeilings)).toHaveLength(0);
  });

  it('groups by (agent, action_type) — different agents analyzed separately', () => {
    const rows: ActionRow[] = [
      ...Array.from({ length: 30 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'completed', i),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        makeRow('marvin', 'send_slack_dm', 'ask', 'completed', i),
      ),
    ];
    const proposals = analyzePromotions(rows, emptyCeilings);
    expect(proposals).toHaveLength(2);
    const agents = proposals.map((p) => p.agent).sort();
    expect(agents).toEqual(['einstein', 'marvin']);
  });

  it('only considers rows at the current trust level (ignores legacy levels)', () => {
    // 30 recent approvals at 'draft', plus 20 old rows at 'ask' — should propose draft → notify
    const rows: ActionRow[] = [
      ...Array.from({ length: 30 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'draft', 'completed', i),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'completed', i + 5),
      ),
    ];
    const proposals = analyzePromotions(rows, {});
    expect(proposals).toHaveLength(1);
    expect(proposals[0].currentLevel).toBe('draft');
    expect(proposals[0].proposedLevel).toBe('notify');
  });

  it('uses the most recent trust level when an action has multiple levels in window', () => {
    // mixed levels — must pick the latest (draft) as the current level
    const rows: ActionRow[] = [
      ...Array.from({ length: 15 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'ask', 'completed', 25 + i),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        makeRow('einstein', 'send_slack_dm', 'draft', 'completed', i),
      ),
    ];
    const proposals = analyzePromotions(rows, {});
    expect(proposals).toHaveLength(1);
    expect(proposals[0].currentLevel).toBe('draft');
    // sample size = 30 rows at current level (draft), 100% approved
    expect(proposals[0].sampleSize).toBe(30);
  });
});
