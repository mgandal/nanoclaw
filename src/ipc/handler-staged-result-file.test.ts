import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  _resetHandlersForTests,
  registerIpcHandler,
  dispatchIpcAction,
  buildContext,
} from './handler.js';
import { _initTestDatabase } from '../db.js';
import { DATA_DIR } from '../config.js';

/**
 * Phase 0c (Task 0c.1) — R3-C3 amendment.
 *
 * Pre-fix: dispatcher's stage path at handler.ts:421 returned
 * `{ handled: true }` WITHOUT writing a result file. For
 * `responseKind: 'result'` handlers, this left the container poller
 * waiting for a file until IPC_TIMEOUT_MS — the agent saw a timeout
 * instead of a "staged for approval" reply.
 *
 * The fix writes
 *   { executed: false, staged: true, pendingId, message }
 * to the expected result-file path before returning. T-staged-result-file
 * is the mutation pin: reverting the new write block makes the test fail
 * on the file-existence assertion.
 *
 * Spec: docs/superpowers/specs/2026-05-19-ipc-gate-activation-design.md
 * (Finding R3-C3).
 */
describe('Phase 0c — stage-path result file (R3-C3 amendment)', () => {
  let agentName: string;
  let agentDir: string;

  beforeEach(() => {
    _resetHandlersForTests();
    _initTestDatabase();
    agentName = `phase0c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    agentDir = path.join(DATA_DIR, 'agents', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    // trust.yaml entry that causes the gate to stage (draft = stage).
    fs.writeFileSync(
      path.join(agentDir, 'trust.yaml'),
      'actions:\n  staging_test: draft\n',
    );
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('T-staged-result-file — stage of result-kind handler writes {executed:false, staged:true, pendingId, message}', async () => {
    // Mutation pin for R3-C3 (handler.ts:421 returning without writing file).
    // Without this fix, the container poller would hang IPC_TIMEOUT_MS.
    registerIpcHandler({
      type: 'staging_test',
      responseKind: 'result',
      resultsDirName: 'staging_test_results',
      parse: (raw) => raw as any,
      authorize: () => ({
        target: 'unit-test-target',
        notifySummary: '',
        payloadForStaging: { type: 'staging_test', echoField: 'hello' },
        // NOT setting skipGate — flow through gateAndStage (trust=draft → stage).
      }),
      execute: async () => {
        throw new Error('execute() must NOT fire on stage path');
      },
    });

    const sourceGroup = `telegram_test--${agentName}`;
    const ctx = buildContext(sourceGroup, false, {
      registeredGroups: () => ({}),
    } as any);

    const requestId = 'req_test_123';
    const result = await dispatchIpcAction(
      { type: 'staging_test', requestId, echoField: 'hello' },
      ctx,
    );
    expect(result.handled).toBe(true);

    // Result-file path matches dispatcher's writeResultFile pattern:
    // dataDir/ipc/sourceGroup/resultsDirName/requestId.json. ctx.sourceGroup
    // is the fs-form compound key (`group--agent`), unchanged from input.
    const resultPath = path.join(
      DATA_DIR,
      'ipc',
      sourceGroup,
      'staging_test_results',
      `${requestId}.json`,
    );
    expect(fs.existsSync(resultPath)).toBe(true);

    const payload = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(payload.executed).toBe(false);
    expect(payload.staged).toBe(true);
    expect(typeof payload.pendingId).toBe('string');
    expect(payload.pendingId).toMatch(/^pa-/);
    expect(payload.message).toContain('Staged for approval');
    expect(payload.message).toContain(payload.pendingId);

    // Cleanup the leaked result-file directory tree.
    fs.rmSync(path.join(DATA_DIR, 'ipc', sourceGroup), {
      recursive: true,
      force: true,
    });
  });
});
