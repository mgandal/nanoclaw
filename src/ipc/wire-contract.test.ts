import { describe, it, expect } from 'vitest';

import {
  IPC_QUEUE_DIRS,
  RESULTS_DIR_BY_TYPE,
  resultsDirFor,
} from './wire-contract.js';
import {
  IPC_QUEUE_DIRS as CONTAINER_QUEUE_DIRS,
  RESULTS_DIR_BY_TYPE as CONTAINER_RESULTS_DIRS,
  resultsDirFor as containerResultsDirFor,
} from '../../container/agent-runner/src/wire-contract.js';
import {
  getIpcHandler,
  _getRegisteredHandlersForTests,
  _resetHandlersForTests,
} from './handler.js';
import {
  registerBuiltinHandlers,
  _resetBuiltinHandlersForTests,
} from './handlers/index.js';

/**
 * The wire contract exists as two physical copies (host mirror +
 * container canonical) because the host build cannot import across the
 * container image build context. These tests are the lockstep mechanism:
 * any edit to one side without the other fails here.
 */
describe('wire contract parity (host mirror == container canonical)', () => {
  it('queue dirs are identical', () => {
    expect(IPC_QUEUE_DIRS).toEqual(CONTAINER_QUEUE_DIRS);
  });

  it('results-dir tables are identical', () => {
    expect(RESULTS_DIR_BY_TYPE).toEqual(CONTAINER_RESULTS_DIRS);
  });

  it('the default convention agrees', () => {
    expect(resultsDirFor('some_new_action')).toBe(
      containerResultsDirFor('some_new_action'),
    );
    expect(resultsDirFor('some_new_action')).toBe('some_new_action_results');
  });
});

describe('wire contract vs the IpcHandler registry', () => {
  it('every registered result-kind handler writes the contract dir', () => {
    _resetHandlersForTests();
    _resetBuiltinHandlersForTests();
    registerBuiltinHandlers();

    // Every type in the contract that names a registry handler must be
    // result-kind and declare (or default to) the contract's dir; and
    // every registered result-kind handler must match the contract.
    const dynamicFamilies = new Set(['browser', 'x']);
    for (const [type, dir] of Object.entries(RESULTS_DIR_BY_TYPE)) {
      if (dynamicFamilies.has(type)) continue; // skill hosts outside src/
      const handler = getIpcHandler(type);
      expect(handler, `contract type ${type} has no registered handler`)
        .toBeDefined();
      expect(
        handler!.responseKind,
        `contract type ${type} is not result-kind`,
      ).toBe('result');
      expect(
        handler!.resultsDirName ?? `${type}_results`,
        `handler ${type} writes a different dir than the contract`,
      ).toBe(dir);
    }

    // Reverse direction: no result-kind handler exists outside the
    // contract's knowledge (default-convention handlers pass trivially,
    // but their dir still must equal resultsDirFor(type)).
    for (const [type, handler] of _getRegisteredHandlersForTests()) {
      if (handler.responseKind !== 'result') continue;
      expect(
        handler.resultsDirName ?? `${type}_results`,
        `result-kind handler ${type} disagrees with resultsDirFor`,
      ).toBe(resultsDirFor(type));
    }
  });
});
