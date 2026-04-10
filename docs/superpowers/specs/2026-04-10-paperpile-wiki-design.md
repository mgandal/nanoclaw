# Paperpile Wiki — Design Spec

**Date**: 2026-04-10
**Status**: Draft
**Author**: Michael Gandal + Claude

## Problem

A personal Paperpile library of 5,721 academic papers (neuroscience, psychiatry, genomics) is searchable only by keyword in Paperpile's UI. There is no way to ask "what does the literature say about X?" and get a synthesized answer grounded in the library. The goal is an auto-generated, navigable wiki of synthesized topic pages — compiled knowledge across papers, not just paper-level summaries.

## Solution

A Python pipeline that:

1. **Ingests** BibTeX metadata + SPECTER2 scientific embeddings
2. **Clusters** papers into topics using BERTopic (UMAP → HDBSCAN → c-TF-IDF)
3. **Synthesizes** wiki pages per cluster using Claude API (Sonnet)
4. **Maintains** the wiki on a monthly schedule with quarterly re-clustering

Output is Obsidian-compatible markdown in the vault at `/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile/`, indexed by QMD for agent access.

## Prior Art — What We Borrow

| Tool | What we borrow | What we skip |
|------|---------------|-------------|
| **SPECTER2** (allenai) | 768-dim scientific paper embeddings trained on citation graphs. Proximity adapter for clustering. Title+[SEP]+abstract input format. ~35s for 5,700 papers on Apple Silicon MPS. | Classification/regression adapters |
| **BERTopic** | UMAP→HDBSCAN→c-TF-IDF clustering pipeline. Hierarchical topic tree. LLM-generated labels via Ollama. Cluster assignments + centroids stored in SQLite. | Incremental partial_fit (we use nearest-centroid for monthly updates), safetensors model persistence (not needed — we store state in SQLite) |
| **Stanford STORM** | Outline → section writing pipeline for structured article generation. Per-section evidence retrieval. Cost optimization (cheap models for labeling, strong for writing). | Full 4-stage pipeline (we simplified to 1-2 calls), VectorRM/Qdrant (we use QMD), persona discovery via Wikipedia, DSPy framework, polish step (folded into writing) |
| **PaperQA2/WikiCrow** | Evidence summarization approach (summarize with respect to synthesis topic). WikiCrow prompt patterns for Wikipedia-style article writing. DocMetadataClient concept for metadata enrichment. | Their agent loop, NumpyVectorStore, PDF parsing (we have PageIndex) |
| **gbrain** | Compiled truth + timeline page model. Human-editable markdown as source of truth. Agent-driven enrichment loop (wiki starts shallow, deepens on demand). | PostgreSQL, pgvector, full MCP server |

## Architecture

```
paperpile.bib (daily sync)
        │
        ▼
┌─────────────────────────────────────────────────┐
│  ingest.py                                      │
│  BibTeX parse → SPECTER2 embed → BERTopic cluster│
│  Store: paperpile.db (SQLite)                   │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│  synthesize.py                                  │
│  Per-cluster: evidence cards → Claude Sonnet    │
│  → markdown synthesis pages                     │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│  98-nanoKB/paperpile/                           │
│  INDEX.md + ~100-200 synthesis .md files        │
│  Obsidian-browsable, QMD-indexed                │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│  QMD collection "paperpile"                     │
│  → agents query via mcp__qmd__query             │
└─────────────────────────────────────────────────┘
```

## Data Model

SQLite database at `store/paperpile.db`. Schema versioned via `schema_version` table.

### papers

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | BibTeX key (e.g. "Aivazidis2025-hw") |
| title | TEXT NOT NULL | |
| authors | TEXT | Semicolon-separated |
| first_author | TEXT | Extracted for display/sorting |
| year | INTEGER | |
| journal | TEXT | |
| abstract | TEXT | 96% of entries have this |
| doi | TEXT | |
| pmid | TEXT | |
| pmc | TEXT | |
| url | TEXT | |
| keywords | TEXT | 26% of entries have this |
| pdf_path | TEXT | Relative path in Google Drive Paperpile folder |
| embedding | BLOB | 768-dim float32 from SPECTER2 (3,072 bytes) |
| cluster_id | INTEGER FK → clusters | |
| cluster_confidence | REAL | 1.0 = HDBSCAN-assigned, <1.0 = nearest-centroid fallback |
| is_new | BOOLEAN DEFAULT 1 | Not yet incorporated into a synthesis |
| created_at | TEXT DEFAULT CURRENT_TIMESTAMP | |
| updated_at | TEXT | |

