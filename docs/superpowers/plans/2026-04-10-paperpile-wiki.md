# Paperpile Wiki Implementation Plan

> **Status: SHIPPED (built, not yet bootstrapped).** Pipeline modules live at `scripts/paperpile/` (`bibtex_parser.py`, `clusterer.py`, `cross_linker.py`). 5,716 papers → SPECTER2 embeddings → 49 BERTopic clusters → Claude synthesis pipeline runs end-to-end; awaiting bootstrap into the live wiki. Open `- [ ]` boxes never updated retroactively.

**Goal:** Build a Python pipeline that auto-synthesizes ~5,700 academic papers into a navigable Obsidian wiki with QMD-indexed topic pages.

**Architecture:** Three Python scripts (ingest, synthesize, maintain) operating on a SQLite graph database. SPECTER2 embeddings + BERTopic clustering discover topics. Claude Sonnet (via credential proxy) writes synthesis pages. Output is markdown in the Obsidian vault, indexed by QMD.

**Tech Stack:** Python 3.11+, bibtexparser, SPECTER2 (adapters + transformers + torch), BERTopic (umap-learn + hdbscan), anthropic SDK, SQLite, Ollama (qwen3:8b for labeling)

**Spec:** `docs/superpowers/specs/2026-04-10-paperpile-wiki-design.md`

---

## File Structure

```
scripts/paperpile-wiki/
├── __init__.py                # Empty (makes it a package for test imports)
├── db.py                      # SQLite schema, migrations, CRUD operations
├── bibtex_parser.py           # BibTeX → structured paper dicts
├── pdf_matcher.py             # Match BibTeX entries to PDFs via DOI/fuzzy
├── embedder.py                # SPECTER2 embedding (batch, MPS-aware)
├── clusterer.py               # BERTopic clustering + Ollama labeling
├── synthesizer.py             # Claude API synthesis (evidence cards → markdown)
├── cross_linker.py            # Deterministic cross-linking + INDEX.md generation
├── ingest.py                  # CLI: orchestrates parse → embed → cluster
├── synthesize.py              # CLI: orchestrates evidence → write → assemble
├── maintain.sh                # Monthly orchestrator (shell)
├── setup.sh                   # First-time setup (venv, deps, schema, QMD)
├── requirements.txt           # Pinned dependencies
├── tests/
│   ├── __init__.py
│   ├── test_bibtex_parser.py
│   ├── test_pdf_matcher.py
│   ├── test_db.py
│   ├── test_embedder.py
│   ├── test_clusterer.py
│   ├── test_synthesizer.py
│   ├── test_cross_linker.py
│   └── fixtures/
│       ├── sample.bib          # 20-entry BibTeX for testing
│       └── sample_export.json  # Matching Paperpile JSON fragment

store/
└── paperpile.db               # Created by db.py on first run

/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile/
├── INDEX.md
├── *.md                       # Synthesis pages
└── .meta/
    ├── hierarchy.html
    └── archived/

container/skills/paperpile/
└── SKILL.md

launchd/
└── com.nanoclaw.paperpile-wiki.plist
```

---

## Tasks

See the full task details in the plan body below. Summary:

| Task | Description | Key Files |
|------|------------|-----------|
| 1 | Project scaffolding + SQLite schema | db.py, requirements.txt, setup.sh |
| 2 | BibTeX parser | bibtex_parser.py |
| 3 | PDF matcher | pdf_matcher.py |
| 4 | SPECTER2 embedder | embedder.py |
| 5 | BERTopic clusterer | clusterer.py |
| 6 | Ingest CLI orchestrator | ingest.py |
| 7 | Synthesis pipeline | synthesizer.py |
| 8 | Cross-linker + INDEX.md | cross_linker.py |
| 9 | Synthesize CLI orchestrator | synthesize.py |
| 10 | Container skill + maintenance + launchd | SKILL.md, maintain.sh, plist |
| 11 | End-to-end integration test | (tests existing pipeline) |
| 12 | Full bootstrap run | (runs full pipeline on real data) |

---

### Task 1: Project Scaffolding + SQLite Schema

