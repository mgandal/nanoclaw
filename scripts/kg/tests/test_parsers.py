from textwrap import dedent

from kg.parsers import (
    generate_person_aliases,
    parse_contact,
    parse_dataset,
    parse_grants_file,
    parse_lab_roster,
    parse_paper,
    parse_projects_file,
    parse_tool,
    extract_paper_stubs,
    normalize_reference,
)


# ---------------------------------------------------------------------------
# Alias generation
# ---------------------------------------------------------------------------


class TestGenerateAliases:
    def test_simple_first_last(self):
        aliases = generate_person_aliases("Michael Gandal")
        assert "Michael Gandal" in aliases
        assert "Gandal, Michael" in aliases
        assert "Gandal, M." in aliases
        assert "Gandal M" in aliases

    def test_with_middle_initial(self):
        aliases = generate_person_aliases("Michael J Gandal")
        assert "Gandal MJ" in aliases
        # Simple first+last still generated
        assert "Michael Gandal" in aliases

    def test_hyphenated_last_name(self):
        aliases = generate_person_aliases("Aaron Alexander-Bloch")
        assert "Aaron Alexander-Bloch" in aliases
        # Last-name comma form uses the full hyphenated surname
        assert "Alexander-Bloch, Aaron" in aliases

    def test_email_handle_as_alias(self):
        aliases = generate_person_aliases("Michael Gandal", "mgandal@example.com")
        assert "mgandal" in aliases

    def test_single_token_no_crash(self):
        aliases = generate_person_aliases("Madonna")
        assert aliases == ["Madonna"]

    def test_empty_returns_empty(self):
        assert generate_person_aliases("") == []
        assert generate_person_aliases("   ") == []

    def test_deduplicates(self):
        aliases = generate_person_aliases("Michael Gandal")
        assert len(aliases) == len(set(aliases))


# ---------------------------------------------------------------------------
# parse_contact
# ---------------------------------------------------------------------------


def _contact(name="", email="", projects=None, extra=""):
    lines = [
        "---",
        "type: collaborator",
        f"name: {name}",
        f"email: {email}",
        "institution: University of Penn",
        "role: PI",
    ]
    if projects:
        lines.append("projects:")
        for p in projects:
            lines.append(f"  - {p}")
    if extra:
        lines.append(extra)
    lines.extend(["---", "", f"# {name}", "", "Some notes.", ""])
    return "\n".join(lines)


class TestParseContact:
    def test_basic(self):
        result = parse_contact(
            _contact(name="Aaron Alexander-Bloch", email="aab@penn.edu"),
            "20-contacts/aaron.md",
        )
        assert result is not None
        entity = result["entity"]
        assert entity["canonical_name"] == "Aaron Alexander-Bloch"
        assert entity["type"] == "person"
        assert entity["metadata"]["email"] == "aab@penn.edu"
        assert entity["metadata"]["institution"] == "University of Penn"
        assert entity["source_doc"] == "20-contacts/aaron.md"
        assert "Aaron Alexander-Bloch" in entity["aliases"]
        assert "aab" in entity["aliases"]

    def test_project_edges_extracted(self):
        result = parse_contact(
            _contact(name="Rachel Smith", projects=["BrainGO", "asd-rarevar-anno"]),
            "20-contacts/rachel.md",
        )
        edges = result["edges"]
        assert len(edges) == 2
        relations = {e["relation"] for e in edges}
        assert relations == {"member_of"}
        targets = {e["target"] for e in edges}
        assert targets == {"BrainGO", "asd-rarevar-anno"}

    def test_no_frontmatter_and_no_h1_returns_none(self):
        assert parse_contact("just body, no frontmatter, no heading.", "x.md") is None

    def test_missing_name_returns_none(self):
        text = _contact(name="")
        assert parse_contact(text, "x.md") is None

    def test_empty_projects_no_edges(self):
        result = parse_contact(_contact(name="X Y", projects=[]), "x.md")
        assert result["edges"] == []

    def test_h1_fallback_when_no_frontmatter(self):
        text = (
            "# Abraham Pachikara\n\n"
            "## Contact\n- **Email:** \n\n"
            "## Position\n- **Role:** \n\n"
        )
        result = parse_contact(text, "20-contacts/abraham.md")
        assert result is not None
        assert result["entity"]["canonical_name"] == "Abraham Pachikara"
        assert result["entity"]["type"] == "person"
        assert result["entity"]["confidence"] == 0.7
        assert result["entity"]["metadata"]["source"] == "h1_fallback"
        assert result["edges"] == []

    def test_h1_fallback_rejects_template_placeholder(self):
        text = "# {{name}}\n\nblah"
        assert parse_contact(text, "x.md") is None

    def test_h1_fallback_rejects_no_heading(self):
        text = "just body text, no heading\n"
        assert parse_contact(text, "x.md") is None

    def test_yaml_entity_has_confidence_1(self):
        result = parse_contact(_contact(name="Rachel Smith"), "x.md")
        assert result["entity"]["confidence"] == 1.0