### clusters

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT | LLM-generated (e.g. "Autism Genetics & GWAS") |
| slug | TEXT UNIQUE | Filesystem-safe (e.g. "autism-genetics-gwas") |
| description | TEXT | 2-3 sentence summary |
| centroid | BLOB | 768-dim mean embedding for nearest-centroid assignment |
| parent_id | INTEGER FK → clusters | Hierarchical from BERTopic topic tree |
| paper_count | INTEGER | |
| created_at | TEXT DEFAULT CURRENT_TIMESTAMP | |
| updated_at | TEXT | |

### synthesis_pages

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| cluster_id | INTEGER FK → clusters | |
| file_path | TEXT | Relative to vault root |
| status | TEXT DEFAULT 'draft' | 'draft', 'current', 'stale' |
| last_generated | TEXT | |
| paper_count_at_generation | INTEGER | |
| generation_cost_usd | REAL | Track spending |
| updated_at | TEXT | |

### paper_synthesis (many-to-many)

| Column | Type | Notes |
|--------|------|-------|
| paper_id | TEXT FK → papers | |
| synthesis_id | INTEGER FK → synthesis_pages | |
| role | TEXT DEFAULT 'primary' | 'primary', 'supporting', 'mentioned' |

### synthesis_history (rollback)

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| synthesis_id | INTEGER FK → synthesis_pages | |
| content | TEXT | Previous markdown content |
| generated_at | TEXT | When this version was generated |
| replaced_at | TEXT DEFAULT CURRENT_TIMESTAMP | When it was superseded |

### schema_version

| Column | Type | Notes |
|--------|------|-------|
| version | INTEGER | Current schema version |
| applied_at | TEXT DEFAULT CURRENT_TIMESTAMP | |

## Pipeline: Ingest

Script: `scripts/paperpile-wiki/ingest.py`

### Stage 1: BibTeX → SQLite (~5 seconds)

- Parse `~/.hermes/paperpile.bib` using `bibtexparser`
- Extract per entry: title, authors (semicolons), first_author, year, journal, abstract, doi, pmid, pmc, url, keywords
- Upsert into `papers` table. New entries get `is_new=1`.
- Report: "N total papers, M new since last run"

### Stage 2: PDF Path Matching

Two-pronged approach to link BibTeX entries to PDFs in `~/Library/CloudStorage/GoogleDrive-mgandal@gmail.com/My Drive/Paperpile/`:

1. **Primary**: Parse the Paperpile JSON export (`Paperpile - Jul 07 JSON Export.txt`, 30MB) which contains `id_list` with SHA1 hashes and DOIs. Match by DOI (95% of entries have DOI). This is authoritative.
2. **Fallback**: Fuzzy match on normalized `FirstAuthorLastAuthor-*-Year` filename patterns with Levenshtein distance. Accept matches above 0.85 similarity threshold.
3. Store matched `pdf_path` in papers table. Log unmatched papers.

Note: PDF matching is best-effort. The pipeline works without PDFs — they're only needed for the optional enrichment step on the user's own papers.

### Stage 3: SPECTER2 Embedding (~35 seconds)

- Load `allenai/specter2_base` + proximity adapter (`allenai/specter2`) via `adapters` library
- For papers missing embeddings, format input as `title [SEP] abstract`
- Batch embed on MPS (Apple Silicon GPU), batch_size=32
- Store 768-dim float32 vectors in `papers.embedding` BLOB
- First run: all 5,721 papers. Subsequent runs: only new papers.

### Stage 4: BERTopic Clustering (~75 seconds including Ollama labeling)

- Load all embeddings from SQLite into numpy array
- BERTopic configuration:
  - UMAP: `n_neighbors=15, n_components=5, min_dist=0.0, metric='cosine', random_state=42`
  - HDBSCAN: `min_cluster_size=30, min_samples=10, metric='euclidean', cluster_selection_method='eom'`
  - CountVectorizer: `stop_words='english', ngram_range=(1,2), min_df=5`
  - ClassTfidfTransformer: `reduce_frequent_words=True`
