from pathlib import Path
from skill_evolve.rubric import score_axes, RubricResult, EvalCase


WIKI_RUBRIC = Path(__file__).parent.parent / "rubrics" / "wiki.yaml"


def write_page(d: Path, rel: str, frontmatter: dict, body: str) -> Path:
    import yaml
    p = d / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"---\n{yaml.safe_dump(frontmatter)}---\n\n{body}\n")
    return p


def test_folder_routing_exact_match(tmp_path):
    write_page(tmp_path, "wiki/papers/tang-2024.md",
               {"title": "Tang 2024", "type": "summary", "created": "2026-05-23",
                "updated": "2026-05-23", "tags": ["wiki/papers"], "skill_version": "test"},
               "## Sources\n- foo")
    case = EvalCase(prompt="add Tang 2024", expected_path_regex=r"^wiki/papers/.*\.md$",
                    expected_tags_subset=["wiki/papers"])
    result = score_axes(case, tmp_path, WIKI_RUBRIC)
    assert result.axis_scores["folder_routing"][0] == 1.0
    assert result.axis_scores["frontmatter_parse"][0] == 1.0
    assert result.axis_scores["tag_set"][0] == 1.0
    assert result.eligible is True


def test_folder_routing_wrong_folder_scores_zero(tmp_path):
    write_page(tmp_path, "wiki/syntheses/tang.md",
               {"title": "Tang", "type": "synthesis", "created": "2026-05-23",
                "updated": "2026-05-23", "tags": ["wiki/syntheses"], "skill_version": "test"},
               "## Related\n- foo")
    case = EvalCase(prompt="add Tang 2024", expected_path_regex=r"^wiki/papers/.*\.md$",
                    expected_tags_subset=["wiki/papers"])
    result = score_axes(case, tmp_path, WIKI_RUBRIC)
    assert result.axis_scores["folder_routing"][0] == 0.0
    assert "Expected" in result.axis_scores["folder_routing"][1]


def test_folder_routing_parent_match_scores_half(tmp_path):
    write_page(tmp_path, "wiki/papers/other/x.md",
               {"title": "X", "type": "summary", "created": "2026-05-23",
                "updated": "2026-05-23", "tags": ["wiki/papers"], "skill_version": "test"},
               "## Sources\n- foo")
    case = EvalCase(prompt="add X", expected_path_regex=r"^wiki/papers/[^/]+\.md$",
                    expected_tags_subset=["wiki/papers"])
    result = score_axes(case, tmp_path, WIKI_RUBRIC)
    assert result.axis_scores["folder_routing"][0] == 0.5


def test_frontmatter_missing_required_key(tmp_path):
    write_page(tmp_path, "wiki/papers/x.md",
               {"title": "X", "type": "summary", "created": "2026-05-23",
                "tags": ["wiki/papers"]},  # missing updated, skill_version
               "## Sources\n- foo")
    case = EvalCase(prompt="add X", expected_path_regex=r"^wiki/papers/.*\.md$",
                    expected_tags_subset=["wiki/papers"])
    result = score_axes(case, tmp_path, WIKI_RUBRIC)
    assert result.axis_scores["frontmatter_parse"][0] == 0.0
    assert "missing" in result.axis_scores["frontmatter_parse"][1].lower()


def test_tag_subset_missing_scores_zero(tmp_path):
    write_page(tmp_path, "wiki/papers/x.md",
               {"title": "X", "type": "summary", "created": "2026-05-23",
                "updated": "2026-05-23", "tags": ["wiki/papers"], "skill_version": "test"},
               "## Sources\n- foo")
    case = EvalCase(prompt="add X", expected_path_regex=r"^wiki/papers/.*\.md$",
                    expected_tags_subset=["wiki/papers", "neuroscience"])
    result = score_axes(case, tmp_path, WIKI_RUBRIC)
    assert result.axis_scores["tag_set"][0] == 0.0


def test_preflight_paper_without_sources_section_ineligible(tmp_path):
    write_page(tmp_path, "wiki/papers/x.md",
               {"title": "X", "type": "paper", "created": "2026-05-23",
                "updated": "2026-05-23", "tags": ["wiki/papers"], "skill_version": "test"},
               "no sources section here")
    case = EvalCase(prompt="add X", expected_path_regex=r"^wiki/papers/.*\.md$",
                    expected_tags_subset=["wiki/papers"])
    result = score_axes(case, tmp_path, WIKI_RUBRIC)
    assert result.eligible is False


def test_zero_files_written_ineligible_score_zero(tmp_path):
    case = EvalCase(prompt="add X", expected_path_regex=r"^wiki/papers/.*\.md$",
                    expected_tags_subset=["wiki/papers"])
    result = score_axes(case, tmp_path, WIKI_RUBRIC)
    assert result.eligible is False
    assert result.mean_score == 0.0
