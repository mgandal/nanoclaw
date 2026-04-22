"""Phase 2 TDD: port hermes-inbox-monitor → mgandal-cc-inbox.

Three RED tests that drive the port:
  1. Container skill exists at container/skills/mgandal-cc-inbox/SKILL.md
  2. scheduled_tasks row registered in OPS-claw with matching cron
  3. Python classifier helper labels seeded emails A/B/C/D correctly

Once all three are GREEN and end-to-end verification passes, the Hermes
hermes-inbox-monitor job may be disabled.
"""

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest


REPO = Path.home() / "Agents" / "nanoclaw"
SKILL_PATH = REPO / "container" / "skills" / "mgandal-cc-inbox" / "SKILL.md"
CLASSIFIER_PATH = REPO / "scripts" / "lib" / "mgandal_cc_classify.py"
DB_PATH = REPO / "store" / "messages.db"

OPS_CLAW_JID = "tg:-1003829244894"
EXPECTED_TASK_ID_PREFIX = "mgandal-cc-inbox"
EXPECTED_CRON = "30,0 9-17 * * 1-5"


# ---------- Test 1: skill file ----------

def test_skill_file_exists():
    assert SKILL_PATH.exists(), (
        f"Container skill not found at {SKILL_PATH}. "
        "Write SKILL.md with A/B/C/D inbox-monitor workflow."
    )


def test_skill_has_required_frontmatter():
    if not SKILL_PATH.exists():
        pytest.skip("skill file missing — covered by test_skill_file_exists")
    text = SKILL_PATH.read_text()
    assert text.startswith("---\n"), "SKILL.md must start with YAML frontmatter"
    assert "name: mgandal-cc-inbox" in text, "frontmatter must declare name"
    assert "description:" in text, "frontmatter must declare description"


def test_skill_documents_ops_claw_routing():
    if not SKILL_PATH.exists():
        pytest.skip("skill file missing")
    text = SKILL_PATH.read_text()
    # Must explicitly route to OPS-claw, not CLAIRE.
    assert "OPS-claw" in text or "-1003829244894" in text, (
        "SKILL.md must document routing to OPS-claw (per Claire group CLAUDE.md)."
    )


# ---------- Test 2: scheduled_tasks row ----------

@pytest.fixture(scope="module")
def conn():
    if not DB_PATH.exists():
        pytest.skip(f"DB not found at {DB_PATH}")
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    yield c
    c.close()


def test_scheduled_task_registered_in_ops_claw(conn):
    row = conn.execute(
        "SELECT id, group_folder, chat_jid, schedule_type, schedule_value, status "
        "FROM scheduled_tasks "
        "WHERE id LIKE ? OR prompt LIKE ?",
        (f"{EXPECTED_TASK_ID_PREFIX}%", "%mgandal-cc-inbox%"),
    ).fetchone()

    assert row is not None, (
        f"No scheduled_tasks row matching '{EXPECTED_TASK_ID_PREFIX}*'. "
        "Register via schedule_task IPC into OPS-claw with cron "
        f"'{EXPECTED_CRON}'."
    )
    assert row["chat_jid"] == OPS_CLAW_JID, (
        f"Task chat_jid={row['chat_jid']!r}, expected {OPS_CLAW_JID} "
        "(OPS-claw). Alerts must NOT land in CLAIRE."
    )
    assert row["group_folder"] == "telegram_ops-claw", (
        f"Task group_folder={row['group_folder']!r}, expected "
        "'telegram_ops-claw'."
    )
    assert row["schedule_type"] == "cron", "schedule_type must be 'cron'"
    assert row["schedule_value"] == EXPECTED_CRON, (
        f"schedule_value={row['schedule_value']!r}, expected {EXPECTED_CRON!r} "
        "(matches Hermes cadence: every 30min 9-17 weekdays)."
    )
    assert row["status"] == "active", "Task must be status='active'"


# ---------- Test 3: Python classifier ----------

@pytest.fixture(scope="module")
def classify():
    if not CLASSIFIER_PATH.exists():
        pytest.skip(f"Classifier not found at {CLASSIFIER_PATH}")
    spec = importlib.util.spec_from_file_location(
        "mgandal_cc_classify", CLASSIFIER_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mgandal_cc_classify"] = mod
    spec.loader.exec_module(mod)
    return mod.classify


def test_classifier_module_importable():
    assert CLASSIFIER_PATH.exists(), (
        f"Classifier helper not found at {CLASSIFIER_PATH}. "
        "Write scripts/lib/mgandal_cc_classify.py with a classify(email) "
        "function returning 'A'|'B'|'C'|'D'."
    )


CALENDAR_EMAIL = {
    "subject": "Invite: lab meeting Thurs 3pm",
    "from": "prem@upenn.edu",
    "body": (
        "Hi all,\n\nLet's meet Thursday at 3pm in BRB 225 to discuss the "
        "TOPMed analysis plan. I'll send a calendar invite separately.\n\n"
        "Best,\nPrem"
    ),
}

ACTION_EMAIL = {
    "subject": "Fwd: grant review request",
    "from": "mgandal@gmail.com",
    "body": (
        "draft decline — too much on my plate\n\n"
        "---------- Forwarded message ---------\n"
        "From: NIH Review <review@nih.gov>\n"
        "Subject: Request for study-section review\n\n"
        "Dear Dr. Gandal, we'd like you to review..."
    ),
}

KNOWLEDGE_EMAIL = {
    "subject": "Fwd: Nature paper on scRNA-seq batch correction",
    "from": "mgandal@gmail.com",
    "body": (
        "---------- Forwarded message ---------\n"
        "Adding for the KB. This new Harmony v2 paper in Nature Methods "
        "benchmarks batch-correction approaches across 14 datasets. "
        "Key finding: scVI + Harmony outperforms scVI alone.\n\n"
        "PDF attached."
    ),
}

UNCLEAR_EMAIL = {
    "subject": "Fwd: ?",
    "from": "mgandal@gmail.com",
    "body": "see this\n\n--forwarded thread omitted--",
}


@pytest.mark.parametrize(
    "email,expected",
    [
        (CALENDAR_EMAIL, "A"),
        (ACTION_EMAIL, "B"),
        (KNOWLEDGE_EMAIL, "C"),
        (UNCLEAR_EMAIL, "D"),
    ],
)
def test_classifier_labels(classify, email, expected):
    got = classify(email)
    assert got == expected, (
        f"Expected {expected} for subject={email['subject']!r}, got {got!r}. "
        "Classifier must distinguish calendar/action/knowledge/unclear."
    )
