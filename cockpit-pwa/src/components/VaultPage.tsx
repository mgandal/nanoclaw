import { useState, useEffect } from 'preact/hooks';
import type { VaultNode } from '../types.js';
// Lazy-loaded: renderMarkdown pulls in markdown-it + highlight.js, ~100 KB gzip.
// Defer until a user actually visits a vault page to keep the home-route bundle lean.

interface Props {
  slug: string;
  tree: VaultNode;
  origin: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; html: string };

// Safety note on dangerouslySetInnerHTML below: renderMarkdown() wraps
// markdown-it with `html: false`, so raw HTML in vault bodies is escaped,
// not passed through. The only HTML-emitting sites are our own plugin
// (escaped broken-link span + escaped frontmatter pre) and highlight.js
// (trusted library output). No untrusted HTML reaches innerHTML.
export function VaultPage({ slug, tree, origin }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    setState({ status: 'loading' });
    let cancelled = false;
    (async () => {
      try {
        const url = `${origin}/data/pages/${slug}.md`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', message: `Could not load page (HTTP ${res.status}).` });
          return;
        }
        const md = await res.text();
        const { renderMarkdown } = await import('../lib/render-markdown.js');
        const html = renderMarkdown(md, tree);
        if (!cancelled) setState({ status: 'ready', html });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', message: `Could not load page: ${String(err)}` });
      }
    })();
    return () => { cancelled = true; };
  }, [slug, origin, tree]);

  if (state.status === 'loading') return <p class="vault-page loading">Loading…</p>;
  if (state.status === 'error') return <p class="vault-page error">{state.message}</p>;
  return <article class="vault-page" dangerouslySetInnerHTML={{ __html: state.html }} />;
}