- LLM labeling via Ollama `qwen3:8b` (OpenAI-compatible endpoint at localhost:11434):
  - Prompt: topic keywords + 5 representative paper excerpts → 3-7 word descriptive label
  - Also extract 2-3 sentence cluster description
- Extract hierarchical topic tree via `topic_model.hierarchical_topics()`

**Noise paper handling**: Papers assigned to HDBSCAN cluster -1 (noise) are reassigned to their nearest cluster by cosine similarity to cluster centroids. These papers get `cluster_confidence < 1.0` proportional to their distance from the centroid. Papers assigned by HDBSCAN get `cluster_confidence = 1.0`.

**Write to SQLite**: cluster assignments, centroids, labels, descriptions, hierarchy (parent_id). Store centroids as BLOBs for monthly nearest-centroid assignment.

**Expected output**: ~100-200 clusters, ~0 unassigned papers.

## Pipeline: Synthesize

Script: `scripts/paperpile-wiki/synthesize.py`

Generates markdown synthesis pages for clusters with status 'draft' or 'stale'. Routes Claude API calls through the OneCLI credential proxy, following the same pattern as `scripts/pageindex/adapter.py`:
- `ANTHROPIC_BASE_URL` set to the OneCLI gateway (e.g. `http://localhost:3001`)
- `ANTHROPIC_API_KEY` set to a placeholder (proxy injects the real credential)
- Uses `anthropic.Anthropic()` client which respects these env vars

### Stage 1: Evidence Gathering (local, no API calls)

For each cluster:

- Pull all papers from SQLite, sorted by year descending
- If >40 papers, select the 40 closest to cluster centroid by embedding cosine similarity
- Format each paper as an evidence card:
  ```
  [Aivazidis2025-hw] "A spatial transcriptomic atlas of autism-associated genes..."
  Authors: Aivazidis, Memi, Rademaker et al. | Journal: bioRxiv | Year: 2025
  Abstract: Autism is a highly heritable neurodevelopmental condition...
  ```
- **Auto-enrich own papers**: If any paper has "Gandal" in authors AND `pdf_path` is set AND Google Drive is mounted, extract text via `pdftotext`, include intro + discussion excerpts (~1K words) in the evidence card. If Drive is unavailable, skip enrichment silently and log a warning.

Citations use the BibTeX key (e.g. `[Aivazidis2025-hw]`) — guaranteed unique, no collision issues.

### Stage 2: Synthesis Writing (1-2 Claude Sonnet calls)

**Small clusters (≤25 papers)**: Single Claude call with all evidence cards. Prompt:

```
You are writing a synthesis page for an academic wiki about the research topic: "{cluster_name}".
Topic description: {cluster_description}

Below are the papers in this topic cluster. Write a comprehensive synthesis that:
1. Opens with a 2-3 paragraph overview of the field/topic
2. Organizes findings into themed sections (## headings)
3. Cites papers inline using their BibTeX keys, e.g. [Aivazidis2025-hw]
4. Highlights key findings, methodological advances, and open questions
5. Ends with a "Key Papers" section listing the ~10 most important papers with one-line descriptions

Evidence:
{evidence_cards}
```

**Large clusters (>25 papers)**: Two calls.
1. First call: all evidence cards → structured outline with section names and paper assignments per section
2. Second call: single call with the outline + per-section evidence cards (only the papers assigned to each section) → all section text with citations. This is one API call, not one per section.

### Stage 3: Assembly (deterministic, no API calls)

- Prepend YAML frontmatter (generated programmatically from SQLite metadata):
  ```yaml
  ---
  title: "Autism Genetics & GWAS"
  type: synthesis
  cluster_id: 12
  paper_count: 47
  generated: 2026-04-10
  status: current
  tags: [autism, GWAS, psychiatric-genetics]
  ---
  ```
- Append `## References` section — full citation for every paper cited in the text:
  ```
  - [Aivazidis2025-hw] Aivazidis A, Memi F, et al. "A spatial transcriptomic atlas..." bioRxiv (2025). doi:10.1101/2025.11.05.685843
  ```
