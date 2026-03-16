# PageIndex Integration — Hierarchical PDF Indexing for NanoClaw

**Date:** 2026-03-16
**Status:** Approved
**Author:** Mike + Claude

## Problem

PDFs arriving via Telegram are extracted to flat text via `pdftotext` and truncated at 50,000 characters. For long documents (grants, papers, agendas >20 pages), the agent loses content beyond the truncation point and has no way to navigate to specific sections. The agent receives an undifferentiated wall of text with no structure.

## Solution

Integrate PageIndex-style hierarchical document indexing. Long PDFs are parsed into a tree structure (titles, summaries, page ranges) using LLM-powered TOC detection. The agent receives the compact tree (~400-600 tokens) instead of flat text, then fetches specific page ranges on demand via IPC.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM for indexing | Claude via credential proxy | Avoids second API subscription; proxy already exists |
| Auto-index threshold | >20 pages | Below 20 pages, flat text fits in 50K chars without truncation |
| On-demand indexing | Yes, via IPC | Agents can request indexing for vault PDFs they encounter |
| Tree storage | Per-folder `.pageindex/` in vault | Avoids namespace collisions; syncs via Dropbox |
| Section fetch | Host-side IPC (not container pdftotext) | Container lacks poppler-utils; keeps image lean |
| Page counting | `pdfinfo` (not pdftotext) | Fast metadata-only read; pdftotext has no page-count flag |
| Fallback | Flat pdftotext extraction | If indexing fails, message delivery is never blocked |

## Architecture

### Two Phases

**Index phase** (host-side): When a PDF arrives via Telegram with >20 pages, or when an agent requests indexing on demand, the host runs PageIndex to build a hierarchical tree. The tree JSON is stored in the vault. The original PDF is saved to `00-inbox/` if it arrived via Telegram.

**Retrieval phase** (agent-side): The agent receives the tree structure in its prompt. It reasons about which sections it needs, then requests specific page ranges via IPC. The host extracts those pages with `pdftotext -f {start} -l {end}` and returns the text.

### Data Flow: Auto-Index (Telegram PDF, >20 pages)

```
Telegram PDF arrives
  → download to temp file
  → pdfinfo: count pages
  → IF ≤20 pages: current flat pdftotext extraction (unchanged)
  → IF >20 pages:
      → compute sha256 content hash
      → check vault .pageindex/ for existing index by hash
      → IF cached: load existing tree
      → IF not cached:
          → send typing indicator + "Indexing document..." message via send_message
          → run PageIndex tree builder (Claude API via credential proxy)
          → ON SUCCESS: save tree JSON + save original PDF to vault
          → ON FAILURE: fall back to flat pdftotext extraction (see Fallback Strategy)
      → inject tree JSON into message content
      → agent sees: [Document: report.pdf — 87 pages, indexed]
                     {tree JSON with titles, summaries, page ranges}
```

### Data Flow: On-Demand Indexing (Agent Request)

```
Agent encounters un-indexed PDF in vault
  → writes IPC task: {
      type: "pageindex_index",
      requestId: "...",
      pdfPath: "/workspace/extra/claire-vault/20-projects/grants/R01.pdf"
    }
  → host picks up IPC, validates + resolves container path to host path (see Path Resolution)
  → host runs indexing (same as auto-index)
  → host creates results directory: data/ipc/{group}/pageindex_results/ (mkdir -p)
  → host writes IPC response: {
      success: true,
      tree: {...},
      pageCount: 87
    }
  → agent polls /workspace/ipc/pageindex_results/{requestId}.json (timeout: 120s)
  → agent reads tree, proceeds with reasoning
```

### Data Flow: Section Fetch (Agent Reads Pages)

```
Agent sees tree, decides it needs pages 34-38
  → writes IPC task: {
      type: "pageindex_fetch",
      requestId: "...",
      pdfPath: "/workspace/extra/claire-vault/00-inbox/report.pdf",
      startPage: 34,
      endPage: 38
    }
  → host validates path (see Path Resolution), runs: pdftotext -f 34 -l 38 -layout {hostPath} -
  → host creates results directory: data/ipc/{group}/pageindex_results/ (mkdir -p)
  → host writes IPC response: {
      success: true,
      text: "...(extracted text)...",
      pages: [34, 35, 36, 37, 38]
    }
  → agent reads text, continues reasoning
```

## Path Resolution & Security

Agents write container paths (e.g., `/workspace/extra/claire-vault/file.pdf`) in IPC requests. The host must resolve these to host paths securely.

