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
