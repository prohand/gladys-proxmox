// -----------------------------------------------------------------------------
// The Proxmox servers this integration talks to.
//
// Gladys renders a FLAT configuration form (`config_schema` has no repeatable
// group), so a second Proxmox is declared as a second block of fields carrying
// the `_2` suffix. This module is what turns that flat form back into a list of
// servers, so nothing above it ever deals with the suffix.
//
// A server object is deliberately CONFIG-SHAPED: it carries the per-server
// fields (host, port, token, TLS posture, node filter) merged with the settings
// shared by both servers (backup window, time zone, refresh interval). Every
// function of `src/proxmox/` therefore keeps taking one object and needs to
// know nothing about there being several of them.
//
// Identity: the first server is id 1, the second id 2. That id is what scopes a
// Gladys external id — and the first server's ids are left UNSCOPED on purpose,
// so an installation that predates the second server keeps its devices instead
// of rediscovering them all under new ids.
// -----------------------------------------------------------------------------

import { isConfigured, SERVER_FIELD_SUFFIXES } from './config.js';

export const PRIMARY_SERVER_ID = 1;
export const SECONDARY_SERVER_ID = 2;

// The declared server ids, in form order: one per block of fields declared in
// the configuration (id 1 owns the unsuffixed block, id 2 the `_2` one).
export const SERVER_IDS = SERVER_FIELD_SUFFIXES.map((_, index) => index + 1);

// Shown in front of every device name, and in the action messages. The first
// server's default is the historical prefix: renaming nothing by accident.
const DEFAULT_LABEL_BY_ID = {
  [PRIMARY_SERVER_ID]: 'Proxmox',
  [SECONDARY_SERVER_ID]: 'Proxmox 2',
};

// Fields that belong to one server.
const SERVER_KEYS = [
  'label',
  'host',
  'port',
  'token_id',
  'token_secret',
  'tls_fingerprint',
  'tls_verify',
  'nodes_filter',
];

// Fields configured once and applied to every server: they describe what is
// read and how it is rendered, not who is being read.
const SHARED_KEYS = [
  'backup_lookback_days',
  'backup_success_scope',
  'timezone',
  'date_format',
  'disks_monitoring',
  'poll_frequency',
];

/**
 * The suffix the fields of one server carry in the flat configuration.
 * @param {number} id - Server id.
 * @returns {string} The suffix ('' for the first server).
 */
function suffixOf(id) {
  return SERVER_FIELD_SUFFIXES[id - 1] ?? '';
}

/**
 * The configuration keys of one server, in the flat form.
 * @param {number} id - Server id.
 * @returns {string[]} The keys, e.g. `['label_2', 'host_2', ...]`.
 */
export function serverConfigKeys(id) {
  return SERVER_KEYS.map((key) => `${key}${suffixOf(id)}`);
}

/**
 * Build one server object out of the flat configuration.
 * @param {object} config - Normalized configuration.
 * @param {number} id - Server id.
 * @returns {object} A config-shaped object describing that server.
 */
export function buildServer(config, id) {
  const suffix = suffixOf(id);
  const server = { id };
  for (const key of SERVER_KEYS) {
    server[key] = config[`${key}${suffix}`];
  }
  for (const key of SHARED_KEYS) {
    server[key] = config[key];
  }
  if (!server.label) {
    server.label = DEFAULT_LABEL_BY_ID[id] ?? `Proxmox ${id}`;
  }
  return server;
}

/**
 * The servers the user actually filled in, in form order.
 *
 * A server exists as soon as its host and both token fields are set: leaving
 * the second block empty is how you say "I only have one Proxmox".
 * @param {object} config - Normalized configuration.
 * @returns {object[]} The configured servers.
 */
export function listServers(config) {
  return SERVER_IDS.map((id) => buildServer(config, id)).filter((server) => isConfigured(server));
}

/**
 * One configured server, by its id.
 * @param {object} config - Normalized configuration.
 * @param {number} id - Server id.
 * @returns {object|null} The server, or null when it is not configured.
 */
export function serverById(config, id) {
  return listServers(config).find((server) => server.id === id) ?? null;
}

/**
 * Is at least one Proxmox configured?
 * @param {object} config - Normalized configuration.
 * @returns {boolean} True when the integration has something to talk to.
 */
export function hasConfiguredServer(config) {
  return listServers(config).length > 0;
}

/**
 * Scope a platform id (a node name, a guest key) to the server it belongs to.
 *
 * The first server's ids stay untouched: they are the ids already stored by
 * every installation that only ever had one Proxmox.
 * @param {number} serverId - Server id.
 * @param {string} localId - Node name or guest key.
 * @returns {string} e.g. `pve1` on server 1, `2@pve1` on server 2.
 */
export function scopeId(serverId, localId) {
  return serverId === PRIMARY_SERVER_ID ? String(localId) : `${serverId}@${localId}`;
}

/**
 * Split a scoped platform id back into its server and its local part.
 *
 * An id with no scope belongs to the first server. A Proxmox node name is a
 * hostname and a guest key is `<kind>-<vmid>`, so neither can start with
 * digits followed by `@`: the ambiguity is only theoretical. A scope with
 * nothing behind it (`2@`) yields an empty local part, which the caller
 * rejects — it is a truncated id, not a device.
 * @param {string} value - A scoped id, as built by `scopeId()`.
 * @returns {{serverId: number, localId: string}} The parts.
 */
export function parseScopedId(value) {
  const text = String(value ?? '');
  const match = /^([1-9]\d*)@([\s\S]*)$/.exec(text);
  if (match) {
    return { serverId: Number(match[1]), localId: match[2] };
  }
  return { serverId: PRIMARY_SERVER_ID, localId: text };
}
