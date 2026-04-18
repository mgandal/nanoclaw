/**
 * parseTextStyles — convert Claude's Markdown output to channel-native formatting.
 *
 * Claude outputs standard Markdown. Each channel has its own text style syntax:
 *   - Signal:             passthrough (SignalChannel handles rich text styles natively
 *                         via the signal-cli JSON-RPC textStyle param — see parseSignalStyles)
 *   - WhatsApp / Telegram: *bold*, _italic_, no headings, plain links
 *   - Slack:              *bold*, _italic_, <url|text> links
 *   - Discord:            passthrough (already Markdown)
 *
 * Code blocks (fenced and inline) are NEVER transformed by marker substitution.
 */

export type ChannelType =
  | 'signal'
  | 'whatsapp'
  | 'telegram'
  | 'slack'
  | 'discord';

/** Transform Markdown text for the target channel's native format. */
export function parseTextStyles(text: string, channel: ChannelType): string {
  if (!text) return text;

  // Discord and Signal are passthrough — no marker substitution.
  // Discord is already Markdown; Signal uses parseSignalStyles() for rich text.
  if (channel === 'discord' || channel === 'signal') return text;

  // Tables render as raw pipes on WhatsApp/Telegram/Slack, so fold them into
  // monospace code blocks FIRST — outside any existing fenced code block, which
  // is already a code region and may legitimately contain pipe-looking lines.
  const detabled = foldTablesOutsideCode(text);

  // Split into protected (code) and unprotected regions, transform only the latter.
  const segments = splitProtectedRegions(detabled);
  return segments
    .map(({ content, protected: isProtected }) =>
      isProtected ? content : transformSegment(content, channel),
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Signal rich-text formatting
// ---------------------------------------------------------------------------

export interface SignalTextStyle {
  /** One of Signal's supported text styles. */
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  /** Start position in the final message string, in UTF-16 code units. */
  start: number;
  /** Length of the styled range, in UTF-16 code units. */
  length: number;
}

/**
 * Parse Claude's Markdown into a plain string + Signal textStyle ranges.
 *
 * The returned `text` has all markdown markers stripped.  The `textStyle`
 * array uses UTF-16 code-unit offsets (JavaScript's native string indexing),
 * matching what signal-cli's JSON-RPC `send.textStyle` param expects.
 *
 * Supported patterns:
 *   **bold**          → BOLD
 *   *italic*          → ITALIC
 *   _italic_          → ITALIC
 *   ~~strike~~        → STRIKETHROUGH
 *   `inline code`     → MONOSPACE
 *   ```code block```  → MONOSPACE
 *   ## Heading        → BOLD (markers stripped)
 *   [text](url)       → "text (url)"  (no style)
 *   ---               → removed
 */
export function parseSignalStyles(rawText: string): {
  text: string;
  textStyle: SignalTextStyle[];
} {
  const textStyle: SignalTextStyle[] = [];
  let out = '';
  let i = 0;
  const s = rawText;
  const n = s.length;

  function addStyle(
    style: SignalTextStyle['style'],
    startOut: number,
    endOut: number,
  ): void {
    const length = endOut - startOut;
    if (length > 0) textStyle.push({ style, start: startOut, length });
  }

  while (i < n) {
    // ── Fenced code block  ```[lang]\n...\n``` ──────────────────────────
    if (s[i] === '`' && s[i + 1] === '`' && s[i + 2] === '`') {
      const langNl = s.indexOf('\n', i + 3);
      if (langNl !== -1) {
        // Find closing ``` on its own line
        const closeAt = s.indexOf('\n```', langNl);
        if (closeAt !== -1) {
          const content = s.slice(langNl + 1, closeAt);
          const startOut = out.length;
          out += content;
          addStyle('MONOSPACE', startOut, out.length);
          // Advance past \n``` + optional trailing newline
          const afterClose = s.indexOf('\n', closeAt + 4);
          i = afterClose !== -1 ? afterClose + 1 : n;
          continue;
        }
      }
      // Malformed fence — copy literally
      out += s[i];
      i++;
      continue;
    }

    // ── Inline code  `text` ────────────────────────────────────────────
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      const nl = s.indexOf('\n', i + 1);
      if (end !== -1 && (nl === -1 || end < nl)) {
        const content = s.slice(i + 1, end);
        const startOut = out.length;
        out += content;
        addStyle('MONOSPACE', startOut, out.length);
        i = end + 1;
        continue;
      }
    }

    // ── Bold  **text** ─────────────────────────────────────────────────
    if (s[i] === '*' && s[i + 1] === '*' && s[i + 2] && s[i + 2] !== ' ') {
      const end = s.indexOf('**', i + 2);
      if (end !== -1 && s[end - 1] !== ' ') {
        const content = s.slice(i + 2, end);
        const startOut = out.length;
        out += content;
        addStyle('BOLD', startOut, out.length);
        i = end + 2;
        continue;
      }
    }

    // ── Strikethrough  ~~text~~ ────────────────────────────────────────
    if (s[i] === '~' && s[i + 1] === '~' && s[i + 2] && s[i + 2] !== ' ') {
      const end = s.indexOf('~~', i + 2);
      if (end !== -1) {
        const content = s.slice(i + 2, end);
        const startOut = out.length;
        out += content;
        addStyle('STRIKETHROUGH', startOut, out.length);
        i = end + 2;
        continue;
      }
    }

    // ── Italic  *text*  (single star, not part of **) ─────────────────
    if (
      s[i] === '*' &&
      s[i + 1] !== '*' &&
      s[i + 1] !== ' ' &&
      s[i + 1] !== undefined
    ) {
      const end = findClosingStar(s, i + 1);
      if (end !== -1) {
        const content = s.slice(i + 1, end);
        const startOut = out.length;
        out += content;
        addStyle('ITALIC', startOut, out.length);
        i = end + 1;
        continue;
      }
    }

    // ── Italic  _text_  (only at word boundaries) ──────────────────────
    if (s[i] === '_' && s[i + 1] !== '_' && s[i + 1] !== ' ' && s[i + 1]) {
      // Guard against snake_case: only treat as italic when preceded by a
      // non-word character (or start of string).
      const prevChar = i > 0 ? s[i - 1] : '';
      if (!/\w/.test(prevChar)) {
        const end = findClosingUnderscore(s, i + 1);
        if (end !== -1) {
          const content = s.slice(i + 1, end);
          const startOut = out.length;
          out += content;
          addStyle('ITALIC', startOut, out.length);
          i = end + 1;
          continue;
        }
      }
    }

    // ── ATX Heading  ## text → text (as BOLD) ─────────────────────────
    if ((i === 0 || s[i - 1] === '\n') && s[i] === '#') {
      let j = i;
      while (j < n && s[j] === '#') j++;
      if (j < n && s[j] === ' ') {
        const lineEnd = s.indexOf('\n', j + 1);
        const headingText =
          lineEnd !== -1 ? s.slice(j + 1, lineEnd) : s.slice(j + 1);
        const startOut = out.length;
        out += headingText;
        addStyle('BOLD', startOut, out.length);
        if (lineEnd !== -1) {
          out += '\n';
          i = lineEnd + 1;
        } else i = n;
        continue;
      }
    }

    // ── Links  [text](url) → text (url) ───────────────────────────────
    if (s[i] === '[') {
      const closeBracket = s.indexOf(']', i + 1);
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        const closeParen = s.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = s.slice(i + 1, closeBracket);
          const url = s.slice(closeBracket + 2, closeParen);
          out += `${linkText} (${url})`;
          i = closeParen + 1;
          continue;
        }
      }
    }

    // ── Horizontal rule  --- / *** / ___ ──────────────────────────────
    if (i === 0 || s[i - 1] === '\n') {
      const hrMatch = /^(-{3,}|\*{3,}|_{3,}) *(\n|$)/.exec(s.slice(i));
      if (hrMatch) {
        i += hrMatch[0].length;
        continue;
      }
    }

    // ── Default: copy character, preserving surrogate pairs ───────────
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      out += s[i] + s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }

  return { text: out, textStyle };
}

