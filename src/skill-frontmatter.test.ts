import { describe, it, expect } from 'vitest';

import { frontmatterDeclaresBash } from './skill-frontmatter.js';

describe('frontmatterDeclaresBash', () => {
  it('returns false when there is no frontmatter block', () => {
    expect(frontmatterDeclaresBash('# A skill\nNo frontmatter here.')).toBe(
      false,
    );
  });

  it('returns false when frontmatter has no allowed-tools key', () => {
    const content = `---
name: harmless
description: just reads files
---

# Body`;
    expect(frontmatterDeclaresBash(content)).toBe(false);
  });

  // Forms the original regex caught.

  it('detects flow-style array containing Bash', () => {
    const content = `---
allowed-tools: [Read, Bash]
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  it('detects single-line comma-separated string with Bash', () => {
    const content = `---
allowed-tools: Bash, Read, Grep
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  it('detects single-line space-separated string with Bash', () => {
    const content = `---
allowed-tools: Read Bash Glob Grep
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  it('detects Bash with parens-pattern arguments', () => {
    const content = `---
allowed-tools: Bash(curl:*), Bash(yt-dlp:*), Read
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  it('detects Bash(*) wildcard pattern', () => {
    const content = `---
allowed-tools: Bash(*), Read
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  // Forms the original regex MISSED — these are the bypass tests.

  it('detects multi-line YAML list with Bash on its own line', () => {
    const content = `---
name: backdoor
allowed-tools:
  - Read
  - Bash
  - Grep
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  it('detects multi-line YAML list with Bash(pattern)', () => {
    const content = `---
allowed-tools:
  - Bash(rm -rf:*)
  - Read
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  it('detects YAML block-string allowed-tools containing Bash', () => {
    const content = `---
allowed-tools: |
  Read
  Bash
  Grep
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  it('detects JSON-like flow array string', () => {
    const content = `---
allowed-tools: ["Bash", "Read"]
---`;
    expect(frontmatterDeclaresBash(content)).toBe(true);
  });

  // Cleanly should-not-match cases (avoid false positives).

  it('does not match Bash inside the description field', () => {
    const content = `---
name: documentation
description: This skill explains how Bash works in Claude Code.
allowed-tools: [Read, Grep]
---`;
    expect(frontmatterDeclaresBash(content)).toBe(false);
  });

  it('does not match Bash inside other unrelated keys', () => {
    const content = `---
name: helper
notes: |
  Use Bash sparingly. Prefer Read.
allowed-tools: Read
---`;
    expect(frontmatterDeclaresBash(content)).toBe(false);
  });

  it('does not match a tool whose name happens to contain "bash" as a substring', () => {
    const content = `---
allowed-tools: BashfulTool
---`;
    // BashfulTool is not Bash — must not be a false positive
    expect(frontmatterDeclaresBash(content)).toBe(false);
  });

  it('does not match a markdown code fence in the body', () => {
    const content = `---
allowed-tools: Read
---

# Body

\`\`\`bash
echo "this is just a code fence"
\`\`\``;
    expect(frontmatterDeclaresBash(content)).toBe(false);
  });

  // Robustness — must never throw or hang on adversarial input.

  it('returns false on malformed YAML (does not throw)', () => {
    const content = `---
allowed-tools: [unclosed
---`;
    expect(() => frontmatterDeclaresBash(content)).not.toThrow();
  });

  it('returns false on empty frontmatter', () => {
    const content = `---
---

# Body`;
    expect(frontmatterDeclaresBash(content)).toBe(false);
  });

  it('returns false on frontmatter with only allowed-tools null', () => {
    const content = `---
allowed-tools:
---`;
    expect(frontmatterDeclaresBash(content)).toBe(false);
  });
});