**Files:**
- Create: `scripts/paperpile-wiki/__init__.py`
- Create: `scripts/paperpile-wiki/db.py`
- Create: `scripts/paperpile-wiki/requirements.txt`
- Create: `scripts/paperpile-wiki/setup.sh`
- Create: `scripts/paperpile-wiki/tests/__init__.py`
- Create: `scripts/paperpile-wiki/tests/test_db.py`
- Modify: `package.json` (add setup script)

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p scripts/paperpile-wiki/tests/fixtures
touch scripts/paperpile-wiki/__init__.py
touch scripts/paperpile-wiki/tests/__init__.py
```

- [ ] **Step 2: Write requirements.txt**

Create `scripts/paperpile-wiki/requirements.txt`:

```
# Core parsing
bibtexparser>=2.0.0,<3.0

# SPECTER2 embeddings
adapters>=1.2.0,<2.0
transformers>=4.40,<5.0
torch>=2.3.0,<2.6

# BERTopic clustering
bertopic>=0.16,<1.0
umap-learn>=0.5.6,<1.0
hdbscan>=0.8.33,<1.0
scikit-learn>=1.4,<2.0

# Synthesis (Claude API via credential proxy)
anthropic>=0.40.0,<1.0

# Ollama labeling (OpenAI-compatible client)
openai>=1.0,<2.0

# Utilities
numpy>=1.26,<3.0
pandas>=2.2,<3.0
scipy>=1.12,<2.0
python-Levenshtein>=0.25,<1.0

# Testing
pytest>=8.0
```

- [ ] **Step 3: Write setup.sh**

Create `scripts/paperpile-wiki/setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$SCRIPT_DIR/venv"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Paperpile Wiki Setup ==="

# 1. Create venv
if [ ! -d "$VENV" ]; then
    echo "[1/4] Creating Python venv..."
    python3 -m venv "$VENV"
else
    echo "[1/4] Venv exists, skipping creation"
fi

# 2. Install dependencies
echo "[2/4] Installing dependencies..."
"$VENV/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt"

# 3. Initialize SQLite schema
echo "[3/4] Initializing database..."
"$VENV/bin/python3" -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
from db import init_db
init_db('$PROJECT_ROOT/store/paperpile.db')
print('Database initialized at store/paperpile.db')
"

# 4. Create output directories
echo "[4/4] Creating output directories..."
mkdir -p /Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile/.meta/archived

echo "=== Setup complete ==="
echo "Run: scripts/paperpile-wiki/venv/bin/python3 scripts/paperpile-wiki/ingest.py --help"
```

- [ ] **Step 4: Write the failing test for db.py**

Create `scripts/paperpile-wiki/tests/test_db.py` with tests for: schema version, upsert/get paper, upsert idempotency, cluster CRUD, papers by cluster, synthesis stale detection, synthesis history.

See spec for full schema. Key tables: papers, clusters, synthesis_pages, paper_synthesis, synthesis_history, schema_version.

- [ ] **Step 5: Run tests to verify they fail**

```bash
cd scripts/paperpile-wiki && venv/bin/python3 -m pytest tests/test_db.py -v
```

Expected: FAIL with ModuleNotFoundError

- [ ] **Step 6: Write db.py**

Implement SQLite schema with WAL mode, foreign keys, and CRUD functions:
- `init_db(path)` — create tables, set schema version
- `get_db(path)` — open existing DB
- `upsert_paper(db, paper_dict)` — INSERT OR UPDATE, preserve pdf_path on update
- `get_paper(db, id)`, `get_papers_by_cluster(db, cluster_id)`
- `get_papers_missing_embeddings(db)`, `get_new_papers(db)`
- `update_paper_embedding(db, id, blob)`, `update_paper_cluster(db, id, cluster_id, confidence)`
- `mark_papers_incorporated(db, paper_ids)` — set is_new=0
- `upsert_cluster(db, cluster_dict)`, `get_cluster(db, id)`, `get_all_clusters(db)`
- `upsert_synthesis_page(db, synth_dict)` — returns ID
- `mark_synthesis_stale(db, cluster_id)`, `get_stale_syntheses(db)` — joins with clusters
- `save_synthesis_history(db, synthesis_id, content)`
- `record_paper_synthesis(db, paper_id, synthesis_id, role)`
- `get_total_paper_count(db)`, `get_new_paper_count_for_cluster(db, cluster_id)`

All timestamps use UTC ISO format via `datetime.now(timezone.utc).isoformat()`.

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd scripts/paperpile-wiki && venv/bin/python3 -m pytest tests/test_db.py -v
```

Expected: All 7 tests PASS

