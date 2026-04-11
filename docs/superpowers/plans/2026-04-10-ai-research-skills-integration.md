# AI Research SKILLs Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install curated AI Research SKILLs from Orchestra Research into SCIENCE-claw and CODE-claw groups, with a persistent sync mechanism so skills survive session resets.

**Architecture:** Add a second skill-sync pass in `container-runner.ts` that copies from `groups/{group}/skills/` into the session dir after container skills, so group-specific skills merge with (and override) global container skills. Then install curated subsets of Orchestra's AI Research SKILLs library into each group's `skills/` directory.

**Tech Stack:** TypeScript (NanoClaw host), SKILL.md files (markdown with YAML frontmatter)

**Source repo:** `https://github.com/Orchestra-Research/AI-Research-SKILLs` (cloned to `/tmp/ai-research-skills`)

---

### File Structure

**Modified:**
- `src/container-runner.ts` — add group-level skill sync after container skill sync (lines 192-193)
- `src/container-runner.test.ts` — add test for group-level skill sync

**Created:**
- `groups/telegram_science-claw/skills/autoresearch/SKILL.md` (+ references/)
- `groups/telegram_science-claw/skills/ml-paper-writing/` (SKILL.md + references/ + templates/)
- `groups/telegram_science-claw/skills/academic-plotting/` (SKILL.md + references/)
- `groups/telegram_science-claw/skills/brainstorming-research-ideas/SKILL.md`
- `groups/telegram_science-claw/skills/peft/` (SKILL.md + references/)
- `groups/telegram_science-claw/skills/lm-evaluation-harness/` (SKILL.md + references/)
- `groups/telegram_science-claw/skills/sentence-transformers/` (SKILL.md + references/)
- `groups/telegram_science-claw/skills/dspy/` (SKILL.md + references/)
- `groups/telegram_code-claw/skills/autoresearch/SKILL.md` (+ references/)
- `groups/telegram_code-claw/skills/ml-paper-writing/` (SKILL.md + references/ + templates/) — replaces v1.0.0
- `groups/telegram_code-claw/skills/dspy/` (SKILL.md + references/)
- `groups/telegram_code-claw/skills/instructor/` (SKILL.md + references/)
- `groups/telegram_code-claw/skills/vllm/` (SKILL.md + references/)
- `groups/telegram_code-claw/skills/weights-and-biases/` (SKILL.md + references/)
- `groups/telegram_code-claw/skills/modal/` (SKILL.md + references/)

---

### Task 1: Add group-level skill sync to container-runner.ts

**Files:**
- Modify: `src/container-runner.ts:192` (after container skills sync, before mount)
- Test: `src/container-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test in `src/container-runner.test.ts` that verifies group-level skills are synced. The existing tests use `runContainerAgent` (not `buildVolumeMounts` directly) and mock `fs` via default import. `cpSync` is NOT in the existing mock — add it.

First, add `cpSync` to the fs mock (inside the `default: { ... }` block at ~line 38):

```typescript
// In the fs mock, add cpSync alongside the existing mocks:
cpSync: vi.fn(),
```

Then add the test in the `describe('container-runner volume mounts')` block (after the existing mount tests around line 1010):

```typescript
it('syncs group-level skills from groups/{folder}/skills/', async () => {
  const mockCpSync = vi.mocked(fs.cpSync);
  mockCpSync.mockClear();

  // existsSync: true for group skills dir, false for others (default)
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
    const s = String(p);
    if (s.endsWith('/skills')) return true; // both container/ and group/ skills dirs
    return false;
  });

  // readdirSync: return a skill dir for the group skills path
  vi.mocked(fs.readdirSync).mockImplementation((p: fs.PathLike) => {
    const s = String(p);
    if (s.includes('groups/') && s.endsWith('/skills'))
      return ['autoresearch'] as any;
    if (s.includes('container/skills'))
      return ['status'] as any;
    return [] as any;
  });

  vi.mocked(fs.statSync).mockReturnValue({
    isDirectory: () => true,
  } as any);

  const resultPromise = runContainerAgent(testGroup, testInput, () => {});
  await vi.advanceTimersByTimeAsync(10);

  // cpSync should have been called for both container skills AND group skills
  const calls = mockCpSync.mock.calls.map((c) => ({
    src: String(c[0]),
    dst: String(c[1]),
  }));

  // Group skills dir (groups/test-group/skills/autoresearch) should be synced
  const groupSync = calls.find(
    (c) => c.src.includes('groups/') && c.src.includes('autoresearch'),
  );
  expect(groupSync).toBeDefined();
  expect(groupSync!.dst).toContain('.claude/skills/autoresearch');

  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mgandal/Agents/nanoclaw/.claude/worktrees/playful-shimmying-scott && npx vitest run src/container-runner.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: FAIL — group skill sync not found in cpSync calls.

