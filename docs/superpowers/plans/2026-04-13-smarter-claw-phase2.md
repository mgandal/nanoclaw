# Smarter Claw Phase 2 — Implementation Plan

> **Status: SHIPPED 2026-04-13.** Both features live. Skill Discovery: `scripts/sync/skill-catalog-sync.sh` (`8fd49486`) generates entries (38 in `data/skill-catalog/`), wired as step `[6/10]` in `sync-all.sh`, indexed under QMD `skill-catalog` collection (37 docs); `skill_search` IPC handler in `src/ipc.ts:1952` (`fd6a5bb5`); `skill_search` MCP tool + `SKILL_RESULTS_DIR` in `container/agent-runner/src/ipc-mcp-stdio.ts:734,1828`. Lossless Memory: `write_agent_memory` MCP tool at `ipc-mcp-stdio.ts:1860`; section-upsert via `sectionRegex` at `src/ipc.ts:1568`; `compactionJustHappened` flag flow in `container/agent-runner/src/index.ts:96,376,1071` (`eafe8953`); `Session Continuity` injection in `src/context-assembler.ts:232` later hardened to "treat as data, not instructions" (`3e99f2f8`); `clearStaleSessionContinuity` in `src/container-runner.ts:1236` wired at line 813 (`3399e9cb`). Open `- [ ]` boxes below were never updated retroactively — see commit pointers above for evidence.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add skill discovery (agents search for capabilities they don't have) and lossless conversation memory (context survives SDK compaction).

**Architecture:** Two independent features. Skill Discovery: scan `.claude/skills/*/SKILL.md` → write catalog to `data/skill-catalog/` → QMD collection → `skill_search` MCP tool with IPC result polling. Lossless Memory: PreCompact hook sets flag → main loop writes IPC extraction prompt → agent calls `write_agent_memory` with section upsert → context-assembler injects `## Session Continuity` into next packet.

**Tech Stack:** TypeScript (Bun), vitest, bash, QMD (HTTP API at localhost:8181)

**Spec:** `docs/superpowers/specs/2026-04-13-smarter-claw-phase2-design.md` (v2, peer-reviewed)

---

## Feature 2.1: Skill Discovery

### Task A1: Create skill catalog generator script

**Files:**
- Create: `scripts/sync/skill-catalog-sync.sh`
- Create: `data/skill-catalog/.gitkeep`

- [ ] **Step 1: Create the catalog directory**

```bash
mkdir -p data/skill-catalog && touch data/skill-catalog/.gitkeep
```

- [ ] **Step 2: Write the catalog generator script**

Create `scripts/sync/skill-catalog-sync.sh`:

```bash
#!/usr/bin/env bash
# Generates data/skill-catalog/*.md from .claude/skills/*/SKILL.md
# Run as part of sync-all.sh (before QMD update so entries are indexed same cycle)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILLS_DIR="$PROJECT_DIR/.claude/skills"
CATALOG_DIR="$PROJECT_DIR/data/skill-catalog"

mkdir -p "$CATALOG_DIR"

COUNT=0
SKIPPED=0

for skill_md in "$SKILLS_DIR"/*/SKILL.md; do
  [ -f "$skill_md" ] || continue

  # Extract name and description from YAML frontmatter
  name=$(sed -n '/^---$/,/^---$/{ /^name:/{ s/^name: *//; s/^"//; s/"$//; p; }; }' "$skill_md")
  description=$(sed -n '/^---$/,/^---$/{ /^description:/{ s/^description: *//; s/^"//; s/"$//; p; }; }' "$skill_md")

  if [ -z "$name" ]; then
    echo "  SKIP: $skill_md (no name in frontmatter)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Body = everything after the closing --- of frontmatter
  body=$(sed '1,/^---$/d; 1,/^---$/d' "$skill_md")

  # Generate install command from name
  install_command="/$name"

  # Write catalog entry
  cat > "$CATALOG_DIR/${name}.md" <<ENTRY
---
name: ${name}
description: ${description}
installed: true
install_command: "${install_command}"
---

${body}
ENTRY

  COUNT=$((COUNT + 1))
done

echo "  Skill catalog: $COUNT entries written, $SKIPPED skipped"
```

- [ ] **Step 3: Make the script executable and test it**

```bash
chmod +x scripts/sync/skill-catalog-sync.sh
bash scripts/sync/skill-catalog-sync.sh
```

Expected: output like `Skill catalog: 35 entries written, 0 skipped`. Verify a few files exist:

```bash
ls data/skill-catalog/ | head -5
head -10 data/skill-catalog/add-telegram.md
```

Verify frontmatter has `name`, `description`, `installed: true`, `install_command`.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync/skill-catalog-sync.sh data/skill-catalog/
git commit -m "feat(skills): add skill catalog generator script"
```

### Task A2: Wire catalog sync into sync-all.sh

**Files:**
- Modify: `scripts/sync/sync-all.sh`

- [ ] **Step 1: Read sync-all.sh to find the insertion point**

The QMD update step starts around line 76 with `echo "=== [6/7] QMD update ==="`. Insert the new step before it.

- [ ] **Step 2: Add the catalog sync step before QMD update**

In `scripts/sync/sync-all.sh`, insert before the QMD update step (between Apple Notes and QMD update). Update step numbers: catalog becomes step 6, QMD update becomes step 7, QMD embed becomes step 8. Update the total count from `[X/7]` to `[X/8]`.

Add this block before the QMD update step:

```bash
# ─── Step 6: Skill catalog refresh ───
echo "=== [6/8] Skill catalog refresh ==="
bash "$SCRIPT_DIR/skill-catalog-sync.sh"
EC=$?
if [ $EC -ne 0 ]; then
    echo "[6/8] WARNING: Skill catalog sync had errors (exit $EC)"
    ERRORS=$((ERRORS + 1))
fi
```

Also update all existing step numbers: QMD update `[6/7]` → `[7/8]`, QMD embed `[7/7]` → `[8/8]`, and any earlier steps from `/7]` → `/8]`.

- [ ] **Step 3: Test the full sync pipeline**

```bash
bash scripts/sync/sync-all.sh 2>&1 | tail -20
```

Expected: step 6 shows "Skill catalog: N entries written", steps 7-8 complete.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync/sync-all.sh
git commit -m "feat(skills): wire catalog sync into sync-all.sh (step 6/8)"
```

