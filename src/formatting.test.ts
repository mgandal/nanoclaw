import { describe, it, expect } from 'vitest';

import {
  ASSISTANT_NAME,
  getTriggerPattern,
  TRIGGER_PATTERN,
} from './config.js';
import {
  escapeXml,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import {
  parseTextStyles,
  parseSignalStyles,
  ChannelType,
} from './text-styles.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  const TZ = 'UTC';

  it('formats a single message as XML with context header', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('>hello</message>');
    expect(result).toContain('Jan 1, 2024');
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
      makeMsg({
        id: '2',
        sender_name: 'Bob',
        content: 'hey',
        timestamp: '2024-01-01T01:00:00.000Z',
      }),
    ];
    const result = formatMessages(msgs, TZ);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })], TZ);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages(
      [makeMsg({ content: '<script>alert("xss")</script>' })],
      TZ,
    );
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<messages>\n\n</messages>');
  });

  it('renders reply context as quoted_message element', () => {
    const result = formatMessages(
      [
        makeMsg({
          content: 'Yes, on my way!',
          reply_to_message_id: '42',
          reply_to_message_content: 'Are you coming tonight?',
          reply_to_sender_name: 'Bob',
        }),
      ],
      TZ,
    );
    expect(result).toContain('reply_to="42"');
    expect(result).toContain(
      '<quoted_message from="Bob">Are you coming tonight?</quoted_message>',
    );
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply attributes when no reply context', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('omits quoted_message when content is missing but id is present', () => {
    const result = formatMessages(
      [
        makeMsg({
          reply_to_message_id: '42',
          reply_to_sender_name: 'Bob',
        }),
      ],
      TZ,
    );
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('escapes special characters in reply context', () => {
    const result = formatMessages(
      [
        makeMsg({
          reply_to_message_id: '1',
          reply_to_message_content: '<script>alert("xss")</script>',
          reply_to_sender_name: 'A & B',
        }),
      ],
      TZ,
    );
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('converts timestamps to local time for given timezone', () => {
    // 2024-01-01T18:30:00Z in America/New_York (EST) = 1:30 PM
    const result = formatMessages(
      [makeMsg({ timestamp: '2024-01-01T18:30:00.000Z' })],
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('<context timezone="America/New_York" />');
  });
});

// --- TRIGGER_PATTERN ---

describe('TRIGGER_PATTERN', () => {
  const name = ASSISTANT_NAME;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();

  it('matches @name at start of message', () => {
    expect(TRIGGER_PATTERN.test(`@${name} hello`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${lower} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${upper} hello`)).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(TRIGGER_PATTERN.test(`hello @${name}`)).toBe(false);
  });

  it('does not match partial name like @NameExtra (word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}extra hello`)).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(TRIGGER_PATTERN.test(`@${name}'s thing`)).toBe(true);
  });

  it('matches @name alone (end of string is a word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}`)).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    // The actual usage trims before testing: TRIGGER_PATTERN.test(m.content.trim())
    expect(TRIGGER_PATTERN.test(`@${name} hey`.trim())).toBe(true);
  });
});

describe('getTriggerPattern', () => {
  it('uses the configured per-group trigger when provided', () => {
    const pattern = getTriggerPattern('@Claw');

    expect(pattern.test('@Claw hello')).toBe(true);
    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(false);
  });

  it('falls back to the default trigger when group trigger is missing', () => {
    const pattern = getTriggerPattern(undefined);

    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
  });

  it('treats regex characters in custom triggers literally', () => {
    const pattern = getTriggerPattern('@C.L.A.U.D.E');

    expect(pattern.test('@C.L.A.U.D.E hello')).toBe(true);
    expect(pattern.test('@CXLXAUXDXE hello')).toBe(false);
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags('<internal>a</internal>hello<internal>b</internal>'),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

describe('formatOutbound', () => {
  it('returns text with internal tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is internal', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });

  it('strips internal tags from remaining text', () => {
    expect(
      formatOutbound('<internal>thinking</internal>The answer is 42'),
    ).toBe('The answer is 42');
  });
});

// --- Trigger gating with requiresTrigger flag ---

describe('trigger gating (requiresTrigger interaction)', () => {
  // Replicates the exact logic from processGroupMessages and startMessageLoop:
  //   if (!isMainGroup && group.requiresTrigger !== false) { check group.trigger }
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    trigger: string | undefined,
    messages: NewMessage[],
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;
    const triggerPattern = getTriggerPattern(trigger);
    return messages.some((m) => triggerPattern.test(m.content.trim()));
  }

  it('main group always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, undefined, msgs)).toBe(true);
  });

  it('main group processes even with requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, true, undefined, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=undefined requires trigger (defaults to true)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(true);
  });

  it('non-main group uses its per-group trigger instead of the default trigger', () => {
    const msgs = [makeMsg({ content: '@Claw do something' })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(true);
  });

  it('non-main group does not process when only the default trigger is present for a custom-trigger group', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, undefined, msgs)).toBe(true);
  });
});

