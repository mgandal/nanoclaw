# Lessons Learned

Patterns and corrections to prevent repeated mistakes.

---

## 2026-03-21: Never silently fail on missing directories
**Pattern:** Scripts and commands referenced `$MARVIN_VAULT/wiki/`, `$MARVIN_VAULT/inbox/`, `99_knowledge/` after a vault restructure removed/renamed them. Scripts checked `[ -d "$dir" ] || continue` or `exit 0` — silently skipping all work with no error.
**Rule:** If code targets a directory or file path that doesn't exist, fail loudly (`exit 1` with an error message), don't silently succeed. A silent no-op is worse than a crash — it hides the problem for weeks. Apply this to scripts, commands, and any pipeline that writes to a destination.
**Severity:** Critical — entire Granola pipeline and all KB commands were silently broken for days.

---

## 2026-03-19: Don't modify package-managed files directly
**Pattern:** Edited QMD's npm-managed launcher script to force Node.js. Would be silently overwritten on `npm update`.
**Rule:** When overriding behavior of globally installed tools, create a PATH-precedent wrapper script (e.g., in `~/.bun/bin/` or `~/.local/bin/`) instead of modifying files inside `node_modules/` or package directories. Always restore the original file after creating the wrapper.

---

## Session: 2026-03-04

### Verify Email Existence Before Adding to Top 3
**Mistake**: Previous session added "Jingjing Li email — received Mar 2" to current.md Top 3, but no such email exists in Exchange or Gmail (most recent is Dec 2025).
**Pattern**: Items added to Top 3 from session context without verifying the source email actually exists.
**Rule**: Before adding an email-related task to current.md Top 3, verify the email exists (search inbox by sender). Don't propagate unverified items from conversation context.
**Severity**: Medium — wasted a Top 3 slot for one session.

---

## Session: 2026-02-03

### Reflect Timestamps
**Mistake**: Including timestamps like `({TIME})` in Reflect daily note headers
**Rule**: Keep Reflect appends clean - no timestamps in headers, just content
**Fixed in**: `/marvin-end` command

---

## Consolidation: 2026-02-14

### High-Friction Task Deferral Pattern
**Pattern**: Tasks appearing 3+ times in "Next Actions" without completion (CV update, paper edits)
**Rule**: If a task appears in 3 consecutive sessions without completion, it needs a dedicated calendar block, not async execution
**Example**: CV update listed 9+ times, still incomplete → needs 2-hour protected block

### Infrastructure Over-Building Trap
**Pattern**: Building tools/integrations instead of completing deliverables
**Rule**: Pause infrastructure additions when >5 hard deadlines exist within 3 weeks
**Example**: 14 plugins + 12 MCP servers installed Feb 5; many unused; created cognitive overhead

### Blocker Cascade Recognition
**Pattern**: Upstream administrative blockers cascade to multiple dependencies
**Rule**: Weekly review: identify any task blocking 2+ other tasks; clear that first
**Example**: CV → Chair's letter → Promotion dossier (3-level cascade)

---

## Consolidation: 2026-02-17

### Judgment Bottleneck
**Pattern**: Tasks requiring Mike's direct scientific/professional judgment (CV, paper edits, sensitive emails) consistently defer when competing with delegatable work
**Rule**: These tasks need protected calendar time, not task-list tracking. Listing them daily doesn't make them happen.
**Evidence**: CV (14+ days), Yunlong paper (20+ days), Raquel Gur (25+ days), Briana Macedo (7+ weeks)

### External Deadline Forcing Function
**Pattern**: Tasks with hard external deadlines and clear handoff partners get completed; tasks without either stall indefinitely
**Rule**: For important tasks without natural deadlines, create artificial forcing functions — schedule a meeting that requires the output
**Evidence**: Completed: R01 JIT (external deadline), SFARI (accept deadline). Stalled: CV (self-imposed), Raquel emails (no deadline)

### Recommendation Follow-Through Gap
**Pattern**: Only 4 of 16 prior recommendations were fully implemented. Recommendations aligned with existing workflows succeed; recommendations requiring behavioral change fail.
**Rule**: New recommendations must include a specific implementation mechanism, not just "do X." Calendar block > task list. Scheduled meeting > "follow up."

---

## Session: 2026-02-20

