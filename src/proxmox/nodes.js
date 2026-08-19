// -----------------------------------------------------------------------------
// The cluster nodes, and the read privilege check on them.
//
// Two read-only endpoints:
//   GET /api2/json/nodes                  -> the nodes of the cluster
//   GET /api2/json/nodes/{node}/status    -> used only as a privilege probe
//
// `GET /nodes/{node}/tasks` (read by `backups.js`) is permission-FILTERED by
// Proxmox itself: without `Sys.Audit` on `/nodes/{node}` a token only sees ITS
// OWN tasks — so it answers 200 with an empty list instead of a 403. That
// silent degradation is the reason `probeNodeAudit()` exists: it is what the
// "Test the connection" action uses to tell the user their token is
// under-privileged before they wonder why the backup features stay unknown.
// -----------------------------------------------------------------------------

import { get, ProxmoxError } from './client.js';
import { splitList } from '../config.js';

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
 * Is this node one of those the user asked to monitor?
 * @param {object} config - Normalized configuration.
 * @param {string} node - Node name.
 * @returns {boolean} True when the filter is empty or lists that node.
 */
export function isMonitoredNode(config, node) {
  const wanted = splitList(config.nodes_filter).map((name) => name.toLowerCase());
  return wanted.length === 0 || wanted.includes(String(node ?? '').toLowerCase());
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