- Parse citations from text → update `paper_synthesis` table
- **Cross-link**: If a cited paper belongs to a different cluster that has a synthesis page, and the clusters share >10% of papers OR centroid cosine similarity > 0.7, add an Obsidian wikilink `[[other-cluster-slug]]` near the first mention. Quality over quantity.
- **Rollback**: Before writing, store previous synthesis content in `synthesis_history` table.
- Write to `/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile/{slug}.md`

### Stage 4: Index Generation (deterministic)

Generate `INDEX.md` from BERTopic's hierarchical topic tree:

```markdown
# Paperpile Wiki

Generated: 2026-04-10 | 5,721 papers | 127 topics | [Hierarchy visualization](.meta/hierarchy.html)

## Psychiatric Genetics
- [[autism-genetics-gwas]] — 47 papers — Common variant architecture, GWAS findings, PRS
- [[schizophrenia-common-variants]] — 38 papers — GWAS loci, fine-mapping, gene prioritization
- [[cross-disorder-pleiotropy]] — 22 papers — Shared genetic architecture across disorders

## Brain Transcriptomics
- [[single-cell-brain-atlases]] — 61 papers — Cell type taxonomies, developmental trajectories
- [[spatial-transcriptomics-methods]] — 29 papers — Technology and analysis approaches
...
```

Also generate BERTopic hierarchy visualization as HTML in `.meta/hierarchy.html`.

### Cost

- ~100-200 clusters × 1-2 Claude Sonnet calls = ~200-400 API calls
- Per call: ~2-4K input tokens, ~500-1.5K output tokens
- Total: ~1.2M input + ~500K output tokens
- At Sonnet pricing ($3/$15 per M tokens): **~$8-15 for bootstrap**
- Credential proxy handles routing; backoff/retry on rate limits

### Concurrency

- Max 5 concurrent API calls (configurable via `--concurrency`)
- Exponential backoff on 429/529 errors
- Progress committed to SQLite after each cluster — resumable on interruption
- `--dry-run` flag shows what would be generated without calling Claude

## Maintenance

### Monthly: Nearest-Centroid Assignment

Launchd job: `com.nanoclaw.paperpile-wiki.plist` — 1st of each month, 3 AM.
Orchestrator: `scripts/paperpile-wiki/maintain.sh`

1. **Ingest new papers**: Run `ingest.py --incremental`
   - Parse new BibTeX entries, embed with SPECTER2 (~seconds for <100 new papers)
   - Assign to existing clusters by cosine similarity to stored centroids (no re-clustering)
   - New papers get `cluster_confidence` proportional to similarity score
   - `is_new=1` on all new papers
2. **Detect stale clusters**: A cluster is stale if it gained ≥3 new papers since last synthesis generation
3. **Re-synthesize stale clusters**: Run `synthesize.py --stale-only`
4. **Re-index QMD**: `qmd update paperpile && qmd embed paperpile`
5. **Log**: Append to `scripts/paperpile-wiki/pipeline.log`:
   ```
   2026-05-01 03:00 | papers: 5,843 (+122) | new_to_clusters: 122 | stale: 8 | regenerated: 8 | cost: $1.80 | duration: 6m
   ```

Monthly cost: **~$2-5** (only stale clusters regenerated).

### Quarterly: Full Re-Cluster

Manually triggered or on a quarterly cron. Run `ingest.py --full-recluster`.

1. Re-embed any papers with stale embeddings
2. Full BERTopic clustering on all papers
3. **Cluster matching**: Hungarian algorithm on centroid cosine distances to map old cluster IDs → new cluster IDs. Threshold: clusters with centroid similarity >0.8 are considered "same topic"
4. For matched clusters with >20% membership change: mark stale, regenerate synthesis
5. For new clusters (no match above threshold): create new synthesis page
6. For dissolved clusters (old cluster with no match): archive old synthesis page (move to `.meta/archived/`), don't delete
7. Re-synthesize all affected clusters
8. Regenerate INDEX.md

## Agent Access

### QMD Collection

New collection `paperpile` registered in QMD config:
- Source: `/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile/`
- Indexed in the existing 8-hourly sync cycle (`scripts/sync/sync-all.sh`)
- Agents query via `mcp__qmd__query` with `collection: "paperpile"`

### Container Skill

`container/skills/paperpile/SKILL.md` — teaches agents how to use the paperpile wiki:

