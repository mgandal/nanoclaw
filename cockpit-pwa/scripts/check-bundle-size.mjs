#!/usr/bin/env node
// Enforce the spec §4 performance budget:
//   initial JS bundle ≤ 100 KB gzipped
//
// "Initial" = main entry chunk + its static imports. Lazy-loaded chunks
// (anything pulled in via dynamic import()) do NOT count toward the budget
// since they never load on the home route.
//
// Strategy: read dist/index.html, find each <script type="module"> src, and
// crawl import-preload-links to discover the static import closure. Sum
// gzipped sizes.
//
// Simpler heuristic used here: sum gzipped sizes of every file in dist/assets/
// whose filename does NOT match the known lazy-chunk prefixes. Update the
// LAZY_PREFIXES list when new dynamic imports land.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET_BYTES = 100 * 1024;  // 100 KB gzip
const DIST = 'dist/assets';
const LAZY_PREFIXES = [
  'markdown-',        // markdown-it chunk — loaded only on vault pages
  'hljs-',            // highlight.js chunk — loaded only on vault pages
  'render-markdown-', // the lazy-importer module itself
];

const files = readdirSync(DIST);
const entries = files
  .filter(f => f.endsWith('.js'))
  .filter(f => !LAZY_PREFIXES.some(p => f.startsWith(p)))
  .map(f => {
    const abs = join(DIST, f);
    const raw = readFileSync(abs);
    const gz = gzipSync(raw);
    return { file: f, raw: raw.length, gzip: gz.length };
  });

console.log('Initial-load JS chunks:');
let total = 0;
for (const e of entries) {
  total += e.gzip;
  console.log(`  ${e.file.padEnd(48)} ${(e.gzip / 1024).toFixed(2).padStart(6)} KB gzip`);
}
console.log(`  ${''.padEnd(48)} ${'------'.padStart(6)}`);
console.log(`  ${'TOTAL'.padEnd(48)} ${(total / 1024).toFixed(2).padStart(6)} KB gzip`);
console.log(`  budget: ${(BUDGET_BYTES / 1024).toFixed(0)} KB`);

if (total > BUDGET_BYTES) {
  console.error(`\n❌ bundle size ${total} bytes exceeds budget ${BUDGET_BYTES} bytes`);
  process.exit(1);
}
console.log(`✓ under budget by ${((BUDGET_BYTES - total) / 1024).toFixed(2)} KB`);
