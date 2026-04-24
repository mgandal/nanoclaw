# PageIndex Integration Implementation Plan

> **Status: SHIPPED.** `src/pageindex.ts` (10K) + `src/pageindex-ipc.ts` (4K) live; Python adapter at `scripts/pageindex/adapter.py` runs Claude API via credential proxy. Auto-indexes Telegram PDFs >20 pages; tree JSON cached in vault `.pageindex/` dirs. Test files comprehensive (`pageindex.test.ts` 18K, `pageindex-ipc.test.ts` 10K). Open `- [ ]` boxes never updated retroactively.

**Goal:** Add hierarchical PDF indexing so agents can navigate long documents by section instead of receiving truncated flat text.

**Architecture:** Host-side TypeScript module (`src/pageindex.ts`) calls a Python adapter (`scripts/pageindex/adapter.py`) that uses Claude API (via credential proxy) to build document trees. Telegram handler auto-indexes PDFs >20 pages. Agents fetch specific page ranges via IPC.

**Tech Stack:** TypeScript (host), Python (PageIndex adapter), vitest (tests), pdfinfo/pdftotext (poppler), Anthropic Python SDK

**Spec:** `docs/superpowers/specs/2026-03-16-pageindex-integration-design.md`

---

## Chunk 1: Core Indexer Module

### Task 1: Page counting and content hashing

**Files:**
- Create: `src/pageindex.ts`
- Create: `src/pageindex.test.ts`

- [ ] **Step 1: Write failing tests for `countPdfPages` and `computeFileHash`**

```typescript
// src/pageindex.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock child_process
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));
vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util');
  return {
    ...actual,
    promisify: () => mockExecFile,
  };
});

describe('countPdfPages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses page count from pdfinfo output', async () => {
    mockExecFile.mockResolvedValue({
      stdout: 'Title: Report\nPages:          87\nCreator: Word',
    });
    const { countPdfPages } = await import('./pageindex.js');
    const count = await countPdfPages('/tmp/test.pdf');
    expect(count).toBe(87);
  });

  it('returns 0 when pdfinfo fails', async () => {
    mockExecFile.mockRejectedValue(new Error('spawn ENOENT'));
    const { countPdfPages } = await import('./pageindex.js');
    const count = await countPdfPages('/tmp/test.pdf');
    expect(count).toBe(0);
  });

  it('returns 0 when output has no Pages line', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'Title: Report\nCreator: Word' });
    const { countPdfPages } = await import('./pageindex.js');
    const count = await countPdfPages('/tmp/test.pdf');
    expect(count).toBe(0);
  });
});

describe('computeFileHash', () => {
  it('returns first 8 chars of sha256 hex digest', async () => {
    const { computeFileHash } = await import('./pageindex.js');
    // sha256 of empty buffer = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = computeFileHash(Buffer.from(''));
    expect(hash).toBe('e3b0c442');
    expect(hash).toHaveLength(8);
  });

  it('produces different hashes for different content', async () => {
    const { computeFileHash } = await import('./pageindex.js');
    const h1 = computeFileHash(Buffer.from('hello'));
    const h2 = computeFileHash(Buffer.from('world'));
    expect(h1).not.toBe(h2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pageindex.test.ts`
Expected: FAIL — module `./pageindex.js` not found

- [ ] **Step 3: Implement `countPdfPages` and `computeFileHash`**

```typescript
// src/pageindex.ts
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const PDFINFO =
  process.platform === 'darwin' ? '/opt/homebrew/bin/pdfinfo' : 'pdfinfo';
const PDFTOTEXT =
  process.platform === 'darwin' ? '/opt/homebrew/bin/pdftotext' : 'pdftotext';

/** Count pages in a PDF using pdfinfo. Returns 0 on failure. */
export async function countPdfPages(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(PDFINFO, [filePath]);
    const match = stdout.match(/Pages:\s+(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to count PDF pages');
    return 0;
  }
}

/** Compute first 8 hex chars of sha256 hash of a buffer. */
export function computeFileHash(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pageindex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pageindex.ts src/pageindex.test.ts
git commit -m "feat(pageindex): add page counting and content hashing"
```

---

### Task 2: Cache lookup and path resolution

**Files:**
- Modify: `src/pageindex.ts`
- Modify: `src/pageindex.test.ts`

- [ ] **Step 1: Write failing tests for cache and path resolution**

Add to `src/pageindex.test.ts`:

```typescript
import fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => '{}'),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      copyFileSync: vi.fn(),
    },
  };
});

describe('findCachedTree', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when .pageindex dir does not exist', async () => {
    (fs.existsSync as any).mockReturnValue(false);
    const { findCachedTree } = await import('./pageindex.js');
    const result = findCachedTree('/vault/00-inbox', 'report.pdf', 'a1b2c3d4');
    expect(result).toBeNull();
  });

  it('returns parsed tree when cache file exists', async () => {
    const tree = { title: 'Test', nodes: [] };
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(tree));
    const { findCachedTree } = await import('./pageindex.js');
    const result = findCachedTree('/vault/00-inbox', 'report.pdf', 'a1b2c3d4');
    expect(result).toEqual(tree);
  });
});

describe('resolveContainerPath', () => {
  it('resolves /workspace/extra/claire-vault/foo.pdf to host path', async () => {
    const { resolveContainerPath } = await import('./pageindex.js');
    const mounts = [
      { hostPath: '/Volumes/sandisk4TB/marvin-vault', containerPath: '/workspace/extra/claire-vault', readonly: false },
    ];
    const result = resolveContainerPath('/workspace/extra/claire-vault/00-inbox/report.pdf', mounts);
    expect(result).toBe('/Volumes/sandisk4TB/marvin-vault/00-inbox/report.pdf');
  });

  it('resolves /workspace/group/file.pdf using group path', async () => {
    const { resolveContainerPath } = await import('./pageindex.js');
    const mounts = [
      { hostPath: '/Users/mgandal/Agents/nanoclaw/groups/main', containerPath: '/workspace/group', readonly: false },
    ];
    const result = resolveContainerPath('/workspace/group/notes.md', mounts);
    expect(result).toBe('/Users/mgandal/Agents/nanoclaw/groups/main/notes.md');
  });

  it('rejects path traversal attempts', async () => {
    const { resolveContainerPath } = await import('./pageindex.js');
    const mounts = [
      { hostPath: '/Volumes/sandisk4TB/marvin-vault', containerPath: '/workspace/extra/claire-vault', readonly: false },
    ];
    const result = resolveContainerPath('/workspace/extra/claire-vault/../../etc/passwd', mounts);
    expect(result).toBeNull();
  });

  it('returns null for unknown mount prefix', async () => {
    const { resolveContainerPath } = await import('./pageindex.js');
    const result = resolveContainerPath('/unknown/path/file.pdf', []);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pageindex.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement cache lookup and path resolution**

Add to `src/pageindex.ts`:

```typescript
import fs from 'fs';
import path from 'path';

export interface PageIndexNode {
  title: string;
  node_id?: string;
  start_index: number;
  end_index: number;
  summary?: string;
  nodes: PageIndexNode[];
}

export interface MountMapping {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/** Look up a cached tree JSON in the vault's .pageindex/ directory. */
export function findCachedTree(
  pdfDir: string,
  pdfName: string,
  hash: string,
): PageIndexNode | null {
  const cacheDir = path.join(pdfDir, '.pageindex');
  const baseName = pdfName.replace(/\.pdf$/i, '');
  const cacheFile = path.join(cacheDir, `${baseName}-${hash}.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  } catch {
    return null;
  }
}

/** Save a tree JSON to the vault's .pageindex/ directory. */
export function saveCachedTree(
  pdfDir: string,
  pdfName: string,
  hash: string,
  tree: PageIndexNode,
): void {
  const cacheDir = path.join(pdfDir, '.pageindex');
  const baseName = pdfName.replace(/\.pdf$/i, '');
  const cacheFile = path.join(cacheDir, `${baseName}-${hash}.json`);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmpFile = `${cacheFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(tree, null, 2));
    fs.renameSync(tmpFile, cacheFile);
  } catch (err) {
    logger.warn({ pdfDir, err }, 'Failed to save PageIndex cache (proceeding without cache)');
  }
}

/**
 * Resolve a container path to a host path using mount mappings.
 * Returns null if path cannot be resolved or fails security validation.
 */
export function resolveContainerPath(
  containerPath: string,
  mounts: MountMapping[],
): string | null {
  for (const mount of mounts) {
    if (containerPath.startsWith(mount.containerPath + '/') || containerPath === mount.containerPath) {
      const relative = containerPath.slice(mount.containerPath.length).replace(/^\//, '');
      const resolved = path.resolve(mount.hostPath, relative);
      // Security: verify resolved path is still under the mount root
      // Use separator-safe check to prevent /Volumes/vault-evil matching /Volumes/vault
      if (!resolved.startsWith(mount.hostPath + '/') && resolved !== mount.hostPath) {
        return null; // path traversal attempt
      }
      return resolved;
    }
  }
  return null; // no matching mount
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pageindex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pageindex.ts src/pageindex.test.ts
git commit -m "feat(pageindex): add cache lookup and secure path resolution"
```

---

### Task 3: Flat text extraction and page-range fetch

**Files:**
- Modify: `src/pageindex.ts`
- Modify: `src/pageindex.test.ts`

- [ ] **Step 1: Write failing tests for `extractFlatText` and `fetchPageRange`**

Add to `src/pageindex.test.ts`:

```typescript
describe('extractFlatText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns extracted text from pdftotext', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'Hello world from PDF' });
    const { extractFlatText } = await import('./pageindex.js');
    const text = await extractFlatText('/tmp/test.pdf');
    expect(text).toBe('Hello world from PDF');
  });

  it('returns empty string on failure', async () => {
    mockExecFile.mockRejectedValue(new Error('spawn ENOENT'));
    const { extractFlatText } = await import('./pageindex.js');
    const text = await extractFlatText('/tmp/test.pdf');
    expect(text).toBe('');
  });
});