// ---------------------------------------------------------------------------
// Helpers for parseSignalStyles
// ---------------------------------------------------------------------------

/** Find the position of a closing single `*` that isn't part of `**`. */
function findClosingStar(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1; // italics don't span lines
    if (s[i] === '*' && s[i + 1] !== '*' && s[i - 1] !== ' ') return i;
  }
  return -1;
}

/** Find the closing `_` that isn't part of `__` and is at a word boundary. */
function findClosingUnderscore(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1;
    if (s[i] === '_' && s[i + 1] !== '_' && !/\w/.test(s[i + 1] ?? '')) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Marker-substitution helpers (WhatsApp / Telegram / Slack)
// ---------------------------------------------------------------------------

interface Segment {
  content: string;
  protected: boolean;
}

/**
 * Split text into alternating unprotected/protected segments.
 * Protected = fenced code blocks (```...```) and inline code (`...`).
 */
function splitProtectedRegions(text: string): Segment[] {
  const segments: Segment[] = [];
  const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]+`/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        content: text.slice(lastIndex, match.index),
        protected: false,
      });
    }
    segments.push({ content: match[0], protected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), protected: false });
  }

  return segments.length > 0 ? segments : [{ content: text, protected: false }];
}

/** Apply marker-substitution transformations to a non-code segment. */
function transformSegment(text: string, channel: ChannelType): string {
  let t = text;

  // Order matters: italic before bold.
  // The italic regex won't match **bold** (it requires the char after the opening *
  // to be a non-* non-space), so running italic first is safe.  If we ran bold
  // first (**bold** → *bold*), the italic step would immediately re-convert *bold*
  // to _bold_, producing wrong output.

  // 1. Italic: *text* → _text_ (whatsapp/telegram/slack use _)
  t = t.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');

  // 2. Bold: **text** → *text* (whatsapp/telegram/slack use single *)
  t = t.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');

  // 3. Headings: ## Title → *Title* (any level, line-start only)
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // 4. Links
  if (channel === 'slack') {
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  } else {
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  }

  // 5. Horizontal rules: strip them
  t = t.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');

  return t;
}

// ---------------------------------------------------------------------------
// GFM table folding (WhatsApp / Telegram / Slack have no native table rendering)
// ---------------------------------------------------------------------------

/**
 * Scan text outside fenced code blocks and replace GFM tables with a fenced
 * monospace block whose columns are space-padded so rows align on a fixed-width
 * font — the best visual approximation Telegram/WhatsApp/Slack can render.
 */
function foldTablesOutsideCode(text: string): string {
  const FENCE = /```[\s\S]*?```/g;
  const out: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = FENCE.exec(text)) !== null) {
    out.push(foldTables(text.slice(cursor, m.index)));
    out.push(m[0]);
    cursor = m.index + m[0].length;
  }
  out.push(foldTables(text.slice(cursor)));
  return out.join('');
}

const SEPARATOR_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function foldTables(chunk: string): string {
  if (!chunk.includes('|')) return chunk;
  const lines = chunk.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (isTableRow(header) && sep !== undefined && SEPARATOR_ROW.test(sep)) {
      let last = i + 2;
      while (last < lines.length && isTableRow(lines[last])) last++;
      const rows = [header, ...lines.slice(i + 2, last)].map(splitRow);
      result.push(renderTable(rows));
      i = last - 1;
    } else {
      result.push(header);
    }
  }
  return result.join('\n');
}

function isTableRow(line: string | undefined): boolean {
  if (line === undefined) return false;
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = splitRow(trimmed);
  return cells.length >= 2;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(...rows.map((r) => (r[c] ?? '').length)),
  );
  const body = rows.map((r) =>
    widths
      .map((w, c) => (r[c] ?? '').padEnd(w))
      .join('  ')
      .trimEnd(),
  );
  const maxLen = Math.max(...body.map((l) => l.length));
  const padded = body.map((l) => l.padEnd(maxLen));
  return ['```', ...padded, '```'].join('\n');
}
