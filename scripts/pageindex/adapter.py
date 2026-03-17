#!/usr/bin/env python3
"""PageIndex adapter: builds hierarchical document trees from PDFs using Claude API.

Usage: python3 adapter.py <pdf_path>
Outputs: JSON tree to stdout

Environment:
  ANTHROPIC_BASE_URL  - API base URL (e.g. http://localhost:3001)
  ANTHROPIC_API_KEY   - API key (or placeholder if proxy handles auth)
"""

import json
import sys
import os

import anthropic
import fitz  # pymupdf


MODEL = "claude-sonnet-4-6"
TOC_PAGES = 20
FLAT_CHUNK_SIZE = 10


def extract_pages(pdf_path: str) -> list[str]:
    """Extract text from each page of a PDF. Returns list of page texts (0-indexed)."""
    doc = fitz.open(pdf_path)
    pages = []
    for page in doc:
        pages.append(page.get_text())
    doc.close()
    return pages


def detect_toc(client: anthropic.Anthropic, pages: list[str], total_pages: int) -> dict | None:
    """Use Claude to detect TOC structure from the first pages of the document.

    Returns a tree dict or None if no TOC is detected.
    """
    sample = pages[:TOC_PAGES]
    numbered_text = ""
    for i, text in enumerate(sample):
        numbered_text += f"\n--- PAGE {i + 1} ---\n{text}"

    prompt = f"""Analyze this PDF document ({total_pages} total pages). The first {len(sample)} pages are shown below.

Detect the table of contents or logical structure of this document. Return a JSON object representing the hierarchical structure.

Each node should have:
- "title": section title (string)
- "start_index": first page number, 1-based (integer)
- "end_index": last page number, 1-based (integer), or null if unknown
- "summary": 1-2 sentence summary of the section (string), or null if unknown
- "nodes": array of child nodes (can be empty array)

The root object should have the same structure, with "title" being the document title.

If you cannot detect a clear table of contents or document structure, respond with exactly: NO_TOC

Important:
- All page indices are 1-based (page 1 is the first page)
- The document has {total_pages} pages total
- Only return valid JSON (or NO_TOC), no other text

{numbered_text}"""

    response = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text.strip()

    if text == "NO_TOC":
        return None

    # Extract JSON from response (handle markdown code blocks)
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first and last lines (``` markers)
        json_lines = []
        in_block = False
        for line in lines:
            if line.startswith("```") and not in_block:
                in_block = True
                continue
            elif line.startswith("```") and in_block:
                break
            elif in_block:
                json_lines.append(line)
        text = "\n".join(json_lines)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def make_flat_chunks(total_pages: int, pages: list[str]) -> dict:
    """Create a flat tree with chunks of FLAT_CHUNK_SIZE pages."""
    nodes = []
    for start in range(0, total_pages, FLAT_CHUNK_SIZE):
        end = min(start + FLAT_CHUNK_SIZE, total_pages)
        start_1 = start + 1  # 1-based
        end_1 = end           # 1-based (inclusive)
        nodes.append({
            "title": f"Pages {start_1}-{end_1}",
            "start_index": start_1,
            "end_index": end_1,
            "summary": None,
            "nodes": [],
        })

    return {
        "title": "Document",
        "start_index": 1,
        "end_index": total_pages,
        "summary": None,
        "nodes": nodes,
    }


def fix_end_indices(node: dict, total_pages: int) -> None:
    """Fill in missing end_index values from the next sibling's start_index."""
    children = node.get("nodes", [])
    for i, child in enumerate(children):
        if child.get("end_index") is None:
            if i + 1 < len(children):
                # Use next sibling's start_index - 1
                next_start = children[i + 1].get("start_index")
                if next_start is not None:
                    child["end_index"] = next_start - 1
            else:
                # Last child: use parent's end_index or total_pages
                child["end_index"] = node.get("end_index") or total_pages

        # Recurse into children
        fix_end_indices(child, total_pages)


def collect_nodes_missing_summary(node: dict, result: list[dict]) -> None:
    """Collect all nodes that lack a summary."""
    if not node.get("summary"):
        result.append(node)
    for child in node.get("nodes", []):
        collect_nodes_missing_summary(child, result)


def add_summaries(client: anthropic.Anthropic, tree: dict, pages: list[str]) -> None:
    """Add 1-2 sentence summaries to nodes that lack them, using Claude."""
    missing = []
    collect_nodes_missing_summary(tree, missing)

    if not missing:
        return

    # Build batch request: for each node, provide its page text
    nodes_info = []
    for node in missing:
        start = node.get("start_index", 1)
        end = node.get("end_index", start)
        # Clamp to valid range
        start_0 = max(0, start - 1)
        end_0 = min(len(pages), end)
        # Limit text to avoid huge prompts — take first and last page of the section
        section_pages = pages[start_0:end_0]
        if len(section_pages) > 4:
            # Take first 2 and last 2 pages to keep prompt manageable
            sampled = section_pages[:2] + section_pages[-2:]
            text_sample = ""
            page_nums = [start, start + 1, end - 1, end]
            for pg, txt in zip(page_nums, sampled):
                text_sample += f"\n--- PAGE {pg} ---\n{txt}"
        else:
            text_sample = ""
            for i, txt in enumerate(section_pages):
                text_sample += f"\n--- PAGE {start + i} ---\n{txt}"

        nodes_info.append({
            "node": node,
            "text": text_sample,
        })

    # Batch into a single Claude call for efficiency
    descriptions = []
    for i, info in enumerate(nodes_info):
        descriptions.append(
            f"Section {i + 1}: \"{info['node']['title']}\" "
            f"(pages {info['node'].get('start_index', '?')}-{info['node'].get('end_index', '?')})\n"
            f"{info['text']}"
        )

    prompt = f"""For each of the following document sections, provide a 1-2 sentence summary.

Return a JSON array of strings, one summary per section, in order.

{chr(10).join(descriptions)}"""

    response = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text.strip()

    # Extract JSON
    if text.startswith("```"):
        lines = text.split("\n")
        json_lines = []
        in_block = False
        for line in lines:
            if line.startswith("```") and not in_block:
                in_block = True
                continue
            elif line.startswith("```") and in_block:
                break
            elif in_block:
                json_lines.append(line)
        text = "\n".join(json_lines)

    try:
        summaries = json.loads(text)
        if isinstance(summaries, list):
            for i, summary in enumerate(summaries):
                if i < len(nodes_info):
                    nodes_info[i]["node"]["summary"] = summary
    except json.JSONDecodeError:
        # If we can't parse, leave summaries as None — non-fatal
        pass


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python3 adapter.py <pdf_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]

    if not os.path.isfile(pdf_path):
        print(f"Error: file not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    try:
        # SDK auto-reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from env
        client = anthropic.Anthropic()

        pages = extract_pages(pdf_path)
        if not pages:
            print("Error: PDF has no pages", file=sys.stderr)
            sys.exit(1)

        total_pages = len(pages)

        # Detect TOC structure
        tree = detect_toc(client, pages, total_pages)

        if tree is None:
            # No TOC detected — create flat chunks
            tree = make_flat_chunks(total_pages, pages)

        # Ensure root has end_index
        if tree.get("end_index") is None:
            tree["end_index"] = total_pages
        if tree.get("start_index") is None:
            tree["start_index"] = 1

        # Fix any missing end_index values
        fix_end_indices(tree, total_pages)

        # Add summaries where missing
        add_summaries(client, tree, pages)

        # Output to stdout
        json.dump(tree, sys.stdout, indent=2)
        sys.stdout.write("\n")

    except anthropic.APIError as e:
        print(f"Error: API call failed: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
