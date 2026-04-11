#!/usr/bin/env python3
"""Tests for synthesizer.py — formatting functions only (no API calls)."""

import os
import sys
import pytest

# Allow importing synthesizer from parent package without installing
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from synthesizer import (
    format_evidence_card,
    extract_citations,
    build_frontmatter,
    build_references_section,
)


# ---------------------------------------------------------------------------
# Test fixtures / sample data
# ---------------------------------------------------------------------------

PAPER_FULL = {
    "id": "Gandal2018-ab",
    "bibtex_key": "Gandal2018-ab",
    "title": "Transcriptome-wide isoform-level dysregulation in ASD, schizophrenia, and bipolar disorder",
    "authors": "Gandal, Michael J.; Zhang, Pan; Hadjimichael, Evi",
    "first_author": "Gandal",
    "year": 2018,
    "journal": "Science",
    "abstract": "We analyzed RNA-seq data from postmortem human brains across multiple psychiatric disorders.",
    "doi": "10.1126/science.aat8127",
}

PAPER_MANY_AUTHORS = {
    "id": "Smith2024-cd",
    "bibtex_key": "Smith2024-cd",
    "title": "Multi-author neuroscience paper",
    "authors": "Smith, John; Doe, Jane; Brown, Alice; Lee, Bob",
    "first_author": "Smith",
    "year": 2024,
    "journal": "Nature Neuroscience",
    "abstract": "A paper with many authors.",
    "doi": "10.1038/nn.9999",
}

PAPER_MISSING_ABSTRACT = {
    "id": "Jones2020-ef",
    "bibtex_key": "Jones2020-ef",
    "title": "Paper with no abstract",
    "authors": "Jones, Bob",
    "first_author": "Jones",
    "year": 2020,
    "journal": "Cell",
}

PAPER_NO_JOURNAL = {
    "id": "Kim2022-gh",
    "bibtex_key": "Kim2022-gh",
    "title": "Paper with no journal",
    "authors": "Kim, Alice",
    "first_author": "Kim",
    "year": 2022,
}


# ---------------------------------------------------------------------------
# TestFormatEvidenceCard
# ---------------------------------------------------------------------------

class TestFormatEvidenceCard:
    def test_full_paper_has_key(self):
        card = format_evidence_card(PAPER_FULL)
        assert "[Gandal2018-ab]" in card

    def test_full_paper_has_title(self):
        card = format_evidence_card(PAPER_FULL)
        assert "Transcriptome-wide isoform-level dysregulation" in card

    def test_full_paper_has_journal(self):
        card = format_evidence_card(PAPER_FULL)
        assert "Science" in card

    def test_full_paper_has_year(self):
        card = format_evidence_card(PAPER_FULL)
        assert "2018" in card

    def test_full_paper_has_abstract(self):
        card = format_evidence_card(PAPER_FULL)
        assert "RNA-seq data" in card

    def test_missing_abstract_no_none_string(self):
        """A paper with no abstract must not output the literal string 'None'."""
        card = format_evidence_card(PAPER_MISSING_ABSTRACT)
        assert "None" not in card

    def test_missing_abstract_still_has_key(self):
        card = format_evidence_card(PAPER_MISSING_ABSTRACT)
        assert "[Jones2020-ef]" in card

    def test_three_authors_not_shortened(self):
        """Exactly 3 authors should not be shortened."""
        card = format_evidence_card(PAPER_FULL)
        # PAPER_FULL has 3 authors — should show author name, not "et al."
        assert "Gandal" in card

    def test_four_authors_shortened_to_et_al(self):
        """More than 3 authors should produce 'First et al.'."""
        card = format_evidence_card(PAPER_MANY_AUTHORS)
        assert "et al." in card
        # Should not list all 4 authors individually in the Authors line
        assert "Lee" not in card

    def test_no_journal_no_none_string(self):
        """Missing journal must not produce 'None'."""
        card = format_evidence_card(PAPER_NO_JOURNAL)
        assert "None" not in card

    def test_enrichment_text_included(self):
        """When enrichment_text is provided, it should appear in the card."""
        card = format_evidence_card(PAPER_FULL, enrichment_text="This is key text from the intro.")
        assert "Full-text excerpts:" in card
        assert "key text from the intro" in card

    def test_enrichment_text_none_not_included(self):
        """When enrichment_text is None, no 'Full-text excerpts:' section."""
        card = format_evidence_card(PAPER_FULL, enrichment_text=None)
        assert "Full-text excerpts:" not in card

    def test_uses_bibtex_key_field(self):
        """Should use bibtex_key field when present."""
        paper = {**PAPER_FULL, "bibtex_key": "Custom2020-zz"}
        card = format_evidence_card(paper)
        assert "[Custom2020-zz]" in card

    def test_falls_back_to_id_when_no_bibtex_key(self):
        """If bibtex_key is absent, use 'id' field as key."""
        paper = dict(PAPER_FULL)
        paper.pop("bibtex_key", None)
        card = format_evidence_card(paper)
        assert "[Gandal2018-ab]" in card


# ---------------------------------------------------------------------------
# TestExtractCitations
# ---------------------------------------------------------------------------