describe('fetchPageRange', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extracts specific page range', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'Page 3 content\nPage 4 content' });
    const { fetchPageRange } = await import('./pageindex.js');
    const text = await fetchPageRange('/tmp/test.pdf', 3, 4);
    expect(text).toBe('Page 3 content\nPage 4 content');
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringContaining('pdftotext'),
      ['-f', '3', '-l', '4', '-layout', '/tmp/test.pdf', '-'],
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pageindex.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement `extractFlatText` and `fetchPageRange`**

Add to `src/pageindex.ts`:

```typescript
/** Extract all text from a PDF using pdftotext. Returns empty string on failure. */
export async function extractFlatText(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT, ['-layout', filePath, '-']);
    return stdout;
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to extract PDF text');
    return '';
  }
}

/** Extract text from a specific page range. Returns empty string on failure. */
export async function fetchPageRange(
  filePath: string,
  startPage: number,
  endPage: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT, [
      '-f', String(startPage),
      '-l', String(endPage),
      '-layout',
      filePath,
      '-',
    ]);
    return stdout;
  } catch (err) {
    logger.warn({ filePath, startPage, endPage, err }, 'Failed to extract page range');
    return '';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pageindex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pageindex.ts src/pageindex.test.ts
git commit -m "feat(pageindex): add flat text extraction and page range fetch"
```

---

### Task 4: `indexPdf()` — main orchestrator with fallback

**Files:**
- Modify: `src/pageindex.ts`
- Modify: `src/pageindex.test.ts`

- [ ] **Step 1: Write failing tests for `indexPdf`**

Add to `src/pageindex.test.ts`:

```typescript
// Mock config
vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test',
}));

describe('indexPdf', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns fallback for PDFs with ≤20 pages', async () => {
    // pdfinfo returns 15 pages
    mockExecFile.mockImplementation((...args: any[]) => {
      const bin = args[0] as string;
      if (bin.includes('pdfinfo')) return Promise.resolve({ stdout: 'Pages:          15' });
      if (bin.includes('pdftotext')) return Promise.resolve({ stdout: 'flat text content' });
      return Promise.reject(new Error('unexpected'));
    });
    const { indexPdf } = await import('./pageindex.js');
    const result = await indexPdf('/tmp/test.pdf', 'test.pdf');
    expect(result.success).toBe(false);
    expect(result.fallbackText).toBe('flat text content');
  });

  it('returns fallback for PDFs with >500 pages', async () => {
    mockExecFile.mockImplementation((...args: any[]) => {
      const bin = args[0] as string;
      if (bin.includes('pdfinfo')) return Promise.resolve({ stdout: 'Pages:          600' });
      if (bin.includes('pdftotext')) return Promise.resolve({ stdout: 'flat text' });
      return Promise.reject(new Error('unexpected'));
    });
    const { indexPdf } = await import('./pageindex.js');
    const result = await indexPdf('/tmp/test.pdf', 'test.pdf');
    expect(result.success).toBe(false);
    expect(result.fallbackText).toBe('flat text');
  });

  it('returns cached tree when available', async () => {
    const tree = { title: 'Cached', start_index: 1, end_index: 30, nodes: [] };
    mockExecFile.mockImplementation((...args: any[]) => {
      const bin = args[0] as string;
      if (bin.includes('pdfinfo')) return Promise.resolve({ stdout: 'Pages:          30' });
      return Promise.reject(new Error('unexpected'));
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(tree));
    const { indexPdf } = await import('./pageindex.js');
    const result = await indexPdf('/tmp/test.pdf', 'test.pdf', { vaultDir: '/vault/00-inbox' });
    expect(result.success).toBe(true);
    expect(result.tree).toEqual(tree);
    expect(result.pageCount).toBe(30);
  });

  it('falls back to flat text when adapter subprocess fails', async () => {
    mockExecFile.mockImplementation((...args: any[]) => {
      const bin = args[0] as string;
      if (bin.includes('pdfinfo')) return Promise.resolve({ stdout: 'Pages:          30' });
      if (bin.includes('pdftotext')) return Promise.resolve({ stdout: 'fallback text' });
      // Python adapter fails
      if (bin.includes('python') || bin.includes('venv')) return Promise.reject(new Error('adapter crashed'));
      return Promise.reject(new Error('unexpected'));
    });
    (fs.existsSync as any).mockReturnValue(false);
    const { indexPdf } = await import('./pageindex.js');
    const result = await indexPdf('/tmp/test.pdf', 'test.pdf');
    expect(result.success).toBe(false);
    expect(result.fallbackText).toBe('fallback text');
    expect(result.error).toContain('adapter crashed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pageindex.test.ts`
Expected: FAIL — `indexPdf` not exported

- [ ] **Step 3: Implement `indexPdf`**

Add to `src/pageindex.ts`:

```typescript
import { CREDENTIAL_PROXY_PORT } from './config.js';

const ADAPTER_SCRIPT = path.join(
  process.cwd(),
  'scripts',
  'pageindex',
  'adapter.py',
);
const ADAPTER_VENV_PYTHON = path.join(
  process.cwd(),
  'scripts',
  'pageindex',
  'venv',
  'bin',
  'python3',
);

const PAGE_THRESHOLD = 20;
const MAX_PAGES = 500;
const ADAPTER_TIMEOUT = 90_000;

export interface IndexResult {
  success: boolean;
  tree?: PageIndexNode;
  pageCount?: number;
  fallbackText?: string;
  error?: string;
}

export interface IndexOptions {
  /** Directory in vault where the PDF lives (for cache lookup/save). */
  vaultDir?: string;
  /** Pre-computed content hash. If not provided, file is read to compute it. */
  contentHash?: string;
  /** Pre-read file buffer. If not provided, file is read from disk. */
  fileBuffer?: Buffer;
}

/**
 * Index a PDF into a hierarchical tree. Never throws.
 * Returns {success: true, tree} or {success: false, fallbackText, error}.
 */
export async function indexPdf(
  filePath: string,
  fileName: string,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  try {
    // Count pages
    const pageCount = await countPdfPages(filePath);
    if (pageCount === 0 || pageCount <= PAGE_THRESHOLD) {
      const fallbackText = await extractFlatText(filePath);
      return { success: false, fallbackText, pageCount: pageCount || undefined };
    }
    if (pageCount > MAX_PAGES) {
      logger.warn({ fileName, pageCount }, 'PDF exceeds 500 pages, skipping indexing');
      const fallbackText = await extractFlatText(filePath);
      return { success: false, fallbackText, pageCount, error: `PDF has ${pageCount} pages (max ${MAX_PAGES})` };
    }

    // Compute hash for cache
    const fileBuffer = opts.fileBuffer ?? fs.readFileSync(filePath);
    const hash = opts.contentHash ?? computeFileHash(fileBuffer);

    // Check cache
    if (opts.vaultDir) {
      const cached = findCachedTree(opts.vaultDir, fileName, hash);
      if (cached) {
        logger.info({ fileName, hash }, 'PageIndex cache hit');
        return { success: true, tree: cached, pageCount };
      }
    }

    // Run adapter
    try {
      const { stdout } = await execFileAsync(ADAPTER_VENV_PYTHON, [ADAPTER_SCRIPT, filePath], {
        timeout: ADAPTER_TIMEOUT,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://localhost:${CREDENTIAL_PROXY_PORT}`,
          ANTHROPIC_API_KEY: 'placeholder',
        },
      });
      const tree: PageIndexNode = JSON.parse(stdout);

      // Save to cache
      if (opts.vaultDir) {
        saveCachedTree(opts.vaultDir, fileName, hash, tree);
      }

      logger.info({ fileName, pageCount, hash }, 'PDF indexed successfully');
      return { success: true, tree, pageCount };
    } catch (adapterErr: any) {
      logger.warn({ fileName, err: adapterErr.message }, 'PageIndex adapter failed, falling back to flat extraction');
      const fallbackText = await extractFlatText(filePath);
      return { success: false, fallbackText, pageCount, error: `Indexing failed: ${adapterErr.message}` };
    }
  } catch (err: any) {
    logger.error({ fileName, err: err.message }, 'indexPdf unexpected error');
    return { success: false, fallbackText: '', error: err.message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pageindex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pageindex.ts src/pageindex.test.ts
git commit -m "feat(pageindex): add indexPdf orchestrator with fallback chain"
```

---

## Chunk 2: Python Adapter

### Task 5: Python adapter setup and scaffold

**Files:**
- Create: `scripts/pageindex/requirements.txt`
- Create: `scripts/pageindex/adapter.py`
- Modify: `package.json` (add setup:pageindex script)

- [ ] **Step 1: Create requirements.txt**

```
anthropic>=0.40.0
pymupdf>=1.25.0
tiktoken>=0.8.0
pyyaml>=6.0.2
```

- [ ] **Step 2: Create adapter.py scaffold**

```python
#!/usr/bin/env python3
"""
PageIndex adapter for NanoClaw.
Builds a hierarchical tree from a PDF using Claude API.
Outputs tree JSON to stdout. Exits non-zero on failure.

Usage: python3 adapter.py <pdf_path>

Environment:
  ANTHROPIC_BASE_URL — credential proxy URL (e.g., http://localhost:3001)
  ANTHROPIC_API_KEY — placeholder (proxy injects real credentials)
"""
import json
import os
import sys

import anthropic
import fitz  # pymupdf


def extract_pages(pdf_path: str) -> list[str]:
    """Extract text content per page from a PDF."""
    doc = fitz.open(pdf_path)
    pages = []
    for page in doc:
        pages.append(page.get_text())
    doc.close()
    return pages


def detect_toc(pages: list[str], client: anthropic.Anthropic, model: str) -> dict | None:
    """Ask Claude to detect and extract a table of contents from the first 20 pages."""
    first_pages = "\n\n---PAGE BREAK---\n\n".join(pages[:20])
    resp = client.messages.create(
        model=model,
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": (
                "Analyze the following document pages and extract the table of contents "
                "as a hierarchical JSON structure. Each node should have: title, start_index "
                "(1-based page number), and nodes (child sections). If there is no clear table "
                "of contents, infer the document structure from headings and section breaks.\n\n"
                "Return ONLY valid JSON, no markdown fences.\n\n"
                f"Document text (first 20 pages):\n\n{first_pages}"
            ),
        }],
    )
    text = resp.content[0].text.strip()
    # Strip markdown fences if present
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
    if text.endswith("```"):
        text = text.rsplit("\n", 1)[0]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def add_end_indices(node: dict, total_pages: int) -> None:
    """Fill in end_index for each node based on next sibling's start_index."""
    children = node.get("nodes", [])
    for i, child in enumerate(children):
        if "end_index" not in child or child["end_index"] is None:
            if i + 1 < len(children):
                child["end_index"] = children[i + 1]["start_index"] - 1
            else:
                child["end_index"] = node.get("end_index", total_pages)
        add_end_indices(child, total_pages)


