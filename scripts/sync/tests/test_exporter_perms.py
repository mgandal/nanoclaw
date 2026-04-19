"""BX2: verify exported email markdown files are written with mode 0600.

Tier A closed B8 for tokens + sync-state files. This test covers the
content-file counterpart that was flagged during Tier A review: the
exported *.md files contain full email bodies and should be private
to the owning user.
"""

from pathlib import Path

from email_ingest.exporter import export_email
from email_ingest.types import ClassificationResult, NormalizedEmail


def _fake_email(body: str = "hi") -> NormalizedEmail:
    return NormalizedEmail(
        id="test-perms-1",
        source="gmail",
        from_addr="a@b.com",
        to=["c@d.com"],
        cc=[],
        subject="s",
        date="2026-04-19",
        labels=[],
        body=body,
        metadata={},
    )


def _fake_result() -> ClassificationResult:
    return ClassificationResult(
        relevance=0.5,
        topic="t",
        summary="s",
        action_items=[],
        entities=[],
    )


def test_exported_markdown_has_mode_0600(tmp_path: Path, monkeypatch) -> None:
    # Redirect EXPORT_DIR to tmp so we don't touch the real cache.
    monkeypatch.setattr("email_ingest.exporter.EXPORT_DIR", tmp_path)
    path = export_email(_fake_email(), _fake_result(), downloader=None)
    assert path.exists()
    assert (path.stat().st_mode & 0o777) == 0o600
