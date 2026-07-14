/**
 * IPC WIRE CONTRACT — canonical copy (container side).
 *
 * The file-based IPC wire between in-container agents and the host has
 * two hand-maintained ends: MCP tools here (writing request files,
 * polling result dirs) and IpcHandlers in src/ipc/handlers/ (writing
 * result files). This module is the single machine-readable statement of
 * the parts both ends must agree on: queue directory names and the
 * results-directory for every result-kind action (many predate the
 * `${type}_results` convention and use legacy prefix-grouped dirs).
 *
 * A byte-identical mirror lives at src/ipc/wire-contract.ts — the host
 * build cannot import across the container build context, so the two
 * copies are kept in lockstep by src/ipc/wire-contract.test.ts, which
 * deep-compares the exports and pins every registered handler to this
 * table. Edit BOTH files together; the test fails on any drift.
 */

/** Queue subdirectories under the per-group IPC root. */
export const IPC_QUEUE_DIRS = {
  /** Actions dispatched through the IpcHandler registry. */
  tasks: 'tasks',
  /** Legacy queue (message / send_file). Since 2026-07-14 both queues
   * feed the same dispatcher; this dir survives for in-flight containers. */
  messages: 'messages',
  /** Failed/stale payloads, moved aside for manual inspection. */
  errors: 'errors',
} as const;

/**
 * results-directory per result-kind action type. Absent types use the
 * default `${type}_results`. The x_* / browser_* families are handled by
 * dynamically-loaded skill hosts outside src/, but their dirs are part
 * of the wire and recorded here.
 */
export const RESULTS_DIR_BY_TYPE: Record<string, string> = {
  dashboard_query: 'dashboard_results',
  deploy_mini_app: 'deploy_results',
  imessage_search: 'imessage_results',
  imessage_read: 'imessage_results',
  imessage_send: 'imessage_results',
  imessage_list_contacts: 'imessage_results',
  kg_query: 'kg_results',
  knowledge_search: 'knowledge_results',
  pageindex_fetch: 'pageindex_results',
  pageindex_index: 'pageindex_results',
  skill_search: 'skill_results',
  save_skill: 'skill_results',
  crystallize_skill: 'skill_results',
  crystallize_candidate_fetch: 'crystallize_candidate_results',
  slack_dm_read: 'slack_results',
  slack_dm: 'slack_results',
  task_add: 'task_results',
  task_list: 'task_results',
  task_close: 'task_results',
  task_reopen: 'task_results',
  // Dynamic skill families (hosts live in .claude/skills/*/host.js):
  browser: 'browser_results',
  x: 'x_results',
};

/** Results dir for an action type (legacy table first, then convention). */
export function resultsDirFor(type: string): string {
  return RESULTS_DIR_BY_TYPE[type] ?? `${type}_results`;
}
