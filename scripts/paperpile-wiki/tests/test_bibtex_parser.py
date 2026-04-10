"""Tests for bibtex_parser.py — Stage 1 of paperpile-wiki ingest pipeline."""

import os
import sys
import pytest

# Make sure the package root is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bibtex_parser import (
    extract_first_author,
    _clean_text,
    _semicolon_authors,
    _parse_year,
    parse_entry,
    parse_bib_file,
)

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")
SAMPLE_BIB = os.path.join(FIXTURES_DIR, "sample.bib")
REAL_BIB = os.path.expanduser("~/.hermes/paperpile.bib")


# ---------------------------------------------------------------------------
# TestExtractFirstAuthor
# ---------------------------------------------------------------------------

class TestExtractFirstAuthor:
    def test_standard_two_authors(self):
        result = extract_first_author("Smith, John and Jones, Mary")
        assert result == "Smith"

    def test_standard_many_authors(self):
        result = extract_first_author(
            "García-Marín, Isabel and Smith, John and Doe, Jane and Roe, Richard"
        )
        assert result == "García-Marín"

    def test_single_author(self):
        result = extract_first_author("Smith, John")
        assert result == "Smith"

    def test_unicode_author(self):
        result = extract_first_author("García-Marín, Isabel and Smith, John")
        assert result == "García-Marín"

    def test_unicode_umlaut(self):
        result = extract_first_author("Müller, Hans and Schmidt, Karl")
        assert result == "Müller"

    def test_braced_consortium(self):
        result = extract_first_author("{Autism Spectrum Disorders Working Group}")
        assert result == "Autism Spectrum Disorders Working Group"

    def test_braced_consortium_with_others(self):
        result = extract_first_author("{GTEx Consortium}")
        assert result == "GTEx Consortium"

    def test_empty_string(self):
        result = extract_first_author("")
        assert result == "Unknown"

    def test_none(self):
        result = extract_first_author(None)
        assert result == "Unknown"

    def test_whitespace_only(self):
        result = extract_first_author("   ")
        assert result == "Unknown"


# ---------------------------------------------------------------------------
# TestCleanText
# ---------------------------------------------------------------------------

class TestCleanText:
    def test_strip_outer_braces(self):
        result = _clean_text("{GTEx Consortium}")
        assert result == "GTEx Consortium"

    def test_no_braces(self):
        result = _clean_text("plain text")
        assert result == "plain text"

    def test_collapse_whitespace(self):
        result = _clean_text("too   many    spaces")
        assert result == "too many spaces"

    def test_none_returns_none(self):
        result = _clean_text(None)
        assert result is None

    def test_empty_string(self):
        result = _clean_text("")
        assert result == ""

    def test_nested_braces_preserved(self):
        # Only outer braces are stripped, inner content stays
        result = _clean_text("{ASD} title")
        # should NOT strip inner braces — only outer wrapping braces
        assert "{ASD}" in result or result == "{ASD} title"


# ---------------------------------------------------------------------------
# TestSemicolonAuthors
# ---------------------------------------------------------------------------

class TestSemicolonAuthors:
    def test_converts_and_to_semicolon(self):
        result = _semicolon_authors("Smith, John and Jones, Mary and Doe, Jane")
        assert result == "Smith, John; Jones, Mary; Doe, Jane"

    def test_single_author_unchanged(self):
        result = _semicolon_authors("Smith, John")
        assert result == "Smith, John"

    def test_none_returns_none(self):
        result = _semicolon_authors(None)
        assert result is None


# ---------------------------------------------------------------------------
# TestParseYear
# ---------------------------------------------------------------------------

class TestParseYear:
    def test_simple_integer_string(self):
        assert _parse_year("2024") == 2024

    def test_integer_input_as_string(self):
        assert _parse_year("1999") == 1999

    def test_none_returns_none(self):
        assert _parse_year(None) is None

    def test_empty_string_returns_none(self):
        assert _parse_year("") is None

    def test_non_numeric_string_returns_none(self):
        assert _parse_year("undated") is None

    def test_year_embedded_in_string(self):
        # Regex fallback: "Published in 2023" → 2023
        result = _parse_year("Published in 2023")
        assert result == 2023


# ---------------------------------------------------------------------------
# TestParseEntry
# ---------------------------------------------------------------------------