- [ ] **Step 8: Add npm setup script to package.json**

Add to `scripts` in `package.json`:

```json
"setup:paperpile-wiki": "cd scripts/paperpile-wiki && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
```

- [ ] **Step 9: Commit**

```bash
git add scripts/paperpile-wiki/__init__.py scripts/paperpile-wiki/db.py \
       scripts/paperpile-wiki/requirements.txt scripts/paperpile-wiki/setup.sh \
       scripts/paperpile-wiki/tests/__init__.py scripts/paperpile-wiki/tests/test_db.py \
       package.json
git commit -m "feat(paperpile-wiki): add project scaffolding and SQLite schema"
```

---

### Task 2: BibTeX Parser

**Files:**
- Create: `scripts/paperpile-wiki/bibtex_parser.py`
- Create: `scripts/paperpile-wiki/tests/test_bibtex_parser.py`
- Create: `scripts/paperpile-wiki/tests/fixtures/sample.bib`

- [ ] **Step 1: Create test fixture**

Copy ~20 diverse entries from `~/.hermes/paperpile.bib` covering: standard entry, unicode authors, missing abstract, consortium author, keywords field, MISC type, Gandal as author.

- [ ] **Step 2: Write the failing test**

Test: `extract_first_author` (standard, single, unicode, consortium, empty, None), `parse_entry` (full fields, missing abstract, year parsing), `parse_bib_file` (sample fixture, optional smoke test on full library checking >5000 entries and unique IDs).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd scripts/paperpile-wiki && venv/bin/python3 -m pytest tests/test_bibtex_parser.py -v
```

- [ ] **Step 4: Write bibtex_parser.py**

Functions:
- `extract_first_author(author_str)` — handles "Last, First and ..." format, braced consortia, None
- `_clean_text(text)` — strip braces, collapse whitespace
- `_semicolon_authors(author_str)` — convert " and " separators to ";"
- `_parse_year(year_str)` — int conversion with regex fallback
- `parse_entry(entry_id, entry_dict)` — returns paper dict with all fields
- `parse_bib_file(path)` — uses bibtexparser v2 API, returns list of paper dicts

Uses `bibtexparser.parse()` (v2 API). Handles `entry.key`, `entry.fields`, `entry.entry_type`.

- [ ] **Step 5: Run tests to verify they pass**

- [ ] **Step 6: Commit**

```bash
git add scripts/paperpile-wiki/bibtex_parser.py scripts/paperpile-wiki/tests/test_bibtex_parser.py
git commit -m "feat(paperpile-wiki): add BibTeX parser with author extraction"
```

---

### Task 3: PDF Matcher

**Files:**
- Create: `scripts/paperpile-wiki/pdf_matcher.py`
- Create: `scripts/paperpile-wiki/tests/test_pdf_matcher.py`

- [ ] **Step 1: Write the failing test**

Test: `normalize_author` (standard, unicode, umlaut, hyphenated), `fuzzy_match_filename` (exact match >0.9, no match <0.5, year mismatch <0.5), `scan_pdf_directory` (smoke test on real Paperpile folder if mounted).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write pdf_matcher.py**

Functions:
- `normalize_author(name)` — NFKD decomposition, strip combining chars, lowercase
- `scan_pdf_directory(directory)` — recursive os.walk for .pdf files
- `match_by_doi_from_json(json_path, papers)` — parse Paperpile JSON export, match by DOI
- `_extract_last_author(authors_str)` — from semicolon-separated format
- `fuzzy_match_filename(first_author, last_author, year, filename)` — Levenshtein ratio on normalized author prefix, year check
- `match_papers_to_pdfs(papers, pdf_dir, json_path, threshold=0.85)` — orchestrator combining DOI + fuzzy matching

Uses `python-Levenshtein` for `ratio()` function.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add scripts/paperpile-wiki/pdf_matcher.py scripts/paperpile-wiki/tests/test_pdf_matcher.py
git commit -m "feat(paperpile-wiki): add PDF fuzzy matcher with DOI+filename matching"
```

---

### Task 4: SPECTER2 Embedder

**Files:**
- Create: `scripts/paperpile-wiki/embedder.py`
- Create: `scripts/paperpile-wiki/tests/test_embedder.py`

- [ ] **Step 1: Write the failing test**

Test: `embedding_to_bytes` / `bytes_to_embedding` round-trip (768-dim, correct byte count 3072), `embed_papers` on 2 papers (returns bytes per paper ID, correct length), missing abstract handling (title-only embed).

