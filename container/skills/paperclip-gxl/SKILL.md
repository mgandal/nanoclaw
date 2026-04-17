---
name: paperclip-gxl
description: Search and read 8M+ biomedical papers from bioRxiv, medRxiv, and PubMed Central using the paperclip CLI (GXL-ai, paperclip.gxl.ai). Do NOT confuse with the `paperclip` control-plane skill — different product, same name collision.
---

# Paperclip â 8M+ Biomedical Papers

You have access to **paperclip**, a CLI for searching and reading 8M+ full-text
biomedical papers from bioRxiv, medRxiv, and PubMed Central (PMC).

## Commands

### search â Find papers
```bash
paperclip search "CRISPR delivery nanoparticle"
paperclip search "protein design" -n 50
paperclip search -s pmc "mRNA vaccine"                # PMC only
paperclip search -s biorxiv "single cell"              # bioRxiv only
paperclip search -e "genome-wide association study"    # exact phrase
paperclip search "AlphaFold" --since 30d               # recent papers
paperclip search "cancer" --journal "Cell" --year 2024  # combine filters
paperclip search "deep learning" --type review-article  # article type (PMC)
paperclip search --all "protein folding"                # full corpus (slower)
paperclip search --ranking vector "immune evasion"      # semantic vector search only
paperclip search --ranking bm25 "TP53 R175H"            # keyword BM25 only
```
Key options: `-n/--limit`, `-s/--source`, `-e/--exact`, `--since`, `--sort [relevance|date]`,
`--author`, `--journal`, `--year`, `--type`, `--category`, `-m/--mode [any|all]`.

### grep â Regex search across entire corpus (sub-second)
```bash
paperclip grep "alphamissense" /papers/              # find term across all 8M+ papers
paperclip grep -c "BRCA[12]" /papers/                 # count matches
paperclip grep "IC50.*nM" /papers/bio_4f78753a6feb/content.lines  # within one paper
```
Runs a server-side regex engine across the full corpus in under 1 second. Use for precise text matching. For topic-based discovery, use `search` instead.

### lookup â Find by metadata
```bash
paperclip lookup doi 10.1101/2024.01.15.575613
paperclip lookup pmc PMC7194329
paperclip lookup pmid 32943797
paperclip lookup author "David Baker" -n 10
paperclip lookup title "CRISPR base editing"
paperclip lookup journal "Nature Medicine"
```
Fields: doi, author, title, abstract, source, date, pmc, pmid,
publisher, type, keywords, category, license, year, volume, issue, issn.

### sql â Direct database queries
```bash
paperclip sql "SELECT source, COUNT(*) FROM documents GROUP BY source"
paperclip sql "SELECT title, doi, source FROM documents WHERE authors ILIKE '%Doudna%' LIMIT 5"
paperclip sql "SELECT journal_title, COUNT(*) FROM documents WHERE source = 'pmc' GROUP BY journal_title ORDER BY 2 DESC LIMIT 10"
paperclip sql "SELECT title, pub_date FROM documents WHERE abstract_text ILIKE '%CRISPR%' ORDER BY pub_date DESC LIMIT 10"
```
Read-only SELECT on the unified `documents` table across all sources. Use `--source pmc` or `--source biorxiv` to filter.

**Unified `documents` columns:**
- `id` â paper identifier (UUID for bioRxiv, PMC ID for PMC)
- `title`, `doi`, `authors`, `source`, `abstract_text` â available for all papers
- `pub_date` â publication date (text)
- `journal_title`, `article_type`, `pmid`, `pub_year` â PMC only (NULL for preprints)
- `keywords` (JSONB), `categories` (JSONB) â PMC only

Only the `documents` table is accessible. 15s timeout, 200-row limit. When `id` appears in results, they auto-save as a result page for use with `map`.

### results â View saved results
```bash
paperclip results --list              # list recent result IDs
paperclip results s_4a2b61f6          # view a specific search result
paperclip results m_ec2c9cc9          # view a specific map result
```
Search and map commands automatically save results with IDs (e.g. `s_xxx`, `m_xxx`).

### Reading papers â filesystem commands