def add_summaries(node: dict, pages: list[str], client: anthropic.Anthropic, model: str) -> None:
    """Add summaries to leaf nodes and nodes without summaries."""
    if node.get("summary"):
        for child in node.get("nodes", []):
            add_summaries(child, pages, client, model)
        return

    start = max(0, node.get("start_index", 1) - 1)
    end = min(len(pages), node.get("end_index", len(pages)))
    section_text = "\n".join(pages[start:end])[:8000]  # Limit to ~8K chars

    if not section_text.strip():
        node["summary"] = "(empty section)"
        return

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=200,
            messages=[{
                "role": "user",
                "content": f"Summarize this document section in 1-2 sentences:\n\n{section_text}",
            }],
        )
        node["summary"] = resp.content[0].text.strip()
    except Exception:
        node["summary"] = f"Pages {node.get('start_index', '?')}-{node.get('end_index', '?')}"

    for child in node.get("nodes", []):
        add_summaries(child, pages, client, model)


def build_tree(pdf_path: str) -> dict:
    """Build a hierarchical tree from a PDF."""
    client = anthropic.Anthropic()  # Uses ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from env
    model = "claude-sonnet-4-6"  # Use Sonnet for cost efficiency

    pages = extract_pages(pdf_path)
    total_pages = len(pages)

    if total_pages == 0:
        print("Error: PDF has no extractable text", file=sys.stderr)
        sys.exit(1)

    # Detect structure
    toc = detect_toc(pages, client, model)
    if toc is None:
        # Fallback: create a flat structure with chunks of 10 pages
        toc = {
            "title": os.path.basename(pdf_path),
            "start_index": 1,
            "end_index": total_pages,
            "nodes": [],
        }
        for i in range(0, total_pages, 10):
            start = i + 1
            end = min(i + 10, total_pages)
            toc["nodes"].append({
                "title": f"Pages {start}-{end}",
                "start_index": start,
                "end_index": end,
                "nodes": [],
            })

    # Ensure root has bounds
    if "start_index" not in toc:
        toc["start_index"] = 1
    if "end_index" not in toc:
        toc["end_index"] = total_pages

    # Fill in missing end_index values
    add_end_indices(toc, total_pages)

    # Add summaries
    add_summaries(toc, pages, client, model)

    return toc


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <pdf_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        print(f"Error: File not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    tree = build_tree(pdf_path)
    print(json.dumps(tree))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Add npm setup script**

Add to `package.json` scripts:

```json
"setup:pageindex": "cd scripts/pageindex && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
```

- [ ] **Step 4: Create the venv and install deps**

Run: `npm run setup:pageindex`
Expected: venv created, packages installed

- [ ] **Step 5: Add venv to .gitignore**

Append to `.gitignore`:

```
scripts/pageindex/venv/
```

- [ ] **Step 6: Commit**

```bash
git add scripts/pageindex/requirements.txt scripts/pageindex/adapter.py package.json .gitignore
git commit -m "feat(pageindex): add Python adapter for PDF tree building"
```

---

## Chunk 3: IPC Handlers

### Task 6: IPC handler for `pageindex_fetch` and `pageindex_index`

**Files:**
- Modify: `src/ipc.ts:477-537` (add to default switch case)
- Create: `src/pageindex-ipc.ts` (handler module)
- Modify: `src/pageindex.test.ts` (add IPC handler tests)

- [ ] **Step 1: Write failing tests for IPC handler**

Add to `src/pageindex.test.ts`:

```typescript
describe('handlePageindexIpc', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handles pageindex_fetch with valid path', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'Extracted page text' });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.mkdirSync as any).mockReturnValue(undefined);
    (fs.writeFileSync as any).mockReturnValue(undefined);
    (fs.renameSync as any).mockReturnValue(undefined);

    const { handlePageindexIpc } = await import('./pageindex-ipc.js');
    const mounts = [
      { hostPath: '/Volumes/vault', containerPath: '/workspace/extra/claire-vault', readonly: false },
    ];
    const handled = await handlePageindexIpc(
      {
        type: 'pageindex_fetch',
        requestId: 'test-123',
        pdfPath: '/workspace/extra/claire-vault/report.pdf',
        startPage: 3,
        endPage: 5,
      },
      'main',
      true, // isMain
      '/tmp/data',
      mounts,
    );
    expect(handled).toBe(true);
    // Verify result was written
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('rejects path traversal in pageindex_fetch', async () => {
    (fs.mkdirSync as any).mockReturnValue(undefined);
    (fs.writeFileSync as any).mockReturnValue(undefined);
    (fs.renameSync as any).mockReturnValue(undefined);

    const { handlePageindexIpc } = await import('./pageindex-ipc.js');
    const mounts = [
      { hostPath: '/Volumes/vault', containerPath: '/workspace/extra/claire-vault', readonly: false },
    ];
    const handled = await handlePageindexIpc(
      {
        type: 'pageindex_fetch',
        requestId: 'test-456',
        pdfPath: '/workspace/extra/claire-vault/../../etc/passwd',
        startPage: 1,
        endPage: 1,
      },
      'main',
      true,
      '/tmp/data',
      mounts,
    );
    expect(handled).toBe(true);
    // Result should contain error
    const writeCall = (fs.writeFileSync as any).mock.calls[0];
    const result = JSON.parse(writeCall[1]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not in allowed mount');
  });

  it('returns false for non-pageindex types', async () => {
    const { handlePageindexIpc } = await import('./pageindex-ipc.js');
    const handled = await handlePageindexIpc(
      { type: 'something_else' },
      'main',
      true,
      '/tmp/data',
      [],
    );
    expect(handled).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pageindex.test.ts`
Expected: FAIL — `./pageindex-ipc.js` not found

- [ ] **Step 3: Implement `pageindex-ipc.ts`**

```typescript
// src/pageindex-ipc.ts
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import {
  resolveContainerPath,
  fetchPageRange,
  indexPdf,
  MountMapping,
} from './pageindex.js';

/**
 * Handle pageindex_* IPC requests.
 * Returns true if handled, false if not a pageindex type.
 */
export async function handlePageindexIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
  mounts: MountMapping[],
): Promise<boolean> {
  const type = data.type as string;
  if (!type?.startsWith('pageindex_')) return false;

  const requestId = data.requestId as string | undefined;
  if (!requestId) {
    logger.warn({ data }, 'PageIndex IPC missing requestId');
    return true;
  }

  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'pageindex_results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: Record<string, unknown>) => {
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const tmpFile = `${resultFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(result));
    fs.renameSync(tmpFile, resultFile);
  };

  try {
    switch (type) {
      case 'pageindex_fetch': {
        const containerPath = data.pdfPath as string;
        const startPage = data.startPage as number;
        const endPage = data.endPage as number;

        if (!containerPath || !startPage || !endPage) {
          writeResult({ success: false, error: 'Missing pdfPath, startPage, or endPage' });
          break;
        }

        const hostPath = resolveContainerPath(containerPath, mounts);
        if (!hostPath) {
          writeResult({ success: false, error: 'Path not in allowed mount' });
          break;
        }

        if (!fs.existsSync(hostPath)) {
          writeResult({ success: false, error: `PDF not found at ${containerPath}` });
          break;
        }

        const text = await fetchPageRange(hostPath, startPage, endPage);
        const pages = Array.from(
          { length: endPage - startPage + 1 },
          (_, i) => startPage + i,
        );
        writeResult({ success: true, text, pages });
        logger.info({ containerPath, startPage, endPage, sourceGroup }, 'PageIndex fetch completed');
        break;
      }

      case 'pageindex_index': {
        const containerPath = data.pdfPath as string;
        if (!containerPath) {
          writeResult({ success: false, error: 'Missing pdfPath' });
          break;
        }

        const hostPath = resolveContainerPath(containerPath, mounts);
        if (!hostPath) {
          writeResult({ success: false, error: 'Path not in allowed mount' });
          break;
        }

        if (!fs.existsSync(hostPath)) {
          writeResult({ success: false, error: `PDF not found at ${containerPath}` });
          break;
        }

        const vaultDir = path.dirname(hostPath);
        const fileName = path.basename(hostPath);
        const result = await indexPdf(hostPath, fileName, { vaultDir });

        if (result.success) {
          writeResult({ success: true, tree: result.tree, pageCount: result.pageCount });
        } else {
          writeResult({
            success: false,
            error: result.error || 'Indexing failed',
            fallbackText: result.fallbackText,
            pageCount: result.pageCount,
          });
        }
        logger.info({ containerPath, sourceGroup, success: result.success }, 'PageIndex index completed');
        break;
      }

      default:
        return false;
    }
  } catch (err: any) {
    logger.error({ err: err.message, type, requestId }, 'PageIndex IPC error');
    writeResult({ success: false, error: err.message });
  }

  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pageindex.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into `ipc.ts`**