class TestParseContactProseMentions:
    """KG contacts → project edges gap: parse_contact only reads the
    frontmatter `projects:` array today, so 384/420 contact files produce
    isolated person nodes with no project edges. Extension: scan the body
    for mentions of known project names (from projects.md) and emit
    member_of edges for those too."""

    KNOWN = frozenset(
        {
            "asd-rarevar-anno",
            "asd-lcl-rnaseq",
            "BrainGO",
            "scRBP",
            "mitoPRS",
            "APA",
        }
    )

    def test_prose_mention_in_position_notes_creates_edge(self):
        text = (
            "---\ntype: lab-member\nname: Rachel Smith\nrole: Postdoc\n---\n\n"
            "# Rachel Smith\n\n"
            "## Position\n"
            "- **Notes:** asd-rarevar-anno, asd-lcl-rnaseq projects; PhD exam Apr 2025\n"
        )
        result = parse_contact(
            text, "20-contacts/rachel-smith.md", known_projects=self.KNOWN
        )
        assert result is not None
        targets = {e["target"] for e in result["edges"]}
        assert "asd-rarevar-anno" in targets
        assert "asd-lcl-rnaseq" in targets
        # Edge should indicate prose provenance (distinguish from array-sourced)
        prose_edges = [e for e in result["edges"] if "prose" in e.get("evidence", "")]
        assert len(prose_edges) >= 2

    def test_prose_mention_in_current_projects_bullets(self):
        text = (
            "---\ntype: lab-member\nname: Rachel Smith\n---\n\n"
            "# Rachel Smith\n\n"
            "## Progress\n"
            "### Current Projects\n"
            "- asd-rarevar-anno\n"
            "- BrainGO / Hierarchical HotNet analysis\n"
        )
        result = parse_contact(
            text, "20-contacts/rachel-smith.md", known_projects=self.KNOWN
        )
        targets = {e["target"] for e in result["edges"]}
        assert "asd-rarevar-anno" in targets
        assert "BrainGO" in targets

    def test_dedup_frontmatter_array_wins_over_prose(self):
        """If a project is in the frontmatter `projects:` array AND the body,
        only one edge is emitted — the frontmatter one (precedence)."""
        text = (
            "---\n"
            "type: lab-member\nname: Rachel Smith\n"
            "projects:\n  - asd-rarevar-anno\n"
            "---\n\n"
            "# Rachel Smith\n\n"
            "## Position\n- **Notes:** asd-rarevar-anno rules\n"
        )
        result = parse_contact(
            text, "20-contacts/rachel.md", known_projects=self.KNOWN
        )
        edges = [e for e in result["edges"] if e["target"] == "asd-rarevar-anno"]
        assert len(edges) == 1
        # Frontmatter-sourced, not prose-sourced
        assert "projects[]" in edges[0]["evidence"]

    def test_prose_match_is_case_insensitive(self):
        text = (
            "---\ntype: lab-member\nname: Rachel Smith\n---\n\n"
            "# Rachel Smith\n\n"
            "Working on ASD-RAREVAR-ANNO and braingo.\n"
        )
        result = parse_contact(
            text, "20-contacts/rachel.md", known_projects=self.KNOWN
        )
        targets = {e["target"] for e in result["edges"]}
        # Targets must be canonical (as supplied in known_projects), not the
        # as-written text
        assert "asd-rarevar-anno" in targets
        assert "BrainGO" in targets

    def test_project_name_not_in_known_set_is_ignored(self):
        text = (
            "---\ntype: lab-member\nname: Rachel Smith\n---\n\n"
            "# Rachel Smith\n\n"
            "## Position\n- **Notes:** some-unknown-project is fun\n"
        )
        result = parse_contact(
            text, "20-contacts/rachel.md", known_projects=self.KNOWN
        )
        assert result["edges"] == []

    def test_backward_compat_no_known_projects_kwarg(self):
        """Pre-existing callers that do not pass known_projects still work
        with the old `projects:`-array-only behavior."""
        text = (
            "---\n"
            "type: lab-member\nname: Rachel Smith\n"
            "projects:\n  - BrainGO\n"
            "---\n\n"
            "# Rachel Smith\n\n"
            "## Position\n- **Notes:** asd-rarevar-anno\n"
        )
        result = parse_contact(text, "20-contacts/rachel.md")  # no kwarg
        targets = {e["target"] for e in result["edges"]}
        assert targets == {"BrainGO"}  # no prose hit

    def test_word_boundary_prevents_substring_match(self):
        """`APA` must not match `APAthetic` or `AppAlled`."""
        text = (
            "---\ntype: lab-member\nname: X Y\n---\n\n"
            "# X Y\n\n"
            "## Position\n- **Notes:** unappathetic attitude; appalled reaction\n"
        )
        result = parse_contact(
            text, "20-contacts/xy.md", known_projects=self.KNOWN
        )
        apa_edges = [e for e in result["edges"] if e["target"] == "APA"]
        assert len(apa_edges) == 0

    def test_prose_match_only_in_body_not_frontmatter_string(self):
        """If someone writes prose about `APA` in a frontmatter comment/value,
        the parser should NOT scan the frontmatter region for prose matches —
        only body. Prevents false positives from malformed YAML values."""
        text = (
            "---\n"
            "type: lab-member\nname: X Y\nrole: APA project guy\n"
            "---\n\n"
            "# X Y\n\nno project mentions here.\n"
        )
        result = parse_contact(
            text, "20-contacts/xy.md", known_projects=self.KNOWN
        )
        # Edges should be empty — APA only appeared in `role:` frontmatter value
        apa_edges = [e for e in result["edges"] if e["target"] == "APA"]
        assert len(apa_edges) == 0