Papers live on a virtual filesystem at `/papers/<id>/`. Use standard UNIX commands directly:
```bash
paperclip cat /papers/<id>/meta.json
paperclip head -40 /papers/<id>/content.lines
paperclip ls /papers/<id>/sections/
paperclip grep -i "CRISPR" /papers/<id>/content.lines
paperclip scan /papers/<id>/content.lines "AAV" "efficiency"   # multi-keyword search
paperclip tail -20 /papers/<id>/content.lines
paperclip awk -F, 'NR==1 || $3>100' /papers/<id>/supplements/data.csv
paperclip sed -n '10,20p' /papers/<id>/content.lines
```
Available commands: `cat`, `head`, `tail`, `ls`, `grep`, `scan`, `sed`, `awk`, `sort`, `cut`, `tr`, `jq`.
`scan` finds multiple patterns in one call â faster than repeated grep.

**Important:** Always use the direct syntax (`paperclip cat`, `paperclip head`, etc.) for single commands. Only use `paperclip bash '...'` when you need **pipes** or **output redirection to `/.gxl/`**:
```bash
paperclip bash 'search "CRISPR lipid nanoparticle" | grep -iE "lung|liver|in vivo"'
paperclip bash 'grep -i "IC50" /papers/<id>/content.lines | head -20'
paperclip bash 'grep -i "IC50" /papers/<id>/content.lines > /.gxl/ic50_hits.txt'
```
**Never** use `paperclip bash 'cat ...'` or `paperclip bash 'ls ...'` â use `paperclip cat ...` and `paperclip ls ...` directly.

#### Writable scratch: `/.gxl/`

Redirect output with `> /.gxl/file.txt` (via `bash`). Files persist for the session. `/papers/` is read-only.

```bash
paperclip bash 'grep -i "IC50" /papers/<id>/content.lines > /.gxl/ic50_hits.txt'
paperclip bash 'awk -F, "NR==1 || $3>100" /papers/<id>/supplements/data.csv > /.gxl/filtered.csv'
paperclip ls /.gxl/
```

#### Supplements (CSV / Excel)

Supplementary materials live under `supplements/` for many PMC papers:

```bash
paperclip ls /papers/<id>/supplements/
paperclip head -5 /papers/<id>/supplements/source_data.csv
paperclip bash 'awk -F, "NR==1 || $3>100" /papers/<id>/supplements/source_data.csv > /.gxl/filtered.csv'

# Save raw paper files to local machine with >
paperclip cat /papers/<id>/supplements/source_data.csv > source_data.csv
```

### Redirection â Save any output to a local file
Append `>` to any paperclip command to write its output to a local file. Use `>>` to append.
```bash
paperclip search "CRISPR delivery" -n 10 > crispr_results.txt
paperclip cat /papers/bio_abc/meta.json > meta.json
paperclip sql "SELECT title, doi FROM documents LIMIT 20" > papers.txt
paperclip grep "deep learning" /papers/bio_abc/ > matches.txt
```

### Saving files locally

`paperclip cat <path>` streams to stdout, so any file can be saved with a shell
redirect. Text files come back as text; figures and other binaries stream as
raw bytes when stdout is not a terminal.

```bash
paperclip cat /papers/PMC10791696/meta.json > meta.json
paperclip cat /papers/PMC10791696/content.lines > content.lines
paperclip cat /papers/bio_abc/figures/fig1.tif > fig1.tif   # binary bytes
paperclip cat /papers/PMC123/supplements/table.csv > table.csv
```

For bulk downloads, use a shell loop:

```bash
mkdir -p figures
for f in $(paperclip ls /papers/PMC10791696/figures/); do
  paperclip cat /papers/PMC10791696/figures/$f > figures/$f
done
```

### ask-image â Analyze figures with Gemini vision
```bash
paperclip ask-image <id>/figures/<filename> "What does this figure show?"
paperclip ask-image <id>/figures/<filename> --fn describe       # detailed description
paperclip ask-image <id>/figures/<filename> --fn extract-data   # extract numbers/stats
```
Use `paperclip ls /papers/<id>/figures/` first to see available figures.

### map â Summarize across papers
```bash
paperclip map "What delivery methods were used?"    # maps over last search results
```

