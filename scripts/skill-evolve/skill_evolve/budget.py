"""Token-cost tally with hard killswitch.

Per spec I1: realistic budget is $20-40/run; this module enforces a
configurable cap and aborts mid-run if exceeded.
"""
from __future__ import annotations
from collections import defaultdict


class BudgetExceeded(RuntimeError):
    pass


# USD per million tokens. Add models as needed.
PRICING_USD_PER_MTOK = {
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-opus-4-7": {"input": 15.0, "output": 75.0},
    "claude-haiku-4-5-20251001": {"input": 0.8, "output": 4.0},
}


def cost_of(input_tokens: int, output_tokens: int, model: str) -> float:
    if model not in PRICING_USD_PER_MTOK:
        raise ValueError(f"Unknown model for pricing: {model}")
    p = PRICING_USD_PER_MTOK[model]
    return (input_tokens / 1_000_000) * p["input"] + (output_tokens / 1_000_000) * p["output"]


class BudgetTracker:
    def __init__(self, max_usd: float) -> None:
        self.max_usd = max_usd
        self.total_cost = 0.0
        self._by_stage: dict[str, float] = defaultdict(float)

    def add(self, *, input_tokens: int, output_tokens: int, model: str,
            stage: str = "unspecified") -> float:
        cost = cost_of(input_tokens, output_tokens, model)
        projected = self.total_cost + cost
        if projected > self.max_usd:
            raise BudgetExceeded(
                f"Cost cap exceeded: would spend ${projected:.2f}, cap ${self.max_usd:.2f} "
                f"(this call: ${cost:.4f} for {input_tokens}+{output_tokens} tokens on {model})"
            )
        self.total_cost = projected
        self._by_stage[stage] += cost
        return cost

    def per_stage_breakdown(self) -> dict[str, float]:
        return dict(self._by_stage)