// --- parseTextStyles ---

describe('parseTextStyles — passthrough channels', () => {
  it('passes text through unchanged on discord', () => {
    const md = '**bold** and *italic* and [link](https://example.com)';
    expect(parseTextStyles(md, 'discord')).toBe(md);
  });

  it('passes text through unchanged on signal (signal uses parseSignalStyles)', () => {
    const md = '**bold** and *italic* and [link](https://example.com)';
    expect(parseTextStyles(md, 'signal')).toBe(md);
  });
});

describe('parseTextStyles — bold', () => {
  it('converts **bold** to *bold* on whatsapp', () => {
    expect(parseTextStyles('**hello**', 'whatsapp')).toBe('*hello*');
  });

  it('converts **bold** to *bold* on telegram', () => {
    expect(parseTextStyles('say **this** now', 'telegram')).toBe(
      'say *this* now',
    );
  });

  it('converts **bold** to *bold* on slack', () => {
    expect(parseTextStyles('**hello**', 'slack')).toBe('*hello*');
  });

  it('does not convert a lone * as bold', () => {
    expect(parseTextStyles('a * b * c', 'whatsapp')).toBe('a * b * c');
  });
});

describe('parseTextStyles — italic', () => {
  it('converts *italic* to _italic_ on whatsapp', () => {
    expect(parseTextStyles('say *this* now', 'whatsapp')).toBe(
      'say _this_ now',
    );
  });

  it('converts inline *italic* to _italic_ on telegram', () => {
    // NOTE: a bare `*word*` ALONE on its own line is treated as a bold header
    // (see "single-asterisk header lines"), so this case uses mid-sentence
    // italic, which is the span that genuinely stays italic.
    expect(parseTextStyles('an *italic* word', 'telegram')).toBe(
      'an _italic_ word',
    );
  });

  it('bold-before-italic: **bold** *italic* → *bold* _italic_', () => {
    expect(parseTextStyles('**bold** *italic*', 'whatsapp')).toBe(
      '*bold* _italic_',
    );
  });
});

describe('parseTextStyles — headings', () => {
  it('converts # heading on whatsapp', () => {
    expect(parseTextStyles('# Top', 'whatsapp')).toBe('*Top*');
  });

  it('converts ## heading on telegram', () => {
    expect(parseTextStyles('## Hello World', 'telegram')).toBe('*Hello World*');
  });

  it('converts ### heading on telegram', () => {
    expect(parseTextStyles('### Section', 'telegram')).toBe('*Section*');
  });

  it('only converts headings at line start', () => {
    const input = 'not a ## heading in middle';
    expect(parseTextStyles(input, 'whatsapp')).toBe(input);
  });
});