### config â Settings and health check
```bash
paperclip config                     # show server, auth, and health status
paperclip config --url <URL>         # set server URL
```

## Paper Filesystem Layout

Each paper at `/papers/<id>/`:
```
meta.json        â title, authors, doi, date, abstract, journal
content.lines    â full text (line-numbered: L<n> [<block>]: <text>)
sections/        â named section files (Introduction.lines, Methods.lines, ...)
figures/         â figure files (PMC papers)
supplements/     â supplementary files (PMC papers)
```

Scratch space: `/.gxl/` â writable, maps to `CWD/.gxl/` on the user's machine.

## Recommended Workflow (tuned for speed)

1. **Search** â `paperclip search "your topic"` to find papers. Narrow with `paperclip bash 'search "broad query" | grep "must-have"'`.
2. **Pick a few papers** from titles/snippets; avoid `cat` on full `content.lines` until needed.
3. **Read metadata** â `paperclip cat /papers/<id>/meta.json` then `paperclip head -40 /papers/<id>/content.lines`.
4. **Targeted reading** â `paperclip ls /papers/<id>/sections/` then read the smallest relevant slice instead of the whole text.
5. **Find claims** â `paperclip grep` or `paperclip scan` for specific terms.
6. **Figures** â `paperclip ls /papers/<id>/figures/` then `paperclip ask-image ... --fn describe`.
7. **Supplements / data** â `paperclip ls /papers/<id>/supplements/` then process with `sed`/`awk` via bash, or save raw files with `paperclip cat /papers/<id>/supplements/<file> > <file>`.

## Citations

Cite papers inline using numbered markers **[1]**, **[2]**, etc. At the end of your response include a **REFERENCES** block:

```
--------
REFERENCES

[1] Author A, Author B, et al. "Title of the paper." *Journal Name* vol, pages (year). doi:XX.XXXX/XXXXXXX
    https://citations.gxl.ai/papers/PMC10791696#L45,L120

[2] Author C, Author D, et al. "Title of the paper." bioRxiv (year). doi:XX.XXXX/XXXXXXX
    https://citations.gxl.ai/papers/bio_214f7ec77685#L210
```

### Building the URL

Each reference MUST include a `citations.gxl.ai` link constructed from the paper's **internal doc_id** (the directory name under `/papers/`) and the `L<n>` line numbers where the cited claims appear:

```
https://citations.gxl.ai/papers/<doc_id>#L<n1>,L<n2>,...
```

- `<doc_id>` is the `/papers/` directory name (e.g. `PMC10791696`, `bio_214f7ec77685`).
- Line numbers come from the `L<n>` prefixes in `content.lines`.
- Single line: `#L45` â range: `#L45-L52` â multiple: `#L45,L120,L210`.

### Rules

- Nature citation style: Authors. "Title." *Journal* vol, pages (year). doi:XXXX
- Preprints: Authors. "Title." bioRxiv/medRxiv (year). doi:XXXX
- Get author names, title, DOI, and date from `meta.json`.
- The `citations.gxl.ai` URL is the **only** place where the internal doc_id appears â never expose it elsewhere in prose.
- Every factual claim from a paper must have a citation marker.
- Number references in the order they first appear.

## Tips

- Prefer `head -N`, section files, or `grep`/`scan` â avoid `cat` on the whole `content.lines`.
- `sed`, `awk`, `sort`, `cut`, `tr`, `jq` all work â use them freely for text processing.
- Use `> file.txt` after any command to save output locally, or `> /.gxl/file.txt` (via bash) to persist server-side for the session.
- Use `--source pmc` for peer-reviewed, `--source biorxiv` for preprints.
- `-m all` / `-e` tighten recall; combine with `search | grep` for precision on the shortlist.
- **`scan`** beats several sequential `grep`s on the same file.
- Shell **loops** (`for`/`while`) and **`xargs`** are not available â use pipes or multiple tool calls.
- **`map`** runs an LLM reader per paper â limit inputs with `-n 5` on the preceding search to keep it fast and cheap.
- Figure paths: `ls /papers/<id>/figures/` then `ask-image`; the tool normalizes paths.
