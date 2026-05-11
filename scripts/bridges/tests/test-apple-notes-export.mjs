// Minimal node test — no framework. Run with:
//   node scripts/bridges/tests/test-apple-notes-export.mjs
//
// Covers the sanitizer that prevents QMD handelize from crashing on
// punctuation-only Apple Notes titles (e.g. "=", ".", "\\").

import assert from 'node:assert';
import { sanitizeNoteTitle } from '../apple-notes-export.js';

const cases = [
  // Normal titles pass through unchanged
  ['hello world', 'hello world'],
  ['Notes for 2026', 'Notes for 2026'],

  // Path-unsafe characters are scrubbed
  ['a/b:c*d?e"f<g>h|i', 'a_b_c_d_e_f_g_h_i'],

  // Whitespace collapse + trim
  ['  many   spaces  ', 'many spaces'],

  // Empty / whitespace-only → untitled
  ['', 'untitled'],
  ['   ', 'untitled'],
  [null, 'untitled'],
  [undefined, 'untitled'],

  // Punctuation-only titles → untitled (the QMD-handelize crash class)
  ['=', 'untitled'],
  ['.', 'untitled'],
  ['\\', 'untitled'],
  ['--', 'untitled'],
  ['...', 'untitled'],
  ['!!!', 'untitled'],

  // A digit alone is valid (matches \p{N})
  ['7', '7'],

  // Emoji-only titles are valid (matches \p{So})
  ['🚀', '🚀'],

  // Mixed punctuation + letter is valid; ? is in the path-strip set.
  ['?.A', '_.A'],
  ['!.B', '!.B'],

  // Length cap at 80 chars
  ['x'.repeat(200), 'x'.repeat(80)],
];

let failures = 0;
for (const [input, expected] of cases) {
  const actual = sanitizeNoteTitle(input);
  try {
    assert.strictEqual(actual, expected);
    console.log(`  PASS  ${JSON.stringify(input)} → ${JSON.stringify(actual)}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL  ${JSON.stringify(input)} → got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} cases passed.`);
