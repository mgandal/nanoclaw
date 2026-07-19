---
name: gpu
description: Help plan, spec out, and find an ideal lab GPU supercomputer for running large language models (LLM training/inference on genomic data, agentic coding). Also tracks pricing and availability across vendors. Use when the user says /GPU, asks about GPU computers for the lab, wants to buy a machine for running LLMs, or asks about GPU VRAM requirements for AI/ML workloads.
---

# /GPU — Lab GPU Supercomputer Planner

Help Mike find and spec the ideal GPU machine for running LLMs on genomic data and agentic coding. Do real research — don't rely on training data alone. Track live prices across all relevant vendors.

## Context (pre-loaded)

- *Use cases*: LLM training/inference on genomic data; agentic coding with dense models (e.g. Qwen3.6-27B, Qwen3-32B, DeepSeek-R1)
- *VRAM target*: 128GB minimum, 256GB preferred
- *Budget*: up to $10k, prefer ~$5k
- *Lab environment*: mostly Macs; noise and form factor matter
- *Already evaluated*:
  - Mac Studio M5 Ultra (~$5k) — attractive but too slow for dense models; Metal ecosystem limits CUDA workloads
  - DGX Spark — good memory but insufficient throughput for dense LLM inference
  - AMD Strix Halo systems — large unified memory but compute throughput lags NVIDIA
  - A100/H100 — too expensive new; used H100 PCIe worth checking

## Approved Vendors (Penn lab purchasing)

Always check these sources for pricing and availability:
- *Apple* — apple.com/shop (Mac Studio, Mac Pro)
- *CDW* — cdw.com (enterprise/education pricing; Penn has account)
- *Newegg* — newegg.com (consumer + professional GPUs; used/refurb marketplace)
- *B&H Photo* — bhphotovideo.com (workstation GPUs, full systems)
- *Other Penn-approved*: Dell (dell.com/en-us/work/shop/), Lenovo, HP/HPE
- *Used/refurb*: serverpartdeals.com, eBay (for enterprise gear like H100/A100)
- *Specialty*: Lambda Labs (lambdalabs.com), Vast.ai for cloud comparison

## When to use
- User says `/GPU`
- User asks about buying a GPU machine for lab ML/LLM work
- User asks what hardware to use for running Qwen, DeepSeek, Llama, or similar models locally
- User wants to compare GPU options for genomics + AI workloads
- User asks for a price check or availability update on GPU hardware

## Steps

### 1. Research current market (always do this — prices change fast)

Use `agent-browser` to get live prices. Check multiple vendors in parallel:

*Search queries to run:*
```
agent-browser open "https://www.perplexity.ai/search?q=best+GPU+workstation+256GB+VRAM+LLM+inference+2026+price"
agent-browser open "https://www.bhphotovideo.com/c/search?q=nvidia+gpu+workstation"
agent-browser open "https://www.cdw.com/search/?key=nvidia+gpu+workstation"
agent-browser open "https://www.newegg.com/p/pl?q=rtx+4090+workstation"
agent-browser open "https://serverpartdeals.com/collections/manufacturer-recertified-gpus"
```

For specific candidates, also check:
- Apple: `apple.com/shop/buy-mac/mac-studio` (M5 Ultra pricing)
- B&H: search "NVIDIA RTX 6000 Ada" or "RTX PRO 6000"
- CDW: search "NVIDIA GPU workstation" (may have edu/gov pricing)
- eBay: search "H100 PCIe 80GB used" and "A100 80GB used"

### 2. Evaluate candidates against these criteria

For each candidate, score or note:
- *Total VRAM* (GB) — can it fit target models?
- *Tokens/sec* on 27B–70B dense models (if benchmark data available)
- *Price* (new and used), broken down by vendor
- *Noise/form factor* — lab-safe? Rackmount vs workstation vs desktop
- *Software ecosystem* — CUDA (best for LLMs), Metal (Mac), ROCm (AMD, improving)
- *Power draw* (W) — lab outlet limits typically 15A/20A = 1800–2400W
- *Penn-purchasable?* — available on CDW, B&H, Newegg, or Apple?
- *Availability* — in stock today?

