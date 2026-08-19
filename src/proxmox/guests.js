// -----------------------------------------------------------------------------
// The guests of the cluster: the QEMU virtual machines and the LXC containers.
//
// One read-only endpoint answers for all of them at once:
//
//   GET /api2/json/cluster/resources?type=vm
//
// It works on a standalone node as well as on a cluster, it reports the node a
// guest currently runs on (so a migration is followed without reconfiguring
// anything), and it is permission-FILTERED: a token only sees the guests it has
// `VM.Audit` on. A token without that privilege therefore gets an empty list
// rather than a 403 — which is why "Test the connection" says how many guests
// are visible instead of just "OK".
//
// The answer is cached for a few seconds, PER SERVER: Gladys polls every guest
// device separately, and one poll round of a 40-guest cluster must not become
// 40 identical HTTP requests — nor must a poll round alternating between two
// configured Proxmox servers evict the entry it is about to need again.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { get, ProxmoxError } from './client.js';
import { isMonitoredNode } from './nodes.js';

const logger = createLogger({ name: 'proxmox-guests' });

// How long one cluster snapshot is reused. Short enough that a guest that
// changes state is seen on the next poll of any device, long enough to collapse
// a poll round into a single request.
export const GUESTS_CACHE_TTL_MS = 15_000;

// The two guest kinds `/cluster/resources` reports for `type=vm`.
const GUEST_KINDS = new Set(['qemu', 'lxc']);

// cacheKey -> { at, promise }. One entry per configured server, so two servers
// polled in the same round each keep their own snapshot.
const cache = new Map();

/**
 * The cache key of a server: a different host, port, token or node filter is a
 * different snapshot. The token is part of it because two servers can point at
 * the same host with tokens that do not see the same guests.
 * @param {object} server - A configured server.
 * @returns {string} The key.
 */
function cacheKey(server) {
  return [
    server.host,
    server.port,
    server.token_id,
    String(server.nodes_filter ?? '').toLowerCase(),
  ].join('|');
}

/**
 * Forget every cached snapshot (configuration change, or a test that must not
 * inherit the previous one).
 * @returns {void}
 */
export function clearGuestsCache() {
  cache.clear();
}

/**
 * Build the stable identifier of a guest: its kind and its VMID.
 *
 * The VMID is unique cluster-wide and survives a migration, where the node does
 * not — so this, and never the node, is what a Gladys external id is built on.
 * @param {string} kind - 'qemu' or 'lxc'.
 * @param {number|string} vmid - The Proxmox VMID.
 * @returns {string} e.g. "qemu-101".
 */
export function guestKey(kind, vmid) {
  return `${kind}-${vmid}`;
}

/**
 * Split a guest key back into its parts.
 * @param {string} key - A key built by `guestKey()`.
 * @returns {{kind: string, vmid: number}|null} The parts, or null when the key is not one of ours.
 */
export function parseGuestKey(key) {
  const match = /^(qemu|lxc)-(\d+)$/.exec(String(key ?? ''));
  return match ? { kind: match[1], vmid: Number(match[2]) } : null;
}

/**
 * Read the guests of the cluster, straight from Proxmox.
 * @param {object} server - A configured server.
 * @returns {Promise<object[]>} The guests, sorted by VMID.
 */
async function readGuests(server) {
  const data = await get(server, '/cluster/resources', { type: 'vm' });
  if (!Array.isArray(data)) {
    throw new ProxmoxError('parse', 'Proxmox returned an unexpected answer for the guest list.');
  }

  return (
    data
      .filter((entry) => GUEST_KINDS.has(String(entry?.type ?? '')))
      .filter((entry) => Number.isFinite(Number(entry?.vmid)))
      // A template is not a running thing: it has no meaningful on/off state.
      .filter((entry) => Number(entry?.template ?? 0) !== 1)
      .filter((entry) => isMonitoredNode(server, entry?.node))
      .map((entry) => {
        const kind = String(entry.type);
        const vmid = Number(entry.vmid);
        const status = String(entry.status ?? 'unknown');
        return {
          key: guestKey(kind, vmid),
          kind,
          vmid,
          node: String(entry.node ?? ''),
          name: String(entry.name ?? '').trim(),
          status,
          running: status === 'running',
        };
      })
      .sort((a, b) => a.vmid - b.vmid)
  );
}

/**
 * The guests of the cluster, from the cache when it is still fresh.
 * @param {object} server - A configured server.
 * @param {object} [options] - Options.
 * @param {boolean} [options.force] - Ignore the cache and re-read from Proxmox.
 * @returns {Promise<object[]>} The guests, sorted by VMID.
 */
export async function fetchGuests(server, { force = false } = {}) {
  const key = cacheKey(server);
  const now = Date.now();

  const cached = cache.get(key);
  if (!force && cached && now - cached.at < GUESTS_CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = readGuests(server);
  cache.set(key, { at: now, promise });
  try {
    const guests = await promise;
    logger.debug(`${server.label ?? server.host}: ${guests.length} guest(s) visible to the token`);
    return guests;
  } catch (error) {
    // A failed read must not be served to the next poll as if it were a
    // snapshot: drop it and let that poll try again.
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
    throw error;
  }
}

/**
 * One guest, by its stable key.
 * @param {object} server - A configured server.
 * @param {string} key - A key built by `guestKey()`.
 * @param {object} [options] - Passed through to `fetchGuests()`.
 * @returns {Promise<object|null>} The guest, or null when it is gone.
 */
export async function fetchGuest(server, key, options) {
  const guests = await fetchGuests(server, options);
  return guests.find((guest) => guest.key === key) ?? null;
}
