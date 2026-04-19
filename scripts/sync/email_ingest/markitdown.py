"""Thin wrapper around scripts/markitdown/adapter.py.

Keeps MarkItDown in its own venv so the email-ingest venv stays small.
Returns markdown text or None on failure/size-skip.
"""

import logging
import os
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger("email-ingest.markitdown")

ROOT = Path(__file__).resolve().parents[3]
ADAPTER = ROOT / "scripts" / "markitdown" / "adapter.py"
VENV_PY = ROOT / "scripts" / "markitdown" / "venv" / "bin" / "python"

SIZE_LIMIT_BYTES = 25 * 1024 * 1024  # mirrors adapter.py

# Extensions we know MarkItDown handles well. Others skipped — classifier
# already has the email body, so missing an attachment isn't catastrophic.
SUPPORTED_EXTS = {
    ".pdf", ".docx", ".xlsx", ".pptx",
    ".html", ".htm", ".csv", ".json", ".xml",
    ".txt", ".md",
}


def is_available() -> bool:
    return ADAPTER.is_file() and VENV_PY.is_file()


def is_supported(filename: str, size: int) -> bool:
    if size > SIZE_LIMIT_BYTES:
        return False
    ext = Path(filename).suffix.lower()
    return ext in SUPPORTED_EXTS


def convert_bytes(data: bytes, filename_hint: str, timeout: int = 60) -> str | None:
    """Write bytes to a temp file (preserving extension), run adapter, return markdown.

    Returns None on any failure — callers treat attachments as best-effort.
    """
    if not is_available():
        log.debug("markitdown adapter not installed; run `bun run setup:markitdown`")
        return None

    suffix = Path(filename_hint).suffix or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        proc = subprocess.run(
            [str(VENV_PY), str(ADAPTER), tmp_path],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if proc.returncode != 0:
            log.info("markitdown failed for %s: %s", filename_hint, proc.stderr.decode("utf-8", "replace").strip())
            return None
        return proc.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        log.warning("markitdown timed out for %s", filename_hint)
        return None
    except Exception as e:
        log.warning("markitdown error for %s: %s", filename_hint, e)
        return None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