describe('parseTextStyles — single-asterisk header lines → bold', () => {
  // Agents frequently emit section headers as a single-asterisk span on its
  // own line (`*Today*`), meaning bold. Standard Markdown reads single `*` as
  // italic, but a span that is the ENTIRE line is unambiguously a header, so
  // render it bold (`*…*` on telegram/whatsapp/slack) rather than italic.

  it('renders a standalone *Header* line as bold on telegram', () => {
    expect(parseTextStyles('*Today*', 'telegram')).toBe('*Today*');
  });

  it('renders a multi-word standalone header as bold', () => {
    expect(parseTextStyles('*NEEDS YOUR DECISION*', 'telegram')).toBe(
      '*NEEDS YOUR DECISION*',
    );
  });

  it('keeps a leading emoji/pin before a standalone header', () => {
    expect(parseTextStyles('📋 *Follow-ups*', 'telegram')).toBe(
      '📋 *Follow-ups*',
    );
  });

  it('treats a standalone header as bold on whatsapp too', () => {
    expect(parseTextStyles('*Overdue*', 'whatsapp')).toBe('*Overdue*');
  });

  it('still renders inline *italic* mid-sentence as italic', () => {
    expect(parseTextStyles('this is *important* today', 'telegram')).toBe(
      'this is _important_ today',
    );
  });

  it('header on its own line, italic inline elsewhere', () => {
    const input = '*Today*\nthis is *important* now';
    expect(parseTextStyles(input, 'telegram')).toBe(
      '*Today*\nthis is _important_ now',
    );
  });

  it('does not treat a **bold** line as needing header handling', () => {
    expect(parseTextStyles('**Already Bold**', 'telegram')).toBe(
      '*Already Bold*',
    );
  });

  it('bolds a label followed by an em-dash at line start', () => {
    expect(
      parseTextStyles('*System alert* — 401 failures today', 'telegram'),
    ).toBe('*System alert* — 401 failures today');
  });

  it('bolds a label followed by a colon at line start', () => {
    expect(parseTextStyles('*Note*: check the logs', 'telegram')).toBe(
      '*Note*: check the logs',
    );
  });

  it('bolds an emoji-led label followed by an em-dash', () => {
    expect(parseTextStyles('💬 *Slack* — lookup failed', 'telegram')).toBe(
      '💬 *Slack* — lookup failed',
    );
  });

  it('does NOT bold a label-like span mid-sentence', () => {
    // The span is not at line start, so it stays italic.
    expect(parseTextStyles('see *this*: details', 'telegram')).toBe(
      'see _this_: details',
    );
  });

  it('does NOT bold when an em-dash appears but span is not at line start', () => {
    expect(parseTextStyles('foo *bar* — baz', 'telegram')).toBe(
      'foo _bar_ — baz',
    );
  });
});

describe('parseTextStyles — links', () => {
  it('converts [text](url) to text (url) on whatsapp', () => {
    expect(parseTextStyles('[Link](https://example.com)', 'whatsapp')).toBe(
      'Link (https://example.com)',
    );
  });

  it('preserves [text](url) on telegram (Markdown v1 supports it natively)', () => {
    expect(parseTextStyles('[Link](https://example.com)', 'telegram')).toBe(
      '[Link](https://example.com)',
    );
  });

  it('converts [text](url) to <url|text> on slack', () => {
    expect(parseTextStyles('[Click here](https://example.com)', 'slack')).toBe(
      '<https://example.com|Click here>',
    );
  });
});

describe('parseTextStyles — horizontal rules', () => {
  it('strips --- on telegram', () => {
    expect(parseTextStyles('above\n---\nbelow', 'telegram')).toBe(
      'above\n\nbelow',
    );
  });

  it('strips *** on whatsapp', () => {
    expect(parseTextStyles('above\n***\nbelow', 'whatsapp')).toBe(
      'above\n\nbelow',
    );
  });
});