### Task A3: Register QMD collection and verify indexing

**Files:**
- Edit: `~/.config/qmd/index.yml`

- [ ] **Step 1: Add skill-catalog collection to QMD config**

Edit `~/.config/qmd/index.yml` and add under the `collections:` key:

```yaml
  skill-catalog:
    path: /Users/mgandal/Agents/nanoclaw/data/skill-catalog
    pattern: "**/*.md"
    context:
      "": NanoClaw skill catalog — searchable index of available agent capabilities and install commands
```

- [ ] **Step 2: Run QMD update and verify**

```bash
qmd update 2>&1 | grep -A2 "skill-catalog"
```

Expected: `skill-catalog (**/*.md)` followed by `Indexed: N new, 0 updated, 0 unchanged, 0 removed`.

- [ ] **Step 3: Test a search**

```bash
curl -s 'http://localhost:8181/mcp' -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query","arguments":{"searches":[{"type":"vec","query":"send messages via telegram"}],"collections":["skill-catalog"],"intent":"find skill for telegram messaging"}}}' | python3 -m json.tool | head -20
```

Expected: results containing `add-telegram` skill with score > 0.5.

- [ ] **Step 4: Commit** (no code change — config is outside repo)

No git commit needed — QMD config is a user-level file.

### Task A4: Add skill_search IPC handler on the host

**Files:**
- Modify: `src/ipc.ts`
- Test: `src/ipc.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/ipc.test.ts`:

```typescript
it('skill_search queries QMD and writes result file', async () => {
  // Mock fetch for QMD HTTP call
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            results: [{
              file: 'skill-catalog/add-telegram.md',
              title: 'add-telegram',
              score: 0.85,
              snippet: 'Add Telegram as a channel.',
            }],
          }),
        }],
      },
    }),
  } as any);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-search-'));
  const ipcDir = path.join(tmpDir, 'ipc', 'test-group');
  fs.mkdirSync(ipcDir, { recursive: true });

  await processTaskIpc(
    {
      type: 'skill_search',
      query: 'send messages via telegram',
      requestId: 'req-test-123',
    } as any,
    'test-group',
    false,
    deps,
  );

  const resultPath = path.join(
    DATA_DIR, 'ipc', 'test-group', 'skill_results', 'req-test-123.json',
  );
  expect(fs.existsSync(resultPath)).toBe(true);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
  expect(result.success).toBe(true);
  expect(result.message).toContain('add-telegram');

  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/ipc.test.ts -t "skill_search"`
Expected: FAIL — no `skill_search` case in processTaskIpc.

- [ ] **Step 3: Implement the skill_search IPC handler**

In `src/ipc.ts`, add a new case in the `switch (data.type)` block (after `knowledge_publish`):

```typescript
    case 'skill_search': {
      const query = (data as any).query as string;
      const requestId = (data as any).requestId as string;
      if (!query || !requestId) break;

      const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'skill_results');
      fs.mkdirSync(resultsDir, { recursive: true });
      const resultFile = path.join(resultsDir, `${requestId}.json`);
      const tmpFile = `${resultFile}.tmp`;

      try {
        const res = await fetch('http://localhost:8181/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'query',
              arguments: {
                searches: [{ type: 'vec', query }],
                collections: ['skill-catalog'],
                intent: query,
                limit: 5,
              },
            },
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) throw new Error(`QMD returned ${res.status}`);
        const json = await res.json();
        const content = json?.result?.content?.[0]?.text;
        const parsed = content ? JSON.parse(content) : { results: [] };
        const results = parsed.results || [];

        if (results.length === 0) {
          fs.writeFileSync(tmpFile, JSON.stringify({ success: true, message: 'No matching skills found.' }));
        } else {
          const formatted = results
            .map((r: any) => `• *${r.title}* (score: ${r.score?.toFixed(2)})\n  ${r.snippet || ''}`)
            .join('\n\n');
          fs.writeFileSync(tmpFile, JSON.stringify({ success: true, message: formatted }));
        }
      } catch (err) {
        const msg = err instanceof Error && err.name === 'AbortError'
          ? 'QMD unavailable (timeout)'
          : `QMD query failed: ${err instanceof Error ? err.message : String(err)}`;
        fs.writeFileSync(tmpFile, JSON.stringify({ success: false, message: msg }));
      }
      fs.renameSync(tmpFile, resultFile);
      break;
    }
```

- [ ] **Step 4: Run tests**

Run: `bun --bun vitest run src/ipc.test.ts -t "skill_search"`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(skills): add skill_search IPC handler with QMD query"
```

### Task A5: Add skill_search MCP tool in agent-runner

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Add the SKILL_RESULTS_DIR constant**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, after the existing results dir constants (around line 633):

```typescript
const SKILL_RESULTS_DIR = path.join(IPC_DIR, 'skill_results');
```

- [ ] **Step 2: Add the skill_search tool registration**

After the `knowledge_search` tool (around line 1310), add:

```typescript
// skill_search — discover available NanoClaw capabilities
server.tool(
  'skill_search',
  'Search for NanoClaw capabilities and skills. Use when you need to do something ' +
    "but don't have the right tool. Returns matching skills with install instructions.",
  {
    need: z.string().describe('What you need to do (natural language)'),
  },
  async (args) => {
    const requestId = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'skill_search',
      query: args.need,
      requestId,
      groupFolder,
    });
    const result = await waitForIpcResult(SKILL_RESULTS_DIR, requestId, 10000);
    if (!result || !(result as any).success) {
      const msg = (result as any)?.message || 'No matching skills found (or QMD unavailable).';
      return { content: [{ type: 'text' as const, text: msg }] };
    }
    return { content: [{ type: 'text' as const, text: (result as any).message }] };
  },
);
```

- [ ] **Step 3: Build the container**

```bash
cd container && bun run build && cd ..
```

Expected: clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(skills): add skill_search MCP tool to agent-runner"
```

