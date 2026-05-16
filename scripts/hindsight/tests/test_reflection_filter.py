"""Tests for scripts/hindsight/reflection_filter.py.

The hindsight recall hook (external plugin: vectorize-io/hindsight) is
over-injecting agent self-reflection memories into every UserPromptSubmit.

A "reflection" is a memory like:
    - The agent identified the next step as either...
      | Involving: claude_code (AI agent)
      | ... [experience] (2026-05-16T...)

These pollute the prompt with stale agent self-talk. Real user-stated facts
(involving the human, or [world]-typed) must NOT be filtered.

The filter operates on the `additionalContext` payload that recall.py emits
to Claude Code's hook system: a `<hindsight_memories>...</hindsight_memories>`
block containing newline-separated "- <text> [<type>] (<date>)" entries.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

MOD_PATH = Path(__file__).resolve().parents[1] / "reflection_filter.py"


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("reflection_filter", MOD_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["reflection_filter"] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Sample memories taken from the live last_recall.json (2026-05-16)
# ---------------------------------------------------------------------------

# These are all `[experience]` type with `Involving: claude_code (AI agent)`
# as the ONLY involved party. They are agent self-narration and MUST be filtered.
REFLECTIONS = [
    "- Extract-all is not broken; it wrote 2,538 to 3,616 links (+1,078) and "
    "64,339 to 65,687 timeline entries (+1,348), confirming the accuracy of "
    "the memory entry from May 11, 2026. | When: 2026-05-16 | "
    "Involving: claude_code (AI agent) | The memory needs updating to avoid "
    "issues with running the command in the future. [experience] "
    "(2026-05-16T19:24:55.637911+00:00)",
    "- Claude_code (AI agent) did not save the RTK hindsight memories from a "
    "system reminder, as they were from a different session and not relevant "
    "for future use. | When: on May 11, 2026 | Involving: claude_code "
    "(AI agent) | To avoid diluting memory index with stale narrative. "
    "[experience] (2026-05-11T22:18:22.353848+00:00)",
    "- The most valuable output of the session is the silent-no-op pattern "
    "memory, which documents a specific failure shape that would otherwise "
    "waste time in future sessions. | When: 2026-05-12 | Involving: "
    "claude_code (AI agent) [experience] (2026-05-12T00:24:12.741535+00:00)",
    "- The agent needs to review a successful 'no new files' session, noting "
    "that the 12:06 run was 352 seconds long, which is longer than others. "
    "| When: 2026-05-16 | Involving: claude_code (AI agent) | To investigate "
    "the session's context mode and jsonl writing. [experience] "
    "(2026-05-16T19:20:16.777661+00:00)",
    "- The next step is human review on GitHub before merging the email-task-"
    "closure I1 fix. | When: 2026-05-13 | Involving: claude_code (AI agent) | "
    "To wait for sign-off. [experience] (2026-05-13T15:00:00.000000+00:00)",
    "- Options for next steps include observing the next natural fire, "
    "switching tasks, or following up with the user. | When: 2026-05-14 | "
    "Involving: claude_code (AI agent) [experience] "
    "(2026-05-14T10:00:00.000000+00:00)",
]

# Adversarial known-good cases: phi4-mini mis-tagged these as
# `[experience]` + agent-only involving, but the content is durable.
# The content-pattern rescue must KEEP them.
ADVERSARIAL_KNOWN_GOOD = [
    # Backtick code span + semver version
    "- v0.33.0's headline feature allows users to inquire about changes "
    "since the last run with the command "
    "`gbrain recall --since-last-run --pending --rollup`. | "
    "When: 2026-05-14 | Involving: claude_code (AI agent) | "
    "[experience] (2026-05-14T12:00:00.000000+00:00)",
    # SHA + path fragment (branch name with slash)
    "- The commit SHA for the changes is 66d8e85d on branch "
    "fix/outcome-watcher-storm-2026-05-16. | When: 2026-05-16 | "
    "Involving: claude_code (AI agent) | "
    "[experience] (2026-05-16T09:00:00.000000+00:00)",
    # Path fragment (@types/sharp) + version
    "- @types/sharp is considered cruft since sharp ships its own types "
    "since v0.33. | When: 2026-05-15 | Involving: claude_code (AI agent) | "
    "[experience] (2026-05-15T11:30:00.000000+00:00)",
]

# Adversarial drop case: even though the line contains a backtick code span
# (which would normally rescue it), the canonical "The next step" signature
# forces the drop. This ensures the force-drop list outweighs the rescue.
FORCED_DROPS_DESPITE_RESCUE = [
    "- The next step is to look at `recall.py` and audit the envelope "
    "schema for v0.6.5. | When: 2026-05-16 | Involving: claude_code "
    "(AI agent) | [experience] (2026-05-16T20:00:00.000000+00:00)",
]

# These are durable facts about the user, the world, or relationships.
# They MUST PASS the filter (NOT be dropped).
REAL_FACTS = [
    "- Mike Gandal prefers Sonnet 4 for code work and uses RTK to compress "
    "tool output. | Involving: mike_gandal | [world] "
    "(2026-04-01T10:00:00.000000+00:00)",
    "- The GPT-OSS Lab grant has a deadline of Sep 15, 2026. | "
    "Involving: mike_gandal, NSF | Grant tracking. [world] "
    "(2026-04-15T09:00:00.000000+00:00)",
    "- Mike Gandal asked claude_code to never enable ANTHROPIC_API_KEY. "
    "| When: 2026-03-20 | Involving: mike_gandal, claude_code (AI agent) "
    "| Security policy. [world] (2026-03-20T14:00:00.000000+00:00)",
    "- Lab roster: Jenny Wang (postdoc, schizophrenia spatial), Andre "
    "(grad student, COBRE pipelines). | Involving: mike_gandal | Lab "
    "context. [world] (2026-02-10T11:00:00.000000+00:00)",
]


# ---------------------------------------------------------------------------
# Unit tests on the per-line classifier
# ---------------------------------------------------------------------------


class TestIsReflection:
    @pytest.mark.parametrize("line", REFLECTIONS)
    def test_reflections_are_classified_as_reflection(self, mod, line):
        assert mod.is_reflection(line) is True, f"Should be filtered: {line!r}"

    @pytest.mark.parametrize("line", REAL_FACTS)
    def test_real_facts_pass(self, mod, line):
        assert mod.is_reflection(line) is False, f"Should NOT be filtered: {line!r}"

    @pytest.mark.parametrize("line", ADVERSARIAL_KNOWN_GOOD)
    def test_adversarial_known_good_are_rescued(self, mod, line):
        # phi4-mini mis-tags these as `[experience]` + agent-only, but the
        # content carries durable signals (backtick code, SHA, semver,
        # path fragment). The rescue clause must KEEP them.
        assert mod.is_reflection(line) is False, (
            f"Adversarial-known-good should be rescued (kept): {line!r}"
        )

    @pytest.mark.parametrize("line", FORCED_DROPS_DESPITE_RESCUE)
    def test_force_drop_signatures_override_rescue(self, mod, line):
        # Even with a rescue-pattern (e.g. a backtick code span), an
        # explicit self-talk signature ("The next step", "Options for
        # next steps") forces the drop.
        assert mod.is_reflection(line) is True, (
            f"Force-drop signature must override rescue: {line!r}"
        )

    def test_empty_line_is_not_reflection(self, mod):
        # Empty and structural lines should not be marked reflection
        # (they get preserved through other paths).
        assert mod.is_reflection("") is False
        assert mod.is_reflection("   ") is False

    def test_world_type_with_only_agent_is_still_kept(self, mod):
        # If somehow a [world]-typed memory has only the agent involved,
        # we still keep it. The filter is conservative — type is the
        # primary signal alongside involving.
        line = (
            "- The local QMD server runs on port 8181. | "
            "Involving: claude_code (AI agent) | Infrastructure fact. "
            "[world] (2026-05-01T00:00:00.000000+00:00)"
        )
        assert mod.is_reflection(line) is False

    def test_experience_with_human_peer_is_kept(self, mod):
        # Experience-type memory involving a human is a legitimate
        # interaction record — keep it.
        line = (
            "- Mike Gandal asked claude_code to switch back to phi4-mini "
            "after the qwen3 panic. | When: 2026-05-16 | Involving: "
            "mike_gandal, claude_code (AI agent) | User decision. "
            "[experience] (2026-05-16T20:00:00.000000+00:00)"
        )
        assert mod.is_reflection(line) is False


# ---------------------------------------------------------------------------
# Block-level filter tests
# ---------------------------------------------------------------------------


def _build_block(memory_lines):
    """Build a hindsight_memories block like recall.py emits."""
    header = (
        "<hindsight_memories>\n"
        "Relevant memories from past conversations (prioritize recent when "
        "conflicting). Only use memories that are directly useful to "
        "continue this conversation; ignore the rest:\n"
        "Current time - 2026-05-16 20:54\n\n"
    )
    body = "\n\n".join(memory_lines)
    return header + body + "\n</hindsight_memories>"


class TestFilterBlock:
    def test_drops_all_reflections_keeps_facts(self, mod):
        block = _build_block(REFLECTIONS + REAL_FACTS)
        filtered = mod.filter_block(block)
        for refl in REFLECTIONS:
            # Use a short distinctive substring to avoid whitespace issues
            snippet = refl[2:50]
            assert snippet not in filtered, f"Reflection should be removed: {snippet!r}"
        for fact in REAL_FACTS:
            snippet = fact[2:50]
            assert snippet in filtered, f"Fact should be retained: {snippet!r}"

    def test_preserves_block_wrapper(self, mod):
        block = _build_block(REAL_FACTS)
        filtered = mod.filter_block(block)
        assert filtered.startswith("<hindsight_memories>")
        assert filtered.rstrip().endswith("</hindsight_memories>")

    def test_all_reflections_yields_minimal_block(self, mod):
        block = _build_block(REFLECTIONS)
        filtered = mod.filter_block(block)
        # When every memory is a reflection, the filter returns an empty
        # marker (the hook is allowed to suppress injection entirely; but
        # at minimum the noisy lines must be gone).
        for refl in REFLECTIONS:
            assert refl[2:50] not in filtered

    def test_non_block_input_passes_through(self, mod):
        # If the input isn't a hindsight_memories block, return it as-is.
        assert mod.filter_block("") == ""
        assert mod.filter_block("hello world") == "hello world"


# ---------------------------------------------------------------------------
# End-to-end JSON hook output filtering (for the wrapper script)
# ---------------------------------------------------------------------------


class TestFilterHookOutput:
    def test_strips_reflections_from_additional_context(self, mod):
        import json

        original = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": _build_block(REFLECTIONS + REAL_FACTS),
            }
        }
        out = json.loads(mod.filter_hook_output_json(json.dumps(original)))
        ctx = out["hookSpecificOutput"]["additionalContext"]
        for refl in REFLECTIONS:
            assert refl[2:50] not in ctx
        for fact in REAL_FACTS:
            assert fact[2:50] in ctx

    def test_empty_after_filter_omits_additional_context(self, mod):
        import json

        original = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": _build_block(REFLECTIONS),
            }
        }
        out = json.loads(mod.filter_hook_output_json(json.dumps(original)))
        # When the filtered context has no memories left, the wrapper drops
        # `additionalContext` entirely so Claude Code doesn't see an empty
        # block. The hook output stays valid JSON.
        ctx = out.get("hookSpecificOutput", {}).get("additionalContext", "")
        # Either dropped or whitespace-only after the header
        assert "claude_code (AI agent)" not in ctx
        # No reflection content remains
        for refl in REFLECTIONS:
            assert refl[2:50] not in ctx

    def test_malformed_json_passes_through_unchanged(self, mod):
        # Defensive: if recall.py emitted non-JSON, don't crash.
        assert mod.filter_hook_output_json("not json") == "not json"
        assert mod.filter_hook_output_json("") == ""


# ---------------------------------------------------------------------------
# Wrapper script — breadcrumb-on-fallback regression test
# ---------------------------------------------------------------------------


class TestWrapperBreadcrumb:
    """If the filter crashes, the wrapper must:
      1. Still emit the unfiltered recall output (graceful degradation).
      2. Print a `[recall-wrapper] filter failed` line to stderr.
      3. Append a timestamp to the fallback marker file.

    Without these, a future plugin update could silently break the filter
    and the noise problem would return undetected.
    """

    @staticmethod
    def _make_fixture(tmpdir: Path) -> tuple[Path, Path, Path]:
        """Lay out a minimal HOME with a fake plugin + crashing filter.

        Returns (wrapper_path, fake_home, fallback_marker).
        """
        repo_root = Path(__file__).resolve().parents[3]
        wrapper_src = repo_root / "scripts" / "hindsight" / "recall-wrapper.sh"

        # Build a fake REPO_ROOT layout: scripts/hindsight/{recall-wrapper.sh,
        # reflection_filter.py}. Use a crashing filter that exits 1.
        fake_repo = tmpdir / "repo"
        (fake_repo / "scripts" / "hindsight").mkdir(parents=True)
        wrapper_dest = fake_repo / "scripts" / "hindsight" / "recall-wrapper.sh"
        wrapper_dest.write_text(wrapper_src.read_text())
        wrapper_dest.chmod(0o755)

        crashing_filter = fake_repo / "scripts" / "hindsight" / "reflection_filter.py"
        crashing_filter.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            "sys.stderr.write('intentional crash\\n')\n"
            "sys.exit(1)\n"
        )
        crashing_filter.chmod(0o755)

        # Build a fake plugin cache that emits a known recall payload.
        fake_home = tmpdir / "home"
        plugin_dir = (
            fake_home
            / ".claude"
            / "plugins"
            / "cache"
            / "hindsight"
            / "hindsight-memory"
            / "0.6.5"
            / "scripts"
        )
        plugin_dir.mkdir(parents=True)
        fake_recall = plugin_dir / "recall.py"
        fake_recall.write_text(
            "#!/usr/bin/env python3\n"
            "import sys\n"
            "# Drain stdin so the wrapper's pipe doesn't SIGPIPE us\n"
            "sys.stdin.read()\n"
            'sys.stdout.write(\'{"unfiltered": "payload"}\')\n'
        )
        fake_recall.chmod(0o755)

        return wrapper_dest, fake_home, fake_home / ".cache" / "hindsight-filter-fallback"

    def test_filter_crash_emits_breadcrumb_and_passes_through(self, tmp_path):
        wrapper, fake_home, marker = self._make_fixture(tmp_path)

        env = os.environ.copy()
        env["HOME"] = str(fake_home)

        result = subprocess.run(
            ["bash", str(wrapper)],
            input='{"hookSpecificOutput": {}}',
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )

        # Unfiltered recall passthrough
        assert "unfiltered" in result.stdout, (
            f"Expected unfiltered passthrough, got: {result.stdout!r}"
        )
        # Stderr breadcrumb
        assert "[recall-wrapper] filter failed" in result.stderr, (
            f"Expected breadcrumb on stderr, got: {result.stderr!r}"
        )
        # Marker file written
        assert marker.exists(), "Fallback marker file should be created"
        assert marker.read_text().strip(), "Marker file should contain a timestamp"

    def test_filter_success_no_breadcrumb(self, tmp_path):
        """Sanity: when the filter works, no breadcrumb fires."""
        repo_root = Path(__file__).resolve().parents[3]
        wrapper_src = repo_root / "scripts" / "hindsight" / "recall-wrapper.sh"
        real_filter = repo_root / "scripts" / "hindsight" / "reflection_filter.py"

        fake_repo = tmp_path / "repo"
        (fake_repo / "scripts" / "hindsight").mkdir(parents=True)
        wrapper_dest = fake_repo / "scripts" / "hindsight" / "recall-wrapper.sh"
        wrapper_dest.write_text(wrapper_src.read_text())
        wrapper_dest.chmod(0o755)
        # Use the real (working) filter
        (fake_repo / "scripts" / "hindsight" / "reflection_filter.py").write_text(
            real_filter.read_text()
        )

        fake_home = tmp_path / "home"
        plugin_dir = (
            fake_home
            / ".claude"
            / "plugins"
            / "cache"
            / "hindsight"
            / "hindsight-memory"
            / "0.6.5"
            / "scripts"
        )
        plugin_dir.mkdir(parents=True)
        # Emit a valid envelope with one reflection
        fake_recall = plugin_dir / "recall.py"
        fake_recall.write_text(
            "#!/usr/bin/env python3\n"
            "import sys, json\n"
            "sys.stdin.read()\n"
            "envelope = {'hookSpecificOutput': {"
            "'hookEventName': 'UserPromptSubmit', "
            "'additionalContext': '<hindsight_memories>\\nhdr\\n\\n"
            "- Mike Gandal prefers Sonnet. | Involving: mike_gandal | "
            "[world] (2026-04-01T10:00:00.000000+00:00)\\n"
            "</hindsight_memories>'}}\n"
            "sys.stdout.write(json.dumps(envelope))\n"
        )
        fake_recall.chmod(0o755)
        marker = fake_home / ".cache" / "hindsight-filter-fallback"

        env = os.environ.copy()
        env["HOME"] = str(fake_home)

        result = subprocess.run(
            ["bash", str(wrapper_dest)],
            input='{"hookSpecificOutput": {}}',
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )

        assert "[recall-wrapper] filter failed" not in result.stderr, (
            f"Expected no breadcrumb on success path, got: {result.stderr!r}"
        )
        assert not marker.exists(), "Marker file should not be created on success"
