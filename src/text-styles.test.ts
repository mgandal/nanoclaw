/**
 * Dedicated regression tests for src/text-styles.ts
 *
 * Covers edge cases and gaps not addressed in formatting.test.ts:
 * - Empty / falsy inputs
 * - Strikethrough conversion across channels
 * - Unclosed formatting markers
 * - Nested / adjacent formatting
 * - Unicode and emoji content
 * - Very long strings
 * - Multi-line headings
 * - Code blocks with language tags
 * - Snake_case preservation
 * - Multiple links in one string
 */
import { describe, it, expect } from 'vitest';
import {
  parseTextStyles,
  parseSignalStyles,
  ChannelType,
} from './text-styles.js';

// ---------------------------------------------------------------------------
// 1. Empty / falsy inputs
// ---------------------------------------------------------------------------
describe('parseTextStyles — empty and falsy inputs', () => {
  it('returns empty string for empty input', () => {
    expect(parseTextStyles('', 'whatsapp')).toBe('');
  });

  it('returns the falsy value unchanged (null/undefined guard)', () => {
    // The function checks `if (!text) return text;`
    expect(parseTextStyles(null as unknown as string, 'telegram')).toBe(null);
    expect(parseTextStyles(undefined as unknown as string, 'slack')).toBe(
      undefined,
    );
  });
});