# ---------------------------------------------------------------------------
# parse_tool
# ---------------------------------------------------------------------------


TOOL_YAML = dedent("""\
    ---
    type: "kb-tool"
    name: "flash"
    url: "https://github.com/x"
    language: "R"
    category: "statistical"
    we_use: false
    related_tools: ["ebnm", "fastTopics"]
    key_papers: ["Wang & Stephens 2021"]
    relevant_projects: ["APA"]
    datasets_tested: []
    ---

    # Flash
""")


class TestParseTool:
    def test_basic_fields(self):
        result = parse_tool(TOOL_YAML, "wiki/tools/flash.md")
        assert result is not None
        e = result["entity"]
        assert e["canonical_name"] == "flash"
        assert e["type"] == "tool"
        assert e["metadata"]["language"] == "R"
        assert e["metadata"]["we_use"] is False

    def test_related_tools_edges(self):
        result = parse_tool(TOOL_YAML, "wiki/tools/flash.md")
        rel = [e for e in result["edges"] if e["relation"] == "related_to"]
        assert {e["target"] for e in rel} == {"ebnm", "fastTopics"}

    def test_key_papers_as_cites_edges(self):
        result = parse_tool(TOOL_YAML, "wiki/tools/flash.md")
        cites = [e for e in result["edges"] if e["relation"] == "cites"]
        assert len(cites) == 1
        assert cites[0]["target"] == "Wang & Stephens 2021"
        assert cites[0]["target_type"] == "paper"

    def test_projects_edge(self):
        result = parse_tool(TOOL_YAML, "wiki/tools/flash.md")
        projs = [e for e in result["edges"] if e["relation"] == "used_by_project"]
        assert len(projs) == 1
        assert projs[0]["target"] == "APA"


