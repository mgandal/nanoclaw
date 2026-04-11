#!/usr/bin/env python3
"""Tests for cross_linker.py — deterministic cross-linking and INDEX.md generation."""

import os
import sys
import pytest

# Allow importing cross_linker from parent package without installing
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cross_linker import (
    find_cross_links,
    inject_wikilinks,
    generate_index_md,
)


# ---------------------------------------------------------------------------
# TestFindCrossLinks
# ---------------------------------------------------------------------------

class TestFindCrossLinks:
    def test_shared_above_threshold_returns_pair(self):
        """Clusters sharing >40% of papers (of the smaller) should produce a link."""
        cluster_papers = {
            "autism-genetics": ["p1", "p2", "p3", "p4", "p5"],  # 5 papers
            "gwas-methods":    ["p1", "p2", "p3", "p6", "p7"],  # 5 papers; 3 shared = 60%
        }
        links = find_cross_links(cluster_papers, share_threshold=0.1)
        assert ("autism-genetics", "gwas-methods") in links

    def test_no_shared_papers_returns_empty(self):
        """Clusters with zero paper overlap should produce no links."""
        cluster_papers = {
            "autism-genetics": ["p1", "p2", "p3"],
            "brain-imaging":   ["p4", "p5", "p6"],
        }
        links = find_cross_links(cluster_papers, share_threshold=0.1)
        assert links == []

    def test_below_threshold_not_linked(self):
        """1/10 shared papers = 10% which is not above threshold of 0.5."""
        cluster_papers = {
            "cluster-a": ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"],
            "cluster-b": ["p1", "p11", "p12", "p13"],  # 1 shared / min(10,4) = 1/4 = 25%
        }
        links = find_cross_links(cluster_papers, share_threshold=0.5)
        assert ("cluster-a", "cluster-b") not in links
        assert ("cluster-b", "cluster-a") not in links

    def test_threshold_boundary_exclusive(self):
        """Exactly at threshold (not above) should not link."""
        # 2 shared out of 4 papers in smaller = 50%, threshold=0.5 → not above
        cluster_papers = {
            "cluster-a": ["p1", "p2", "p3", "p4"],
            "cluster-b": ["p1", "p2", "p5", "p6"],
        }
        links = find_cross_links(cluster_papers, share_threshold=0.5)
        assert ("cluster-a", "cluster-b") not in links
        assert ("cluster-b", "cluster-a") not in links

    def test_threshold_boundary_above(self):
        """Just above threshold should link."""
        # 3 shared out of 4 = 75% > 50%
        cluster_papers = {
            "cluster-a": ["p1", "p2", "p3", "p4"],
            "cluster-b": ["p1", "p2", "p3", "p5"],
        }
        links = find_cross_links(cluster_papers, share_threshold=0.5)
        assert len(links) == 1

    def test_results_are_sorted(self):
        """Output tuples should be sorted (slug_a < slug_b) and list sorted."""
        cluster_papers = {
            "zoo-topic":   ["p1", "p2", "p3"],
            "alpha-topic": ["p1", "p2", "p4"],
        }
        links = find_cross_links(cluster_papers, share_threshold=0.1)
        assert len(links) == 1
        slug_a, slug_b = links[0]
        assert slug_a < slug_b  # alphabetically sorted within pair

    def test_multiple_pairs_detected(self):
        """Should detect multiple crossing pairs simultaneously."""
        cluster_papers = {
            "cluster-a": ["p1", "p2", "p3", "p4", "p5"],
            "cluster-b": ["p1", "p2", "p3", "p6", "p7"],  # 3/5 = 60% with a
            "cluster-c": ["p1", "p2", "p4", "p8", "p9"],  # 3/5 = 60% with a, 2/5=40% with b
        }
        links = find_cross_links(cluster_papers, share_threshold=0.4)
        assert ("cluster-a", "cluster-b") in links
        assert ("cluster-a", "cluster-c") in links

    def test_single_cluster_returns_empty(self):
        """Only one cluster — no pairs to check."""
        cluster_papers = {"solo-cluster": ["p1", "p2", "p3"]}
        links = find_cross_links(cluster_papers, share_threshold=0.1)
        assert links == []

    def test_empty_cluster_paper_lists(self):
        """Clusters with empty paper lists should not error and min_size = 0 (no NaN)."""
        cluster_papers = {
            "cluster-a": [],
            "cluster-b": ["p1", "p2"],
        }
        # Empty cluster → min_size = 0 → intersection/0 would be 0/0; should not crash
        links = find_cross_links(cluster_papers, share_threshold=0.1)
        # Empty intersection / 0 is 0 shared, should not raise
        assert isinstance(links, list)

    def test_uses_smaller_cluster_for_threshold(self):
        """Threshold is based on min cluster size, not the larger one."""
        # 2 shared: cluster-a has 10, cluster-b has 4 → min=4 → 2/4=50% → above 0.4
        cluster_papers = {
            "cluster-a": ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"],
            "cluster-b": ["p1", "p2", "p11", "p12"],
        }
        links = find_cross_links(cluster_papers, share_threshold=0.4)
        assert len(links) == 1

    def test_default_threshold_is_0_1(self):
        """Default threshold of 0.1 should catch even small overlaps."""
        cluster_papers = {
            "cluster-a": ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"],
            "cluster-b": ["p1", "p11", "p12", "p13", "p14", "p15", "p16", "p17", "p18", "p19"],
        }
        # 1 shared / min(10,10) = 10% — exactly at default threshold, not above
        links = find_cross_links(cluster_papers)
        assert ("cluster-a", "cluster-b") not in links


