// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values are filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches them
// (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module only holds the defaults and normalizes the received object, so
// the rest of the code never deals with `undefined` nor with a number that
// arrived as a string from the form.
//
// The form is flat, and a second Proxmox is declared as a second block of the
// same fields carrying the `_2` suffix. Normalization is written once and
// applied to every block; turning those blocks back into a list of servers is
// `src/servers.js`'s job.
// -----------------------------------------------------------------------------

// Suffix carried by each server's fields, in server-id order (the first server
// carries none: its keys are the ones that existed before there was a second).
export const SERVER_FIELD_SUFFIXES = ['', '_2'];

// The per-server fields, with their default value.
const SERVER_DEFAULTS = {
  label: '',
  host: '',
  port: 8006,
  token_id: '',
  token_secret: '',
  tls_fingerprint: '',
  tls_verify: true,
  nodes_filter: '',
};

// The settings shared by every server: they describe what is read and how it is
// rendered, not who is being read.
const SHARED_DEFAULTS = {
  backup_lookback_days: 7,
  backup_success_scope: 'ok_only', // 'ok_only' | 'ok_and_warnings'
  timezone: '',
  poll_frequency: 300,
};

/**
 * Spread one default map over every server block.
 * @param {Record<string, unknown>} defaults - The per-server defaults.
 * @returns {Record<string, unknown>} The suffixed entries of every block.
 */
function perServerDefaults(defaults) {
  const entries = {};
  for (const suffix of SERVER_FIELD_SUFFIXES) {
    for (const [key, value] of Object.entries(defaults)) {
      entries[`${key}${suffix}`] = value;
    }
  }
  return entries;
}

// Defaults: they MUST stay consistent with the `default` values declared in
// the `config_schema` of the manifest (a unit test pins that).
export const DEFAULT_CONFIG = {
  ...perServerDefaults(SERVER_DEFAULTS),
  ...SHARED_DEFAULTS,
};

// Bounds mirrored from the manifest, applied here too: the form enforces them
// on the way in, this keeps a hand-edited value from producing a nonsensical
// request (a 0 s poll frequency, a 10 000 day window...).
const BOUNDS = {
  ...perServerDefaults({ port: [1, 65535] }),
  backup_lookback_days: [1, 365],
  poll_frequency: [60, 3600],
};

/**
 * Clamp a numeric config value, falling back to the default when the value is
 * missing or not a number.
 * @param {unknown} value - Raw value coming from the form.
 * @param {string} key - Config key, used to read the default and the bounds.
 * @returns {number} A finite number inside the declared bounds.
 */
function normalizeNumber(value, key) {
  const parsed = Number(value);
  const fallback = DEFAULT_CONFIG[key];
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const [min, max] = BOUNDS[key];
  return Math.min(Math.max(Math.round(parsed), min), max);
}

/**
 * Trim a string config value, falling back to its default.
 * @param {Record<string, unknown>} raw - The raw configuration.
 * @param {string} key - Config key.
 * @returns {string} The trimmed value.
 */
function normalizeString(raw, key) {
  return String(raw[key] ?? DEFAULT_CONFIG[key]).trim();
}

/**
 * Split a comma-separated field into a list of trimmed, non-empty entries.
 * @param {unknown} value - Raw field value.
 * @returns {string[]} The entries, empty when the field is left blank.
 */
export function splitList(value) {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Normalize the fields of one server block.
 * @param {Record<string, unknown>} raw - Configuration returned by the SDK.
 * @param {string} suffix - The block suffix ('' or '_2').
 * @returns {Record<string, unknown>} The normalized entries of that block.
 */
function normalizeServerFields(raw, suffix) {
  const key = (name) => `${name}${suffix}`;
  return {
    [key('label')]: normalizeString(raw, key('label')),
    [key('host')]: normalizeString(raw, key('host')),
    [key('port')]: normalizeNumber(raw[key('port')], key('port')),
    [key('token_id')]: normalizeString(raw, key('token_id')),
    [key('token_secret')]: normalizeString(raw, key('token_secret')),
    [key('tls_fingerprint')]: normalizeString(raw, key('tls_fingerprint')),
    // Only an explicit false turns the verification off: an absent value must
    // never silently downgrade the TLS check.
    [key('tls_verify')]: raw[key('tls_verify')] !== false,
    [key('nodes_filter')]: normalizeString(raw, key('nodes_filter')),
  };
}

/**
 * Merge the user configuration with the defaults and force the types.
 * @param {Record<string, unknown>} raw - Configuration returned by the SDK.
 * @returns {Record<string, unknown>} The normalized configuration.
 */
export function normalizeConfig(raw = {}) {
  const servers = SERVER_FIELD_SUFFIXES.map((suffix) => normalizeServerFields(raw, suffix));
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    ...Object.assign({}, ...servers),
    backup_lookback_days: normalizeNumber(raw.backup_lookback_days, 'backup_lookback_days'),
    backup_success_scope:
      raw.backup_success_scope === 'ok_and_warnings' ? 'ok_and_warnings' : 'ok_only',
    timezone: normalizeString(raw, 'timezone'),
    poll_frequency: normalizeNumber(raw.poll_frequency, 'poll_frequency'),
  };
}

/**
 * Is this server complete enough to talk to Proxmox?
 * The three credentials fields are the only mandatory ones; everything else
 * has a usable default.
 * @param {Record<string, unknown>} server - A normalized server (or the
 *   configuration itself, for the first one).
 * @returns {boolean} True when host, token id and token secret are all filled in.
 */
export function isConfigured(server) {
  return Boolean(server.host && server.token_id && server.token_secret);
}