Tests that need the model skip with `self.skipTest()` if ImportError or OSError.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write embedder.py**

Constants: `EMBEDDING_DIM=768`, `BATCH_SIZE=32`, `MODEL_NAME='allenai/specter2_base'`, `ADAPTER_NAME='allenai/specter2'`

Functions:
- `embedding_to_bytes(vec)` — numpy float32 tobytes or struct.pack
- `bytes_to_embedding(blob)` — struct.unpack
- `_load_model()` — load tokenizer + AutoAdapterModel + proximity adapter, move to MPS/CPU
- `embed_papers(papers, batch_size=32)` — format `title[SEP]abstract`, batch through model, return `{id: bytes}`

Uses `adapters.AutoAdapterModel`, torch MPS detection, progress logging.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add scripts/paperpile-wiki/embedder.py scripts/paperpile-wiki/tests/test_embedder.py
git commit -m "feat(paperpile-wiki): add SPECTER2 embedder with MPS support"
```

---

### Task 5: BERTopic Clusterer

**Files:**
- Create: `scripts/paperpile-wiki/clusterer.py`
- Create: `scripts/paperpile-wiki/tests/test_clusterer.py`

- [ ] **Step 1: Write the failing test**

Test: `slugify` (basic, special chars, spaces), `assign_noise_to_nearest` (reassignment + confidence, no-noise case), `assign_new_papers_to_clusters` (nearest centroid assignment).

All tests use small numpy arrays — no model loading needed.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write clusterer.py**

Functions:
- `slugify(text)` — lowercase, strip non-alphanumeric, collapse hyphens
- `_compute_centroids(embeddings, topics)` — mean embedding per cluster, exclude noise
- `assign_noise_to_nearest(topics, embeddings, centroids)` — cosine similarity to nearest centroid, return (new_topics, confidences)
- `assign_new_papers_to_clusters(new_embeddings, centroids)` — cosine sim to centroids, return [(cluster_id, confidence)]
- `build_hierarchy(topic_model, docs)` — extract BERTopic hierarchical_topics, return parent/child relationships
- `_get_ollama_labeler()` — BERTopic OpenAI representation model pointing at localhost:11434
- `cluster_papers(abstracts, embeddings, min_cluster_size=30, use_ollama=True)` — full BERTopic pipeline: UMAP + HDBSCAN + c-TF-IDF + optional Ollama labels

BERTopic config: UMAP(n_neighbors=15, n_components=5, min_dist=0.0, cosine, seed=42), HDBSCAN(min_cluster_size=30, min_samples=10, eom), CountVectorizer(english stop words, bigrams, min_df=5).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add scripts/paperpile-wiki/clusterer.py scripts/paperpile-wiki/tests/test_clusterer.py
git commit -m "feat(paperpile-wiki): add BERTopic clusterer with noise reassignment"
```

---

### Task 6: Ingest CLI (Orchestrator)

**Files:**
- Create: `scripts/paperpile-wiki/ingest.py`

- [ ] **Step 1: Write ingest.py**

CLI with argparse: `--incremental`, `--full-recluster`, `--skip-pdf`, `--bib PATH`, `--db PATH`

Orchestrates 4 stages:
1. `run_parse(db, bib_path)` — parse BibTeX, upsert papers, return new count
2. `run_pdf_match(db, papers)` — match PDFs, update pdf_path (skip if --skip-pdf)
3. `run_embed(db)` — embed papers missing embeddings
4. `run_cluster(db, full_recluster)` — if incremental: assign new papers to existing centroids + detect stale (>=3 new papers). If full: BERTopic cluster all, reassign noise, write clusters + hierarchy to DB.

BibTeX stability check: compare mtime before and after 1s sleep. If changed, wait 60s.

Default paths: `DB_PATH = PROJECT_ROOT/store/paperpile.db`, `BIB_PATH = ~/.hermes/paperpile.bib`

- [ ] **Step 2: Smoke test on real data**

```bash
cd scripts/paperpile-wiki && venv/bin/python3 ingest.py --skip-pdf
```

Expected: ~5,721 papers parsed, embedded, clustered. ~2 minutes total.

- [ ] **Step 3: Commit**

```bash
git add scripts/paperpile-wiki/ingest.py
git commit -m "feat(paperpile-wiki): add ingest CLI (parse, embed, cluster)"
```

