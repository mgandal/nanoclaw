from pathlib import Path

from email_ingest.secure_write import write_file_secure


def test_writes_content(tmp_path: Path) -> None:
    target = tmp_path / "out.txt"
    write_file_secure(target, "hello", mode=0o600)
    assert target.read_text() == "hello"


def test_sets_mode(tmp_path: Path) -> None:
    target = tmp_path / "out.txt"
    write_file_secure(target, "x", mode=0o600)
    assert (target.stat().st_mode & 0o777) == 0o600


def test_atomic_no_tmp_leftover(tmp_path: Path) -> None:
    target = tmp_path / "out.txt"
    write_file_secure(target, "first", mode=0o600)
    write_file_secure(target, "second", mode=0o600)
    assert target.read_text() == "second"
    leftover = [p for p in tmp_path.iterdir() if p.suffix == ".tmp"]
    assert leftover == []


def test_accepts_bytes(tmp_path: Path) -> None:
    target = tmp_path / "out.bin"
    write_file_secure(target, b"\x00\x01\x02", mode=0o600)
    assert target.read_bytes() == b"\x00\x01\x02"


def test_gmail_save_token_uses_secure_write(tmp_path: Path, monkeypatch) -> None:
    """Regression test for B8: gmail_adapter._save_token must chmod 0o600."""
    from email_ingest import gmail_adapter

    token_file = tmp_path / "gmail-token.json"
    monkeypatch.setattr(gmail_adapter, "GMAIL_TOKEN_FILE", token_file)

    class StubCreds:
        token = "stub-access-token"

    gmail_adapter._save_token(
        StubCreds(),
        {"refresh_token": "r", "client_id": "c", "client_secret": "s"},
    )
    assert token_file.exists()
    assert (token_file.stat().st_mode & 0o777) == 0o600
