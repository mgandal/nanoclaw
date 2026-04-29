import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyChatProbe,
  renderMarkdown,
  diffAudits,
  loadPriorReport,
  computeAuditAlerts,
} from './swarm-audit.js';

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

describe('corrupt prior auto-quarantine', () => {
  let tmpDir: string;
  let priorPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-audit-test-'));
    priorPath = path.join(tmpDir, 'swarm-membership-audit.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  const currentReport = {
    generated_at: '2026-04-29T00:00:00.000Z',
    rows: [
      row('telegram_lab-claw', 'Marvin', 'not_member'),
      row('telegram_lab-claw', 'Warren', 'not_member'),
      row('telegram_lab-claw', 'Vincent', 'error'),
      row('telegram_clinic-claw', 'Steve', 'not_member'),
    ],
    summary: {
      total: 4,
      member: 0,
      not_member: 3,
      error: 1,
      unpinned: 0,
      no_chat: 0,
    },
  };

  it('rotates a malformed prior file aside with a timestamped suffix', () => {
    fs.writeFileSync(priorPath, '{ "broken": tru', 'utf8');

    const result = loadPriorReport(priorPath);

    expect(result.report).toBeNull();
    expect(result.recovered).toBe(true);
    expect(result.rotatedTo).toBeDefined();
    // Original path should no longer exist (it was renamed).
    expect(fs.existsSync(priorPath)).toBe(false);
    // Rotated file should exist and carry the timestamp suffix.
    const rotated = result.rotatedTo!;
    expect(fs.existsSync(rotated)).toBe(true);
    expect(path.basename(rotated)).toMatch(
      /^swarm-membership-audit\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,
    );
    // Bad payload should be preserved on the rotated file (forensics).
    expect(fs.readFileSync(rotated, 'utf8')).toBe('{ "broken": tru');
  });

  it('emits zero per-persona new_miss diffs when prior is corrupt', () => {
    fs.writeFileSync(priorPath, '{ this is not json', 'utf8');

    const { diffs } = computeAuditAlerts(priorPath, currentReport);

    // Pre-fix: every non-member row would be classified as new_miss
    // (4 rows here). Post-fix: zero per-persona diffs.
    expect(diffs).toEqual([]);
  });

  it('emits exactly one meta-alert tagged distinguishably from regressions', () => {
    fs.writeFileSync(priorPath, 'not even close to json', 'utf8');

    const { meta } = computeAuditAlerts(priorPath, currentReport);

    expect(meta).not.toBeNull();
    expect(meta!.kind).toBe('meta');
    expect(meta!.reason).toBe('prior_unreadable');
    // The meta alert must be distinguishable from a real regression: it has
    // no group_folder/persona/from/to fields that downstream consumers use to
    // route per-persona alerts. The `kind: 'meta'` tag is the canonical marker.
    expect(meta).not.toHaveProperty('group_folder');
    expect(meta).not.toHaveProperty('persona');
  });

  it('renders the meta-alert as a distinct section in the markdown digest', () => {
    fs.writeFileSync(priorPath, 'corrupt!', 'utf8');
    const { meta } = computeAuditAlerts(priorPath, currentReport);

    const md = renderMarkdown(currentReport, meta ?? undefined);

    // Meta alert must surface under a clearly-labelled section so OPS sees it.
    expect(md).toContain('## Audit health');
    expect(md).toMatch(/prior.*unreadable|prior file unreadable/i);
  });

  it('treats a missing prior file as first-run (not recovered, no meta)', () => {
    // priorPath does not exist
    const result = loadPriorReport(priorPath);
    expect(result.report).toBeNull();
    expect(result.recovered).toBe(false);
    expect(result.rotatedTo).toBeUndefined();

    const { diffs, meta } = computeAuditAlerts(priorPath, currentReport);
    expect(meta).toBeNull();
    // First-run: every non-member row is a legitimate new_miss.
    expect(diffs.length).toBe(4);
  });

  it('uses the well-formed prior for normal diffing', () => {
    const goodPrior = {
      generated_at: '2026-04-28T00:00:00.000Z',
      rows: [
        row('telegram_lab-claw', 'Marvin', 'member'),
        row('telegram_lab-claw', 'Warren', 'member'),
        row('telegram_lab-claw', 'Vincent', 'member'),
        row('telegram_clinic-claw', 'Steve', 'member'),
      ],
      summary: { total: 4, member: 4, not_member: 0, error: 0, unpinned: 0, no_chat: 0 },
    };
    fs.writeFileSync(priorPath, JSON.stringify(goodPrior), 'utf8');

    const { diffs, meta } = computeAuditAlerts(priorPath, currentReport);
    expect(meta).toBeNull();
    // All 4 should be regressions (member→not_member or member→error).
    expect(diffs.every((d) => d.kind === 'regression')).toBe(true);
    expect(diffs.length).toBe(4);
  });
});
