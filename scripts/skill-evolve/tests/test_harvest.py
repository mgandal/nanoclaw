import json
from pathlib import Path
from skill_evolve.harvest import harvest_real_prompts, RealPrompt


def make_jsonl(path: Path, events: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n")


def test_extracts_first_user_message_when_session_writes_wiki(tmp_path):
    f = tmp_path / "s1.jsonl"
    make_jsonl(f, [
        {"type": "user", "message": {"content": "Add Tang 2024 paper on cortical GWAS"}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "98-nanoKB/wiki/papers/tang-2024.md"}}
        ]}},
    ])
    prompts = harvest_real_prompts([f], limit=10)
    assert len(prompts) == 1
    assert prompts[0].prompt == "Add Tang 2024 paper on cortical GWAS"
    assert prompts[0].session_id == "s1"


def test_filters_scheduled_task_wrappers(tmp_path):
    f = tmp_path / "s2.jsonl"
    make_jsonl(f, [
        {"type": "user", "message": {"content": "[SCHEDULED TASK - 2026-05-23] vault-inbox-ingest: process 98-nanoKB/00-inbox/"}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "98-nanoKB/wiki/notes/x.md"}}
        ]}},
    ])
    assert harvest_real_prompts([f], limit=10) == []


def test_skips_sessions_with_no_wiki_writes(tmp_path):
    f = tmp_path / "s3.jsonl"
    make_jsonl(f, [
        {"type": "user", "message": {"content": "what time is it"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "noon"}]}},
    ])
    assert harvest_real_prompts([f], limit=10) == []


def test_pii_redactor_strips_emails(tmp_path):
    f = tmp_path / "s4.jsonl"
    make_jsonl(f, [
        {"type": "user", "message": {"content": "email alice@example.com about the paper"}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "98-nanoKB/wiki/notes/x.md"}}
        ]}},
    ])
    prompts = harvest_real_prompts([f], limit=10)
    assert "alice@example.com" not in prompts[0].prompt
    assert "[REDACTED_EMAIL]" in prompts[0].prompt


def test_limit_respected(tmp_path):
    files = []
    for i in range(5):
        f = tmp_path / f"s{i}.jsonl"
        make_jsonl(f, [
            {"type": "user", "message": {"content": f"add paper {i}"}},
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Write", "input": {"file_path": "98-nanoKB/wiki/papers/p.md"}}
            ]}},
        ])
        files.append(f)
    assert len(harvest_real_prompts(files, limit=3)) == 3