---

## Feature 2.2: Lossless Conversation Memory

### Task B1: Add write_agent_memory MCP tool to agent-runner

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Add the write_agent_memory tool registration**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, after the `skill_search` tool added in Task A5:

```typescript
// write_agent_memory — persist structured memory across sessions
server.tool(
  'write_agent_memory',
  'Write or update a section of your persistent memory file. ' +
    'Content persists across sessions. Use for decisions, key facts, and session continuity.',
  {
    section: z.string().describe('Section header (e.g., "Session Continuity", "Standing Instructions")'),
    content: z.string().describe('Content for this section (bullet points recommended)'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'write_agent_memory',
      section: args.section,
      content: args.content,
    });
    return { content: [{ type: 'text' as const, text: `Memory section "${args.section}" updated.` }] };
  },
);
```

- [ ] **Step 2: Build the container**

```bash
cd container && bun run build && cd ..
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(memory): add write_agent_memory MCP tool to agent-runner"
```

### Task B2: Add section-upsert mode to write_agent_memory IPC handler

**Files:**
- Modify: `src/ipc.ts`
- Test: `src/ipc.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/ipc.test.ts`:

```typescript
describe('write_agent_memory section upsert', () => {
  it('upserts a new section without clobbering existing content', async () => {
    // Create agent dir and seed memory.md
    const agentDir = path.join(DATA_DIR, 'agents', 'claire');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'memory.md'),
      '# Claire — Memory\n\n## Standing Instructions\n- Be concise\n- Use bullet points\n',
    );

    await processTaskIpc(
      {
        type: 'write_agent_memory',
        section: 'Session Continuity',
        content: '- Decided to use PostCompact approach\n- TODO: review PR\n',
      } as any,
      'claire',
      true,
      deps,
    );

    const content = fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf-8');
    expect(content).toContain('## Standing Instructions');
    expect(content).toContain('Be concise');
    expect(content).toContain('## Session Continuity');
    expect(content).toContain('PostCompact approach');
  });

  it('replaces an existing section on re-upsert', async () => {
    const agentDir = path.join(DATA_DIR, 'agents', 'claire');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'memory.md'),
      '# Claire — Memory\n\n## Session Continuity\n- Old data\n\n## Standing Instructions\n- Be concise\n',
    );

    await processTaskIpc(
      {
        type: 'write_agent_memory',
        section: 'Session Continuity',
        content: '- New data replaces old\n',
      } as any,
      'claire',
      true,
      deps,
    );

    const content = fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf-8');
    expect(content).toContain('New data replaces old');
    expect(content).not.toContain('Old data');
    expect(content).toContain('## Standing Instructions');
    expect(content).toContain('Be concise');
  });

  it('preserves full-file replacement when no section field', async () => {
    const agentDir = path.join(DATA_DIR, 'agents', 'claire');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'memory.md'), '# Old content\n');

    await processTaskIpc(
      {
        type: 'write_agent_memory',
        content: '# Completely new file\n',
      } as any,
      'claire',
      true,
      deps,
    );

    const content = fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf-8');
    expect(content).toBe('# Completely new file\n');
    expect(content).not.toContain('Old content');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --bun vitest run src/ipc.test.ts -t "write_agent_memory section upsert"`
Expected: FAIL — first test fails because current handler does full-file replacement, clobbering Standing Instructions.