---

### Task 7: Synthesis Pipeline

**Files:**
- Create: `scripts/paperpile-wiki/synthesizer.py`
- Create: `scripts/paperpile-wiki/tests/test_synthesizer.py`

- [ ] **Step 1: Write the failing test**

Test: `format_evidence_card` (full paper, missing abstract — no "None" in output), `extract_citations` (standard [Key2024-xx] format, no citations, dedup), `build_frontmatter` (title, cluster_id, type, status), `build_references_section` (formatted citation with doi).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write synthesizer.py**

Constants: `MODEL="claude-sonnet-4-6"`, `MAX_EVIDENCE_PAPERS=40`, `PDFTOTEXT='/opt/homebrew/bin/pdftotext'`

Functions:
- `format_evidence_card(paper, enrichment_text=None)` — format [Key] "Title" | Authors | Journal | Year | Abstract
- `_enrich_own_paper(paper)` — pdftotext extract intro+discussion if Gandal in authors and pdf_path set
- `select_papers_for_cluster(papers, centroid, max=40)` — closest to centroid by cosine similarity
- `build_prompt_small(name, description, cards)` — single-call prompt for <=25 papers
- `build_prompt_outline(name, description, cards)` — outline prompt for >25 papers
- `build_prompt_sections(name, outline, cards)` — section-writing prompt
- `extract_citations(text)` — regex `\[([A-Za-z]\w+-\d{4}-[a-z]{2})\]`, deduplicate
- `build_frontmatter(title, cluster_id, paper_count, tags)` — YAML frontmatter string
- `build_references_section(cited_ids, papers_by_id)` — formatted reference list
- `synthesize_cluster(client, cluster, papers, papers_by_id, dry_run=False)` — full pipeline, returns (markdown, cost_usd)

Uses `anthropic.Anthropic()` which reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from env (credential proxy pattern from `scripts/pageindex/adapter.py`).

Cost tracking: `(input_tokens * 3.0 / 1M) + (output_tokens * 15.0 / 1M)` for Sonnet pricing.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add scripts/paperpile-wiki/synthesizer.py scripts/paperpile-wiki/tests/test_synthesizer.py
git commit -m "feat(paperpile-wiki): add synthesis pipeline with Claude API integration"
```

---

### Task 8: Cross-Linker + Index Generator

**Files:**
- Create: `scripts/paperpile-wiki/cross_linker.py`
- Create: `scripts/paperpile-wiki/tests/test_cross_linker.py`

- [ ] **Step 1: Write the failing test**

Test: `find_cross_links` (shared papers above threshold, no shared papers), `inject_wikilinks` (inject once, no duplicates), `generate_index_md` (header, wikilinks, paper counts).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Write cross_linker.py**

Functions:
- `find_cross_links(cluster_papers, share_threshold=0.1)` — pairwise set intersection, return [(slug_a, slug_b)]
- `inject_wikilinks(text, target_slugs, slug_to_name)` — add "See also: [[slug]]" before References section, once per slug
- `generate_index_md(clusters, total_papers)` — hierarchical listing with wikilinks, paper counts, descriptions. Groups by parent_id.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add scripts/paperpile-wiki/cross_linker.py scripts/paperpile-wiki/tests/test_cross_linker.py
git commit -m "feat(paperpile-wiki): add deterministic cross-linker and INDEX.md generator"
```

---

### Task 9: Synthesize CLI (Orchestrator)

**Files:**
- Create: `scripts/paperpile-wiki/synthesize.py`

- [ ] **Step 1: Write synthesize.py**

CLI with argparse: `--stale-only`, `--dry-run`, `--cluster-id N`, `--concurrency N`, `--db PATH`

Checks `ANTHROPIC_BASE_URL` env var (errors if missing and not dry-run).

Main flow:
1. Determine target clusters (specific ID, stale-only, or all needing synthesis)
2. For each cluster: save previous version to synthesis_history, call `synthesize_cluster()`, write markdown file, update synthesis_pages table, record citations in paper_synthesis, mark papers incorporated
3. Run cross-linking on all synthesis pages
4. Generate INDEX.md
5. Report total cost and time

Output dir: `/Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile/`

- [ ] **Step 2: Test with dry-run**

```bash
cd scripts/paperpile-wiki && venv/bin/python3 synthesize.py --dry-run
```

