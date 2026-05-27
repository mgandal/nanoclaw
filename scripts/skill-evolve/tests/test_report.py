from skill_evolve.report import render_report, ReportInputs


def test_report_includes_axis_table():
    inputs = ReportInputs(
        run_id="20260523-1530-deadbeef",
        skill="wiki",
        baseline_score=0.6,
        winner_score=0.85,
        noise_floor=0.05,
        merge_threshold=0.3,
        per_axis_baseline={"folder_routing": 0.5, "frontmatter_parse": 0.7, "tag_set": 0.6},
        per_axis_winner={"folder_routing": 0.9, "frontmatter_parse": 0.8, "tag_set": 0.85},
        sample_diffs=[],
        realism_check=[],
        size_baseline_bytes=4600,
        size_winner_bytes=4700,
        cost_usd=22.4,
        intentional_drops=[],
        rollback_runbook_run_id="20260523-1530-deadbeef",
    )
    out = render_report(inputs)
    assert "folder_routing" in out
    assert "0.50" in out and "0.90" in out
    assert "Rollback" in out
    assert "skill-evolve/wiki-20260523-1530-deadbeef" in out


def test_report_includes_size_delta():
    inputs = ReportInputs(
        run_id="x", skill="wiki", baseline_score=0.5, winner_score=0.7,
        noise_floor=0.0, merge_threshold=0.3,
        per_axis_baseline={"a": 0.5}, per_axis_winner={"a": 0.7},
        sample_diffs=[], realism_check=[],
        size_baseline_bytes=4600, size_winner_bytes=5000,
        cost_usd=20.0, intentional_drops=[], rollback_runbook_run_id="x",
    )
    out = render_report(inputs)
    assert "4600" in out and "5000" in out


def test_report_flags_15kb_overage():
    inputs = ReportInputs(
        run_id="x", skill="wiki", baseline_score=0.5, winner_score=0.7,
        noise_floor=0.0, merge_threshold=0.3,
        per_axis_baseline={"a": 0.5}, per_axis_winner={"a": 0.7},
        sample_diffs=[], realism_check=[],
        size_baseline_bytes=4600, size_winner_bytes=16000,
        cost_usd=20.0, intentional_drops=[], rollback_runbook_run_id="x",
    )
    out = render_report(inputs)
    assert "HARD FAIL" in out.upper()