describe('parseTextStyles — code block protection', () => {
  it('does not transform **bold** inside fenced code block', () => {
    const input = '```\n**not bold**\n```';
    expect(parseTextStyles(input, 'whatsapp')).toBe(input);
  });

  it('does not transform *italic* inside inline code', () => {
    const input = 'use `*star*` literally';
    expect(parseTextStyles(input, 'telegram')).toBe(input);
  });

  it('transforms text outside code blocks but not inside', () => {
    const input = '**bold** and `*code*` and *italic*';
    expect(parseTextStyles(input, 'whatsapp')).toBe(
      '*bold* and `*code*` and _italic_',
    );
  });

  it('transforms text outside fenced block but not inside', () => {
    // Trailing italic is mid-line ("an *x* y") so it stays italic — a bare
    // `*x*` alone on a line would be promoted to a bold header instead.
    const input = '**bold**\n```\n**raw**\n```\nan *italic* tail';
    expect(parseTextStyles(input, 'telegram')).toBe(
      '*bold*\n```\n**raw**\n```\nan _italic_ tail',
    );
  });
});

describe('parseTextStyles — telegram marker balance (Markdown v1)', () => {
  // Telegram Markdown v1 rejects the ENTIRE message (silent plain-text
  // fallback) if literal `_` or `*` leave the emphasis markers unbalanced.
  // Identifiers like CLAUDE_CODE_OAUTH_TOKEN or file_name.py are the common
  // trigger — their underscores must be escaped so v1 treats them as literal.
  const unescapedUnderscores = (s: string): number =>
    (s.match(/(?<!\\)_/g) ?? []).length;
  const unescapedStars = (s: string): number =>
    (s.match(/(?<!\\)\*/g) ?? []).length;

  it('escapes underscores inside snake_case identifiers', () => {
    expect(
      parseTextStyles(
        'Token CLAUDE_CODE_OAUTH_TOKEN may be expired.',
        'telegram',
      ),
    ).toBe('Token CLAUDE\\_CODE\\_OAUTH\\_TOKEN may be expired.');
  });

  it('keeps the underscore count even when an identifier is present', () => {
    const out = parseTextStyles(
      'See file_name_here.py and other_var today.',
      'telegram',
    );
    expect(unescapedUnderscores(out) % 2).toBe(0);
  });

  it('does not break intentional _italic_ when an identifier is also present', () => {
    const out = parseTextStyles('*Today* uses my_var_name here', 'telegram');
    // The intentional emphasis survives as a balanced pair...
    expect(out).toContain('_Today_');
    // ...and the identifier underscores are escaped (literal).
    expect(out).toContain('my\\_var\\_name');
    expect(unescapedUnderscores(out) % 2).toBe(0);
  });

  it('full digest with identifier headers stays balanced', () => {
    const raw = [
      '*System alert* — CLAUDE_CODE_OAUTH_TOKEN may be expired.',
      '',
      '*Today*',
      '• 12:00 — Lab Meeting',
      '',
      '*Awaiting you*',
      '• billing fix — see followups.md',
    ].join('\n');
    const out = parseTextStyles(raw, 'telegram');
    expect(unescapedUnderscores(out) % 2).toBe(0);
    expect(unescapedStars(out) % 2).toBe(0);
  });

  // Regression: a leading- or trailing-underscore identifier has a balanced
  // underscore count to begin with; a naive "escape only when flanked by word
  // chars on BOTH sides" rule escapes the interior `_` but not the boundary
  // one, turning balanced → UNBALANCED and silently breaking the whole message.
  it('keeps balance for a leading-underscore identifier', () => {
    const out = parseTextStyles('set _internal_state now', 'telegram');
    expect(unescapedUnderscores(out) % 2).toBe(0);
    expect(out).toBe('set \\_internal\\_state now');
  });

  it('keeps balance for a single leading-underscore token', () => {
    // A lone `_id` would leave one stray `_` and break the message.
    const out = parseTextStyles('use _id today', 'telegram');
    expect(unescapedUnderscores(out) % 2).toBe(0);
    expect(out).toBe('use \\_id today');
  });

  it('keeps balance for a dunder identifier', () => {
    const out = parseTextStyles('override __init__ here', 'telegram');
    expect(unescapedUnderscores(out) % 2).toBe(0);
  });

  it('preserves italic AND escapes an identifier on the same line', () => {
    const out = parseTextStyles('mix _this_ and file_name here', 'telegram');
    expect(out).toContain('_this_'); // intentional italic survives
    expect(out).toContain('file\\_name'); // identifier escaped
    expect(unescapedUnderscores(out) % 2).toBe(0);
  });

  it('escapes a stray word-internal asterisk to keep balance', () => {
    const out = parseTextStyles('compute 2*3 now', 'telegram');
    expect(unescapedStars(out) % 2).toBe(0);
    expect(out).toBe('compute 2\\*3 now');
  });

  it('escaping is idempotent: a second pass does not double-escape', () => {
    // parseTextStyles is non-idempotent overall (one-transform invariant), but
    // the marker escaping specifically must not turn \_ into \\_ / \* into \\*.
    for (const input of [
      'set _internal_state now',
      'CLAUDE_CODE_OAUTH_TOKEN here',
      '*System alert* — file_name.py down',
      'compute 2*3 now',
    ]) {
      const once = parseTextStyles(input, 'telegram');
      expect(parseTextStyles(once, 'telegram')).toBe(once);
    }
  });

  it('does not add escapes on non-telegram channels', () => {
    const input = 'CLAUDE_CODE_OAUTH_TOKEN and _x_ and 2*3';
    expect(parseTextStyles(input, 'whatsapp')).not.toContain('\\');
    expect(parseTextStyles(input, 'slack')).not.toContain('\\');
  });

  it('does not escape underscores inside code (still literal, but protected)', () => {
    const out = parseTextStyles('run `my_func()` now', 'telegram');
    // Code is protected verbatim — no backslash escaping inside it.
    expect(out).toBe('run `my_func()` now');
  });

  it('leaves a normal _italic_ pair untouched', () => {
    expect(parseTextStyles('say _this_ now', 'telegram')).toBe(
      'say _this_ now',
    );
  });
});