- [ ] **Step 3: Modify the write_agent_memory handler to support section upsert**

In `src/ipc.ts`, replace the `case 'write_agent_memory'` block (around line 810) with:

```typescript
    case 'write_agent_memory': {
      const d = data as Record<string, unknown>;
      const content = d.content as string;
      if (!content) break;

      // Resolve agent name: compound key first, then payload agent_name
      const { agent: compoundAgent } = parseCompoundKey(
        fsPathToCompoundKey(sourceGroup),
      );
      const agentName = compoundAgent || (d.agent_name as string | undefined);
      if (!agentName) {
        logger.warn(
          { sourceGroup },
          'write_agent_memory: cannot determine agent name',
        );
        break;
      }

      // Validate agent directory exists (prevents path traversal)
      const agentDir = path.join(AGENTS_DIR, agentName);
      if (
        !fs.existsSync(agentDir) ||
        agentName.includes('..') ||
        agentName.includes('/')
      ) {
        logger.warn(
          { agentName, sourceGroup },
          'write_agent_memory: invalid agent name',
        );
        break;
      }

      const memoryPath = path.join(agentDir, 'memory.md');
      const tmpPath = `${memoryPath}.tmp`;
      const section = d.section as string | undefined;

      if (section) {
        // Section upsert: read existing, replace/append section
        const existing = fs.existsSync(memoryPath)
          ? fs.readFileSync(memoryPath, 'utf-8')
          : `# ${agentName} — Memory\n`;
        const sectionHeader = `## ${section}`;
        const sectionRegex = new RegExp(
          `${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?(?=\\n## |$)`,
        );
        const newSection = `${sectionHeader}\n${content}`;
        const updated = sectionRegex.test(existing)
          ? existing.replace(sectionRegex, newSection)
          : `${existing.trimEnd()}\n\n${newSection}\n`;
        fs.writeFileSync(tmpPath, updated);
      } else {
        // Full-file replacement (backwards compat)
        fs.writeFileSync(tmpPath, content);
      }
      fs.renameSync(tmpPath, memoryPath);
      logger.info({ agent: agentName, section: section || '(full)' }, 'Agent memory updated via IPC');
      break;
    }
```

- [ ] **Step 4: Run tests**

Run: `bun --bun vitest run src/ipc.test.ts -t "write_agent_memory section upsert"`
Expected: all 3 tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(memory): add section-upsert mode to write_agent_memory IPC handler"
```

### Task B3: Add post-compaction IPC message in agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Add the compaction flag variable**

In `container/agent-runner/src/index.ts`, near the top of the `main()` function (around line 785, before the query loop), add:

```typescript
  let compactionJustHappened = false;
```

- [ ] **Step 2: Set the flag in the PreCompact hook**

In `createPreCompactHook` (around line 309), the function currently returns `{}` at the end. Before the `return {}`, add:

```typescript
    // Signal the main loop to inject a memory extraction prompt
    compactionJustHappened = true;
```

But wait — `compactionJustHappened` is in `main()` scope, not in `createPreCompactHook`. The hook is a closure that needs access to this flag. Refactor: move the flag to module scope (before `createPreCompactHook`), and have both the hook and the main loop reference it:

At module level (around line 95, after the `IPC_INPUT_DIR` constant):

```typescript
let compactionJustHappened = false;
```

Then in `createPreCompactHook`, before `return {}` (around line 353):

```typescript
    compactionJustHappened = true;
```

- [ ] **Step 3: Check the flag in the main loop and write the IPC message**

In the main loop (around line 1030, after `log('Query ended, waiting for next IPC message...');` and before `await waitForIpcMessage()`):

