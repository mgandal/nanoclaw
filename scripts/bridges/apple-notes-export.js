#!/usr/bin/env node
// Export all Apple Notes as markdown files for QMD indexing
// Uses JXA (JavaScript for Automation) via osascript

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Mirror QMD handelize's filename-validity rule so downstream indexing never
// crashes on punctuation-only titles (e.g. "=", ".", "\\").
const HANDELIZE_VALID = /[\p{L}\p{N}\p{So}\p{Sk}$]/u;
export function sanitizeNoteTitle(title) {
  let cleaned = (title ?? '')
    .replace(/[/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!cleaned || !HANDELIZE_VALID.test(cleaned)) return 'untitled';
  return cleaned;
}

function main() {
const EXPORT_DIR = process.argv[2] || path.join(process.env.HOME, '.cache/apple-notes-mcp/exported');

// Clean and recreate
fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });

console.log(`Exporting Apple Notes to ${EXPORT_DIR} ...`);

// Step 1: Get all folder names and note counts via JXA
const foldersRaw = execFileSync('osascript', ['-l', 'JavaScript', '-e', `
  const app = Application("Notes");
  const folders = app.folders();
  const result = folders.map(f => ({ name: f.name(), count: f.notes.length }));
  JSON.stringify(result);
`], { timeout: 30000 }).toString().trim();

const folders = JSON.parse(foldersRaw);
console.log(`Found ${folders.length} folders, ${folders.reduce((s, f) => s + f.count, 0)} total notes`);

let exported = 0;
let errors = 0;

for (const folder of folders) {
  if (folder.count === 0) continue;

  const cleanFolder = folder.name.replace(/[/:*?"<>|]/g, '_');
  const folderPath = path.join(EXPORT_DIR, cleanFolder);
  fs.mkdirSync(folderPath, { recursive: true });

  // Get all notes in this folder via JXA (batch per folder)
  let notesRaw;
  try {
    notesRaw = execFileSync('osascript', ['-l', 'JavaScript', '-e', `
      const app = Application("Notes");
      const folder = app.folders.byName(${JSON.stringify(folder.name)});
      const notes = folder.notes();
      const result = notes.map(n => {
        try {
          return {
            title: n.name(),
            body: n.plaintext(),
            modified: n.modificationDate().toISOString().split("T")[0],
            created: n.creationDate().toISOString().split("T")[0]
          };
        } catch(e) {
          return { title: "error", body: "", modified: "", created: "", error: e.message };
        }
      });
      JSON.stringify(result);
    `], { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }).toString().trim();
  } catch (e) {
    console.error(`Error reading folder "${folder.name}": ${e.message}`);
    errors++;
    continue;
  }

  let notes;
  try {
    notes = JSON.parse(notesRaw);
  } catch (e) {
    console.error(`Error parsing notes from "${folder.name}": ${e.message}`);
    errors++;
    continue;
  }

  const usedNames = new Set();
  for (const note of notes) {
    if (note.error) {
      errors++;
      continue;
    }

    const cleanTitle = sanitizeNoteTitle(note.title);

    // Handle duplicates
    let fileName = cleanTitle;
    let counter = 1;
    while (usedNames.has(fileName.toLowerCase())) {
      fileName = `${cleanTitle}-${counter}`;
      counter++;
    }
    usedNames.add(fileName.toLowerCase());

    const content = [
      `# ${note.title}`,
      '',
      `**Folder:** ${folder.name}  `,
      `**Modified:** ${note.modified}  `,
      `**Created:** ${note.created}`,
      '',
      '---',
      '',
      note.body
    ].join('\n');

    const filePath = path.join(folderPath, `${fileName}.md`);
    fs.writeFileSync(filePath, content);
    exported++;

    if (exported % 100 === 0) {
      console.log(`Exported ${exported} notes...`);
    }
  }
}

console.log(`\nExport complete: ${exported} notes exported, ${errors} errors`);
}

// CLI guard — only run main() when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