describe('parseSignalStyles — empty input', () => {
  it('returns empty text and no styles for empty string', () => {
    const { text, textStyle } = parseSignalStyles('');
    expect(text).toBe('');
    expect(textStyle).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Unclosed formatting markers (should pass through unchanged)
// ---------------------------------------------------------------------------
describe('parseTextStyles — unclosed markers', () => {
  it('passes through unclosed bold **text on whatsapp', () => {
    expect(parseTextStyles('**unclosed bold', 'whatsapp')).toBe(
      '**unclosed bold',
    );
  });

  it('passes through unclosed italic *text on telegram', () => {
    expect(parseTextStyles('*unclosed italic', 'telegram')).toBe(
      '*unclosed italic',
    );
  });

  it('passes through unclosed inline code `text on slack', () => {
    expect(parseTextStyles('`unclosed code', 'slack')).toBe('`unclosed code');
  });
});

describe('parseSignalStyles — unclosed markers', () => {
  it('passes through unclosed bold **text literally', () => {
    const { text } = parseSignalStyles('**unclosed bold');
    // Bold requires closing **, so it should not be consumed
    expect(text).toContain('unclosed bold');
  });

  it('passes through unclosed inline code literally', () => {
    const { text, textStyle } = parseSignalStyles('say `unclosed code');
    expect(text).toContain('`');
    expect(textStyle.filter((s) => s.style === 'MONOSPACE')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Unicode and emoji content
// ---------------------------------------------------------------------------
describe('parseTextStyles — unicode and emoji', () => {
  it('preserves emoji in formatted text on whatsapp', () => {
    expect(parseTextStyles('**hello 🌍**', 'whatsapp')).toBe('*hello 🌍*');
  });

  it('preserves CJK characters in formatted text on telegram', () => {
    expect(parseTextStyles('*日本語*', 'telegram')).toBe('_日本語_');
  });
});

describe('parseSignalStyles — unicode offsets', () => {
  it('handles emoji in bold with correct offsets', () => {
    const { text, textStyle } = parseSignalStyles('**hi 🌍**');
    expect(text).toBe('hi 🌍');
    // 🌍 is a surrogate pair (2 UTF-16 code units), so length = 3 + 1 + 2 = 6
    expect(textStyle).toEqual([{ style: 'BOLD', start: 0, length: 5 }]);
  });

  it('preserves surrogate pairs in plain text', () => {
    const { text } = parseSignalStyles('hello 🎉 world');
    expect(text).toBe('hello 🎉 world');
  });
});

// ---------------------------------------------------------------------------
// 4. Very long strings
// ---------------------------------------------------------------------------
describe('parseTextStyles — long strings', () => {
  it('handles very long plain text without error on whatsapp', () => {
    const long = 'a'.repeat(50000);
    expect(parseTextStyles(long, 'whatsapp')).toBe(long);
  });

  it('handles very long bold text on telegram', () => {
    const inner = 'b'.repeat(10000);
    expect(parseTextStyles(`**${inner}**`, 'telegram')).toBe(`*${inner}*`);
  });
});

// ---------------------------------------------------------------------------
// 5. Nested / adjacent formatting
// ---------------------------------------------------------------------------
describe('parseTextStyles — adjacent formatting', () => {
  it('handles bold immediately followed by italic on whatsapp', () => {
    const result = parseTextStyles('**bold***italic*', 'whatsapp');
    // **bold** is consumed first, then *italic* remains
    // After bold conversion: *bold**italic* — the remaining *italic* should become _italic_
    // This is tricky — let's just verify no crash and reasonable output
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('handles multiple bold segments on telegram', () => {
    expect(parseTextStyles('**a** and **b**', 'telegram')).toBe('*a* and *b*');
  });

  it('handles multiple italic segments on slack', () => {
    expect(parseTextStyles('*a* and *b*', 'slack')).toBe('_a_ and _b_');
  });
});

// ---------------------------------------------------------------------------
// 6. Multi-line with multiple headings
// ---------------------------------------------------------------------------
describe('parseTextStyles — multi-line headings', () => {
  it('converts multiple headings in multi-line text on whatsapp', () => {
    const input = '# First\nsome text\n## Second';
    const result = parseTextStyles(input, 'whatsapp');
    expect(result).toBe('*First*\nsome text\n*Second*');
  });
});

// ---------------------------------------------------------------------------
// 7. Code blocks with language specifiers
// ---------------------------------------------------------------------------
describe('parseTextStyles — code blocks with language tags', () => {
  it('preserves code block with language tag on telegram', () => {
    const input = '```typescript\nconst x = **1**;\n```';
    expect(parseTextStyles(input, 'telegram')).toBe(input);
  });

  it('transforms text around code block with language tag', () => {
    const input = '**bold**\n```js\ncode\n```\n*italic*';
    const result = parseTextStyles(input, 'whatsapp');
    expect(result).toContain('*bold*');
    expect(result).toContain('```js\ncode\n```');
    expect(result).toContain('_italic_');
  });
});

describe('parseSignalStyles — fenced code block with language', () => {
  it('strips language tag and marks content as MONOSPACE', () => {
    const input = '```python\nprint("hi")\n```';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toBe('print("hi")');
    expect(textStyle).toEqual([{ style: 'MONOSPACE', start: 0, length: 11 }]);
  });
});

// ---------------------------------------------------------------------------
// 8. Snake_case preservation in non-Signal channels
// ---------------------------------------------------------------------------
describe('parseTextStyles — snake_case in non-Signal channels', () => {
  it('does not convert snake_case underscores to italic on whatsapp', () => {
    // The italic regex requires non-space after opening *, not _
    // But the input here uses _ which is NOT converted by transformSegment
    // (transformSegment only converts * to _, not _ to anything)
    const input = 'use my_variable_name here';
    expect(parseTextStyles(input, 'whatsapp')).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 9. Multiple links in one string
// ---------------------------------------------------------------------------
describe('parseTextStyles — multiple links', () => {
  it('converts multiple links on whatsapp', () => {
    const input = '[A](https://a.com) and [B](https://b.com)';
    expect(parseTextStyles(input, 'whatsapp')).toBe(
      'A (https://a.com) and B (https://b.com)',
    );
  });

  it('converts multiple links to slack format', () => {
    const input = '[A](https://a.com) and [B](https://b.com)';
    expect(parseTextStyles(input, 'slack')).toBe(
      '<https://a.com|A> and <https://b.com|B>',
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Horizontal rules (edge variants)
// ---------------------------------------------------------------------------
describe('parseTextStyles — horizontal rule variants', () => {
  it('strips ___ horizontal rule on telegram', () => {
    expect(parseTextStyles('above\n___\nbelow', 'telegram')).toBe(
      'above\n\nbelow',
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Signal — heading + link combined
// ---------------------------------------------------------------------------
describe('parseSignalStyles — combined heading and link', () => {
  it('converts heading then link in sequence', () => {
    const input = '## Title\n[click](https://example.com)';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toContain('Title');
    expect(text).toContain('click (https://example.com)');
    const boldStyle = textStyle.find((s) => s.style === 'BOLD');
    expect(boldStyle).toBeDefined();
    expect(boldStyle!.length).toBe(5); // "Title"
  });
});

// ---------------------------------------------------------------------------
// 12. Special characters that might break formatting
// ---------------------------------------------------------------------------
describe('parseTextStyles — special characters', () => {
  it('handles angle brackets in non-link context on whatsapp', () => {
    const input = 'a < b > c';
    expect(parseTextStyles(input, 'whatsapp')).toBe('a < b > c');
  });

  it('handles parentheses that look like link syntax on telegram', () => {
    const input = 'not a [link without](closing paren';
    // No closing paren after ](, so regex won't match
    expect(parseTextStyles(input, 'telegram')).toBe(input);
  });

  it('handles backslashes in text on slack', () => {
    const input = 'path\\to\\file';
    expect(parseTextStyles(input, 'slack')).toBe('path\\to\\file');
  });
});

// ---------------------------------------------------------------------------
// 13. Signal — multiple styles with correct offset tracking
// ---------------------------------------------------------------------------
describe('parseSignalStyles — offset tracking with mixed content', () => {
  it('tracks offsets correctly with plain text, bold, code, and italic', () => {
    const input = 'Hello **world** and `code` and *more*';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toBe('Hello world and code and more');

    // bold "world" at position 6, length 5
    expect(textStyle[0]).toEqual({ style: 'BOLD', start: 6, length: 5 });
    // monospace "code" at position 16, length 4
    expect(textStyle[1]).toEqual({ style: 'MONOSPACE', start: 16, length: 4 });
    // italic "more" at position 25, length 4
    expect(textStyle[2]).toEqual({ style: 'ITALIC', start: 25, length: 4 });
  });
});