In `src/ipc.ts`, add to the `default` case block (around line 477), before the `imessage_` check:

```typescript
// At the top of ipc.ts, add import:
import { handlePageindexIpc } from './pageindex-ipc.js';

// In the default case, before the imessage check:
if (typeof data.type === 'string' && data.type.startsWith('pageindex_')) {
  // Build mount mappings from registered group config
  const groupEntry = Object.values(registeredGroups).find(g => g.folder === sourceGroup);
  const mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }> = [];
  if (groupEntry?.containerConfig?.additionalMounts) {
    for (const m of groupEntry.containerConfig.additionalMounts) {
      const containerPath = `/workspace/extra/${m.containerPath || path.basename(m.hostPath)}`;
      mounts.push({ hostPath: m.hostPath, containerPath, readonly: m.readonly !== false });
    }
  }
  // Add group folder mount
  mounts.push({
    hostPath: resolveGroupFolderPath(sourceGroup),
    containerPath: '/workspace/group',
    readonly: false,
  });
  handled = await handlePageindexIpc(
    data as Record<string, unknown>,
    sourceGroup,
    isMain,
    DATA_DIR,
    mounts,
  );
}
```

- [ ] **Step 6: Build and verify no type errors**

Run: `npm run build`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/pageindex-ipc.ts src/ipc.ts src/pageindex.test.ts
git commit -m "feat(pageindex): add IPC handlers for fetch and index"
```

---

## Chunk 4: Telegram Integration

### Task 7: Modify Telegram document handler for auto-indexing

**Files:**
- Modify: `src/channels/telegram.ts:438-467` (PDF extraction block)

- [ ] **Step 1: Import pageindex module**

At the top of `src/channels/telegram.ts`, add:

```typescript
import { countPdfPages, indexPdf, computeFileHash } from '../pageindex.js';
```

- [ ] **Step 2: Replace the PDF extraction block**

Replace the existing `EXTRACTABLE_EXTS` block for PDFs (lines 438-467) with logic that counts pages first and auto-indexes if >20:

```typescript
      // Try extracting text from binary documents (PDF, DOCX, etc.)
      if (doc?.file_id && EXTRACTABLE_EXTS[ext]) {
        try {
          const file = await ctx.api.getFile(doc.file_id);
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

          // For PDFs: check page count and auto-index if >20 pages
          if (ext === '.pdf') {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
            const buf = Buffer.from(await resp.arrayBuffer());

            // Write to temp file for processing
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-doc-'));
            const tmpFile = path.join(tmpDir, name);
            fs.writeFileSync(tmpFile, buf);

            try {
              const pageCount = await countPdfPages(tmpFile);

              if (pageCount > 20) {
                // Send typing indicator — indexing takes 30-60s
                try {
                  await ctx.api.sendChatAction(ctx.chat.id, 'typing');
                } catch { /* ignore typing indicator failures */ }

                // Auto-index: build tree structure
                const hash = computeFileHash(buf);

                // Determine vault directory from group's additionalMounts
                const chatJid = `tg:${ctx.chat.id}`;
                const group = this.opts.registeredGroups()[chatJid];
                let vaultDir: string | undefined;
                let inboxDir: string | undefined;
                if (group?.containerConfig?.additionalMounts) {
                  for (const m of group.containerConfig.additionalMounts) {
                    if (fs.existsSync(m.hostPath)) {
                      const inbox = path.join(m.hostPath, '00-inbox');
                      if (fs.existsSync(m.hostPath)) {
                        inboxDir = inbox;
                        vaultDir = inbox;
                        break;
                      }
                    }
                  }
                }

                const result = await indexPdf(tmpFile, name, {
                  vaultDir,
                  contentHash: hash,
                  fileBuffer: buf,
                });

                if (result.success && result.tree) {
                  // Save PDF to vault inbox
                  if (vaultDir) {
                    try {
                      fs.mkdirSync(inboxDir, { recursive: true });
                      const vaultPdf = path.join(inboxDir, name);
                      if (!fs.existsSync(vaultPdf)) {
                        fs.copyFileSync(tmpFile, vaultPdf);
                      }
                    } catch (saveErr) {
                      logger.warn({ name, err: saveErr }, 'Failed to save PDF to vault');
                    }
                  }
                  storeNonText(
                    ctx,
                    `[Document: ${name} — ${pageCount} pages, indexed]\n\n${JSON.stringify(result.tree, null, 2)}`,
                  );
                  logger.info({ name, pageCount, hash }, 'PDF auto-indexed');
                  return;
                }

                // Indexing failed — use fallback text
                if (result.fallbackText && result.fallbackText.trim().length > 0) {
                  const maxChars = 50_000;
                  const truncated =
                    result.fallbackText.length > maxChars
                      ? result.fallbackText.slice(0, maxChars) +
                        `\n\n[Truncated — ${result.fallbackText.length} chars total]`
                      : result.fallbackText;
                  storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
                  logger.info({ name, pageCount, error: result.error }, 'PDF indexing failed, using flat text');
                  return;
                }
              }

              // ≤20 pages or fallback empty: use standard extraction
              const extracted = await extractDocumentText(url, name);
              if (extracted && extracted.trim().length > 0) {
                const maxChars = 50_000;
                const truncated =
                  extracted.length > maxChars
                    ? extracted.slice(0, maxChars) +
                      `\n\n[Truncated — ${extracted.length} chars total]`
                    : extracted;
                storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
                logger.info({ name, chars: extracted.length }, 'Telegram document extracted');
                return;
              }
            } finally {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            }
          } else {
            // Non-PDF extractable documents (DOCX, etc.) — existing logic
            const extracted = await extractDocumentText(url, name);
            if (extracted && extracted.trim().length > 0) {
              const maxChars = 50_000;
              const truncated =
                extracted.length > maxChars
                  ? extracted.slice(0, maxChars) +
                    `\n\n[Truncated — ${extracted.length} chars total]`
                  : extracted;
              storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
              logger.info({ name, chars: extracted.length }, 'Telegram document extracted');
              return;
            }
          }
        } catch (err) {
          logger.warn({ name, err }, 'Failed to extract Telegram document text');
        }
      }