// --- parseSignalStyles ---

describe('parseSignalStyles — basic styles', () => {
  it('extracts BOLD from **text**', () => {
    const { text, textStyle } = parseSignalStyles('**hello**');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 0, length: 5 }]);
  });

  it('extracts ITALIC from *text*', () => {
    const { text, textStyle } = parseSignalStyles('*hello*');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'ITALIC', start: 0, length: 5 }]);
  });

  it('extracts ITALIC from _text_', () => {
    const { text, textStyle } = parseSignalStyles('_hello_');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'ITALIC', start: 0, length: 5 }]);
  });

  it('extracts STRIKETHROUGH from ~~text~~', () => {
    const { text, textStyle } = parseSignalStyles('~~hello~~');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([
      { style: 'STRIKETHROUGH', start: 0, length: 5 },
    ]);
  });

  it('extracts MONOSPACE from `inline code`', () => {
    const { text, textStyle } = parseSignalStyles('`code`');
    expect(text).toBe('code');
    expect(textStyle).toEqual([{ style: 'MONOSPACE', start: 0, length: 4 }]);
  });

  it('extracts BOLD from ## heading and strips marker', () => {
    const { text, textStyle } = parseSignalStyles('## Hello World');
    expect(text).toBe('Hello World');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 0, length: 11 }]);
  });

  it('no styles for plain text', () => {
    const { text, textStyle } = parseSignalStyles('just plain text');
    expect(text).toBe('just plain text');
    expect(textStyle).toHaveLength(0);
  });
});

