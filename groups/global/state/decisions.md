# Decision Log

### 2026-03-26 - Todoist as Primary Task System
**Decision:** Make Todoist the single source of truth for all tasks. current.md becomes context-only (deadlines, escalations, narrative priorities). No more task checkboxes in markdown.
**Context:** Mike wanted (1) single source of truth and (2) mobile capture from phone. Maintaining checkboxes in current.md was manual and not accessible from mobile. Todoist provides projects, sections, priorities, due dates, and a mobile app.
**Status:** Active

### 2026-03-29 - Gemini 2.5 Flash for Cognee LLM
**Decision:** Use Gemini 2.5 Flash API for Cognee entity extraction and summarization. Local Ollama nomic-embed-text for embeddings only.
**Context:** Local qwen3:8b takes ~350s/file (days for full vault). Gemini does it in ~12s (30x faster, ~$2-3 for full vault). Both Gemini keys currently exhausted — using qwen3:8b as interim fallback.
**Status:** Active (pending Gemini billing fix)

### 2026-03-29 - Delete llama3.1:8b from Ollama
**Decision:** Removed llama3.1:8b model from Ollama entirely.
**Context:** Produces invalid structured JSON output (wraps in extra object), consumed 56.7GB VRAM, wouldn't unload via API. No longer needed — qwen3:8b is the local fallback, Gemini is the primary.
**Status:** Active

### 2026-03-29 - Embedding Truncation at 8000 chars
**Decision:** Hard-truncate text to 8000 chars before sending to nomic-embed-text embedding model.
**Context:** nomic-embed-text has 8192 token context (~9000 chars empirically). Cognee's default truncation assumed 4 chars/token (wrong — it's ~1.1). Patched in `_get_embedding` monkey-patch in cognee_patches.py.
**Status:** Active

### 2026-04-01 - GPT-OSS 20B as Cognee Local LLM
**Decision:** Use gpt-oss:20b as the local Ollama model for Cognee MCP server. Updated .mcp.json and cognee-health.sh.
**Context:** llama3.1:8b was already deleted (bad JSON output). gpt-oss:20b (13GB, MXFP4) supports tool calling and thinking, has 131K context, and is already installed on M3Max. Better structured output than qwen3:8b for entity extraction. Gemini 2.5 Flash remains primary for batch ingestion when API keys are available.
**Status:** Active

### 2026-03-31 - Hermes Replaces MarvinClaw Identity
**Decision:** Hermes agent uses its own "Hermes" identity for Chief of Staff role. All "Marvin"/"MarvinClaw" references removed from SOUL.md, MEMORY.md, USER.md. Legacy system names (marvin-vault, mgandal+marvin email, Todoist MARVIN project) retained but labeled as legacy.
**Context:** Running two agents with overlapping "Marvin" branding causes confusion. Hermes has its own personality system (SOUL.md) and should own its identity. Same role and scope, different name.
**Status:** Active

### 2026-04-04 - Ollama 3-Model Consolidation
**Decision:** Consolidate to 3 Ollama models: qwen3.5-27b-claude-opus-v2 (reasoning), qwen3:8b (classification), nomic-embed-text (all embeddings). SimpleMem uses qwen3:8b + nomic-embed-text. All services share nomic-embed-text at 768 dims.
**Context:** Was running 9 models with VRAM contention and config drift. SimpleMem had wrong model (qwen3-embedding:0.6b/1024d). Consolidation reduces VRAM from unpredictable to 68.8GB/128GB (54%). Note: qwen3:8b has inference hang bug on Ollama 0.20.x — may need replacement.
**Status:** Active (qwen3:8b unstable)

### 2026-04-04 - M3Max Has 128GB Unified Memory
**Decision:** Corrected memory spec from 96GB (assumed in design docs) to 128GB (actual). VRAM budget is comfortable for 3 models simultaneously.
**Context:** Design spec assumed 96GB and budgeted 34GB for models. Actual is 128GB with 68.8GB model footprint = 54% utilization. No need to downgrade quantization or limit loaded models.
**Status:** Active

### 2026-04-05 - Cognee Session Auto-Capture: Nightly, Incremental, Own Dataset
**Decision:** Feed session logs into Cognee via nightly ingestion as a "sessions" dataset. Nightly cadence (not real-time). Incremental via content-hash dedup (no custom tracking). Own dataset (not merged with vault-state).
**Context:** Cognee was the only memory layer not auto-capturing session context. Minimal implementation: 3 lines added to existing infrastructure (collect_files branch, nightly loop entry, 2 tests). Cognee's built-in content-hash dedup eliminates need for custom change tracking.
**Status:** Active

### 2026-04-05 - Letta Platform: WAIT
**Decision:** Do not adopt Letta (formerly MemGPT) or LettaBot for MARVIN. Watch only.
**Context:** Heavy overlap with existing SimpleMem + Cognee stack. Only unique capability is agent-self-editing memory blocks. LettaBot (cross-platform messaging) would restructure MARVIN around Letta SDK — wrong architecture. Operational cost too high for marginal gain.
**Status:** Active (watching)

### 2026-04-05 - Cognee Model Names Updated
**Decision:** Updated all Cognee scripts from gpt-oss:20b to qwen3.5-27b-claude-opus-v2, and qwen3-embedding to nomic-embed-text.
**Context:** Follows the Apr 4 3-model consolidation decision. 5 scripts updated for consistency.
**Status:** Active

### 2026-04-02 - Franklin: Native Process with Docker Terminal Sandbox
**Decision:** Run Franklin as a native Hermes profile (not full Docker) with `terminal.backend: docker` for sandboxed shell commands. Use Claude Code OAuth (not OpenRouter API key). Use shared QMD instance with `franklin-lab` collection scoping (not separate QMD server).
**Context:** Full Docker containerization blocked by 3 issues: (1) QMD HTTP binds localhost only — unreachable from Docker bridge, (2) Claude Code OAuth tokens in ~/.claude/.credentials.json inaccessible from container, (3) unnecessary complexity. Native process inherits OAuth + QMD access; Docker terminal sandbox provides security where it matters (LLM-generated shell commands).
**Status:** Active
