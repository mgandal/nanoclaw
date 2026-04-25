import { describe, it, expect } from 'vitest';
import { classifyChatProbe, renderMarkdown, diffAudits } from './swarm-audit.js';

describe('classifyChatProbe', () => {
  it('classifies a successful getChat as member', () => {
    expect(classifyChatProbe(null, { id: -1003892106437, type: 'supergroup' })).toEqual({
      status: 'member',
      detail: 'getChat ok',
    });
  });

  it('classifies error_code 403 as not_member', () => {
    const err = { error_code: 403, description: 'Forbidden: bot is not a member of the supergroup chat' };
    expect(classifyChatProbe(err, null)).toEqual({
      status: 'not_member',
      detail: 'Forbidden: bot is not a member of the supergroup chat',
    });
  });

  it('classifies error_code 400 chat not found as not_member', () => {
    const err = { error_code: 400, description: 'Bad Request: chat not found' };
    expect(classifyChatProbe(err, null)).toEqual({
      status: 'not_member',
      detail: 'Bad Request: chat not found',
    });
  });

  it('classifies generic errors as error (not not_member)', () => {
    const err = { error_code: 500, description: 'Internal Server Error' };
    expect(classifyChatProbe(err, null)).toEqual({
      status: 'error',
      detail: 'Internal Server Error',
    });
  });

  it('classifies network errors with no error_code as error', () => {
    const err = new Error('ECONNREFUSED');
    expect(classifyChatProbe(err, null)).toEqual({
      status: 'error',
      detail: 'ECONNREFUSED',
    });
  });
});

describe('renderMarkdown', () => {
  it('groups rows by group_folder and uses status icons', () => {
    const md = renderMarkdown({
      generated_at: '2026-04-25T12:00:00.000Z',
      rows: [
        {
          group_folder: 'telegram_lab-claw',
          group_jid: 'tg:-1003892106437',
          persona: 'Marvin',
          status: 'member',
          detail: 'getChat ok',
          probed_at: '2026-04-25T12:00:00.000Z',
        },
        {
          group_folder: 'telegram_lab-claw',
          group_jid: 'tg:-1003892106437',
          persona: 'Steve',
          status: 'not_member',
          detail: 'Forbidden: bot is not a member of the supergroup chat',
          probed_at: '2026-04-25T12:00:00.000Z',
        },
      ],
      summary: { total: 2, member: 1, not_member: 1, error: 0, unpinned: 0, no_chat: 0 },
    });
    expect(md).toContain('# Swarm Membership Audit — 2026-04-25T12:00:00.000Z');
    expect(md).toContain('## telegram_lab-claw');
    expect(md).toContain('✓ **Marvin** — member: getChat ok');
    expect(md).toContain(
      '✗ **Steve** — not_member: Forbidden: bot is not a member of the supergroup chat',
    );
    expect(md).toContain('1/2 reachable');
  });
});

const row = (
  group: string,
  persona: string,
  status: 'member' | 'not_member' | 'error' | 'unpinned' | 'no_chat',
) => ({
  group_folder: group,
  group_jid: `tg:fake-${group}`,
  persona,
  status,
  detail: '',
  probed_at: '2026-04-25T12:00:00.000Z',
});

describe('diffAudits', () => {
  it('returns empty when prev and curr are identical', () => {
    const r = [row('telegram_lab-claw', 'Marvin', 'member')];
    expect(diffAudits(r, r)).toEqual([]);
  });

  it('flags a member→not_member regression', () => {
    const prev = [row('telegram_lab-claw', 'Marvin', 'member')];
    const curr = [row('telegram_lab-claw', 'Marvin', 'not_member')];
    expect(diffAudits(prev, curr)).toEqual([
      {
        group_folder: 'telegram_lab-claw',
        persona: 'Marvin',
        from: 'member',
        to: 'not_member',
        kind: 'regression',
      },
    ]);
  });

  it('flags a brand-new not_member row as new_miss', () => {
    const prev: ReturnType<typeof row>[] = [];
    const curr = [row('telegram_clinic-claw', 'Steve', 'not_member')];
    expect(diffAudits(prev, curr)).toEqual([
      {
        group_folder: 'telegram_clinic-claw',
        persona: 'Steve',
        from: null,
        to: 'not_member',
        kind: 'new_miss',
      },
    ]);
  });

  it('does NOT flag not_member→not_member (still broken, but not new)', () => {
    const prev = [row('telegram_clinic-claw', 'Steve', 'not_member')];
    const curr = [row('telegram_clinic-claw', 'Steve', 'not_member')];
    expect(diffAudits(prev, curr)).toEqual([]);
  });

  it('flags not_member→member as recovery', () => {
    const prev = [row('telegram_clinic-claw', 'Steve', 'not_member')];
    const curr = [row('telegram_clinic-claw', 'Steve', 'member')];
    expect(diffAudits(prev, curr)).toEqual([
      {
        group_folder: 'telegram_clinic-claw',
        persona: 'Steve',
        from: 'not_member',
        to: 'member',
        kind: 'recovery',
      },
    ]);
  });
});