# ---------------------------------------------------------------------------
# parse_dataset
# ---------------------------------------------------------------------------


DATASET_YAML = dedent("""\
    ---
    type: "kb-dataset"
    name: "Siletti et al. 2023 Adult Human Brain Cell Atlas"
    acronym: "Siletti-Brain-Atlas"
    url: "https://example.com"
    sample_size: "3M+ nuclei"
    disorders: ["cross-disorder"]
    key_papers: ["wiki/papers/siletti-2023"]
    related_datasets: ["wiki/datasets/kim-2023"]
    ---
""")


class TestParseDataset:
    def test_basic(self):
        result = parse_dataset(DATASET_YAML, "wiki/datasets/siletti.md")
        e = result["entity"]
        assert e["type"] == "dataset"
        assert "Siletti-Brain-Atlas" in e["aliases"]

    def test_dataset_disorder_edge(self):
        result = parse_dataset(DATASET_YAML, "wiki/datasets/siletti.md")
        dis = [e for e in result["edges"] if e["relation"] == "related_to_disorder"]
        assert len(dis) == 1
        assert dis[0]["target"] == "cross-disorder"

    def test_dataset_related_dataset_edge(self):
        result = parse_dataset(DATASET_YAML, "wiki/datasets/siletti.md")
        rel = [e for e in result["edges"] if e["relation"] == "related_to"]
        assert {e["target"] for e in rel} == {"wiki/datasets/kim-2023"}


# ---------------------------------------------------------------------------
# parse_paper
# ---------------------------------------------------------------------------


PAPER_YAML = dedent("""\
    ---
    type: kb-paper
    doi: "10.1038/s41592-026-03045-6"
    first_author: "Neng Huang"
    year: 2026
    journal: "Nature Methods"
    lab_relevance: "high"
    ---

    # Long RNA-seq paper
""")


class TestParsePaper:
    def test_canonical_name_from_author_year(self):
        result = parse_paper(PAPER_YAML, "wiki/papers/huang.md")
        e = result["entity"]
        assert e["canonical_name"] == "Neng Huang 2026 (Nature Methods)"
        assert e["type"] == "paper"
        assert "doi:10.1038/s41592-026-03045-6" in e["aliases"]

    def test_authored_edge_generated(self):
        result = parse_paper(PAPER_YAML, "wiki/papers/huang.md")
        auth = [e for e in result["edges"] if e["relation"] == "authored"]
        assert len(auth) == 1
        assert auth[0]["source"] == "Neng Huang"
        assert auth[0]["source_type"] == "person"

    def test_no_author_no_doi_returns_none(self):
        text = dedent("""\
            ---
            type: kb-paper
            ---
        """)
        assert parse_paper(text, "x.md") is None


# ---------------------------------------------------------------------------
# State file parsers
# ---------------------------------------------------------------------------


GRANTS_TEXT = dedent("""\
    # Grant Portfolio

    ## Active Grants

    ### NIH R01-MH137578 (NEW)
    **Title:** foo

    ### NIH R01-MH121521
    **Title:** bar

    ### SFARI Targeted #957585
    **Title:** baz
""")


class TestParseGrants:
    def test_extracts_grant_ids(self):
        entities = parse_grants_file(GRANTS_TEXT, "state/grants.md")
        names = {e["entity"]["canonical_name"] for e in entities}
        # R01 grants by ID; SFARI matched as "SFARI Targeted #957585"
        assert "R01-MH137578" in names
        assert "R01-MH121521" in names
        assert "SFARI Targeted #957585" in names

    def test_all_typed_as_grant(self):
        entities = parse_grants_file(GRANTS_TEXT, "state/grants.md")
        assert all(e["entity"]["type"] == "grant" for e in entities)


PROJECTS_TEXT = dedent("""\
    # Lab Projects

    ## Active Projects

    ### APA (Alternative Polyadenylation)
    **Lead:** X

    ### iso-TWAS / Long-Read Transcriptomics
    **Lead:** Y

    ### asd-rarevar-anno (ASD Rare Variant Annotation)
    **Lead:** Z
""")


