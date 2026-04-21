import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import type { VaultNode } from '../types.js';
import { resolveWikilink } from './wikilink.js';

/**
 * Render vault markdown to HTML. Handles:
 *   - YAML frontmatter → collapsible <details> block
 *   - [[wikilink]] → resolved <a> or broken-link <span>
 *   - fenced code → highlight.js-highlighted <pre><code>
 *   - everything else → markdown-it defaults
 *
 * Kept as a pure function taking vault_tree so the tree-resolution step
 * can be unit-tested without any DOM.
 */
export function renderMarkdown(source: string, vaultTree: VaultNode): string {
  const { frontmatter, body } = extractFrontmatter(source);
  const md = new MarkdownIt({
    html: false,  // untrusted vault content; never allow raw HTML
    linkify: true,
    typographer: false,
    highlight: (str, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre><code class="hljs language-${lang}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
        } catch {
          // fall through
        }
      }
      return `<pre><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`;
    },
  });

  installWikilinkPlugin(md, vaultTree);

  const bodyHtml = md.render(body);
  if (frontmatter !== null) {
    const escaped = md.utils.escapeHtml(frontmatter);
    return `<details class="frontmatter"><summary>frontmatter</summary><pre>${escaped}</pre></details>\n${bodyHtml}`;
  }
  return bodyHtml;
}

function extractFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: source };
  return { frontmatter: match[1], body: match[2] };
}

function installWikilinkPlugin(md: MarkdownIt, tree: VaultNode): void {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const pos = state.pos;
    if (state.src.charCodeAt(pos) !== 0x5b /* [ */) return false;
    if (state.src.charCodeAt(pos + 1) !== 0x5b /* [ */) return false;

    const close = state.src.indexOf(']]', pos + 2);
    if (close === -1) return false;

    const target = state.src.slice(pos + 2, close).trim();
    if (target.length === 0) return false;
    if (target.includes('\n')) return false;

    if (!silent) {
      const slug = resolveWikilink(target, tree);
      if (slug) {
        const open = state.push('link_open', 'a', 1);
        open.attrs = [['href', `/vault/${slug}`], ['class', 'wikilink']];
        const text = state.push('text', '', 0);
        text.content = target;
        state.push('link_close', 'a', -1);
      } else {
        const open = state.push('html_inline', '', 0);
        open.content = `<span class="broken-link">${md.utils.escapeHtml(target)}</span>`;
      }
    }
    state.pos = close + 2;
    return true;
  });
}