```typescript
      // After compaction, inject a memory extraction prompt
      if (compactionJustHappened) {
        compactionJustHappened = false;
        const extractFile = path.join(
          IPC_INPUT_DIR,
          `extract-${Date.now()}.json`,
        );
        fs.writeFileSync(
          extractFile,
          JSON.stringify({
            type: 'message',
            text:
              '[SYSTEM] Your conversation context was just compacted. ' +
              'Important context may have been lost. Please call write_agent_memory ' +
              'with a concise summary of:\n' +
              '- Decisions made in this session\n' +
              '- Tasks you committed to\n' +
              '- Open questions or unresolved items\n' +
              '- Key facts the user shared that you\'ll need later\n' +
              'Write to section "Session Continuity". Use bullet points. Be concise (under 1500 chars).',
          }),
        );
        log('Injected memory extraction prompt after compaction');
      }
```

- [ ] **Step 4: Build the container**

```bash
cd container && bun run build && cd ..
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(memory): inject memory extraction prompt after context compaction"
```

### Task B4: Add Session Continuity injection to context-assembler

**Files:**
- Modify: `src/context-assembler.ts`
- Test: `src/context-assembler.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/context-assembler.test.ts`:

```typescript
describe('Session Continuity injection', () => {
  it('injects Session Continuity from agent memory.md when agentName provided', async () => {
    // Mock agent memory.md with a Session Continuity section
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('agents/claire/memory.md')) return true;
      if (s.includes('agents/claire/identity.md')) return false;
      if (s.includes('memory.md')) return false;
      return false;
    });

    mockReadFileSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes('agents/claire/memory.md')) {
        return '# Claire — Memory\n\n## Session Continuity\n- Decided to use PostCompact\n- TODO: review PR\n\n## Standing Instructions\n- Be concise\n';
      }
      return '';
    });

    const packet = await assembleContextPacket('telegram_claire', true, 'claire');
    expect(packet).toContain('Session Continuity (from prior compaction)');
    expect(packet).toContain('Decided to use PostCompact');
  });

  it('does not inject Session Continuity without agentName', async () => {
    const packet = await assembleContextPacket('telegram_claire', true);
    expect(packet).not.toContain('Session Continuity');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --bun vitest run src/context-assembler.test.ts -t "Session Continuity"`
Expected: FAIL — no Session Continuity section injected.

- [ ] **Step 3: Add Session Continuity injection**

In `src/context-assembler.ts`, after the group memory section (around line 187, after the `current.md` priorities block and before the staleness check), add:

```typescript
  // Session Continuity from agent memory (injected early so it survives truncation)
  if (agentName) {
    const agentMemoryPath = path.join(AGENTS_DIR, agentName, 'memory.md');
    if (fs.existsSync(agentMemoryPath)) {
      const agentMemory = fs.readFileSync(agentMemoryPath, 'utf-8');
      const continuityMatch = agentMemory.match(
        /## Session Continuity\n([\s\S]*?)(?=\n## |$)/,
      );
      if (continuityMatch?.[1]?.trim()) {
        const continuity = continuityMatch[1].trim().slice(0, 1500);
        sections.push(
          `\n--- Session Continuity (from prior compaction) ---\n${continuity}`,
        );
      }
    }
  }
```

Note: uses `AGENTS_DIR` which should already be defined (same as used in the agent identity block). If not, add at the top of the function:

```typescript
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
```

- [ ] **Step 4: Run tests**

Run: `bun --bun vitest run src/context-assembler.test.ts -t "Session Continuity"`
Expected: both tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/context-assembler.ts src/context-assembler.test.ts
git commit -m "feat(memory): inject Session Continuity into context packet from agent memory"
```

### Task B5: Add session-start cleanup for stale continuity

**Files:**
- Modify: `src/container-runner.ts`
- Test: `src/container-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/container-runner.test.ts`:

```typescript
import { clearStaleSessionContinuity } from './container-runner.js';