### Bulk Extraction Context Blowup
**Mistake**: Running N parallel agents for bulk scraping (e.g., 8 agents × 77 tweets) where each agent returns content to the main context — caused massive context usage spike
**Rule**: For any bulk extraction task:
1. **One background agent, not N parallel** — single orchestrator loops internally, reports one short summary
2. **Cap return payload** — subagent replies with "Saved X items to {path}" only, never echoing content
3. **Never re-read scraped files back into context** for verification — trust the write
4. **Use `run_in_background=true`** for all bulk ops; `/capture` already enforces this
**Example**: 8 Twitter agents returning full tweet text → use 1 background agent that writes files silently and returns a 2-line summary

### Subagent Compaction Death Loop
**Mistake**: Delegated a 3-file find-and-replace to a haiku subagent with wrong file paths (assumed `SKILL.md` in subdirectories; files were flat). Agent hit ENOTDIR, compacted (~167K tokens re-cached), retried same wrong path, compacted again — 3+ cycles, 167K+ tokens burned on a 2-minute task.
**Rules**:
1. **Verify paths before delegating** — run `file` or `ls` on targets in main context before spawning any subagent that needs specific file paths
2. **Set `max_turns`** on simple subagents — rule of thumb: 2x expected tool calls (e.g., 10 for a 3-file edit)
3. **Don't delegate trivial edits** — if you can describe the exact edits (not just the task), do them directly. Subagent overhead (167K system context) dwarfs the cost of 9 Edit calls
4. **Haiku can't recover from ambiguous filesystems** — use sonnet for tasks requiring path discovery; haiku only when paths are verified
**Cost**: ~167K tokens wasted (3+ compaction cycles × ~167K cached context per cycle)

---

## Session: 2026-02-21

### Mail AppleScript Timeout
**Mistake**: Using `tell application "Mail" to count of (messages of inbox whose read status is false)` or even `count of accounts` / `name of every account` — any query touching mailbox/account data hangs when Mail.app is syncing (especially Exchange accounts)
**Root cause**: Mail.app's `inbox` is a virtual aggregate mailbox; queries against it do unbounded scans across all accounts. Even `count of accounts` blocks during Exchange sync.
**Rule**:
1. **Always wrap Mail AppleScript in `timeout 10`** — Mail can hang indefinitely during sync
2. **Use `tell application "Mail" to name`** for health checks — app-level property, never touches mailbox data
3. **Never use aggregate `inbox`** — always iterate per-account with `mailbox "Inbox" of theAccount`
4. **For email search, use `search-mail.sh`** — it runs per-account searches in parallel with 120s timeouts
**Fixed in**: `/marvin:status` doctor mode, `/marvin:digest` preflight

---

## Session: 2026-02-23

### Multi-Day Event Blind Spot in iCalBuddy
**Mistake**: Reported Mar 17 as available despite SFARI meeting (Mar 16–18) being on calendar
**Root cause**: iCalBuddy `-f` output lists multi-day events under their **start date only** — they don't repeat for each spanned day. A parser filtering for "Mar 17" in event times will miss any event that starts on Mar 16 and ends on Mar 18.
**Rule**:
1. When checking availability for a target date, also scan a ±3 day window for multi-day events with start ≤ target ≤ end
2. Look for events where the time string contains two different dates (e.g., `Mar 16, 2026 at 8:00 AM - Mar 18, 2026 at 1:00 PM`)
3. Flag these as blocking the target date
**Detection pattern**: `re.search(r'(\w+ \d+, \d{4}) at .* - (\w+ \d+, \d{4}) at', line)` — if start_date != end_date, it spans multiple days; check if target falls within range

---

## Session: 2026-03-02

### Digest: Verify Sent Before Categorizing
**Mistake**: Flagged 4 "escalation" emails as ACTION REQUIRED (Raquel Gur COAP, Briana Macedo, Kai Wang, Science Advances review) when Mike had already replied to all of them. Unread messages were just incoming replies in threads he'd already handled.
**Root cause**: Skipped digest Step 3 (verify completion via sent messages) and jumped to categorization. The unread flag ≠ unanswered.
**Rule**:
1. **Always run sent-mail search BEFORE categorizing unread emails** — the digest skill's Step 3 exists for this reason
2. **Unread ≠ needs response** — an unread email may be someone's reply to a thread Mike already handled
3. **For any item flagged as "overdue" in state files**, search sent mail for that topic before re-escalating — it may have been resolved between sessions
4. **Update state files** when sent-search confirms completion — don't carry stale items across sessions
**Cost**: Presented incorrect digest, wasted user's time correcting false escalations

---

## 2026-03-25: Chrome extension ref-based clicks fail on some sites

