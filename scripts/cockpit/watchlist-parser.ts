import type { WatchlistItem } from './types.js';

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
const EMDASH_SEP = ' — ';  // em-dash with spaces on both sides

/**
 * Extract the body (lines following a heading) of a specific section from markdown.
 * Section is matched case-insensitively on the heading name (## HeadingName).
 * Returns null if section not found. Returns empty string if section exists but is empty.
 */
export function extractSection(md: string, sectionName: string): string | null {
  const lines = md.split('\n');
  const headingRe = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  const nextHeadingRe = /^##\s+/;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) return null;

  const body: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (nextHeadingRe.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/**
 * Parse top-level markdown bullets into WatchlistItems.
 * Rules (from spec §6):
 *   - One item per top-level bullet (`- ` at column 0)
 *   - First [text](url) match on line → title + url
 *   - If no [text](url) → remainder of line becomes title, no url
 *   - Everything after first " — " → note
 *   - Nested bullets, YAML frontmatter, non-bullet lines: ignored
 */
export function parseWatchlistBullets(body: string): WatchlistItem[] {
  const items: WatchlistItem[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const content = line.slice(2);
    items.push(parseOne(content));
  }
  return items;
}

function parseOne(content: string): WatchlistItem {
  const sepIdx = content.indexOf(EMDASH_SEP);
  const head = sepIdx === -1 ? content : content.slice(0, sepIdx);
  const note = sepIdx === -1 ? undefined : content.slice(sepIdx + EMDASH_SEP.length).trim();

  const linkMatch = head.match(LINK_RE);
  if (linkMatch) {
    return {
      title: linkMatch[1].trim(),
      url: linkMatch[2].trim(),
      ...(note ? { note } : {}),
    };
  }
  return {
    title: head.trim(),
    ...(note ? { note } : {}),
  };
}
