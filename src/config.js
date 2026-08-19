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
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in
// the `config_schema` of the manifest (a unit test pins that).
export const DEFAULT_CONFIG = {
  host: '',
  port: 8006,
  token_id: '',
  token_secret: '',
  tls_fingerprint: '',
  tls_verify: true,
  nodes_filter: '',
  lookback_hours: 24,
  failure_scope: 'errors', // 'errors' | 'errors_and_warnings'
  task_type_filter: '',
  max_failures_listed: 5,
  timezone: '',
  poll_frequency: 300,
};

// Bounds mirrored from the manifest, applied here too: the form enforces them
// on the way in, this keeps a hand-edited value from producing a nonsensical
// request (a 0 s poll frequency, a 10 000 h window...).
const BOUNDS = {
  port: [1, 65535],
  lookback_hours: [1, 720],
  max_failures_listed: [1, 20],
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
 * Merge the user configuration with the defaults and force the types.
 * @param {Record<string, unknown>} raw - Configuration returned by the SDK.
 * @returns {Record<string, unknown>} The normalized configuration.
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    host: String(raw.host ?? DEFAULT_CONFIG.host).trim(),
    port: normalizeNumber(raw.port, 'port'),
    token_id: String(raw.token_id ?? DEFAULT_CONFIG.token_id).trim(),
    token_secret: String(raw.token_secret ?? DEFAULT_CONFIG.token_secret).trim(),
    tls_fingerprint: String(raw.tls_fingerprint ?? DEFAULT_CONFIG.tls_fingerprint).trim(),
    // Only an explicit false turns the verification off: an absent value must
    // never silently downgrade the TLS check.
    tls_verify: raw.tls_verify !== false,
    nodes_filter: String(raw.nodes_filter ?? DEFAULT_CONFIG.nodes_filter).trim(),
    lookback_hours: normalizeNumber(raw.lookback_hours, 'lookback_hours'),
    failure_scope: raw.failure_scope === 'errors_and_warnings' ? 'errors_and_warnings' : 'errors',
    task_type_filter: String(raw.task_type_filter ?? DEFAULT_CONFIG.task_type_filter).trim(),
    max_failures_listed: normalizeNumber(raw.max_failures_listed, 'max_failures_listed'),
    timezone: String(raw.timezone ?? DEFAULT_CONFIG.timezone).trim(),
    poll_frequency: normalizeNumber(raw.poll_frequency, 'poll_frequency'),
  };
}

/**
 * Is the configuration complete enough to talk to Proxmox?
 * The three credentials fields are the only mandatory ones; everything else
 * has a usable default.
 * @param {Record<string, unknown>} config - A normalized configuration.
 * @returns {boolean} True when host, token id and token secret are all filled in.
 */
export function isConfigured(config) {
  return Boolean(config.host && config.token_id && config.token_secret);
}