describe('parseSignalStyles — mixed content', () => {
  it('correctly offsets styles in mixed text', () => {
    const { text, textStyle } = parseSignalStyles('say **hi** now');
    expect(text).toBe('say hi now');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 4, length: 2 }]);
  });

  it('handles multiple styles with correct offsets', () => {
    const { text, textStyle } = parseSignalStyles('**bold** and *italic*');
    expect(text).toBe('bold and italic');
    expect(textStyle[0]).toEqual({ style: 'BOLD', start: 0, length: 4 });
    expect(textStyle[1]).toEqual({ style: 'ITALIC', start: 9, length: 6 });
  });

  it('strips link markers, no style applied', () => {
    const { text, textStyle } = parseSignalStyles(
      '[Click here](https://example.com)',
    );
    expect(text).toBe('Click here (https://example.com)');
    expect(textStyle).toHaveLength(0);
  });

  it('strips horizontal rules', () => {
    const { text, textStyle } = parseSignalStyles('above\n---\nbelow');
    expect(text).toBe('above\nbelow');
    expect(textStyle).toHaveLength(0);
  });
});

describe('parseSignalStyles — code block protection', () => {
  it('protects fenced code block content with MONOSPACE', () => {
    const input = '```\n**not bold**\n```';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toBe('**not bold**');
    expect(textStyle).toEqual([{ style: 'MONOSPACE', start: 0, length: 12 }]);
  });

  it('styles outside block are still processed', () => {
    const input = '**bold**\n```\nraw code\n```';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toContain('bold');
    expect(text).toContain('raw code');
    const boldStyle = textStyle.find((s) => s.style === 'BOLD');
    const codeStyle = textStyle.find((s) => s.style === 'MONOSPACE');
    expect(boldStyle).toBeDefined();
    expect(codeStyle).toBeDefined();
  });
});

describe('parseSignalStyles — snake_case guard', () => {
  it('does not italicise underscores in snake_case', () => {
    const { text, textStyle } = parseSignalStyles('use snake_case_here');
    expect(text).toBe('use snake_case_here');
    expect(textStyle).toHaveLength(0);
  });
});

describe('formatOutbound — channel-aware', () => {
  it('applies parseTextStyles when channel is provided', () => {
    expect(formatOutbound('**bold**', 'whatsapp')).toBe('*bold*');
  });

  it('returns plain stripped text when no channel provided', () => {
    expect(formatOutbound('**bold**')).toBe('**bold**');
  });

  it('strips internal tags then applies channel formatting', () => {
    expect(
      formatOutbound('<internal>thinking</internal>**done**', 'telegram'),
    ).toBe('*done*');
  });

  it('signal channel is passthrough — raw markdown preserved for parseSignalStyles', () => {
    expect(formatOutbound('**bold**', 'signal')).toBe('**bold**');
  });
});

// --- Regression tests: router.ts hardening ---

import { routeOutbound, findChannel } from './router.js';
import { Channel } from './types.js';

// ---------------------------------------------------------------------------
// Regression guard for the bypass-fix audit (2026-05-19).
//
// Six call sites in src/index.ts that used to call channel.sendMessage(jid, text)
// directly now wrap with formatOutbound(text, channel.name as ChannelType).
// We can't easily unit-test those exact call sites without booting the full
// message loop, but we CAN lock in the runtime contract: when a caller follows
// the documented pattern, raw Claude markdown arrives at the channel transformed.
//
// If any of those wraps gets removed, the pattern would still work in isolation
// here — but the in-channel transforms (sendPoolMessage, sendFile) are guarded
// by tests in src/channels/telegram.test.ts. Together they cover both halves of
// the one-transform invariant documented in docs/REQUIREMENTS.md.
// ---------------------------------------------------------------------------

