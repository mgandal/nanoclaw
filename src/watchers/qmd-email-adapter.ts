import fs from 'fs';
import path from 'path';
import type {
  QmdEmailClient,
  ThreadMessage,
} from './thread-silence-watcher.js';

export class QmdEmailAdapter implements QmdEmailClient {
  constructor(private dir: string) {}

  async queryThreads(): Promise<
    { threadId: string; messages: ThreadMessage[] }[]
  > {
    if (!fs.existsSync(this.dir)) return [];
    const files = this.walkMarkdownFiles(this.dir);
    const byThread = new Map<string, ThreadMessage[]>();
    for (const f of files) {
      const fm = parseFrontmatter(fs.readFileSync(f, 'utf-8'));
      if (!fm.thread_id || !fm.direction) continue;
      const list = byThread.get(fm.thread_id) ?? [];
      list.push({
        direction: fm.direction as 'inbound' | 'outbound',
        from: fm.from || '',
        subject: fm.subject || '',
        timestamp: fm.timestamp || fm.date || '',
      });
      byThread.set(fm.thread_id, list);
    }
    return Array.from(byThread.entries()).map(([threadId, messages]) => ({
      threadId,
      messages,
    }));
  }

  private walkMarkdownFiles(dir: string): string[] {
    const out: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...this.walkMarkdownFiles(full));
      else if (e.name.endsWith('.md')) out.push(full);
    }
    return out;
  }
}

function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const ix = line.indexOf(':');
    if (ix < 0) continue;
    const k = line.slice(0, ix).trim();
    let v = line.slice(ix + 1).trim();
    // Strip surrounding quotes (single or double) if present and matched.
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}