**Pattern:** `mcp__claude-in-chrome__computer` with `ref` parameter fails on when2meet with "Cannot access a chrome-extension:// URL of different extension" error. Screenshots also fail with same error.
**Rule:** For sites where ref-based clicks and screenshots fail (likely due to cross-origin iframe or extension isolation), use `mcp__claude-in-chrome__javascript_tool` to interact with the DOM directly. This is more reliable anyway for grid/form interactions since you can toggle many elements in a single call.
**Severity:** Low — workaround is straightforward (JS tool), but wastes time on first encounter.

---

## 2026-03-25: Scheduling Email Drafts — Offer Specific Options

**Pattern**: First drafts for Jordan Feldman and Carlos Rodriguez suggested a single vague time ("next Tuesday afternoon") or one specific slot. User corrected twice: (1) give specific dates and times based on calendar availability, (2) offer at least 3 options, (3) start from next week not this week.
**Rule**:
1. **Always check calendar** before drafting scheduling replies — cross-reference the sender's stated availability with Mike's open slots
2. **Offer 3+ specific date/time options** — not "sometime next week" or a single slot
3. **Start from next week** unless urgency requires sooner
4. **Include quoted original email** so Mike can see what was sent in the thread
5. **Include location** (ARC 1016C) and duration (30 min) by default for advisor/check-in meetings
**Severity**: Medium — required 3 rounds to get the draft format right

---

*Add new lessons below as corrections occur*

## 2026-03-28: Always verify machine identity from actual output
**Pattern:** Hostname output clearly showed `MJG-MBP-M3max.local` but MARVIN referred to the machine as "M4 Air" throughout the session, leading to incorrect performance estimates and recommendations.
**Rule:** Run `hostname` at session start. Read the output. Refer to it when making machine-dependent claims (model availability, RAM, service access). Never assume or carry forward stale machine identity.
**Severity:** Medium — led to incorrect recommendations (e.g., "this is an M3 Max tool, not portable to the Air" when we were already on M3 Max)

## 2026-03-28: Test → Prove → Guard pattern for all fixes
**Pattern:** After being corrected on the hostname issue, MARVIN saved a memory and updated a command but didn't verify the fix worked or show proof.
**Rule:** Every fix must go through three steps: (1) build tests to convince yourself it works, (2) show evidence to convince Mike it works, (3) add structural guardrails so it stays working. This applies to code fixes, behavioral corrections, configuration changes — everything.
**Severity:** High — without this discipline, fixes are aspirational, not verified

## 2026-03-29: Ollama models stick in VRAM — `ollama stop` is unreliable
**Pattern:** `ollama stop llama3.1:8b` and `keep_alive:0` both reported success but the model stayed in VRAM (56.7GB). Even `pkill -9` + relaunch kept it loaded. Only `ollama rm` + full process kill cleared it.
**Rule:** To reliably free VRAM from a stuck Ollama model: (1) `ollama rm <model>` to delete it, (2) `pkill -9 -f "ollama serve"`, (3) relaunch. Don't waste time with `ollama stop` or `keep_alive:0` if the first attempt fails — go straight to rm + kill.

## 2026-03-29: Cognee default embedding truncation assumes wrong tokenizer ratio
**Pattern:** Cognee's `_truncate_text_to_token_limit` uses `max_tokens * 4` chars, assuming ~4 chars/token. But `nomic-embed-text` uses a subword tokenizer at ~1.1 chars/token. Texts truncated to 8192 chars still exceeded the 8192 *token* limit.
**Rule:** When patching embedding limits, test empirically with the actual model (binary search on input size). Don't trust chars-per-token estimates — they vary wildly by tokenizer. For nomic-embed-text: 8000 chars is the safe limit.

## 2026-04-02: QMD collection scoping — multi-tenant agents MUST filter
**Pattern:** Franklin (lab manager bot) connected to the shared QMD instance but wasn't scoping searches to `collections: ["franklin-lab"]`. His queries returned results from all 2,166 docs across 10 collections (personal vault, session logs, apple notes, etc.) — diluting lab KB answers with irrelevant personal content.
**Rule:** When connecting a new agent to a shared QMD instance, always (1) add collection filtering in the SOUL.md/system prompt as an explicit instruction, (2) list the agent's collection name(s) so it can't accidentally search outside its scope, (3) test with a query that would return different results scoped vs unscoped. Default QMD behavior searches ALL collections — isolation is opt-in, not default.
