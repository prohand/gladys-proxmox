// -----------------------------------------------------------------------------
// Proxmox backups: finding the last one of a node, and deciding whether it
// succeeded.
//
// A Proxmox VE backup is a `vzdump` task, so the source of truth is the task
// log of the node:
//
//   GET /api2/json/nodes/{node}/tasks    -> the finished tasks of one node
//
// Only FINISHED tasks are returned by that endpoint by default (Proxmox's
// archived list), which is exactly what "the last backup" means here: a backup
// still running has neither a duration nor an outcome yet.
//
// `typefilter` is asked for when the node understands it, and the whole page is
// filtered here when it does not: the parameter only exists on recent Proxmox
// VE generations, and the endpoint declares `additionalProperties => 0`, so an
// older node answers 400 instead of ignoring it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { get, ProxmoxError } from './client.js';

const logger = createLogger({ name: 'proxmox-backups' });

// The Proxmox task type of a backup.
export const BACKUP_TASK_TYPE = 'vzdump';

// How many tasks are asked for. The server-side `typefilter` makes the first
// ceiling a ceiling on BACKUP tasks; without it the page holds every task type,
// so a larger one is needed to still reach a backup on a busy node.
const MAX_TASKS_FETCHED = 200;
const MAX_TASKS_FETCHED_UNFILTERED = 500;

// Hosts+nodes that answered 400 to `typefilter`, so the fallback is taken
// directly on the next poll instead of paying for a doomed request every time.
const noTypeFilter = new Set();

/**
 * Forget which nodes rejected `typefilter` (a reconfiguration, or a test that
 * must not inherit the previous one).
 * @returns {void}
 */
export function resetTypeFilterSupport() {
  noTypeFilter.clear();
}

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
 * Which status types count as a successful backup, for the configured scope.
 *
 * `unknown` is never a success: on the archived (finished) task list it means
 * the task left no exit status behind — a crashed worker, not a backup.
 * @param {string} successScope - 'ok_only' or 'ok_and_warnings'.
 * @returns {Set<string>} The status types that mean "the backup went through".
 */
export function successStatusTypes(successScope) {
  return successScope === 'ok_and_warnings' ? new Set(['ok', 'warning']) : new Set(['ok']);
}

/**
 * Read a page of backup tasks of one node, asking the server to filter by task
 * type when it can, and falling back to a wider page otherwise.
 * @param {object} config - Normalized configuration.
 * @param {string} node - Node name.
 * @returns {Promise<unknown>} The raw `data` member of the answer.
 */
async function fetchTaskPage(config, node) {
  const path = `/nodes/${encodeURIComponent(node)}/tasks`;
  const fallback = () => get(config, path, { limit: MAX_TASKS_FETCHED_UNFILTERED, start: 0 });
  // Keyed by host too: two Proxmox installations can hold nodes of the same
  // name on different generations.
  const key = `${config.host}:${config.port}/${node}`;

  if (noTypeFilter.has(key)) {
    return fallback();
  }
  try {
    return await get(config, path, {
      typefilter: BACKUP_TASK_TYPE,
      limit: MAX_TASKS_FETCHED,
      start: 0,
    });
  } catch (error) {
    // 400 = this Proxmox generation does not know `typefilter`. Every other
    // failure (auth, TLS, network...) is the caller's to report.
    if (error instanceof ProxmoxError && error.kind === 'http' && error.status === 400) {
      logger.debug(`Node ${node}: no server-side typefilter, filtering the task page here.`);
      noTypeFilter.add(key);
      return fallback();
    }
    throw error;
  }
}

/**
 * Read the backup tasks of one node, inside the configured window.
 * @param {object} config - Normalized configuration.
 * @param {string} node - Node name.
 * @returns {Promise<object[]>} The backups, most recent first.
 */
export async function fetchBackupTasks(config, node) {
  const data = await fetchTaskPage(config, node);
  if (!Array.isArray(data)) {
    throw new ProxmoxError('parse', `Proxmox returned an unexpected task list for node ${node}.`);
  }

  const since = Math.floor(Date.now() / 1000) - config.backup_lookback_days * 86400;
  const success = successStatusTypes(config.backup_success_scope);

  const backups = data
    .filter((task) => String(task?.type ?? '').toLowerCase() === BACKUP_TASK_TYPE)
    .filter((task) => Number.isFinite(Number(task?.starttime)))
    .map((task) => {
      const starttime = Number(task.starttime);
      const endtime = Number.isFinite(Number(task.endtime)) ? Number(task.endtime) : null;
      const statusType = normalizeStatusType(task.status);
      return {
        upid: String(task.upid ?? ''),
        node: String(task.node ?? node),
        type: String(task.type ?? BACKUP_TASK_TYPE),
        id: task.id === undefined || task.id === null ? '' : String(task.id),
        user: String(task.user ?? ''),
        starttime,
        endtime,
        // A task with no end time never reported one: its duration is unknown,
        // which is not the same as zero.
        duration: endtime === null ? null : Math.max(0, endtime - starttime),
        status: task.status === undefined || task.status === null ? '' : String(task.status),
        statusType,
        success: success.has(statusType),
      };
    })
    .filter((task) => task.starttime >= since)
    .sort((a, b) => b.starttime - a.starttime);

  logger.debug(
    `Node ${node}: ${backups.length} backup(s) in the last ${config.backup_lookback_days} day(s)`,
  );

  if (backups.length === 0 && data.length >= MAX_TASKS_FETCHED) {
    // The page Proxmox returned is full and holds no backup: an older one may
    // sit just beyond it, out of reach without paging the whole log.
    logger.warn(
      `Node ${node}: Proxmox returned a full task page with no backup in it — a backup older ` +
        'than that page cannot be seen.',
    );
  }

  return backups;
}

/**
 * The last backup of one node, or null when the window holds none.
 * @param {object} config - Normalized configuration.
 * @param {string} node - Node name.
 * @returns {Promise<object|null>} The most recent backup task, or null.
 */
export async function fetchLastBackup(config, node) {
  const backups = await fetchBackupTasks(config, node);
  return backups.length > 0 ? backups[0] : null;
}
