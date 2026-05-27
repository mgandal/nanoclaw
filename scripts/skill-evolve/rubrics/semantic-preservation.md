# Semantic preservation judge

You will be given two versions of a skill's procedural instructions file:
- BASELINE: the current production version
- VARIANT: a candidate replacement

Optionally, you will also be given an `intentional_drops` list — rules the variant author explicitly chose to remove with a stated reason.

Your job: identify whether the variant preserves the baseline's procedures, folder rules, frontmatter requirements, and tag conventions.

For each rule or invariant in BASELINE, check whether VARIANT preserves it. A rule is "preserved" if VARIANT does not silently drop, contradict, or weaken it. A rule listed in `intentional_drops` does NOT count as a violation regardless of whether it appears in VARIANT.

Output JSON with this shape:

```json
{
  "score": <integer 1-5>,
  "dropped_rules": ["rule 1 description", "rule 2 description", ...],
  "contradicted_rules": ["..."],
  "summary": "one-paragraph explanation"
}
```

Scoring rubric:
- 5: variant preserves all rules; refactor is purely cosmetic or clarifying
- 4: 0-1 minor rules dropped/contradicted, all in intentional_drops or clearly intentional
- 3: 2-3 rules silently dropped or weakened
- 2: ≥4 rules dropped, OR core invariants contradicted
- 1: variant is substantively a different skill, not a refactor