describe('clearStaleSessionContinuity', () => {
  it('removes Session Continuity section from memory.md on fresh session', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-test-'));
    const memoryPath = path.join(tmpDir, 'memory.md');
    fs.writeFileSync(
      memoryPath,
      '# Claire — Memory\n\n## Standing Instructions\n- Be concise\n\n## Session Continuity\n- Old data\n',
    );

    clearStaleSessionContinuity(memoryPath);

    const content = fs.readFileSync(memoryPath, 'utf-8');
    expect(content).toContain('## Standing Instructions');
    expect(content).toContain('Be concise');
    expect(content).not.toContain('Session Continuity');
    expect(content).not.toContain('Old data');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when no Session Continuity section exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-test-'));
    const memoryPath = path.join(tmpDir, 'memory.md');
    const original = '# Claire — Memory\n\n## Standing Instructions\n- Be concise\n';
    fs.writeFileSync(memoryPath, original);

    clearStaleSessionContinuity(memoryPath);

    const content = fs.readFileSync(memoryPath, 'utf-8');
    expect(content).toBe(original);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when memory.md does not exist', () => {
    expect(() => clearStaleSessionContinuity('/nonexistent/path/memory.md')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --bun vitest run src/container-runner.test.ts -t "clearStaleSessionContinuity"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement clearStaleSessionContinuity**

In `src/container-runner.ts`, add the exported function:

```typescript
/**
 * Remove the ## Session Continuity section from an agent's memory.md.
 * Called on fresh session start to prevent stale continuity from prior sessions.
 */
export function clearStaleSessionContinuity(memoryPath: string): void {
  if (!fs.existsSync(memoryPath)) return;
  const content = fs.readFileSync(memoryPath, 'utf-8');
  if (!content.includes('## Session Continuity')) return;
  const cleaned = content.replace(
    /\n*## Session Continuity\n[\s\S]*?(?=\n## |$)/,
    '',
  );
  const tmpPath = `${memoryPath}.tmp`;
  fs.writeFileSync(tmpPath, cleaned);
  fs.renameSync(tmpPath, memoryPath);
}
```

- [ ] **Step 4: Wire into the container spawn path**

In `src/container-runner.ts`, inside the `runContainerAgent` function, before the container is spawned (after the context packet is written, around line 618), add:

```typescript
    // Clear stale Session Continuity on fresh session (no existing sessionId)
    if (!input.sessionId && input.agentName) {
      const agentMemoryPath = path.join(DATA_DIR, 'agents', input.agentName, 'memory.md');
      clearStaleSessionContinuity(agentMemoryPath);
    }
```

- [ ] **Step 5: Run tests**

Run: `bun --bun vitest run src/container-runner.test.ts -t "clearStaleSessionContinuity"`
Expected: all 3 tests PASS.

- [ ] **Step 6: Run full test suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat(memory): clear stale Session Continuity on fresh session start"
```

### Task B6: Rebuild container and verify build

**Files:**
- Rebuild: `./container/build.sh`

- [ ] **Step 1: Rebuild the container image**

```bash
./container/build.sh
```

Expected: clean build.

- [ ] **Step 2: Verify all tests pass**

```bash
bun run test
```

Expected: all tests pass.

- [ ] **Step 3: Verify production build**

```bash
bun run build 2>&1 | grep "error TS" | grep -v "test.ts"
```

Expected: no non-test TypeScript errors.

- [ ] **Step 4: Commit** (if container/build produced any artifacts)

No commit needed unless build artifacts changed.

---

## Post-Implementation Checklist

- [ ] All tests pass: `bun run test`
- [ ] Build succeeds: `bun run build` (no non-test errors)
- [ ] Container builds: `./container/build.sh`
- [ ] Skill Discovery: run `bash scripts/sync/skill-catalog-sync.sh`, verify `data/skill-catalog/` populated
- [ ] Skill Discovery: `qmd update` indexes `skill-catalog` collection
- [ ] Skill Discovery: search via QMD returns results for "telegram"
- [ ] Lossless Memory: `write_agent_memory` with `section` field upserts correctly
- [ ] Lossless Memory: context-assembler injects Session Continuity when present
- [ ] Lossless Memory: fresh session clears stale continuity
