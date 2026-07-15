import { describe, it, expect } from 'vitest';

import { WIRE_SCHEMAS, wireParse } from './wire-schemas.js';

/**
 * These pin the migrated schemas to the EXACT behavior of the hand-rolled
 * parse bodies they replaced. `oldParse` copies below are verbatim from the
 * pre-migration handlers (git 67e6ad62-era) — if a schema ever drifts from
 * its guard, the fuzz comparison fails.
 */

const taskIdOld = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return null;
  const { taskId } = raw as { taskId?: unknown };
  return typeof taskId === 'string' && taskId.length > 0 ? { taskId } : null;
};

const messageOld = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.chatJid !== 'string' || r.chatJid.length === 0) return null;
  if (typeof r.text !== 'string' || r.text.length === 0) return null;
  return {
    chatJid: r.chatJid,
    text: r.text,
    sender: typeof r.sender === 'string' ? r.sender : undefined,
    webAppUrl: typeof r.webAppUrl === 'string' ? r.webAppUrl : undefined,
  };
};

const sendFileOld = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.chatJid !== 'string' || r.chatJid.length === 0) return null;
  if (typeof r.filePath !== 'string' || r.filePath.length === 0) return null;
  return {
    chatJid: r.chatJid,
    filePath: r.filePath,
    caption: typeof r.caption === 'string' ? r.caption : undefined,
  };
};

/** Strip undefined-valued keys so {a:1, b:undefined} equals {a:1} — Zod
 * omits absent optionals, the guards set them to undefined; both mean the
 * same downstream. */
function normalize(o: unknown): unknown {
  if (o === null || typeof o !== 'object') return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const CASES: Array<Record<string, unknown> | unknown> = [
  null,
  undefined,
  42,
  'str',
  [],
  {},
  { taskId: 'abc' },
  { taskId: '' },
  { taskId: 123 },
  { chatJid: 'tg:1', text: 'hi' },
  { chatJid: 'tg:1', text: 'hi', sender: 'Einstein', webAppUrl: 'http://x' },
  { chatJid: 'tg:1', text: '' },
  { chatJid: '', text: 'hi' },
  { chatJid: 'tg:1', text: 'hi', sender: 42 },
  { chatJid: 'tg:1', filePath: '/w/a.pdf' },
  { chatJid: 'tg:1', filePath: '/w/a.pdf', caption: 'c' },
  { chatJid: 'tg:1', filePath: '' },
  { chatJid: 'tg:1', filePath: '/w/a.pdf', extra: 'ignored' },
];

describe('wire-schemas parity with hand-rolled guards', () => {
  const pairs: Array<[string, (r: unknown) => unknown, (r: unknown) => unknown]> =
    [
      ['cancel_task', taskIdOld, wireParse(WIRE_SCHEMAS.cancel_task)],
      ['pause_task', taskIdOld, wireParse(WIRE_SCHEMAS.pause_task)],
      ['resume_task', taskIdOld, wireParse(WIRE_SCHEMAS.resume_task)],
      ['message', messageOld, wireParse(WIRE_SCHEMAS.message)],
      ['send_file', sendFileOld, wireParse(WIRE_SCHEMAS.send_file)],
    ];

  for (const [name, oldParse, newParse] of pairs) {
    it(`${name}: schema accepts/rejects exactly what the guard did`, () => {
      for (const c of CASES) {
        const oldR = oldParse(c);
        const newR = newParse(c);
        expect(
          oldR === null ? null : normalize(oldR),
          `case ${JSON.stringify(c)}`,
        ).toEqual(newR === null ? null : normalize(newR));
      }
    });
  }
});
