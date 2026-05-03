import YAML from 'yaml';

/**
 * Inspect a SKILL.md body and return true if its frontmatter declares Bash
 * as an allowed tool. Used by both A2 (group skill sync — `container-runner.ts`)
 * and A4 (`save_skill` IPC — `ipc.ts`) to keep agent-supplied skills from
 * silently importing arbitrary shell execution.
 *
 * The Claude Code `allowed-tools` field is informally typed: it appears in
 * SKILL.md files in at least five distinct forms across this repo and the
 * plugin cache:
 *   - flow array:        `allowed-tools: [Read, Bash]`
 *   - JSON-like array:   `allowed-tools: ["Bash"]`
 *   - comma string:      `allowed-tools: Bash, Read, Grep`
 *   - space string:      `allowed-tools: Read Bash Glob Grep`
 *   - parens patterns:   `allowed-tools: Bash(curl:*), Bash(yt-dlp:*)`
 *   - multi-line list:   `allowed-tools:\n  - Read\n  - Bash`
 *   - block string:      `allowed-tools: |\n  Read\n  Bash`
 *
 * The previous A2/A4 implementation used a single-line regex and missed the
 * multi-line and block-string forms, allowing a Bash-using skill through.
 *
 * Approach: parse the frontmatter as YAML, extract the `allowed-tools` value,
 * normalize it into a flat list of token strings (split on whitespace and
 * commas), then check each token for an exact-word `Bash` match (with optional
 * `(...)` arguments). Returns false on any parse failure — fail-closed for the
 * security check is correct (skill is rejected) but for backward compatibility
 * with the existing usage we return false (skill is allowed) on parse failures
 * and let other validators catch malformed YAML. Callers that want fail-closed
 * semantics on parse error should add their own try/catch.
 */
export function frontmatterDeclaresBash(content: string): boolean {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  let parsed: unknown;
  try {
    parsed = YAML.parse(fmMatch[1]);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;

  const value = (parsed as Record<string, unknown>)['allowed-tools'];
  if (value == null) return false;

  const tokens = normalizeAllowedTools(value);
  return tokens.some(isBashTool);
}

/**
 * Reduce any of the YAML-shaped `allowed-tools` values to a flat list of
 * tool-name tokens.
 *
 * For top-level strings, split on whitespace AND commas — string values
 * carry their own delimiters: `Bash, Read, Grep` or `Read Bash Glob`.
 *
 * For arrays, trust YAML's tokenization. Each item is already a single
 * tool string and may legitimately contain spaces inside parens, e.g.
 * `Bash(rm -rf:*)` or `Bash(npm install:*)`. Re-splitting would
 * fragment those into invalid tokens.
 */
function normalizeAllowedTools(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

/**
 * A token names the Bash tool iff it is exactly `Bash` (case-insensitive)
 * with optional `(...)` argument-pattern suffix. Substring matches like
 * `BashfulTool` must not trigger.
 */
function isBashTool(token: string): boolean {
  return /^bash(\(.*\))?$/i.test(token);
}