# ---------------------------------------------------------------------------
# TestInjectWikilinks
# ---------------------------------------------------------------------------

class TestInjectWikilinks:
    def test_inject_before_references(self):
        """Wikilinks should be injected before ## References section."""
        text = "Some content.\n\n## References\n\n- [Paper2020-ab] Title"
        slug_to_name = {"related-topic": "Related Topic"}
        result = inject_wikilinks(text, ["related-topic"], slug_to_name)
        ref_pos = result.index("## References")
        see_also_pos = result.index("See also:")
        assert see_also_pos < ref_pos

    def test_inject_before_key_papers(self):
        """Wikilinks should be injected before ## Key Papers section when no References."""
        text = "Some content.\n\n## Key Papers\n\n- [Paper2020-ab] Title"
        slug_to_name = {"related-topic": "Related Topic"}
        result = inject_wikilinks(text, ["related-topic"], slug_to_name)
        key_papers_pos = result.index("## Key Papers")
        see_also_pos = result.index("See also:")
        assert see_also_pos < key_papers_pos

    def test_prefers_references_over_key_papers(self):
        """When both markers exist, inject before ## References."""
        text = "Content.\n\n## Key Papers\n\nPapers.\n\n## References\n\nRefs."
        slug_to_name = {"other-topic": "Other Topic"}
        result = inject_wikilinks(text, ["other-topic"], slug_to_name)
        ref_pos = result.index("## References")
        see_also_pos = result.index("See also:")
        assert see_also_pos < ref_pos

    def test_append_to_end_when_no_markers(self):
        """When neither References nor Key Papers found, append to end."""
        text = "Just some content without sections."
        slug_to_name = {"other-topic": "Other Topic"}
        result = inject_wikilinks(text, ["other-topic"], slug_to_name)
        assert result.endswith("[[other-topic]]") or "See also:" in result
        assert result.index("See also:") > result.index("Just some content")

    def test_wikilink_format(self):
        """Should produce [[slug]] format wikilinks."""
        text = "Content.\n\n## References\n\nRefs."
        slug_to_name = {"autism-genetics": "Autism Genetics GWAS"}
        result = inject_wikilinks(text, ["autism-genetics"], slug_to_name)
        assert "[[autism-genetics]]" in result

    def test_no_duplicate_links(self):
        """Calling inject_wikilinks twice should not duplicate wikilinks."""
        text = "Content.\n\n## References\n\nRefs."
        slug_to_name = {"topic-a": "Topic A"}
        result1 = inject_wikilinks(text, ["topic-a"], slug_to_name)
        result2 = inject_wikilinks(result1, ["topic-a"], slug_to_name)
        assert result2.count("[[topic-a]]") == 1

    def test_multiple_targets_all_injected(self):
        """All target slugs should appear in the output."""
        text = "Content.\n\n## References\n\nRefs."
        slug_to_name = {
            "topic-a": "Topic A",
            "topic-b": "Topic B",
            "topic-c": "Topic C",
        }
        result = inject_wikilinks(text, ["topic-a", "topic-b", "topic-c"], slug_to_name)
        assert "[[topic-a]]" in result
        assert "[[topic-b]]" in result
        assert "[[topic-c]]" in result

    def test_empty_targets_returns_unchanged(self):
        """Empty target list should return text unchanged."""
        text = "Content.\n\n## References\n\nRefs."
        result = inject_wikilinks(text, [], {})
        assert result == text

    def test_slug_already_present_not_duplicated(self):
        """If a slug's wikilink already exists in text, it should not be added again."""
        text = "See [[existing-topic]] for details.\n\n## References\n\nRefs."
        slug_to_name = {"existing-topic": "Existing Topic"}
        result = inject_wikilinks(text, ["existing-topic"], slug_to_name)
        assert result.count("[[existing-topic]]") == 1

    def test_see_also_section_label(self):
        """The injected block should contain 'See also:' label."""
        text = "Content.\n\n## References\n\nRefs."
        slug_to_name = {"related": "Related"}
        result = inject_wikilinks(text, ["related"], slug_to_name)
        assert "See also:" in result


# ---------------------------------------------------------------------------
# TestGenerateIndexMd
# ---------------------------------------------------------------------------

