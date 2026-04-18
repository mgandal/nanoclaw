#!/usr/bin/env python3
"""Hand-test the KG Phase 2 extractor against a single vault document.

Usage:
    python3 scripts/kg/extract_one.py <path-to-markdown>
    python3 scripts/kg/extract_one.py --text "Rachel Smith met with Mike."

Prints the filtered ExtractionResult as JSON. Also prints the prompt sent
to the model (to stderr) so you can inspect what phi4-mini saw.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kg.extractor import (  # noqa: E402
    DEFAULT_MODEL,
    DEFAULT_OLLAMA_URL,
    build_extraction_prompt,
    extract_from_doc,
)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", nargs="?", type=Path, help="Markdown file to extract from")
    ap.add_argument("--text", help="Inline text (alternative to path)")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--url", default=DEFAULT_OLLAMA_URL)
    ap.add_argument(
        "--show-prompt",
        action="store_true",
        help="Print the full prompt to stderr before calling Ollama.",
    )
    args = ap.parse_args(argv)

    if args.text:
        body = args.text
        source = "<inline>"
    elif args.path:
        if not args.path.is_file():
            print(f"ERROR: {args.path} not found", file=sys.stderr)
            return 2
        body = args.path.read_text(encoding="utf-8", errors="replace")
        source = str(args.path)
    else:
        print("ERROR: pass a path or --text", file=sys.stderr)
        return 2

    if args.show_prompt:
        prompt = build_extraction_prompt(body, source)
        print("---PROMPT (first 2000 chars)---", file=sys.stderr)
        print(prompt[:2000], file=sys.stderr)
        print("---END PROMPT---", file=sys.stderr)

    t0 = time.time()
    try:
        result = extract_from_doc(
            body,
            source,
            model=args.model,
            ollama_url=args.url,
        )
    except Exception as e:
        print(f"EXTRACTION FAILED: {e}", file=sys.stderr)
        return 1
    elapsed = time.time() - t0

    output = {
        "source_doc": result.source_doc,
        "entities": result.entities,
        "edges": result.edges,
        "stats": {
            "n_entities": len(result.entities),
            "n_edges": len(result.edges),
            "doc_chars": len(body),
            "elapsed_s": round(elapsed, 2),
        },
    }
    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