- [ ] **Step 3: Implement group-level skill sync**

In `src/container-runner.ts`, after the container skills sync block (line 192) and before the mount push (line 193), add:

```typescript
  // Sync group-level skills (from groups/{folder}/skills/) into the session dir.
  // Runs AFTER container skills so group-specific skills override global ones.
  const groupSkillsSrc = path.join(groupDir, 'skills');
  if (fs.existsSync(groupSkillsSrc)) {
    for (const skillDir of fs.readdirSync(groupSkillsSrc)) {
      const srcDir = path.join(groupSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
```

This is 8 lines, follows the exact same pattern as the container skills sync above it, and uses `groupDir` which is already defined at line 97.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mgandal/Agents/nanoclaw/.claude/worktrees/playful-shimmying-scott && npx vitest run src/container-runner.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/mgandal/Agents/nanoclaw/.claude/worktrees/playful-shimmying-scott && npx vitest run --reporter=verbose 2>&1 | tail -30`

Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: sync group-level skills into container sessions

Group-specific skills in groups/{folder}/skills/ are now copied to the
container's .claude/skills/ directory on every spawn. Runs after container
skills so group overrides take precedence."
```

---

### Task 2: Install curated skills into SCIENCE-claw

**Files:**
- Create: `groups/telegram_science-claw/skills/` (8 skill directories)

**Source:** `/tmp/ai-research-skills` (cloned repo)

Skills to install:
1. `autoresearch` ← `0-autoresearch-skill/` (SKILL.md + references/)
2. `ml-paper-writing` ← `20-ml-paper-writing/ml-paper-writing/` (SKILL.md + references/ + templates/)
3. `academic-plotting` ← `20-ml-paper-writing/academic-plotting/` (SKILL.md + references/)
4. `brainstorming-research-ideas` ← `21-research-ideation/brainstorming-research-ideas/` (SKILL.md only)
5. `peft` ← `03-fine-tuning/peft/` (SKILL.md + references/)
6. `lm-evaluation-harness` ← `11-evaluation/lm-evaluation-harness/` (SKILL.md + references/)
7. `sentence-transformers` ← `15-rag/sentence-transformers/` (SKILL.md + references/)
8. `dspy` ← `16-prompt-engineering/dspy/` (SKILL.md + references/)

- [ ] **Step 1: Create skills directory**

```bash
mkdir -p groups/telegram_science-claw/skills
```

- [ ] **Step 2: Copy all 8 skills from cloned repo**