**Resolution rules:**
- `/workspace/extra/{name}/...` → look up `{name}` in the group's `additionalMounts` config. Map `containerPath` back to `hostPath`. Example: `/workspace/extra/claire-vault/00-inbox/report.pdf` → `/Volumes/sandisk4TB/marvin-vault/00-inbox/report.pdf`
- `/workspace/group/...` → resolve via `resolveGroupFolderPath(sourceGroup)` (existing function in `group-folder.ts`)

**Security validation (mandatory):**
1. `path.resolve()` the resolved host path to eliminate `..` traversal
2. Verify the resolved path starts with one of the group's allowed mount roots (from mount-allowlist.json)
3. Reject paths that escape allowed mounts with `{success: false, error: "Path not in allowed mount"}`

**Implementation:** New function `resolveContainerPath(containerPath, sourceGroup, isMain)` in `src/pageindex.ts`, reusing `loadMountAllowlist()` from `mount-security.ts`.

## Components

### 1. Host-side indexer (`src/pageindex.ts`)

New module. Responsibilities:
- Count PDF pages via `/opt/homebrew/bin/pdfinfo` (absolute path for launchd). Parse output: `stdout.match(/Pages:\s+(\d+)/)`
- Compute sha256 content hash for cache dedup
- Call PageIndex Python adapter as subprocess, passing env vars: `ANTHROPIC_BASE_URL=http://localhost:{CREDENTIAL_PROXY_PORT}`, `ANTHROPIC_API_KEY=placeholder`
- Save tree JSON to vault `.pageindex/` directory
- Save original Telegram PDFs to vault `00-inbox/`
- Extract page ranges via `/opt/homebrew/bin/pdftotext -f {start} -l {end}`
- Resolve container paths → host paths with security validation
- `indexPdf()` returns `{success: true, tree}` or `{success: false, fallbackText, error}` — never throws
- Python subprocess has a 90-second timeout (`{timeout: 90_000}`). On timeout, subprocess is killed and fallback is returned.
- If PDF exceeds 500 pages, skip indexing and use flat extraction with warning. Tree building is untested beyond that size.

**Credential proxy dependency:** `pageindex.ts` assumes the credential proxy is already running (started in `src/index.ts` before any message processing). The Python subprocess connects to `http://localhost:{CREDENTIAL_PROXY_PORT}`. The proxy injects real credentials regardless of whether the Python SDK sends `x-api-key` or `Authorization: Bearer` — the proxy is auth-mode agnostic.

### 2. PageIndex Python adapter (`scripts/pageindex/`)

Thin Python wrapper around PageIndex's core logic:
- Replaces OpenAI client with Anthropic client (`anthropic` Python SDK)
- Reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from environment (set by parent process)
- The Python SDK respects `ANTHROPIC_BASE_URL` for all API calls — verified compatible with credential proxy
- Prompts are model-agnostic (TOC detection, JSON extraction, section validation)
- Dependencies: `anthropic`, `pymupdf`, `tiktoken`, `pyyaml`
- Installed in venv: `scripts/pageindex/venv/` (not committed)
- PageIndex core is vendored at `scripts/pageindex/pageindex/` (MIT license)

**Setup:** `npm run setup:pageindex` creates the venv and installs requirements:
```bash
cd scripts/pageindex && python3 -m venv venv && venv/bin/pip install -r requirements.txt
```

### 3. Telegram channel changes (`src/channels/telegram.ts`)

Modify the `message:document` handler for `.pdf` files:
- After download to temp file, count pages with `pdfinfo`
- If >20 pages: call `indexPdf()` from `pageindex.ts`
  - If `indexPdf()` returns `{success: true}`: inject tree as message content, save PDF to vault
  - If `indexPdf()` returns `{success: false}`: use `fallbackText` (flat pdftotext extraction). If `fallbackText` is also empty, use placeholder `[Document: name]`
- If ≤20 pages: current flat extraction (unchanged)
- Start typing indicator after `pdfinfo` returns >20 pages, before indexing begins

### 4. IPC handlers (`src/ipc.ts`)

Two new IPC types, following the existing iMessage request-response pattern:

**`pageindex_index`**: Agent requests indexing of a vault PDF.
- Input: `{type, requestId, pdfPath}`
- Host validates path (see Path Resolution), creates `data/ipc/{group}/pageindex_results/` directory, runs indexer
- Output written to `data/ipc/{group}/pageindex_results/{requestId}.json`
- On failure: `{success: false, error: "..."}`