```

- [ ] **Step 3: Build and verify no type errors**

Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat(pageindex): auto-index PDFs >20 pages in Telegram handler"
```

---

## Chunk 5: Agent Instructions and Finalization

### Task 8: Update global CLAUDE.md with PageIndex instructions

**Files:**
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: Add PageIndex section**

Add after the "Obsidian Vault" section in `groups/global/CLAUDE.md`:

```markdown
## Indexed Documents (PageIndex)

When a PDF has >20 pages, you receive a hierarchical tree instead of flat text. The tree shows sections with titles, page ranges, and summaries.

Example:
```
[Document: report.pdf — 87 pages, indexed]
{
  "title": "Grant Application R01MH143721",
  "start_index": 1, "end_index": 87,
  "summary": "NIH R01 grant application for genomics research",
  "nodes": [
    {"title": "Specific Aims", "start_index": 1, "end_index": 2, "summary": "...", "nodes": []},
    {"title": "Research Strategy", "start_index": 3, "end_index": 40, "summary": "...", "nodes": [
      {"title": "Significance", "start_index": 3, "end_index": 12, "summary": "...", "nodes": []}
    ]}
  ]
}
```

### Fetching Pages

To read specific pages from an indexed PDF, write an IPC task:

```bash
echo '{"type":"pageindex_fetch","requestId":"pf-'$(date +%s%N)'","pdfPath":"/workspace/extra/claire-vault/00-inbox/report.pdf","startPage":3,"endPage":12}' > /workspace/ipc/tasks/pf-$(date +%s).json
```

Then poll for the result:

```bash
cat /workspace/ipc/pageindex_results/pf-*.json 2>/dev/null
```

The response contains the extracted text for those pages.

### Indexing a Vault PDF

To index a PDF that wasn't auto-indexed (e.g., one already in the vault):

```bash
echo '{"type":"pageindex_index","requestId":"pi-'$(date +%s%N)'","pdfPath":"/workspace/extra/claire-vault/20-projects/grants/R01.pdf"}' > /workspace/ipc/tasks/pi-$(date +%s).json
```

Poll for result in `/workspace/ipc/pageindex_results/`.

### Notes
- Short documents (<20 pages) arrive as full text — no tree, no fetching needed
- Page numbers in the tree are 1-based and inclusive (start_index=3, end_index=12 means pages 3 through 12)
- If polling times out after 120s, proceed without the indexed data
```