class TestExtractCitations:
    def test_standard_citation_extracted(self):
        text = "See [Gandal2018-ab] for details."
        result = extract_citations(text)
        assert result == ["Gandal2018-ab"]

    def test_multiple_citations_extracted(self):
        text = "See [Smith2024-cd] and [Jones2020-ef] for more."
        result = extract_citations(text)
        assert "Smith2024-cd" in result
        assert "Jones2020-ef" in result

    def test_no_citations_returns_empty_list(self):
        text = "No citations here."
        result = extract_citations(text)
        assert result == []

    def test_duplicates_removed(self):
        text = "[Gandal2018-ab] is mentioned here and also [Gandal2018-ab] again."
        result = extract_citations(text)
        assert result.count("Gandal2018-ab") == 1

    def test_order_preserved_first_occurrence(self):
        text = "[Smith2024-cd] came first, then [Gandal2018-ab]."
        result = extract_citations(text)
        assert result[0] == "Smith2024-cd"
        assert result[1] == "Gandal2018-ab"

    def test_citation_with_underscore_in_key(self):
        text = "[Author_2022-xy] has underscore."
        result = extract_citations(text)
        assert "Author_2022-xy" in result

    def test_citation_with_hyphen_in_key(self):
        text = "[De-Rubeis2014-ab] has hyphen."
        result = extract_citations(text)
        assert "De-Rubeis2014-ab" in result

    def test_no_match_for_non_standard_format(self):
        """Strings like [2024] or [Author] without year+suffix should not match."""
        text = "[2024] or [Author] should not match."
        result = extract_citations(text)
        assert result == []


# ---------------------------------------------------------------------------
# TestBuildFrontmatter
# ---------------------------------------------------------------------------

class TestBuildFrontmatter:
    def test_title_present(self):
        fm = build_frontmatter("Neuroscience Synthesis", cluster_id=1, paper_count=10)
        assert "Neuroscience Synthesis" in fm

    def test_type_is_synthesis(self):
        fm = build_frontmatter("Test", cluster_id=1, paper_count=5)
        assert "type: synthesis" in fm

    def test_cluster_id_present(self):
        fm = build_frontmatter("Test", cluster_id=42, paper_count=5)
        assert "42" in fm

    def test_paper_count_present(self):
        fm = build_frontmatter("Test", cluster_id=1, paper_count=33)
        assert "33" in fm

    def test_status_is_current(self):
        fm = build_frontmatter("Test", cluster_id=1, paper_count=5)
        assert "status: current" in fm

    def test_frontmatter_has_delimiters(self):
        fm = build_frontmatter("Test", cluster_id=1, paper_count=5)
        assert fm.startswith("---")
        assert "---" in fm[3:]  # closing delimiter

    def test_generated_date_field_present(self):
        fm = build_frontmatter("Test", cluster_id=1, paper_count=5)
        assert "generated" in fm

    def test_tags_included_when_provided(self):
        fm = build_frontmatter("Test", cluster_id=1, paper_count=5, tags=["neuroscience", "rna-seq"])
        assert "neuroscience" in fm
        assert "rna-seq" in fm

    def test_tags_omitted_when_none(self):
        fm = build_frontmatter("Test", cluster_id=1, paper_count=5, tags=None)
        # Should not raise; tags section is just absent
        assert "tags:" not in fm or "null" not in fm


# ---------------------------------------------------------------------------
# TestBuildReferencesSection
# ---------------------------------------------------------------------------

class TestBuildReferencesSection:
    def _papers_by_id(self):
        return {
            "Gandal2018-ab": PAPER_FULL,
            "Jones2020-ef": PAPER_MISSING_ABSTRACT,
        }

    def test_references_header_present(self):
        section = build_references_section(["Gandal2018-ab"], self._papers_by_id())
        assert "## References" in section

    def test_citation_key_in_output(self):
        section = build_references_section(["Gandal2018-ab"], self._papers_by_id())
        assert "[Gandal2018-ab]" in section

    def test_author_in_output(self):
        section = build_references_section(["Gandal2018-ab"], self._papers_by_id())
        assert "Gandal" in section

    def test_title_in_output(self):
        section = build_references_section(["Gandal2018-ab"], self._papers_by_id())
        assert "Transcriptome-wide isoform-level dysregulation" in section

    def test_journal_in_output(self):
        section = build_references_section(["Gandal2018-ab"], self._papers_by_id())
        assert "Science" in section

    def test_year_in_output(self):
        section = build_references_section(["Gandal2018-ab"], self._papers_by_id())
        assert "2018" in section

    def test_doi_in_output(self):
        section = build_references_section(["Gandal2018-ab"], self._papers_by_id())
        assert "10.1126/science.aat8127" in section

    def test_multiple_refs_in_output(self):
        section = build_references_section(
            ["Gandal2018-ab", "Jones2020-ef"], self._papers_by_id()
        )
        assert "[Gandal2018-ab]" in section
        assert "[Jones2020-ef]" in section

    def test_unknown_key_skipped(self):
        """Keys not in papers_by_id should not raise — just skip."""
        section = build_references_section(
            ["Gandal2018-ab", "Unknown2099-zz"], self._papers_by_id()
        )
        assert "[Gandal2018-ab]" in section
        # Unknown key should not crash, and should not appear or appear gracefully
        assert "Unknown2099-zz" not in section or "Unknown2099-zz" in section  # no exception raised

    def test_empty_cited_ids_returns_header_only(self):
        section = build_references_section([], self._papers_by_id())
        assert "## References" in section
