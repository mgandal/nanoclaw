import { describe, it, expect } from 'vitest';

import { shouldTriggerApply } from './followup-hub-poller.js';

describe('shouldTriggerApply', () => {
  it('triggers on a real user submission message', () => {
    const line = JSON.stringify({
      id: 'abc123',
      event: 'message',
      topic: 'nanoclaw-relay-7406c450',
      message: JSON.stringify({
        processed: false,
        items: [{ id: 'f-x', itemType: 'followup' }],
      }),
    });
    expect(shouldTriggerApply(line)).toBe(true);
  });

  it('ignores ntfy keepalive/open events', () => {
    expect(shouldTriggerApply(JSON.stringify({ event: 'keepalive' }))).toBe(
      false,
    );
    expect(shouldTriggerApply(JSON.stringify({ event: 'open' }))).toBe(false);
  });

  it('ignores the self-test ping the page sends with test=true', () => {
    const line = JSON.stringify({
      event: 'message',
      message: JSON.stringify({ processed: false, test: true, items: [] }),
    });
    expect(shouldTriggerApply(line)).toBe(false);
  });

  it('ignores an already-processed echo', () => {
    const line = JSON.stringify({
      event: 'message',
      message: JSON.stringify({
        processed: true,
        items: [{ id: 'f-x', itemType: 'followup' }],
      }),
    });
    expect(shouldTriggerApply(line)).toBe(false);
  });

  it('does not trigger when a message carries no followup items', () => {
    const line = JSON.stringify({
      event: 'message',
      message: JSON.stringify({
        processed: false,
        items: [{ id: 't-1', itemType: 'todo' }],
      }),
    });
    expect(shouldTriggerApply(line)).toBe(false);
  });

  it('returns false on blank lines and malformed JSON (stream noise)', () => {
    expect(shouldTriggerApply('')).toBe(false);
    expect(shouldTriggerApply('   ')).toBe(false);
    expect(shouldTriggerApply('{not json')).toBe(false);
    // message field present but its inner body is not JSON
    expect(
      shouldTriggerApply(
        JSON.stringify({ event: 'message', message: 'plain text' }),
      ),
    ).toBe(false);
  });
});
