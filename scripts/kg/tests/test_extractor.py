"""Unit tests for scripts/kg/extractor.py.

These tests validate:
  - prompt construction (what goes to the model)
  - JSON parsing / schema validation (what comes back)
  - error handling (HTTP failure, invalid JSON, missing fields)

The Ollama HTTP call is mocked throughout. End-to-end with real phi4-mini
is exercised in session 2 via scripts/kg/extract_one.py against vault docs.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from kg.extractor import (
    build_extraction_prompt,
    ExtractionError,
    ExtractionResult,
    extract_from_doc,
    parse_ollama_response,
    strip_frontmatter,
)


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------


class TestBuildPrompt:
    def test_includes_doc_text(self):
        prompt = build_extraction_prompt(
            doc_text="Rachel Smith met with Mike Gandal about BrainGO.",
            source_doc="meetings/2026-04-01.md",
        )
        assert "Rachel Smith met with Mike Gandal" in prompt

    def test_includes_source_doc_for_context(self):
        prompt = build_extraction_prompt("body", "daily/2026-04-01.md")
        assert "daily/2026-04-01.md" in prompt

    def test_requests_json_only(self):
        prompt = build_extraction_prompt("body", "x.md")
        # Must instruct model to return JSON only, no prose
        assert "JSON" in prompt
        # Must enumerate allowed entity types so the output is constrained
        for kind in ("person", "project", "grant", "tool", "dataset", "paper"):
            assert kind in prompt.lower()

    def test_truncates_long_docs(self):
        """Docs longer than the configured cap should be truncated to keep
        context within phi4-mini's window and avoid pathological latency."""
        long_body = "x " * 50_000  # ~100k chars
        prompt = build_extraction_prompt(long_body, "big.md")
        # Prompt + instructions should still be bounded
        assert len(prompt) < 30_000

    def test_empty_body_is_handled(self):
        # Don't crash on empty content; still produce a valid prompt string.
        prompt = build_extraction_prompt("", "empty.md")
        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_yaml_frontmatter_stripped_before_prompting(self):
        """YAML `tags:` lists are keywords, not entities. Stripping
        frontmatter prevents the model from extracting tag values as
        entity names."""
        doc = (
            "---\n"
            "type: meeting\n"
            "tags: [scRNA, cell-annotation, GPNN]\n"
            "---\n\n"
            "# Meeting\n\n"
            "Eleanor presented on ICVI.\n"
        )
        prompt = build_extraction_prompt(doc, "meeting.md")
        # Tags from YAML must not appear in the prompt body
        assert "cell-annotation" not in prompt
        assert "scRNA" not in prompt
        # But body content IS in the prompt
        assert "Eleanor presented on ICVI" in prompt


class TestStripFrontmatter:
    def test_strips_leading_yaml_block(self):
        doc = "---\ntype: meeting\ntags: [a, b]\n---\n\n# Body\n\nHi."
        out = strip_frontmatter(doc)
        assert out == "\n# Body\n\nHi."

    def test_no_frontmatter_passthrough(self):
        doc = "# Just a body\n\nNo yaml here."
        assert strip_frontmatter(doc) == doc

    def test_does_not_strip_dashes_mid_doc(self):
        doc = "# Body\n\n---\nnot-frontmatter\n---\nmore"
        assert strip_frontmatter(doc) == doc

    def test_handles_empty(self):
        assert strip_frontmatter("") == ""


# ---------------------------------------------------------------------------
# JSON / schema validation on the model's response
# ---------------------------------------------------------------------------


