import type { PromotionProposal } from './analyze-promotions.js';

export function formatProposal(p: PromotionProposal): string {
  const pct = (p.approvalRate * 100).toFixed(0);
  const approved = Math.round(p.approvalRate * p.sampleSize);
  return `${p.agent} :: ${p.action}
  ${approved}/${p.sampleSize} approved (${pct}%) over ${p.windowDays}d at '${p.currentLevel}' level
  → propose promotion: ${p.currentLevel} → ${p.proposedLevel}
  Reply "promote ${p.agent} ${p.action}" to confirm, or ignore to leave unchanged.`;
}
