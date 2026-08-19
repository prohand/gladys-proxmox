// -----------------------------------------------------------------------------
// Rendering of the "recent failure details" text.
//
// Proxmox stores task timestamps as UNIX epoch seconds (UTC). What the user
// wants to read is their own wall clock, so every timestamp goes through
// `Intl.DateTimeFormat` with an explicit IANA time zone: the one configured in
// the integration, or the container's own zone when the field is left empty.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'format' });

// The text feature is meant to be read at a glance on a dashboard tile: cap it
// so a burst of failures with very long Proxmox error strings cannot turn it
// into a wall of text.
export const MAX_DETAILS_LENGTH = 2000;
// One Proxmox error string can be a whole shell command plus its output.
const MAX_STATUS_LENGTH = 160;

// Warn once per invalid zone instead of on every poll.
const warnedTimezones = new Set();

/**
 * Resolve the IANA time zone to render timestamps in.
 * @param {string} timezone - The configured zone, possibly empty or invalid.
 * @returns {string} A zone `Intl` accepts.
 */
export function resolveTimezone(timezone) {
  const candidate = String(timezone ?? '').trim();
  if (candidate.length === 0) {
    // Honours the TZ environment variable, else the container's zone (UTC).
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    if (!warnedTimezones.has(candidate)) {
      warnedTimezones.add(candidate);
      logger.warn(`Unknown time zone "${candidate}", falling back to the host time zone.`);
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
}

/**
 * Render a Proxmox epoch timestamp in the user's time zone.
 *
 * The parts are assembled by hand rather than taken from a locale pattern:
 * `Intl` is only asked for the numeric fields of the target time zone, which
 * every ICU build provides, so the output is the same `YYYY-MM-DD HH:mm:ss`
 * on any runtime — unambiguous whatever the reader's locale conventions.
 * @param {number|null} epochSeconds - UNIX timestamp in seconds, or null.
 * @param {string} timezone - A resolved IANA time zone.
 * @returns {string} e.g. "2026-08-19 02:04:11", or "—" when unknown.
 */
export function formatTimestamp(epochSeconds, timezone) {
  if (!Number.isFinite(epochSeconds)) {
    return '—';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochSeconds * 1000));

  const field = {};
  for (const part of parts) {
    field[part.type] = part.value;
  }
  return `${field.year}-${field.month}-${field.day} ${field.hour}:${field.minute}:${field.second}`;
}

/**
 * Render a duration in a compact, readable form.
 * @param {number|null} seconds - Duration in seconds.
 * @returns {string} e.g. "4 min 8 s", or an empty string when unknown.
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} h` : `${hours} h ${restMinutes} min`;
}

/**
 * Shorten a Proxmox status string to something a dashboard tile can hold.
 * @param {string} status - The raw `status` field.
 * @param {string} statusType - The normalized type, used when status is empty.
 * @returns {string} The displayable status.
 */
export function formatStatus(status, statusType) {
  const trimmed = String(status ?? '').trim();
  if (trimmed.length === 0) {
    return statusType === 'unknown' ? 'no exit status (worker crashed?)' : 'unknown';
  }
  return trimmed.length > MAX_STATUS_LENGTH
    ? `${trimmed.slice(0, MAX_STATUS_LENGTH - 1)}…`
    : trimmed;
}

/**
 * Build the human-readable label of a task: its Proxmox type, plus the guest
 * or resource it acted on when there is one.
 * @param {object} task - A normalized task.
 * @returns {string} e.g. "vzdump (101)".
 */
export function formatTaskLabel(task) {
  return task.id ? `${task.type} (${task.id})` : task.type;
}

/**
 * Render the "recent failure details" text of one node.
 *
 * One block per failure: the task type, when it started and ended in the
 * user's time zone, how long it ran, and the status Proxmox recorded.
 * @param {object} options - Options.
 * @param {string} options.node - Node name.
 * @param {object[]} options.tasks - Failed tasks, most recent first.
 * @param {object} options.config - Normalized configuration.
 * @returns {string} The details text, capped at MAX_DETAILS_LENGTH characters.
 */
export function formatFailureDetails({ node, tasks, config }) {
  const timezone = resolveTimezone(config.timezone);
  const window = `${config.lookback_hours} h`;

  if (tasks.length === 0) {
    return `No failed task on ${node} in the last ${window}.`;
  }

  const shown = tasks.slice(0, config.max_failures_listed);
  const header =
    tasks.length === 1
      ? `1 failed task on ${node} in the last ${window} (times in ${timezone}):`
      : `${tasks.length} failed tasks on ${node} in the last ${window} (times in ${timezone}):`;

  const blocks = shown.map((task) => {
    const started = formatTimestamp(task.starttime, timezone);
    const ended = formatTimestamp(task.endtime, timezone);
    const duration = task.endtime === null ? '' : formatDuration(task.endtime - task.starttime);
    const timing = duration ? `${started} → ${ended} (${duration})` : `${started} → ${ended}`;
    return [
      `• ${formatTaskLabel(task)}`,
      `  ${timing}`,
      `  status: ${formatStatus(task.status, task.statusType)}`,
    ].join('\n');
  });

  const hidden = tasks.length - shown.length;
  const footer = hidden > 0 ? [`… and ${hidden} more failure(s) in the window.`] : [];

  const text = [header, ...blocks, ...footer].join('\n');
  return text.length > MAX_DETAILS_LENGTH ? `${text.slice(0, MAX_DETAILS_LENGTH - 1)}…` : text;
}