describe('formatOutbound + channel.sendMessage pattern (audit regression guard)', () => {
  it('agent streaming reply pattern: raw Claude markdown → telegram-v1 at channel', async () => {
    const ch = makeMockChannel('telegram', ['tg:1']);
    const raw =
      '## Project Apollo\n\n**Status:** *on track*\n\nNext: review PR #42';
    const formatted = formatOutbound(raw, ch.name as ChannelType);
    if (formatted) await ch.sendMessage('tg:1', formatted);

    const sent = (ch as Channel & { _sent: { jid: string; text: string }[] })
      ._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('*Project Apollo*');
    expect(sent[0].text).toContain('*Status:*');
    expect(sent[0].text).toContain('_on track_');
    expect(sent[0].text).not.toContain('**');
    expect(sent[0].text).not.toContain('## ');
  });

  it('strips <internal> blocks before transforming (agent reasoning never reaches channel)', async () => {
    const ch = makeMockChannel('telegram', ['tg:1']);
    const raw = '<internal>weighing options...</internal>**Result:** ship it';
    const formatted = formatOutbound(raw, ch.name as ChannelType);
    if (formatted) await ch.sendMessage('tg:1', formatted);

    const sent = (ch as Channel & { _sent: { jid: string; text: string }[] })
      ._sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('*Result:* ship it');
    expect(sent[0].text).not.toContain('<internal>');
    expect(sent[0].text).not.toContain('weighing options');
  });

  it('empty payload (all-internal) is suppressed, no send occurs', async () => {
    const ch = makeMockChannel('telegram', ['tg:1']);
    const raw = '<internal>private thought, no user-visible reply</internal>';
    const formatted = formatOutbound(raw, ch.name as ChannelType);
    if (formatted) await ch.sendMessage('tg:1', formatted);

    const sent = (ch as Channel & { _sent: { jid: string; text: string }[] })
      ._sent;
    expect(sent).toHaveLength(0);
  });
});

function makeMockChannel(
  name: string,
  ownedJids: string[],
  connected = true,
): Channel {
  const sent: { jid: string; text: string }[] = [];
  return {
    name,
    connect: async () => {},
    sendMessage: async (jid: string, text: string) => {
      sent.push({ jid, text });
    },
    isConnected: () => connected,
    ownsJid: (jid: string) => ownedJids.includes(jid),
    disconnect: async () => {},
    _sent: sent,
  } as Channel & { _sent: typeof sent };
}

describe('escapeXml — OWASP-relevant edge cases', () => {
  it('handles single quotes (apostrophes) in attribute context', () => {
    // Single quotes are safe when attributes use double quotes (which formatMessages does),
    // but escapeXml should at minimum not corrupt them
    const result = escapeXml("it's a test");
    expect(result).toContain("'"); // single quotes pass through (attributes use double quotes)
  });

  it('returns empty string for null/undefined input (falsy guard)', () => {
    expect(escapeXml(null as unknown as string)).toBe('');
    expect(escapeXml(undefined as unknown as string)).toBe('');
  });

  it('handles strings with only special characters', () => {
    expect(escapeXml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });

  it('handles very long strings without stack overflow', () => {
    const longStr = '<'.repeat(10000);
    const result = escapeXml(longStr);
    expect(result).toBe('&lt;'.repeat(10000));
  });

  it('does not double-escape already-escaped entities', () => {
    // If input already has &amp; it should become &amp;amp;
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });
});

describe('formatMessages — edge cases', () => {
  it('handles empty content gracefully', () => {
    const result = formatMessages([makeMsg({ content: '' })], 'UTC');
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('></message>'); // empty content between tags
  });

  it('handles very long content without truncation', () => {
    const longContent = 'x'.repeat(50000);
    const result = formatMessages([makeMsg({ content: longContent })], 'UTC');
    expect(result).toContain(longContent);
  });

  it('handles messages with only whitespace content', () => {
    const result = formatMessages([makeMsg({ content: '   ' })], 'UTC');
    expect(result).toContain('   </message>');
  });

  it('handles reply_to_message_id with special characters', () => {
    const result = formatMessages(
      [makeMsg({ reply_to_message_id: 'id<with>&"special' })],
      'UTC',
    );
    expect(result).toContain('reply_to="id&lt;with&gt;&amp;&quot;special"');
  });
});

describe('stripInternalTags — malformed and nested', () => {
  it('handles unclosed internal tag (no match, text preserved)', () => {
    expect(stripInternalTags('hello <internal>unclosed')).toBe(
      'hello <internal>unclosed',
    );
  });

  it('handles nested internal tags (greedy inner match)', () => {
    const input =
      '<internal>outer<internal>inner</internal>still</internal>visible';
    const result = stripInternalTags(input);
    // The non-greedy [\s\S]*? will match the first closing tag
    expect(result).toContain('visible');
  });

  it('handles internal tags with attributes (does not match)', () => {
    // <internal foo="bar"> is NOT <internal> — regex requires exact tag
    const input = '<internal foo="bar">secret</internal>';
    expect(stripInternalTags(input)).toBe(input.trim());
  });

  it('handles empty internal tags', () => {
    expect(stripInternalTags('hello <internal></internal> world')).toBe(
      'hello  world',
    );
  });

  it('preserves text when no internal tags present', () => {
    expect(stripInternalTags('just normal text')).toBe('just normal text');
  });
});

describe('formatOutbound — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(formatOutbound('')).toBe('');
  });

  it('returns empty string for whitespace-only after stripping tags', () => {
    expect(formatOutbound('<internal>hidden</internal>   ')).toBe('');
  });

  it('applies formatting for all known channel types', () => {
    const channels: Array<{
      type: ChannelType;
      input: string;
      expected: string;
    }> = [
      { type: 'whatsapp', input: '**bold**', expected: '*bold*' },
      { type: 'telegram', input: '**bold**', expected: '*bold*' },
      { type: 'slack', input: '**bold**', expected: '*bold*' },
      { type: 'discord', input: '**bold**', expected: '**bold**' },
      { type: 'signal', input: '**bold**', expected: '**bold**' },
    ];
    for (const { type, input, expected } of channels) {
      expect(formatOutbound(input, type)).toBe(expected);
    }
  });
});