```bash
SRC=/tmp/ai-research-skills
DST=groups/telegram_science-claw/skills

# 1. autoresearch (orchestrator — the high-value piece)
cp -r "$SRC/0-autoresearch-skill" "$DST/autoresearch"

# 2. ml-paper-writing (with LaTeX templates for NeurIPS/ICML/ICLR/ACL/AAAI/COLM)
cp -r "$SRC/20-ml-paper-writing/ml-paper-writing" "$DST/ml-paper-writing"

# 3. academic-plotting (publication-quality figures)
cp -r "$SRC/20-ml-paper-writing/academic-plotting" "$DST/academic-plotting"

# 4. brainstorming-research-ideas (10 ideation frameworks)
cp -r "$SRC/21-research-ideation/brainstorming-research-ideas" "$DST/brainstorming-research-ideas"

# 5. peft (LoRA/QLoRA fine-tuning)
cp -r "$SRC/03-fine-tuning/peft" "$DST/peft"

# 6. lm-evaluation-harness (model benchmarking)
cp -r "$SRC/11-evaluation/lm-evaluation-harness" "$DST/lm-evaluation-harness"

# 7. sentence-transformers (embeddings)
cp -r "$SRC/15-rag/sentence-transformers" "$DST/sentence-transformers"

# 8. dspy (structured LLM programs)
cp -r "$SRC/16-prompt-engineering/dspy" "$DST/dspy"
```

- [ ] **Step 3: Remove .gitkeep files and hidden files**

```bash
find groups/telegram_science-claw/skills -name ".gitkeep" -delete
find groups/telegram_science-claw/skills -name ".DS_Store" -delete
```

- [ ] **Step 4: Verify installation**

```bash
echo "=== SCIENCE-claw skills ===" && \
ls groups/telegram_science-claw/skills/ && \
echo "=== Total size ===" && \
du -sh groups/telegram_science-claw/skills/ && \
echo "=== Skill count ===" && \
find groups/telegram_science-claw/skills -name "SKILL.md" | wc -l
```

Expected: 8 skill directories, ~1.5MB total (mostly LaTeX templates), 8 SKILL.md files.

- [ ] **Step 5: Commit**

```bash
git add groups/telegram_science-claw/skills/
git commit -m "feat: install 8 AI Research SKILLs for SCIENCE-claw

Curated from Orchestra Research's AI-Research-SKILLs library:
- autoresearch: two-loop autonomous research orchestrator
- ml-paper-writing: LaTeX paper writing for 6 conferences
- academic-plotting: publication-quality figures
- brainstorming-research-ideas: 10 structured ideation frameworks
- peft: LoRA/QLoRA fine-tuning
- lm-evaluation-harness: model benchmarking (60+ benchmarks)
- sentence-transformers: embedding generation
- dspy: structured LLM programs

Source: github.com/Orchestra-Research/AI-Research-SKILLs"
```

---

### Task 3: Install curated skills into CODE-claw

**Files:**
- Create: `groups/telegram_code-claw/skills/` (7 skill directories — 6 new + 1 upgrade)

**Source:** `/tmp/ai-research-skills` (cloned repo)

Skills to install:
1. `autoresearch` ← `0-autoresearch-skill/` (SKILL.md + references/)
2. `ml-paper-writing` ← `20-ml-paper-writing/ml-paper-writing/` (UPGRADE v1.0.0 → v1.2.0, SKILL.md + references/ + templates/)
3. `dspy` ← `16-prompt-engineering/dspy/` (SKILL.md + references/)
4. `instructor` ← `16-prompt-engineering/instructor/` (SKILL.md + references/)
5. `vllm` ← `12-inference-serving/vllm/` (SKILL.md + references/)
6. `weights-and-biases` ← `13-mlops/weights-and-biases/` (SKILL.md + references/)
7. `modal` ← `09-infrastructure/modal/` (SKILL.md + references/)

Note: CODE-claw already has 6 custom skills in `groups/telegram_code-claw/skills/` (daily-task-manager, daily-task-prep, eval-repo, executive-assistant, last30days, simon). These must NOT be overwritten.

- [ ] **Step 1: Copy all 7 skills from cloned repo**