class TestGenerateIndexMd:
    def _make_cluster(self, id, name, slug, desc, paper_count, parent_id=None):
        return {
            "id": id,
            "name": name,
            "slug": slug,
            "description": desc,
            "paper_count": paper_count,
            "parent_id": parent_id,
        }

    def test_header_contains_paper_count(self):
        clusters = [self._make_cluster(1, "Autism Genetics", "autism-genetics", "GWAS studies", 47)]
        result = generate_index_md(clusters, total_papers=5721)
        assert "5,721" in result or "5721" in result

    def test_header_contains_cluster_count(self):
        clusters = [
            self._make_cluster(1, "Topic A", "topic-a", "Desc A", 47),
            self._make_cluster(2, "Topic B", "topic-b", "Desc B", 38),
        ]
        result = generate_index_md(clusters, total_papers=100)
        assert "2" in result  # cluster count

    def test_header_contains_date(self):
        clusters = [self._make_cluster(1, "Topic", "topic", "Desc", 10)]
        result = generate_index_md(clusters, total_papers=100)
        assert "2026-04-10" in result or "Generated:" in result

    def test_header_contains_hierarchy_link(self):
        clusters = [self._make_cluster(1, "Topic", "topic", "Desc", 10)]
        result = generate_index_md(clusters, total_papers=100)
        assert ".meta/hierarchy.html" in result

    def test_wikilinks_present(self):
        clusters = [self._make_cluster(1, "Autism Genetics GWAS", "autism-genetics-gwas", "GWAS", 47)]
        result = generate_index_md(clusters, total_papers=5721)
        assert "[[autism-genetics-gwas]]" in result

    def test_paper_counts_shown(self):
        clusters = [self._make_cluster(1, "Brain Transcriptomics", "brain-transcriptomics", "scRNA", 38)]
        result = generate_index_md(clusters, total_papers=5721)
        assert "38" in result

    def test_clusters_ordered_by_paper_count_descending(self):
        """Larger clusters should appear before smaller ones at same level."""
        clusters = [
            self._make_cluster(1, "Small Topic", "small-topic", "Small", 5),
            self._make_cluster(2, "Large Topic", "large-topic", "Large", 100),
        ]
        result = generate_index_md(clusters, total_papers=200)
        large_pos = result.index("large-topic")
        small_pos = result.index("small-topic")
        assert large_pos < small_pos

    def test_top_level_clusters_listed_first(self):
        """Clusters with parent_id=None should appear as top-level entries."""
        clusters = [
            self._make_cluster(1, "Parent Topic", "parent-topic", "Parent", 50, parent_id=None),
            self._make_cluster(2, "Child Topic", "child-topic", "Child", 20, parent_id=1),
        ]
        result = generate_index_md(clusters, total_papers=100)
        # Parent should appear before child
        parent_pos = result.index("parent-topic")
        child_pos = result.index("child-topic")
        assert parent_pos < child_pos

    def test_children_indented_under_parents(self):
        """Child clusters should be indented relative to their parent."""
        clusters = [
            self._make_cluster(1, "Parent Topic", "parent-topic", "Parent", 50, parent_id=None),
            self._make_cluster(2, "Child Topic", "child-topic", "Child", 20, parent_id=1),
        ]
        result = generate_index_md(clusters, total_papers=100)
        lines = result.split("\n")
        # Find lines containing slug
        parent_line = next(l for l in lines if "parent-topic" in l)
        child_line = next(l for l in lines if "child-topic" in l)
        # Child line should have more leading whitespace than parent line
        parent_indent = len(parent_line) - len(parent_line.lstrip())
        child_indent = len(child_line) - len(child_line.lstrip())
        assert child_indent > parent_indent

    def test_description_shown(self):
        """Cluster description should appear in the index."""
        clusters = [self._make_cluster(1, "Autism Genetics", "autism-genetics", "Papers about autism GWAS", 47)]
        result = generate_index_md(clusters, total_papers=5721)
        assert "Papers about autism GWAS" in result

    def test_paperpile_wiki_title(self):
        """INDEX.md should start with # Paperpile Wiki header."""
        clusters = [self._make_cluster(1, "Topic", "topic", "Desc", 10)]
        result = generate_index_md(clusters, total_papers=100)
        assert result.startswith("# Paperpile Wiki")

    def test_multiple_top_level_clusters(self):
        """Multiple top-level clusters should all appear."""
        clusters = [
            self._make_cluster(1, "Autism Genetics", "autism-genetics", "GWAS", 47),
            self._make_cluster(2, "Brain Transcriptomics", "brain-transcriptomics", "scRNA", 38),
        ]
        result = generate_index_md(clusters, total_papers=5721)
        assert "[[autism-genetics]]" in result
        assert "[[brain-transcriptomics]]" in result

    def test_orphan_children_handled(self):
        """Children whose parent_id doesn't match any cluster should still appear."""
        clusters = [
            self._make_cluster(99, "Orphan Child", "orphan-child", "Orphan", 5, parent_id=999),
        ]
        result = generate_index_md(clusters, total_papers=100)
        assert "orphan-child" in result

    def test_empty_clusters_list(self):
        """Empty cluster list should still produce valid INDEX.md."""
        result = generate_index_md([], total_papers=0)
        assert "# Paperpile Wiki" in result
