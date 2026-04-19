# oMLX vs Ollama — Benchmark Plan & Go/No-Go Criteria

**Upstream:** https://github.com/jundot/omlx (10,633 ⭐, 2026-04-18)
**Verdict (pre-benchmark):** STEAL *conditional on ≥2× speedup on email classification*.
**Date:** 2026-04-19

## Why we care

The email-ingest pipeline (`scripts/sync/email-ingest.py`) runs every 4 hours and is
the dominant local-inference consumer. It hits Ollama with phi4-mini for classification
at ~1 request per email. A 2× speedup there shortens the sync window materially.

## What oMLX claims

- **Apple Silicon native** via MLX (faster than llama.cpp GGUF on M-series)
- **Continuous batching** — concurrent requests amortized through `mlx-lm.BatchGenerator`
- **Tiered KV cache (hot RAM + cold SSD)** — persistent prefix reuse across restarts
- **Claude Code optimization** — token-count scaling + SSE keep-alive (irrelevant for us)
- **Fully OpenAI-compatible** on `http://localhost:8000/v1`
  — drop-in swap for the Ollama endpoint

Sources: README at commit 2026-04-18, lines 100-250.

## Hypothesis

For short single-shot classification (prompt ~1-2KB, output ~80 tokens), oMLX should
beat Ollama by:
- **20-40%** on single-request latency (MLX > llama.cpp on Apple Silicon in most benches)
- **2-5×** on concurrent throughput (continuous batching vs Ollama's per-request model load)

For embedding (nomic-embed-text, 768-dim, batch-friendly), the win is marginal —
Ollama already handles embeddings efficiently and the model is not load-bearing on
latency.

## Benchmark design

### Test harness

Reuse the email-ingest classifier against a fixed sample. No new code — just vary the
endpoint.

```bash
# 1. Freeze a sample: 500 real emails from the pipeline, classified by the current
#    Ollama pipeline, with inputs + expected outputs saved as JSONL
python3 scripts/sync/email-ingest.py --sample 500 --out /tmp/bench-sample.jsonl

# 2. Run under Ollama (baseline)
time OLLAMA_HOST=http://localhost:11434 \
     python3 scripts/benchmarks/classify-bench.py /tmp/bench-sample.jsonl

# 3. Run under oMLX
brew tap jundot/omlx https://github.com/jundot/omlx
brew install omlx
brew services start omlx
# download phi4-mini-mlx equivalent to ~/models first
time OLLAMA_HOST=http://localhost:8000 \
     python3 scripts/benchmarks/classify-bench.py /tmp/bench-sample.jsonl
```

The harness must measure:
- **Total wall time** for 500 classifications
- **p50 / p95 per-request latency**
- **Concurrent throughput** at `concurrency=8` and `concurrency=16` (classify-bench
  should dispatch requests via `asyncio.gather` or threads)
- **Accuracy** — fraction of classifications matching the Ollama baseline labels
  (target: >95% agreement; classification is stochastic but should stabilize with
  `temperature=0`)

### Model equivalence

Ollama uses `phi4-mini` (Microsoft's phi-4-mini, ~3.8B params, Q4_0 GGUF by default).
oMLX needs the MLX-converted equivalent. Two options:

1. **Search HuggingFace for `mlx-community/Phi-4-mini-*`** — likely exists as 4-bit MLX
2. **Convert locally:** `mlx_lm.convert --hf-path microsoft/Phi-4-mini-instruct -q`

The quantization format differs (GGUF Q4_0 vs MLX 4-bit), so outputs will drift slightly.
Accuracy >95% agreement is the real pass criterion, not bit-identical outputs.

### Sample size

500 emails is enough to:
- Stabilize p50/p95 latency estimates (CLT kicks in >~100)
- Detect >10% speedup at p<0.01 with paired t-test
- Catch regression accuracy issues (a 2% true accuracy drop shows up)

Do **not** use the 42 Python test fixtures — those are too small for timing variance.

### Environment controls

- Run on the same mac, same power state (plugged in, no throttling)
- No concurrent heavy workloads (pause the 4-hour sync cron during the benchmark)
- Flush Ollama model cache between runs: `ollama stop phi4-mini && ollama run phi4-mini ""`
- Run Ollama baseline → oMLX → Ollama baseline again. If second Ollama run differs
  from first by >5%, the test is noisy — reboot and retry

## Go/no-go matrix

| Outcome | Action |
|---|---|
| oMLX ≥ 2× throughput at concurrency=8, accuracy ≥ 95% | **GO** — migrate email-ingest only |
| oMLX 1.5–2×, accuracy ≥ 95% | **MAYBE** — migrate only if the sync window is actually tight (currently 4h cron; if we move to 1h, reconsider) |
| oMLX < 1.5× or accuracy < 95% | **NO-GO** — stay on Ollama |
| oMLX wins but requires cairosvg / other heavy deps | **NO-GO** — not worth the ops overhead |

## What we do NOT migrate

- **Embeddings (nomic-embed-text)** — stay on Ollama. Re-embedding the existing QMD
  corpus is expensive; keep this stable until oMLX proves long-term reliability.
- **Honcho's embedding model** — same reason. Honcho is shared with Hermes Agent and
  expects Ollama's port 11434.
- **Anything behind OneCLI gateway** — oMLX is `local + OpenAI-compatible` so OneCLI
  semantics may need retesting. Not worth touching on the first pass.

## Migration footprint (if GO)

The email-ingest path expects `OLLAMA_HOST` or similar. Check:
- `scripts/sync/email-ingest.py` — environment variable read
- `scripts/sync/email_ingest/classifier.py` — request URL construction
- Would need: new env var `CLASSIFIER_HOST=http://localhost:8000` with Ollama fallback

Keep both services running during migration week. Ollama stays as fallback for
embeddings. No launchd plist conflicts — oMLX uses port 8000, Ollama uses 11434.

## Rollback

Trivial. Remove the env var, restart email-ingest. No state to migrate, no schema to
rewind — both services speak JSON and we don't cache the raw model output.

## Open questions

- Does oMLX load-and-serve phi4-mini with the same chat template as Ollama, or do we
  need to adjust the system prompt on switch? Check `/v1/chat/completions` output shape.
- Does continuous batching actually help our workload? Email classification is bursty
  (all 500 within a few minutes during sync), not continuous — batching helps most in
  the hot window of each sync cycle, not between cycles.
- Tiered KV cache (cold SSD) helps with long shared prefixes. Our classifier prompt is
  short and similar across emails — likely modest win.

## Actionable next step

Build `scripts/benchmarks/classify-bench.py` (20 lines, just wraps existing classifier
with timing and concurrency params). Run the benchmark. Decide based on the go/no-go
matrix above. Do NOT install oMLX as a launchd service until the benchmark passes.

## Sources

- oMLX README (commit 2026-04-18, lines 100–250) for API surface + feature list
- Lab's current sync pipeline: `scripts/sync/email-ingest.py`, `scripts/sync/sync-all.sh`
- Ollama models in use: phi4-mini (classification), nomic-embed-text (embeddings)
  per `memory/MEMORY.md` "Ollama Models" section