class TestParseEntry:
    def _make_fields(self, **kwargs):
        """Helper: return list of simple objects mimicking bibtexparser Field."""
        from types import SimpleNamespace
        return [SimpleNamespace(key=k, value=str(v)) for k, v in kwargs.items()]

    def test_full_entry(self):
        fields = self._make_fields(
            title="Test Paper",
            author="Gandal, Michael J and Smith, John",
            year="2024",
            journal="Science",
            abstract="An important paper.",
            doi="10.1234/test",
            pmid="12345678",
            pmc="PMC123456",
            url="http://example.com",
            keywords="autism; genetics",
        )
        result = parse_entry("Gandal2024-xx", {"fields": fields, "entry_type": "article"})
        assert result["id"] == "Gandal2024-xx"
        assert result["title"] == "Test Paper"
        assert result["first_author"] == "Gandal"
        assert result["year"] == 2024
        assert result["journal"] == "Science"
        assert result["abstract"] == "An important paper."
        assert result["doi"] == "10.1234/test"
        assert result["pmid"] == "12345678"
        assert result["pmc"] == "PMC123456"
        assert result["url"] == "http://example.com"
        assert result["keywords"] == "autism; genetics"
        # authors should use semicolons
        assert ";" in result["authors"]

    def test_missing_abstract_is_none(self):
        fields = self._make_fields(
            title="No Abstract Paper",
            author="Smith, John",
            year="2020",
        )
        result = parse_entry("Smith2020-xx", {"fields": fields, "entry_type": "article"})
        assert result["abstract"] is None
        # Make sure the string "None" is not stored
        assert result["abstract"] != "None"

    def test_missing_optional_fields_are_none(self):
        fields = self._make_fields(title="Minimal Paper", author="Jones, Alice", year="2021")
        result = parse_entry("Jones2021-xx", {"fields": fields, "entry_type": "article"})
        assert result["doi"] is None
        assert result["pmid"] is None
        assert result["pmc"] is None
        assert result["url"] is None
        assert result["keywords"] is None

    def test_year_as_integer_string(self):
        fields = self._make_fields(title="Year Test", author="Doe, Jane", year="2015")
        result = parse_entry("Doe2015-xx", {"fields": fields, "entry_type": "article"})
        assert result["year"] == 2015
        assert isinstance(result["year"], int)

    def test_invalid_year_returns_none(self):
        fields = self._make_fields(title="Bad Year", author="Doe, Jane", year="n.d.")
        result = parse_entry("Doe-nd-xx", {"fields": fields, "entry_type": "article"})
        assert result["year"] is None

    def test_author_none_gives_unknown_first_author(self):
        fields = self._make_fields(title="No Author")
        result = parse_entry("NoAuthor-xx", {"fields": fields, "entry_type": "misc"})
        assert result["first_author"] == "Unknown"
        assert result["authors"] is None

    def test_required_keys_present(self):
        fields = self._make_fields(title="Complete")
        result = parse_entry("X-xx", {"fields": fields, "entry_type": "article"})
        for key in ("id", "title", "authors", "first_author", "year", "journal",
                    "abstract", "doi", "pmid", "pmc", "url", "keywords"):
            assert key in result, f"Missing key: {key}"


# ---------------------------------------------------------------------------
# TestParseBibFile
# ---------------------------------------------------------------------------

class TestParseBibFile:
    def test_sample_bib_returns_entries(self):
        papers = parse_bib_file(SAMPLE_BIB)
        assert len(papers) > 0

    def test_all_entries_have_id_and_title(self):
        papers = parse_bib_file(SAMPLE_BIB)
        for p in papers:
            assert "id" in p and p["id"], f"Missing id: {p}"
            assert "title" in p and p["title"], f"Missing title: {p}"

    def test_entries_with_no_title_are_skipped(self):
        """Entries without titles (like bare MISC with only url) must be skipped."""
        papers = parse_bib_file(SAMPLE_BIB)
        # UnknownUnknown-ig only has a url, no title — should be skipped
        ids = [p["id"] for p in papers]
        assert "UnknownUnknown-ig" not in ids

    def test_gandal_paper_present(self):
        papers = parse_bib_file(SAMPLE_BIB)
        ids = [p["id"] for p in papers]
        assert any("Gandal" in pid for pid in ids), "Expected at least one Gandal paper"

    def test_gandal_first_author(self):
        papers = parse_bib_file(SAMPLE_BIB)
        gandal_papers = [p for p in papers if "Gandal" in p["id"]]
        assert len(gandal_papers) > 0
        for p in gandal_papers:
            assert p["first_author"] == "Gandal", (
                f"Expected first_author='Gandal' for {p['id']}, got {p['first_author']!r}"
            )

    def test_unicode_author_parsed(self):
        papers = parse_bib_file(SAMPLE_BIB)
        unicode_paper = next((p for p in papers if p["id"] == "García-Marín2023-ab"), None)
        assert unicode_paper is not None
        assert unicode_paper["first_author"] == "García-Marín"

    def test_no_abstract_entry_has_none(self):
        papers = parse_bib_file(SAMPLE_BIB)
        no_abstract = next((p for p in papers if p["id"] == "Morin2024-qh"), None)
        assert no_abstract is not None
        assert no_abstract["abstract"] is None
        assert no_abstract["abstract"] != "None"

    def test_keywords_entry(self):
        papers = parse_bib_file(SAMPLE_BIB)
        kw_paper = next((p for p in papers if p["id"] == "Gonzalez-Devesa2025-ry"), None)
        assert kw_paper is not None
        assert kw_paper["keywords"] is not None
        assert len(kw_paper["keywords"]) > 0

    def test_consortium_author_first_author(self):
        papers = parse_bib_file(SAMPLE_BIB)
        gtex = next((p for p in papers if p["id"] == "GTEx-Consortium2020-rf"), None)
        assert gtex is not None
        assert gtex["first_author"] == "GTEx Consortium"

    def test_misc_with_title_included(self):
        papers = parse_bib_file(SAMPLE_BIB)
        ids = [p["id"] for p in papers]
        # Author-Name-Not-Available-2018-ot has a title, so it should be included
        assert "Author-Name-Not-Available-2018-ot" in ids

    def test_unique_ids(self):
        papers = parse_bib_file(SAMPLE_BIB)
        ids = [p["id"] for p in papers]
        assert len(ids) == len(set(ids)), "Duplicate IDs found"

    @pytest.mark.skipif(not os.path.exists(REAL_BIB), reason="Real paperpile.bib not available")
    def test_real_bib_smoke(self):
        papers = parse_bib_file(REAL_BIB)
        assert len(papers) > 5000, f"Expected >5000 entries, got {len(papers)}"
        ids = [p["id"] for p in papers]
        assert len(ids) == len(set(ids)), "Duplicate IDs in real bib"
        # All entries must have id and title
        for p in papers:
            assert p["id"], "Empty id found"
            assert p["title"], f"Empty title for {p['id']}"