class TestParseProjects:
    def test_extracts_project_names(self):
        entities = parse_projects_file(PROJECTS_TEXT, "state/projects.md")
        names = {e["entity"]["canonical_name"] for e in entities}
        assert "APA" in names
        assert "iso-TWAS / Long-Read Transcriptomics" in names
        assert "asd-rarevar-anno" in names

    def test_full_heading_preserved_as_alias(self):
        entities = parse_projects_file(PROJECTS_TEXT, "state/projects.md")
        apa = next(e for e in entities if e["entity"]["canonical_name"] == "APA")
        assert "APA (Alternative Polyadenylation)" in apa["entity"]["aliases"]


ROSTER_TEXT = dedent("""\
    # Gandal Lab Roster

    ## Current Members

    | Name | Role | Projects | Meeting Schedule |
    |------|------|----------|-----------------|
    | Daniel Vo | PhD Student | mitoPRS | Weekly 1:1 |
    | Rachel Smith | Postdoc | — | Weekly 1:1 |

    ## Collaborators

    | Name | Affiliation | Focus |
    |------|-------------|-------|
    | Should Not Appear | Elsewhere | Not parsed |
""")


class TestParseLabRoster:
    def test_only_current_members(self):
        entities = parse_lab_roster(ROSTER_TEXT, "state/lab-roster.md")
        names = {e["entity"]["canonical_name"] for e in entities}
        assert names == {"Daniel Vo", "Rachel Smith"}
        assert "Should Not Appear" not in names

    def test_role_in_metadata(self):
        entities = parse_lab_roster(ROSTER_TEXT, "state/lab-roster.md")
        by_name = {e["entity"]["canonical_name"]: e for e in entities}
        assert by_name["Daniel Vo"]["entity"]["metadata"]["role"] == "PhD Student"

    def test_aliases_generated(self):
        entities = parse_lab_roster(ROSTER_TEXT, "state/lab-roster.md")
        rachel = next(
            e for e in entities if e["entity"]["canonical_name"] == "Rachel Smith"
        )
        assert "Smith, Rachel" in rachel["entity"]["aliases"]


# ---------------------------------------------------------------------------
# Reference normalization (for edge resolution fallback)
# ---------------------------------------------------------------------------


class TestNormalizeReference:
    def test_strips_wiki_prefix(self):
        assert normalize_reference("wiki/tools/susier") == "susier"
        assert normalize_reference("content/wiki/tools/flash") == "flash"
        assert normalize_reference("tools/fuma") == "fuma"

    def test_strips_leading_slash_and_brackets(self):
        assert normalize_reference("[[projects/active/apa]]") == "apa"
        assert normalize_reference("/wiki/papers/huang-2026") == "huang-2026"

    def test_lowercases(self):
        assert normalize_reference("wiki/tools/SuSiER") == "susier"

    def test_empty_or_garbage(self):
        assert normalize_reference("") == ""
        assert normalize_reference("   ") == ""


# ---------------------------------------------------------------------------
# Paper stub extraction from citations / references in other entities
# ---------------------------------------------------------------------------


