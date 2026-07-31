import { describe, expect, it } from 'vitest';

import { isNoopResult, NOOP_SENTINEL } from './task-scheduler.js';

/**
 * A scheduled task cannot "just stop". The Agent SDK always returns a final
 * result string, and runTask forwards any non-empty result to the chat — so
 * prompts telling the agent to "EXIT SILENTLY, do not say anything at all"
 * still produce a Telegram message reading "No new files to process —
 * silently exiting per instructions". The prompt is not fixable; emitting a
 * fixed sentinel is an instruction an agent CAN follow, and the host drops it.
 */
describe('isNoopResult', () => {
  it('suppresses the bare sentinel', () => {
    expect(isNoopResult(NOOP_SENTINEL)).toBe(true);
  });

  it('tolerates surrounding whitespace and newlines', () => {
    expect(isNoopResult(`\n  ${NOOP_SENTINEL}  \n`)).toBe(true);
  });

  it('tolerates trailing punctuation', () => {
    expect(isNoopResult(`${NOOP_SENTINEL}.`)).toBe(true);
  });

  it('tolerates markdown emphasis the formatter may add', () => {
    expect(isNoopResult(`**${NOOP_SENTINEL}**`)).toBe(true);
    expect(isNoopResult(`\`${NOOP_SENTINEL}\``)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isNoopResult('no_report')).toBe(true);
  });

  it('does NOT suppress a real report that merely mentions the sentinel', () => {
    expect(
      isNoopResult(`Converted 3 files. Prior run emitted ${NOOP_SENTINEL}.`),
    ).toBe(false);
  });

  it('does NOT suppress an ordinary report', () => {
    expect(isNoopResult('Converted 2 files: a.pdf, b.pdf')).toBe(false);
  });

  it('does NOT suppress prose that happens to say nothing to process', () => {
    // Only the sentinel is special — no fuzzy natural-language matching, which
    // would risk swallowing a real report.
    expect(isNoopResult('No new files to process — exiting silently.')).toBe(
      false,
    );
  });

  it('treats empty and nullish results as no-ops', () => {
    expect(isNoopResult('')).toBe(true);
    expect(isNoopResult('   ')).toBe(true);
    expect(isNoopResult(null)).toBe(true);
    expect(isNoopResult(undefined)).toBe(true);
  });
});