Expected: Lists clusters, paper counts, strategies. No API calls.

- [ ] **Step 3: Commit**

```bash
git add scripts/paperpile-wiki/synthesize.py
git commit -m "feat(paperpile-wiki): add synthesize CLI with dry-run and credential proxy"
```

---

### Task 10: Container Skill + Maintenance + Launchd

**Files:**
- Create: `container/skills/paperpile/SKILL.md`
- Create: `scripts/paperpile-wiki/maintain.sh`
- Create: `launchd/com.nanoclaw.paperpile-wiki.plist`

- [ ] **Step 1: Write container skill**

`container/skills/paperpile/SKILL.md` — instructs agents to search QMD collection "paperpile", use [AuthorYear-xx] citation format, offer to enrich shallow pages via PageIndex.

- [ ] **Step 2: Write maintain.sh**

Shell script orchestrating monthly maintenance:
1. `ingest.py --incremental --skip-pdf` (assign new papers to existing clusters)
2. `synthesize.py --stale-only` (only if ANTHROPIC_BASE_URL is set)
3. `qmd update && qmd embed`

Logs to `scripts/paperpile-wiki/pipeline.log` via `tee -a`. Reports error count.

- [ ] **Step 3: Make maintain.sh executable**

```bash
chmod +x scripts/paperpile-wiki/maintain.sh
```

- [ ] **Step 4: Write launchd plist**

`com.nanoclaw.paperpile-wiki.plist` — runs maintain.sh on 1st of each month at 3 AM. Logs to `logs/paperpile-wiki.log`. Sets HOME and PATH.

- [ ] **Step 5: Commit**

```bash
git add container/skills/paperpile/SKILL.md scripts/paperpile-wiki/maintain.sh \
       launchd/com.nanoclaw.paperpile-wiki.plist
git commit -m "feat(paperpile-wiki): add container skill, maintenance script, and launchd plist"
```

---

### Task 11: End-to-End Integration Test

- [ ] **Step 1: Run setup**

```bash
chmod +x scripts/paperpile-wiki/setup.sh && scripts/paperpile-wiki/setup.sh
```

- [ ] **Step 2: Run full ingest on real data**

```bash
scripts/paperpile-wiki/venv/bin/python3 scripts/paperpile-wiki/ingest.py --skip-pdf
```

Expected: ~5,721 papers parsed, embedded (~35s), clustered (~75s).

- [ ] **Step 3: Review clustering results**

Query SQLite for cluster count, top 20 by paper count, noise paper reassignment count. Inspect topic labels for quality.

- [ ] **Step 4: Run synthesis dry-run**

```bash
scripts/paperpile-wiki/venv/bin/python3 scripts/paperpile-wiki/synthesize.py --dry-run
```

- [ ] **Step 5: Test synthesis on a single cluster**

Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY=placeholder`, run `synthesize.py --cluster-id <ID>`. Inspect output markdown.

- [ ] **Step 6: Run all unit tests**

```bash
cd scripts/paperpile-wiki && venv/bin/python3 -m pytest tests/ -v
```

- [ ] **Step 7: Verify output in Obsidian**

Check INDEX.md, synthesis page frontmatter, wikilinks.

- [ ] **Step 8: Commit any fixes**

```bash
git add -u
git commit -m "fix(paperpile-wiki): integration test fixes"
```

---

### Task 12: Full Bootstrap Run

- [ ] **Step 1: Run full synthesis**

```bash
export ANTHROPIC_BASE_URL="http://localhost:3001/YOUR_PROXY_TOKEN"
export ANTHROPIC_API_KEY="placeholder"
scripts/paperpile-wiki/venv/bin/python3 scripts/paperpile-wiki/synthesize.py
```

Expected: 30-90 minutes, ~$8-15 cost.

- [ ] **Step 2: Verify the wiki**

```bash
ls /Volumes/sandisk4TB/marvin-vault/98-nanoKB/paperpile/*.md | wc -l
```

Expected: ~100-200 files.

- [ ] **Step 3: Register QMD collection and index**

```bash
qmd update && qmd embed
```

Verify with a test query against collection "paperpile".

- [ ] **Step 4: Install launchd plist**

```bash
cp launchd/com.nanoclaw.paperpile-wiki.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.paperpile-wiki.plist
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(paperpile-wiki): complete bootstrap with wiki generated and indexed"
```