class TestExtractPaperStubs:
    def test_extracts_doi_from_citation_string(self):
        # Given a tool entity with key_papers pointing to a citation string
        input_entities = [
            {
                "entity": {
                    "canonical_name": "flash",
                    "type": "tool",
                    "aliases": ["flash"],
                },
                "edges": [
                    {
                        "source": "flash",
                        "source_type": "tool",
                        "target": (
                            "Wang & Stephens 2021 JRSS-B doi:10.1111/rssb.12488"
                        ),
                        "target_type": "paper",
                        "relation": "cites",
                        "evidence": "key_papers[]",
                        "source_doc": "wiki/tools/flash.md",
                    }
                ],
            }
        ]
        stubs = extract_paper_stubs(input_entities)
        assert len(stubs) == 1
        stub = stubs[0]
        assert (
            stub["entity"]["canonical_name"]
            == "Wang & Stephens 2021 JRSS-B doi:10.1111/rssb.12488"
        )
        assert stub["entity"]["type"] == "paper"
        # DOI extracted as alias for future resolution
        assert "doi:10.1111/rssb.12488" in stub["entity"]["aliases"]
        # Citation-derived confidence lower than YAML-backed
        assert stub["entity"]["confidence"] < 1.0

    def test_extracts_wiki_slug_as_alias(self):
        input_entities = [
            {
                "entity": {
                    "canonical_name": "cell2fate",
                    "type": "tool",
                    "aliases": ["cell2fate"],
                },
                "edges": [
                    {
                        "source": "cell2fate",
                        "source_type": "tool",
                        "target": "wiki/papers/aivazidis-2025-cell2fate-rna-velocity",
                        "target_type": "paper",
                        "relation": "cites",
                        "evidence": "",
                        "source_doc": "wiki/tools/cell2fate.md",
                    }
                ],
            }
        ]
        stubs = extract_paper_stubs(input_entities)
        assert len(stubs) == 1
        aliases = stubs[0]["entity"]["aliases"]
        # The full wikilink is an alias so existing-paper lookup by wiki-slug works.
        assert (
            "wiki/papers/aivazidis-2025-cell2fate-rna-velocity" in aliases
        )
        # Basename is also an alias.
        assert "aivazidis-2025-cell2fate-rna-velocity" in aliases

    def test_deduplicates_identical_citations(self):
        cite = "Wang & Stephens 2021 doi:10.1111/rssb.12488"
        edges = [
            {
                "source": src,
                "source_type": "tool",
                "target": cite,
                "target_type": "paper",
                "relation": "cites",
                "evidence": "",
                "source_doc": f"wiki/tools/{src}.md",
            }
            for src in ("flash", "ebnm", "fastTopics")
        ]
        input_entities = [
            {"entity": {"canonical_name": e["source"], "type": "tool", "aliases": [e["source"]]}, "edges": [e]}
            for e in edges
        ]
        stubs = extract_paper_stubs(input_entities)
        # Same citation across three tools → one paper stub
        assert len(stubs) == 1

    def test_skips_non_paper_edges(self):
        input_entities = [
            {
                "entity": {
                    "canonical_name": "flash",
                    "type": "tool",
                    "aliases": ["flash"],
                },
                "edges": [
                    {
                        "source": "flash",
                        "source_type": "tool",
                        "target": "susieR",
                        "target_type": "tool",
                        "relation": "related_to",
                        "evidence": "",
                        "source_doc": "",
                    }
                ],
            }
        ]
        assert extract_paper_stubs(input_entities) == []

    def test_does_not_create_stub_if_reference_is_only_an_alias_of_existing_paper(self):
        # If "doi:10.1038/xyz" is already an alias of an existing paper,
        # the stub extractor should skip (caller pre-filters by existing aliases).
        # We model this by passing a known_aliases set to the extractor.
        input_entities = [
            {
                "entity": {
                    "canonical_name": "sometool",
                    "type": "tool",
                    "aliases": ["sometool"],
                },
                "edges": [
                    {
                        "source": "sometool",
                        "source_type": "tool",
                        "target": "doi:10.1038/xyz",
                        "target_type": "paper",
                        "relation": "cites",
                        "evidence": "",
                        "source_doc": "",
                    }
                ],
            }
        ]
        # Pretend a paper already has this DOI as an alias
        known = {("paper", "doi:10.1038/xyz")}
        stubs = extract_paper_stubs(input_entities, known_paper_aliases=known)
        assert stubs == []


# ---------------------------------------------------------------------------
# parse_paper — wiki-slug alias (lets other entities reference it by path)
# ---------------------------------------------------------------------------


class TestParsePaperWikiSlugAlias:
    def test_wiki_slug_alias_added(self):
        result = parse_paper(PAPER_YAML, "wiki/papers/huang-2026-longcallr.md")
        aliases = result["entity"]["aliases"]
        # Both the full path and the basename (sans .md) should be aliases
        assert "wiki/papers/huang-2026-longcallr" in aliases
        assert "huang-2026-longcallr" in aliases