- [ ] **Step 2: Commit**

```bash
git add groups/global/CLAUDE.md
git commit -m "docs: add PageIndex agent instructions to global CLAUDE.md"
```

---

### Task 9: Add setup:pageindex to package.json and .gitignore

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add npm script** (if not already done in Task 5)

In `package.json`, add to scripts:
```json
"setup:pageindex": "cd scripts/pageindex && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
```

- [ ] **Step 2: Add venv to .gitignore** (if not already done in Task 5)

Append to `.gitignore`:
```
scripts/pageindex/venv/
```

- [ ] **Step 3: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: add pageindex setup script and gitignore venv"
```

---

### Task 10: Build, restart, and smoke test

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Set up Python venv**

Run: `npm run setup:pageindex`
Expected: venv created, packages installed

- [ ] **Step 4: Restart service**

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

- [ ] **Step 5: Verify startup**

Run: `sleep 5 && tail -20 logs/nanoclaw.log`
Expected: Clean startup, no new errors

- [ ] **Step 6: Smoke test — send a short PDF (<20 pages) via Telegram**

Expected: Same behavior as before (flat text extraction). Verify in logs: no pageindex references.

- [ ] **Step 7: Smoke test — send a long PDF (>20 pages) via Telegram**

Expected: Logs show `PDF auto-indexed`, agent receives tree JSON. If adapter not fully working yet, falls back to flat text with log warning.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat: complete PageIndex integration for hierarchical PDF indexing"
```
