// -----------------------------------------------------------------------------
// Proxmox task log: reading it, and deciding what counts as a failure.
//
// Two read-only endpoints are used, and nothing else:
//   GET /api2/json/nodes                 -> the nodes of the cluster
//   GET /api2/json/nodes/{node}/tasks    -> the finished tasks of one node
//
// `GET /nodes/{node}/tasks` is permission-filtered by Proxmox itself: without
// `Sys.Audit` on `/nodes/{node}` a token only sees ITS OWN tasks — so it
// answers 200 with an empty (or truncated) list instead of a 403. That silent
// degradation is the reason `probeNodeAudit()` exists: it is what the "Test
// the connection" action uses to tell the user their token is under-privileged
// before they wonder why the counter stays at zero.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { get, ProxmoxError } from './client.js';
import { splitList } from '../config.js';

const logger = createLogger({ name: 'proxmox-tasks' });

// Upper bound of the task page we ask Proxmox for. `errors=1` already filters
// the successful tasks out server-side, so this is a ceiling on FAILED tasks
// in the window, not on the whole log.
const MAX_TASKS_FETCHED = 200;

/**
 * Classify a Proxmox task status exactly like Proxmox does
 * (`PVE::UPID::normalize_status_type`): a finished task is `OK`,
 * `WARNINGS: <n>`, the literal `unexpected status`, or an error string.
 * @param {string|undefined} status - The `status` field of a task entry.
 * @returns {string} 'ok' | 'warning' | 'unknown' | 'error'.
 */
export function normalizeStatusType(status) {
  if (!status) {
    return 'unknown';
  }
  if (status === 'OK') {
    return 'ok';
  }
  if (/^WARNINGS: \d+$/.test(status)) {
    return 'warning';
  }
  if (status === 'unexpected status') {
    return 'unknown';
  }
  return 'error';
}

/**
 * Which status types count as a failure, for the configured scope.
 *
 * `unknown` is always a failure: on the archived (finished) task list it means
 * the task left no exit status behind — a crashed worker, not a success.
 * @param {string} failureScope - 'errors' or 'errors_and_warnings'.
 * @returns {Set<string>} The failing status types.
 */
export function failingStatusTypes(failureScope) {
  return failureScope === 'errors_and_warnings'
    ? new Set(['error', 'warning', 'unknown'])
    : new Set(['error', 'unknown']);
}

/**
 * List the nodes of the cluster, restricted to the user's filter when set.
 *
 * `GET /nodes` needs no particular privilege (`user => 'all'` in Proxmox), so
 * it succeeds even with a token that cannot read a single task: the per-node
 * privilege is checked separately.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{node: string, status: string}[]>} The monitored nodes.
 */
export async function listNodes(config) {
  const data = await get(config, '/nodes');
  if (!Array.isArray(data)) {
    throw new ProxmoxError('parse', 'Proxmox returned an unexpected answer for the node list.');
  }
  const wanted = splitList(config.nodes_filter).map((name) => name.toLowerCase());
  return data
    .filter((entry) => typeof entry?.node === 'string' && entry.node.length > 0)
    .filter((entry) => wanted.length === 0 || wanted.includes(entry.node.toLowerCase()))
    .map((entry) => ({ node: entry.node, status: entry.status ?? 'unknown' }))
    .sort((a, b) => a.node.localeCompare(b.node));
}

/**
 * Read the failed tasks of one node, inside the configured window.
 *
 * Only three query parameters are sent — `errors`, `limit` and `start` — the
 * ones every Proxmox VE generation accepts. The newer `since` / `until` /
 * `statusfilter` / `source` parameters would be rejected with a 400 by older
 * nodes (the endpoint declares `additionalProperties => 0`), so the time
 * window and the status scope are applied here instead. `errors=1` keeps
 * everything that is not `OK`, which is a superset of both scopes.
 * @param {object} config - Normalized configuration.
 * @param {string} node - Node name.
 * @returns {Promise<object[]>} The failed tasks, most recent first.
 */
export async function fetchFailedTasks(config, node) {
  const data = await get(config, `/nodes/${encodeURIComponent(node)}/tasks`, {
    errors: 1,
    limit: MAX_TASKS_FETCHED,
    start: 0,
  });
  if (!Array.isArray(data)) {
    throw new ProxmoxError('parse', `Proxmox returned an unexpected task list for node ${node}.`);
  }

  const since = Math.floor(Date.now() / 1000) - config.lookback_hours * 3600;
  const failing = failingStatusTypes(config.failure_scope);
  const types = splitList(config.task_type_filter).map((type) => type.toLowerCase());

  const tasks = data
    .filter((task) => Number.isFinite(Number(task?.starttime)))
    .map((task) => ({
      upid: String(task.upid ?? ''),
      node: String(task.node ?? node),
      type: String(task.type ?? 'unknown'),
      id: task.id === undefined || task.id === null ? '' : String(task.id),
      user: String(task.user ?? ''),
      starttime: Number(task.starttime),
      endtime: Number.isFinite(Number(task.endtime)) ? Number(task.endtime) : null,
      status: task.status === undefined || task.status === null ? '' : String(task.status),
      statusType: normalizeStatusType(task.status),
    }))
    .filter((task) => task.starttime >= since)
    .filter((task) => failing.has(task.statusType))
    .filter((task) => types.length === 0 || types.includes(task.type.toLowerCase()))
    .sort((a, b) => b.starttime - a.starttime);

  logger.debug(
    `Node ${node}: ${tasks.length} failed task(s) in the last ${config.lookback_hours} h`,
  );

  if (data.length >= MAX_TASKS_FETCHED) {
    logger.warn(
      `Node ${node}: Proxmox returned the full page of ${MAX_TASKS_FETCHED} failed tasks — ` +
        'older failures inside the window may be missing. Shorten the observation window.',
    );
  }

  return tasks;
}

/**
 * Check whether the token really has `Sys.Audit` on `/nodes/{node}`.
 *
 * `GET /nodes/{node}/status` is the cheap, explicitly permission-checked twin
 * of the task list (`check => ['perm', '/nodes/{node}', ['Sys.Audit']]`): it
 * answers 403 when the privilege is missing, where the task list would just
 * hand back a silently filtered result. Read-only, and it touches nothing the
 * integration does not already need.
 * @param {object} config - Normalized configuration.
 * @param {string} node - Node name.
 * @returns {Promise<{node: string, granted: boolean, reason?: string}>} The probe result.
 */
export async function probeNodeAudit(config, node) {
  try {
    await get(config, `/nodes/${encodeURIComponent(node)}/status`);
    return { node, granted: true };
  } catch (error) {
    if (error instanceof ProxmoxError && error.kind === 'permission') {
      return { node, granted: false, reason: 'missing Sys.Audit on /nodes/' + node };
    }
    return { node, granted: false, reason: error.message };
  }
}
