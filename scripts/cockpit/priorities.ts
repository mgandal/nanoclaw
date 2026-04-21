// Match "## Top N" with optional trailing words, e.g. "## Top 3 Priorities This Week".
const TOP_HEADING_RE = /^##\s+Top\s+\d+\b/i;
const NEXT_HEADING_RE = /^##\s+/;
const NUMBERED_ITEM_RE = /^\d+\.\s+(.+)$/;

export function parsePriorities(md: string): string[] {
  const lines = md.split('\n');
  let inSection = false;
  const items: string[] = [];
  for (const line of lines) {
    if (inSection && NEXT_HEADING_RE.test(line)) break;
    if (TOP_HEADING_RE.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    const m = line.match(NUMBERED_ITEM_RE);
    if (m) items.push(m[1].trim());
  }
  return items;
}