```bash
SRC=/tmp/ai-research-skills
DST=groups/telegram_code-claw/skills

# 1. autoresearch (orchestrator)
cp -r "$SRC/0-autoresearch-skill" "$DST/autoresearch"

# 2. ml-paper-writing (UPGRADE: replaces v1.0.0 in session dir with v1.2.0)
cp -r "$SRC/20-ml-paper-writing/ml-paper-writing" "$DST/ml-paper-writing"

# 3. dspy (structured LLM programs)
cp -r "$SRC/16-prompt-engineering/dspy" "$DST/dspy"

# 4. instructor (type-safe LLM outputs)
cp -r "$SRC/16-prompt-engineering/instructor" "$DST/instructor"

# 5. vllm (inference serving)
cp -r "$SRC/12-inference-serving/vllm" "$DST/vllm"

# 6. weights-and-biases (experiment tracking)
cp -r "$SRC/13-mlops/weights-and-biases" "$DST/weights-and-biases"

# 7. modal (serverless GPU)
cp -r "$SRC/09-infrastructure/modal" "$DST/modal"
```

- [ ] **Step 2: Remove .gitkeep files and hidden files**

```bash
find groups/telegram_code-claw/skills -name ".gitkeep" -delete
find groups/telegram_code-claw/skills -name ".DS_Store" -delete
```

- [ ] **Step 3: Verify installation preserves existing skills**

```bash
echo "=== CODE-claw skills ===" && \
ls groups/telegram_code-claw/skills/ && \
echo "=== Existing skills intact? ===" && \
ls groups/telegram_code-claw/skills/simon/SKILL.md && \
ls groups/telegram_code-claw/skills/daily-task-prep/SKILL.md && \
echo "=== New skills present? ===" && \
ls groups/telegram_code-claw/skills/autoresearch/SKILL.md && \
ls groups/telegram_code-claw/skills/vllm/SKILL.md && \
echo "=== Total size ===" && \
du -sh groups/telegram_code-claw/skills/ && \
echo "=== Skill count ===" && \
find groups/telegram_code-claw/skills -maxdepth 2 -name "SKILL.md" | wc -l
```

Expected: 13 skill directories (6 existing + 7 new), 13 SKILL.md files, existing skills untouched.

- [ ] **Step 4: Commit**

```bash
git add groups/telegram_code-claw/skills/autoresearch/ \
        groups/telegram_code-claw/skills/ml-paper-writing/ \
        groups/telegram_code-claw/skills/dspy/ \
        groups/telegram_code-claw/skills/instructor/ \
        groups/telegram_code-claw/skills/vllm/ \
        groups/telegram_code-claw/skills/weights-and-biases/ \
        groups/telegram_code-claw/skills/modal/
git commit -m "feat: install 7 AI Research SKILLs for CODE-claw

Curated from Orchestra Research's AI-Research-SKILLs library:
- autoresearch: two-loop autonomous research orchestrator
- ml-paper-writing: UPGRADE v1.0.0 → v1.2.0 with LaTeX templates
- dspy: structured LLM programs
- instructor: type-safe LLM outputs with Pydantic
- vllm: inference serving with PagedAttention
- weights-and-biases: experiment tracking
- modal: serverless GPU compute

Source: github.com/Orchestra-Research/AI-Research-SKILLs"
```

---

### Task 4: Verify end-to-end

- [ ] **Step 1: Build the project**

```bash
cd /Users/mgandal/Agents/nanoclaw/.claude/worktrees/playful-shimmying-scott && bun run build
```

Expected: Clean build, no TypeScript errors.

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/mgandal/Agents/nanoclaw/.claude/worktrees/playful-shimmying-scott && npx vitest run --reporter=verbose 2>&1 | tail -40
```

Expected: All tests pass, including the new group-level skill sync test.

- [ ] **Step 3: Verify skill YAML frontmatter is valid**

```bash
for f in $(find groups/telegram_science-claw/skills groups/telegram_code-claw/skills -name "SKILL.md" -path "*/autoresearch/*" -o -name "SKILL.md" -path "*/ml-paper-writing/*" -o -name "SKILL.md" -path "*/dspy/*"); do
  echo "--- $f ---"
  head -12 "$f"
  echo ""
done
```

Expected: All SKILL.md files have valid YAML frontmatter with name, description, version, author fields.