describe('routeOutbound — channel routing', () => {
  it('throws when no channel owns the JID', () => {
    const ch = makeMockChannel('telegram', ['tg:123']);
    expect(() => routeOutbound([ch], 'unknown:999', 'hello')).toThrow(
      'No channel for JID: unknown:999',
    );
  });

  it('throws when channel owns JID but is disconnected', () => {
    const ch = makeMockChannel('telegram', ['tg:123'], false);
    expect(() => routeOutbound([ch], 'tg:123', 'hello')).toThrow(
      'No channel for JID: tg:123',
    );
  });

  it('routes to the correct channel when multiple exist', async () => {
    const ch1 = makeMockChannel('telegram', ['tg:123']) as Channel & {
      _sent: { jid: string; text: string }[];
    };
    const ch2 = makeMockChannel('whatsapp', ['wa:456']) as Channel & {
      _sent: { jid: string; text: string }[];
    };
    await routeOutbound([ch1, ch2], 'wa:456', 'hello');
    expect(ch1._sent).toHaveLength(0);
    expect(ch2._sent).toHaveLength(1);
    expect(ch2._sent[0]).toEqual({ jid: 'wa:456', text: 'hello' });
  });

  it('throws with empty channel list', () => {
    expect(() => routeOutbound([], 'tg:123', 'hello')).toThrow(
      'No channel for JID: tg:123',
    );
  });
});

describe('findChannel — lookup edge cases', () => {
  it('returns undefined when no channels exist', () => {
    expect(findChannel([], 'tg:123')).toBeUndefined();
  });

  it('returns undefined when no channel owns the JID', () => {
    const ch = makeMockChannel('telegram', ['tg:123']);
    expect(findChannel([ch], 'tg:999')).toBeUndefined();
  });

  it('returns the first matching channel', () => {
    const ch1 = makeMockChannel('telegram', ['tg:123']);
    const ch2 = makeMockChannel('telegram2', ['tg:123']); // duplicate
    const result = findChannel([ch1, ch2], 'tg:123');
    expect(result?.name).toBe('telegram');
  });

  it('finds channel regardless of connection status', () => {
    const ch = makeMockChannel('telegram', ['tg:123'], false);
    // findChannel does NOT check isConnected (unlike routeOutbound)
    expect(findChannel([ch], 'tg:123')).toBeDefined();
    expect(findChannel([ch], 'tg:123')?.name).toBe('telegram');
  });
});
