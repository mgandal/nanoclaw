#!/usr/bin/env python3
"""MarkItDown adapter: convert arbitrary files to markdown.

Usage: python3 adapter.py <file_path>
Outputs: markdown to stdout. Non-zero exit on failure.

Supported (via Microsoft's markitdown):
  .pdf .docx .xlsx .pptx .html .htm .csv .json .xml
  .jpg .jpeg .png (EXIF + optional LLM description)
  .mp3 .wav (transcription if whisper configured)
  .zip (recurses)
"""

import sys
from pathlib import Path

from markitdown import MarkItDown


SIZE_LIMIT_BYTES = 25 * 1024 * 1024  # 25 MB — skip huge files


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: adapter.py <file_path>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"not a file: {path}", file=sys.stderr)
        return 2

    size = path.stat().st_size
    if size > SIZE_LIMIT_BYTES:
        print(f"file too large: {size} bytes (limit {SIZE_LIMIT_BYTES})", file=sys.stderr)
        return 3

    md = MarkItDown()
    result = md.convert(str(path))
    sys.stdout.write(result.text_content or "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
