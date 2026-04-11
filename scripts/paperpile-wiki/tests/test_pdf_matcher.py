"""Tests for pdf_matcher.py — Stage 2 of paperpile-wiki ingest pipeline."""

from __future__ import annotations

import os
import sys
import json
import tempfile
import pytest

# Make sure the package root is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pdf_matcher import (
    normalize_author,
    scan_pdf_directory,
    fuzzy_match_filename,
    _extract_last_author,
    match_by_doi_from_json,
    match_papers_to_pdfs,
    PAPERPILE_DIR,
)

REAL_PAPERPILE_DIR_AVAILABLE = os.path.isdir(PAPERPILE_DIR)


# ---------------------------------------------------------------------------
# TestNormalizeAuthor
# ---------------------------------------------------------------------------

class TestNormalizeAuthor:
    def test_standard_lowercase(self):
        """Plain ASCII names are just lowercased."""
        assert normalize_author("Smith") == "smith"

    def test_unicode_accent_stripped(self):
        """Spanish accent e.g. García → garcia."""
        assert normalize_author("García") == "garcia"

    def test_hyphenated_with_accent(self):
        """García-Marín → garcia-marin (hyphen preserved, accents stripped)."""
        assert normalize_author("García-Marín") == "garcia-marin"

    def test_umlaut(self):
        """German umlaut Fröhlich → frohlich."""
        assert normalize_author("Fröhlich") == "frohlich"

    def test_umlaut_u(self):
        """German umlaut Müller → muller."""
        assert normalize_author("Müller") == "muller"

    def test_already_ascii(self):
        """No-op for plain ASCII."""
        assert normalize_author("Gandal") == "gandal"

    def test_empty_string(self):
        assert normalize_author("") == ""

    def test_preserves_hyphen(self):
        """Hyphens should not be removed."""
        result = normalize_author("Aguzzoli-Heberle")
        assert "-" in result


# ---------------------------------------------------------------------------
# TestFuzzyMatchFilename
# ---------------------------------------------------------------------------

class TestFuzzyMatchFilename:
    def test_exact_match_high_score(self):
        """Known Gandal paper matches well."""
        score = fuzzy_match_filename(
            first_author="Gandal",
            last_author="Geschwind",
            year=2022,
            filename="GandalGeschwind-Nature-2022.pdf",
        )
        assert score > 0.9, f"Expected >0.9, got {score}"

    def test_year_mismatch_returns_zero(self):
        """Wrong year → immediate 0.0."""
        score = fuzzy_match_filename(
            first_author="Gandal",
            last_author="Geschwind",
            year=2021,
            filename="GandalGeschwind-Nature-2022.pdf",
        )
        assert score == 0.0

    def test_completely_different_paper_low_score(self):
        """Unrelated paper scores low."""
        score = fuzzy_match_filename(
            first_author="Smith",
            last_author="Jones",
            year=2022,
            filename="GandalGeschwind-Nature-2022.pdf",
        )
        assert score < 0.5, f"Expected <0.5, got {score}"

    def test_unicode_author_normalized(self):
        """Accented author name is normalized before comparison."""
        score = fuzzy_match_filename(
            first_author="García-Marín",
            last_author="Bhattacharya",
            year=2023,
            filename="Garcia-MarinBhattacharya-Nat_Neurosci_-2023.pdf",
        )
        # Should not be penalized for missing accents in filename
        assert score > 0.7, f"Expected >0.7, got {score}"

    def test_returns_float(self):
        score = fuzzy_match_filename("Smith", "Jones", 2020, "SmithJones-Journal-2020.pdf")
        assert isinstance(score, float)

    def test_score_bounded_0_to_1(self):
        score = fuzzy_match_filename("Smith", "Jones", 2020, "SmithJones-Journal-2020.pdf")
        assert 0.0 <= score <= 1.0


# ---------------------------------------------------------------------------
# TestExtractLastAuthor
# ---------------------------------------------------------------------------

class TestExtractLastAuthor:
    def test_two_authors(self):
        """Last author extracted from two-author semicolon list."""
        result = _extract_last_author("Gandal, Michael; Geschwind, Daniel")
        assert result == "Geschwind"

    def test_single_author(self):
        """Single author returns that author's last name."""
        result = _extract_last_author("Smith, John")
        assert result == "Smith"

    def test_many_authors(self):
        """Returns last author's last name from long list."""
        result = _extract_last_author("Smith, J; Jones, A; Doe, B; Roe, R")
        assert result == "Roe"

    def test_none_returns_empty(self):
        result = _extract_last_author(None)
        assert result == ""

    def test_empty_string_returns_empty(self):
        result = _extract_last_author("")
        assert result == ""


# ---------------------------------------------------------------------------
# TestMatchByDoiFromJson
# ---------------------------------------------------------------------------