**`pageindex_fetch`**: Agent requests specific page range from a PDF.
- Input: `{type, requestId, pdfPath, startPage, endPage}`
- Host validates path, creates results directory, runs `pdftotext -f {start} -l {end}`
- Output: `{success, text, pages}`
- On failure: `{success: false, error: "PDF not found"}` or `{success: false, error: "Path not in allowed mount"}`

Both handlers follow the `imessage_*` pattern: `fs.mkdirSync(resultsDir, { recursive: true })` before writing results. Atomic write via tmp file + rename.

### 5. Agent instructions (`groups/global/CLAUDE.md`)

Add a section explaining indexed documents with concrete examples:

```markdown
## Indexed Documents (PageIndex)

When a PDF has >20 pages, you receive a hierarchical tree instead of flat text:

[Document: report.pdf — 87 pages, indexed]
{
  "title": "Grant Application R01MH143721",
  "start_index": 1, "end_index": 87,
  "summary": "NIH R01 grant application for genomics research",
  "nodes": [
    {"title": "Specific Aims", "start_index": 1, "end_index": 2, "summary": "...", "nodes": []},
    {"title": "Research Strategy", "start_index": 3, "end_index": 40, "summary": "...", "nodes": [
      {"title": "Significance", "start_index": 3, "end_index": 12, "summary": "...", "nodes": []},
      {"title": "Innovation", "start_index": 13, "end_index": 18, "summary": "...", "nodes": []}
    ]}
  ]
}

To fetch specific pages (e.g., pages 3-12 for Significance):
echo '{"type":"pageindex_fetch","requestId":"fetch-001","pdfPath":"/workspace/extra/claire-vault/00-inbox/report.pdf","startPage":3,"endPage":12}' > /workspace/ipc/tasks/pf-$(date +%s).json
# Then poll: cat /workspace/ipc/pageindex_results/fetch-001.json

To index an un-indexed vault PDF:
echo '{"type":"pageindex_index","requestId":"idx-001","pdfPath":"/workspace/extra/claire-vault/20-projects/grants/R01.pdf"}' > /workspace/ipc/tasks/pi-$(date +%s).json
# Then poll: cat /workspace/ipc/pageindex_results/idx-001.json

Short documents (<20 pages) arrive as full text — no indexing needed.
```

### 6. Container MCP tool (optional, `container/agent-runner/`)

Alternative to raw IPC file writing: expose `pageindex_fetch` and `pageindex_index` as MCP tools in the nanoclaw MCP server. This gives agents a cleaner interface than writing JSON files. Same host-side processing, just a friendlier agent-facing API. Deferred to a follow-up if the IPC approach proves cumbersome.

## Tree Node Structure

Each node in the tree JSON:

```json
{
  "title": "Budget Justification",
  "node_id": "3.2",
  "start_index": 34,
  "end_index": 38,
  "summary": "Detailed budget for personnel, equipment, and travel costs",
  "nodes": []
}
```

**Field definitions:**
- `title`: Section heading extracted from document structure
- `node_id`: Hierarchical identifier (e.g., "3.2" = section 3, subsection 2). Optional — may be absent if PageIndex doesn't generate it.
- `start_index`, `end_index`: Page numbers (inclusive on both ends). `start_index=34, end_index=38` means pages 34, 35, 36, 37, 38.
- `summary`: LLM-generated summary of the section content. Typically 1-2 sentences.
- `nodes`: Recursive array of child nodes. Tree depth is typically 2-4 levels.

**Page numbering convention:** The adapter normalizes all page indices to **1-based** (matching `pdftotext -f/-l`). If PageIndex internally uses 0-based indices, the adapter adds +1 during tree construction. This is verified by a mandatory test case: index a known PDF, check that `start_index=1` corresponds to actual page 1.

## Fallback Strategy

`indexPdf()` in `src/pageindex.ts` implements a two-level fallback:

```
indexPdf(tmpFilePath, fileName)
  → try: run PageIndex adapter
    → ON SUCCESS: return {success: true, tree: {...}}
    → ON FAILURE (LLM timeout, parse error, adapter crash):
        → try: flat pdftotext extraction (existing logic)
          → return {success: false, fallbackText: "...", error: "Indexing failed: ..."}
        → ON FAILURE (pdftotext also fails):
          → return {success: false, fallbackText: "", error: "All extraction failed"}
```

