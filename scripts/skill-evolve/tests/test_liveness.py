import json
from pathlib import Path
from skill_evolve.liveness import count_wiki_writes, liveness_report


def make_jsonl(path: Path, events: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n")


def test_counts_assistant_tool_use_with_wiki_path(tmp_path):
    f = tmp_path / "session.jsonl"
    make_jsonl(f, [
        {"type": "user", "message": {"content": "save this note"}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "/workspace/extra/claire-vault/98-nanoKB/wiki/notes/foo.md"}}
        ]}},
    ])
    assert count_wiki_writes([f]) == 1


def test_does_not_count_user_mentions(tmp_path):
    f = tmp_path / "session.jsonl"
    make_jsonl(f, [
        {"type": "user", "message": {"content": "look at 98-nanoKB/wiki/index.md"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}]}},
    ])
    assert count_wiki_writes([f]) == 0


def test_does_not_count_reads_only_writes(tmp_path):
    f = tmp_path / "session.jsonl"
    make_jsonl(f, [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "98-nanoKB/wiki/index.md"}}
        ]}},
    ])
    assert count_wiki_writes([f]) == 0


def test_multiple_writes_summed(tmp_path):
    f = tmp_path / "session.jsonl"
    make_jsonl(f, [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "98-nanoKB/wiki/papers/a.md"}},
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "98-nanoKB/wiki/index.md"}},
        ]}},
    ])
    assert count_wiki_writes([f]) == 2


def test_liveness_report_per_group_counts(tmp_path):
    g1 = tmp_path / "telegram_vault-claw" / ".claude" / "projects" / "-workspace-group"
    g1.mkdir(parents=True)
    g1_session = g1 / "s.jsonl"
    make_jsonl(g1_session, [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "98-nanoKB/wiki/papers/x.md"}}
        ]}},
    ])
    g2 = tmp_path / "telegram_other" / ".claude" / "projects" / "-workspace-group"
    g2.mkdir(parents=True)
    # g2 has no jsonl files
    hidden = tmp_path / ".cache"
    hidden.mkdir()  # should NOT appear in report
    report = liveness_report(tmp_path)
    assert report["telegram_vault-claw"] == 1
    assert report["telegram_other"] == 0
    assert ".cache" not in report