class TestParseResponse:
    def test_valid_minimal_response(self):
        raw = json.dumps(
            {
                "entities": [{"name": "Rachel Smith", "type": "person"}],
                "edges": [],
            }
        )
        result = parse_ollama_response(raw)
        assert len(result.entities) == 1
        assert result.entities[0]["name"] == "Rachel Smith"
        assert result.edges == []

    def test_full_response_with_edges(self):
        raw = json.dumps(
            {
                "entities": [
                    {"name": "Rachel Smith", "type": "person"},
                    {"name": "BrainGO", "type": "project"},
                ],
                "edges": [
                    {
                        "source": "Rachel Smith",
                        "source_type": "person",
                        "target": "BrainGO",
                        "target_type": "project",
                        "relation": "member_of",
                        "evidence": "co-PI on aim 2",
                    }
                ],
            }
        )
        result = parse_ollama_response(raw)
        assert len(result.entities) == 2
        assert len(result.edges) == 1
        assert result.edges[0]["relation"] == "member_of"

    def test_malformed_json_raises(self):
        with pytest.raises(ExtractionError, match="JSON"):
            parse_ollama_response("not json at all { broken")

    def test_missing_entities_key_defaults_to_empty(self):
        """Some model runs omit empty arrays. Be lenient — missing entities
        is a valid 'nothing extracted' signal, not an error."""
        raw = json.dumps({"edges": []})
        result = parse_ollama_response(raw)
        assert result.entities == []
        assert result.edges == []

    def test_entity_without_type_is_filtered(self):
        """Entities missing required fields are dropped rather than raising;
        the extractor runs over 2k+ docs and one malformed entity should
        not fail the whole doc."""
        raw = json.dumps(
            {
                "entities": [
                    {"name": "Good Entity", "type": "person"},
                    {"name": "Bad — no type"},
                    {"type": "person"},  # no name
                ],
                "edges": [],
            }
        )
        result = parse_ollama_response(raw)
        assert len(result.entities) == 1
        assert result.entities[0]["name"] == "Good Entity"

    def test_disallowed_entity_type_filtered(self):
        """Model may hallucinate types. Keep only allowed ones."""
        raw = json.dumps(
            {
                "entities": [
                    {"name": "Rachel", "type": "person"},
                    {"name": "Whatever", "type": "pokemon"},
                ],
                "edges": [],
            }
        )
        result = parse_ollama_response(raw)
        names = [e["name"] for e in result.entities]
        assert "Rachel" in names
        assert "Whatever" not in names

    def test_edge_with_unknown_endpoint_is_filtered(self):
        """Edges that reference an entity not in the entities list are
        dropped — we cannot resolve an edge whose source/target is a phantom.
        """
        raw = json.dumps(
            {
                "entities": [
                    {"name": "Rachel", "type": "person"},
                ],
                "edges": [
                    # target 'Ghost' not in entities list
                    {
                        "source": "Rachel",
                        "source_type": "person",
                        "target": "Ghost",
                        "target_type": "project",
                        "relation": "member_of",
                        "evidence": "",
                    },
                    # both endpoints present — keeps
                    {
                        "source": "Rachel",
                        "source_type": "person",
                        "target": "Rachel",
                        "target_type": "person",
                        "relation": "related_to",
                        "evidence": "self-ref",
                    },
                ],
            }
        )
        result = parse_ollama_response(raw)
        assert len(result.edges) == 1
        assert result.edges[0]["target"] == "Rachel"

    def test_strips_whitespace_from_names(self):
        raw = json.dumps(
            {
                "entities": [{"name": "  Rachel Smith  ", "type": "person"}],
                "edges": [],
            }
        )
        result = parse_ollama_response(raw)
        assert result.entities[0]["name"] == "Rachel Smith"

    def test_duplicate_entities_deduped(self):
        raw = json.dumps(
            {
                "entities": [
                    {"name": "Rachel", "type": "person"},
                    {"name": "Rachel", "type": "person"},
                ],
                "edges": [],
            }
        )
        result = parse_ollama_response(raw)
        assert len(result.entities) == 1


# ---------------------------------------------------------------------------
# End-to-end extract_from_doc — Ollama HTTP call mocked
# ---------------------------------------------------------------------------


def _mock_ollama(response_json: str, status: int = 200):
    """Build a mock urlopen that returns the given response body."""
    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps(
        {"response": response_json, "done": True}
    ).encode("utf-8")
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    mock_resp.getcode.return_value = status
    return mock_resp


class TestExtractFromDoc:
    def test_happy_path(self):
        body = json.dumps(
            {
                "entities": [{"name": "Rachel", "type": "person"}],
                "edges": [],
            }
        )
        with patch("kg.extractor.urllib.request.urlopen", return_value=_mock_ollama(body)):
            result = extract_from_doc(
                "Some text about Rachel Smith.",
                source_doc="doc.md",
            )
        assert isinstance(result, ExtractionResult)
        assert len(result.entities) == 1
        assert result.source_doc == "doc.md"

    def test_retries_on_malformed_json(self):
        """First response garbled, second valid — extractor should retry once
        before giving up."""
        bad = "not json"
        good = json.dumps({"entities": [{"name": "OK", "type": "person"}], "edges": []})
        responses = iter([_mock_ollama(bad), _mock_ollama(good)])
        with patch(
            "kg.extractor.urllib.request.urlopen",
            side_effect=lambda *a, **k: next(responses),
        ):
            result = extract_from_doc("body", "x.md", max_retries=2)
        assert len(result.entities) == 1

    def test_gives_up_after_max_retries(self):
        bad = "not json"
        with patch(
            "kg.extractor.urllib.request.urlopen", return_value=_mock_ollama(bad)
        ):
            with pytest.raises(ExtractionError):
                extract_from_doc("body", "x.md", max_retries=2)

    def test_http_error_raises(self):
        import urllib.error

        def _raise(*a, **k):
            raise urllib.error.URLError("connection refused")

        with patch("kg.extractor.urllib.request.urlopen", side_effect=_raise):
            with pytest.raises(ExtractionError, match="Ollama"):
                extract_from_doc("body", "x.md", max_retries=1)

    def test_empty_doc_returns_empty_result(self):
        """Don't even call Ollama for empty docs — saves ~5 seconds per empty."""
        with patch("kg.extractor.urllib.request.urlopen") as mock:
            result = extract_from_doc("", "empty.md")
            mock.assert_not_called()
        assert result.entities == []
        assert result.edges == []