### 3. Candidate shortlist to research

| Candidate | VRAM | Likely source |
|---|---|---|
| 2× RTX 4090 workstation | 96GB | Newegg, B&H, CDW |
| NVIDIA RTX PRO 6000 (Blackwell) | 96GB | B&H, CDW |
| NVIDIA RTX 6000 Ada (used) | 48GB×1 | Newegg, eBay |
| NVIDIA GB10 / DGX Spark | 128GB | Apple, NVIDIA direct |
| Used H100 PCIe 80GB | 80GB | serverpartdeals, eBay |
| AMD MI300X (used) | 192GB | serverpartdeals, eBay |
| Mac Studio M5 Ultra | 192GB unified | Apple |
| Lambda Labs workstation | varies | lambdalabs.com |
| Used A100 SXM4 80GB | 80GB | serverpartdeals |
| Custom build: 4× RTX 3090 | 96GB | Newegg |

### 4. Price tracking

After researching, save a price snapshot to the vault:

```bash
# Save to vault
cat >> /workspace/extra/claire-vault/10-daily/gpu-price-log.md << EOF

## Price check — [DATE]
[table of options with prices and sources]
EOF
```

Format the log as:
```
| Option | VRAM | Price | Source | In Stock? | Date checked |
|---|---|---|---|---|---|
| RTX PRO 6000 | 96GB | $X | B&H | Yes | 2026-05-27 |
```

This allows Mike to track price trends over time across sessions.

### 5. Build the recommendation

Produce a *ranked shortlist* of 3–5 options:

```
*Rank 1: [Option Name]*
• VRAM: X GB
• Price: $X (new at [vendor]) / $X (used at [vendor])
• Perf: ~X tok/s on Qwen3-27B (if known)
• Pros: ...
• Cons: ...
• Penn-purchasable: Yes/No (via CDW / B&H / etc.)
```

Then give a *single top recommendation* with reasoning tailored to Mike's constraints (budget, lab Mac environment, noise, CUDA ecosystem).

### 6. Flag key trade-offs

Always surface:
- CUDA vs Metal: most LLM tools (vLLM, llama.cpp CUDA, Ollama CUDA) are significantly faster on NVIDIA
- NVLink: 4090s can't NVLink — multi-GPU requires tensor parallelism, which adds latency
- Used enterprise gear risk: no warranty, check PSU requirements for SXM cards
- Power: multi-GPU builds can exceed 600W TDP — confirm lab outlet capacity
- Penn purchasing: CDW and B&H may have institutional pricing lower than list
- New 2026 options: NVIDIA Blackwell consumer/prosumer cards may change the calculus

## Output format

Telegram-formatted (single *asterisks*, • bullets, no ## headings):

```
*GPU Lab Machine — Shortlist*
_Prices checked [DATE] across Apple, CDW, Newegg, B&H, ServerPartDeals_

*Option 1: [Name]* — $X (CDW) / $X used (eBay)
• VRAM: X GB | Perf: ~X tok/s on 27B dense
• Pros: ...
• Cons: ...
• Penn-purchasable: Yes via CDW/B&H

[repeat for options 2–4]

*Top pick*: [name] — [1-sentence rationale]

*Key trade-offs*:
• ...
• ...
```

## Notes

- Always verify prices with a live search — don't use stale training data
- CDW often has edu/institutional pricing — check edu.cdw.com
- serverpartdeals.com and eBay for used enterprise (H100, A100)
- Log prices to vault at `/workspace/extra/claire-vault/10-daily/gpu-price-log.md` after each research session
- If user wants to go deeper on a specific option, open that product page with agent-browser