- Search synthesis pages via QMD scoped to `collection: "paperpile"`
- Citation format: `[AuthorYear-xx]` matching BibTeX keys
- When user asks to go deeper on a topic: fetch PDFs via PageIndex, regenerate with full-text evidence, update the synthesis page
- When user asks "what papers do we have about X?": search QMD, return synthesis summary + paper list
- Available to all groups (most relevant for SCIENCE-claw and CLAIRE)

No new MCP tools required.

## File Layout

```
scripts/paperpile-wiki/
├── ingest.py              # BibTeX parse → SPECTER2 embed → BERTopic cluster
├── synthesize.py          # Claude API synthesis pipeline
├── maintain.sh            # Monthly orchestrator
├── setup.sh               # First-time setup (venv, deps, schema, QMD collection, launchd)
├── requirements.txt       # Pinned dependencies
├── pipeline.log           # Maintained by maintain.sh
└── README.md              # Usage docs

store/
└── paperpile.db           # SQLite graph (papers, clusters, synthesis_pages, etc.)

/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile/
├── INDEX.md               # Hierarchical topic tree with wikilinks
├── autism-genetics-gwas.md
├── single-cell-brain-atlases.md
├── spatial-transcriptomics-methods.md
├── ...                    # ~100-200 synthesis pages
└── .meta/
    ├── hierarchy.html     # BERTopic interactive topic visualization
    └── archived/          # Dissolved cluster pages (from quarterly re-cluster)

container/skills/paperpile/
└── SKILL.md               # Agent instructions for paperpile wiki

launchd/
└── com.nanoclaw.paperpile-wiki.plist  # Monthly maintenance (1st of month, 3 AM)
```

## Dependencies

Python venv at `scripts/paperpile-wiki/.venv/`:

```
# Core parsing
bibtexparser>=2.0

# SPECTER2 embeddings
adapters>=1.2.0
transformers>=4.40
torch>=2.3.0,<2.6  # Pin to avoid MPS breakage

# BERTopic clustering
bertopic>=0.16
umap-learn>=0.5.6
hdbscan>=0.8.33
scikit-learn>=1.4

# Synthesis
anthropic>=0.40  # For credential proxy routing

# Ollama labeling (BERTopic representation)
openai>=1.0  # OpenAI-compatible client for Ollama

# PDF text extraction (optional, for enrichment)
# Uses system pdftotext (/opt/homebrew/bin/pdftotext)

# Utilities
numpy>=1.26
pandas>=2.2
scipy>=1.12  # For Hungarian algorithm (cluster matching)
python-Levenshtein>=0.25  # For fuzzy PDF matching
```

## Error Handling

| Failure | Behavior |
|---------|----------|
| Google Drive unmounted | Skip PDF enrichment, generate abstract-only synthesis, log warning |
| Ollama down | Skip LLM topic labeling, use c-TF-IDF keyword labels (less readable but functional) |
| Claude API 429/529 | Exponential backoff (3 retries, 5s/15s/45s). Cluster stays stale on failure, retried next run. |
| BibTeX parse error | Skip malformed entry, log warning, continue with remaining entries |
| pdftotext failure | Skip enrichment for that paper, log warning, use abstract-only evidence card |
| Paperpile.bib mid-sync | Check file modification time stability (unchanged for >60s) before parsing |

## Testing

- **Unit**: BibTeX parsing edge cases (unicode authors, missing fields, consortia). PDF fuzzy matching. Citation extraction from synthesis text. Noise paper reassignment.
- **Integration**: Run full pipeline on a 50-paper subset. Verify: correct cluster count, synthesis pages generated, INDEX.md valid, QMD indexable.
- **Dry run**: `synthesize.py --dry-run` shows cluster list, paper counts, estimated cost, evidence card previews — no API calls.
- **Smoke test**: After bootstrap, verify all synthesis pages have valid frontmatter, no broken wikilinks, all cited papers exist in References section.

## Success Criteria

1. All 5,721 papers assigned to clusters (zero unassigned)
2. ~100-200 synthesis pages generated in the vault
3. INDEX.md provides a navigable topic hierarchy
4. QMD searches over the collection return relevant synthesis pages
5. Container agents (SCIENCE-claw, CLAIRE) can answer "what does the literature say about X?" using the wiki
6. Monthly maintenance runs unattended, costs <$5/month
7. Pages are readable and useful in Obsidian (valid markdown, working wikilinks, proper frontmatter)