class TestMatchByDoiFromJson:
    def _make_json_file(self, entries: list) -> str:
        """Write a temp JSON file and return its path."""
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as f:
            json.dump(entries, f)
        return path

    def test_doi_match(self):
        """Paper with matching DOI is resolved."""
        json_entries = [
            {
                "doi": "10.1234/test",
                "id_list": ["doi:10.1234/test", "sha1:abc123"],
                "citekey": "Smith2021-xx",
                "author": [{"last": "Smith"}, {"last": "Jones"}],
            }
        ]
        papers = [
            {"id": "Smith2021-ab", "doi": "10.1234/test", "title": "Test"},
        ]
        path = self._make_json_file(json_entries)
        try:
            result = match_by_doi_from_json(path, papers)
            assert "Smith2021-ab" in result
            assert result["Smith2021-ab"] == "10.1234/test"
        finally:
            os.unlink(path)

    def test_no_doi_no_match(self):
        """Paper without DOI is not matched."""
        json_entries = [{"doi": "10.9999/other", "id_list": [], "author": []}]
        papers = [{"id": "Smith2021-ab", "doi": None, "title": "Test"}]
        path = self._make_json_file(json_entries)
        try:
            result = match_by_doi_from_json(path, papers)
            assert "Smith2021-ab" not in result
        finally:
            os.unlink(path)

    def test_missing_json_returns_empty(self):
        """Gracefully handles non-existent JSON file."""
        papers = [{"id": "Smith2021-ab", "doi": "10.1234/test"}]
        result = match_by_doi_from_json("/nonexistent/path.json", papers)
        assert result == {}

    def test_empty_papers_list(self):
        """Empty papers list returns empty dict."""
        json_entries = [{"doi": "10.1234/test", "id_list": [], "author": []}]
        path = self._make_json_file(json_entries)
        try:
            result = match_by_doi_from_json(path, [])
            assert result == {}
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# TestScanPdfDirectory
# ---------------------------------------------------------------------------

class TestScanPdfDirectory:
    def test_smoke_real_paperpile(self):
        """Real Paperpile folder has >5000 PDFs, all with .pdf extension."""
        if not REAL_PAPERPILE_DIR_AVAILABLE:
            pytest.skip("Paperpile directory not available")
        paths = scan_pdf_directory(PAPERPILE_DIR)
        assert len(paths) > 5000, f"Expected >5000 PDFs, got {len(paths)}"
        for p in paths:
            assert p.endswith(".pdf") or p.lower().endswith(".pdf"), (
                f"Non-PDF path returned: {p}"
            )
            assert os.path.isabs(p), f"Expected absolute path, got: {p}"

    def test_returns_list(self):
        """scan_pdf_directory returns a list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a fake PDF
            open(os.path.join(tmpdir, "test.pdf"), "w").close()
            result = scan_pdf_directory(tmpdir)
            assert isinstance(result, list)
            assert len(result) == 1
            assert result[0].endswith("test.pdf")

    def test_nonexistent_dir_returns_empty(self):
        """Gracefully handles missing directory."""
        result = scan_pdf_directory("/nonexistent/path/to/pdfs")
        assert result == []

    def test_excludes_non_pdf_files(self):
        """Only .pdf files are returned."""
        with tempfile.TemporaryDirectory() as tmpdir:
            open(os.path.join(tmpdir, "paper.pdf"), "w").close()
            open(os.path.join(tmpdir, "readme.txt"), "w").close()
            open(os.path.join(tmpdir, "data.csv"), "w").close()
            result = scan_pdf_directory(tmpdir)
            assert len(result) == 1
            assert result[0].endswith("paper.pdf")

    def test_recursive_subdirs(self):
        """PDFs in subdirectories are included."""
        with tempfile.TemporaryDirectory() as tmpdir:
            subdir = os.path.join(tmpdir, "sub")
            os.makedirs(subdir)
            open(os.path.join(tmpdir, "root.pdf"), "w").close()
            open(os.path.join(subdir, "nested.pdf"), "w").close()
            result = scan_pdf_directory(tmpdir)
            assert len(result) == 2


# ---------------------------------------------------------------------------
# TestMatchPapersToPdfs
# ---------------------------------------------------------------------------

class TestMatchPapersToPdfs:
    def test_returns_dict(self):
        """match_papers_to_pdfs returns a dict even when no matches."""
        with tempfile.TemporaryDirectory() as tmpdir:
            papers = [{"id": "X-xx", "doi": None, "first_author": "Smith",
                       "authors": "Smith, John", "year": 2020}]
            result = match_papers_to_pdfs(papers, pdf_dir=tmpdir, json_path=None)
            assert isinstance(result, dict)

    def test_fuzzy_match_works(self):
        """Creates a fake PDF filename that matches a paper."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create PDF with matching filename
            open(os.path.join(tmpdir, "SmithJones-Science-2020.pdf"), "w").close()
            papers = [{
                "id": "Smith2020-ab",
                "doi": None,
                "first_author": "Smith",
                "authors": "Smith, John; Jones, Alice",
                "year": 2020,
            }]
            result = match_papers_to_pdfs(papers, pdf_dir=tmpdir, json_path=None,
                                          threshold=0.7)
            assert "Smith2020-ab" in result