**Telegram handler uses the result:**
```typescript
const result = await indexPdf(tmpFile, name);
if (result.success) {
  storeNonText(ctx, `[Document: ${name} — ${pageCount} pages, indexed]\n\n${JSON.stringify(result.tree, null, 2)}`);
} else if (result.fallbackText) {
  // Flat extraction worked, indexing didn't — truncate as usual
  const truncated = result.fallbackText.length > 50_000
    ? result.fallbackText.slice(0, 50_000) + `\n\n[Truncated — ${result.fallbackText.length} chars total]`
    : result.fallbackText;
  storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
} else {
  storeNonText(ctx, `[Document: ${name}]`);
}
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Indexing fails (LLM timeout, malformed PDF) | `indexPdf()` returns `{success: false, fallbackText}`. Telegram handler uses flat text. Log warning. |
| Vault disk offline | Fall back to flat extraction. Log warning. PDF not saved to vault. |
| Duplicate PDF (same content hash) | Return cached tree from `.pageindex/`. No re-indexing. |
| Scanned/image-only PDF | pdftotext returns empty. `indexPdf()` returns `{fallbackText: ""}`. Handler uses `[Document: name — scanned PDF, no extractable text]`. |
| Indexing latency (~30-60s) | Start typing indicator after `pdfinfo` returns >20 pages. Stop after indexing completes (success or fallback). |
| IPC fetch for non-existent PDF | `{success: false, error: "PDF not found at {path}"}` |
| IPC path traversal attempt | `{success: false, error: "Path not in allowed mount"}` |
| Page range out of bounds | pdftotext handles gracefully (returns whatever pages exist) |
| Python venv missing | `indexPdf()` catches ENOENT on subprocess spawn, returns fallback |
| Python subprocess hangs | 90-second timeout; subprocess killed, fallback returned |
| PDF >500 pages | Skip indexing, use flat extraction with warning |
| Agent IPC poll timeout (>120s) | Agent-side concern — instructions tell agents to timeout and proceed without indexed data |
| Vault write permission denied | Log warning, proceed with non-cached indexing (tree returned but not saved) |

## File Layout

```
nanoclaw/
  src/
    pageindex.ts              # Host-side indexer + fetch + path resolution
    channels/telegram.ts      # Modified: auto-index >20 page PDFs
    ipc.ts                    # Modified: pageindex_index + pageindex_fetch handlers
  scripts/
    pageindex/
      venv/                   # Python venv (not committed, created by setup:pageindex)
      requirements.txt        # anthropic, pymupdf, tiktoken, pyyaml
      adapter.py              # Thin wrapper: PageIndex core + Anthropic client
      pageindex/              # Vendored PageIndex source (MIT license)
  groups/
    global/CLAUDE.md          # Modified: agent instructions for indexed documents

vault (example):
  /Volumes/sandisk4TB/marvin-vault/
    00-inbox/
      .pageindex/
        report-a1b2c3d4.json  # Tree JSON (hash suffix = first 8 chars of sha256)
      report.pdf              # Original PDF (saved from Telegram)
    20-projects/
      grants/
        .pageindex/
          R01-e5f6g7h8.json
        R01MH143721-01.pdf
```

## Testing Strategy

Tests use TDD. Key test cases:

**Unit tests (`src/pageindex.test.ts`):**
- Page counting: mock `execFileAsync` for `pdfinfo`, verify parsing of `Pages: 87`
- Content hash: sha256 of known bytes produces expected hex string
- Cache hit: `.pageindex/{name}-{hash}.json` exists → return cached tree, no subprocess call
- Cache miss: no cache file → spawn adapter subprocess
- Tree JSON parsing: valid tree → parsed; malformed JSON → fallback
- Page number normalization: if raw tree has 0-based indices, adapter output is 1-based (test with known PDF)
- Path resolution: `/workspace/extra/claire-vault/foo.pdf` → `/Volumes/sandisk4TB/marvin-vault/foo.pdf`
- Path traversal rejection: `/workspace/extra/claire-vault/../../etc/passwd` → error
- Fallback chain: indexing fails → flat extraction returned; both fail → empty fallback

**Integration tests:**
- End-to-end: real PDF file → indexer → tree JSON file at correct vault path
- IPC round-trip: write request JSON → process → read response JSON (mock subprocess)
- Telegram handler: PDF >20 pages triggers `indexPdf()`; ≤20 pages uses flat extraction
- Scanned PDF: pdftotext returns empty → correct placeholder message

**Python adapter tests (`scripts/pageindex/test_adapter.py`):**
- Anthropic client initialization: reads `ANTHROPIC_BASE_URL` from env
- Tree building: sample PDF → valid tree JSON output
- Page numbering: first node's `start_index` is 1 (not 0) for a document starting on page 1
- Graceful failure: malformed PDF → exits with non-zero, stderr contains error
- Empty PDF: 0 pages → exits with error message
