// -----------------------------------------------------------------------------
// Rendering of the values shown on the dashboard.
//
// Proxmox stores task timestamps as UNIX epoch seconds (UTC). What the user
// wants to read is their own wall clock, so every timestamp goes through
// `Intl.DateTimeFormat` with an explicit IANA time zone: the one configured in
// the integration, or the container's own zone when the field is left empty.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'format' });

// What a text feature holds when there is nothing to report: no backup in the
// window, a guest Proxmox describes with no state at all. Deliberately the same
// word the Gladys interface uses for a feature that has never received a state.
export const UNKNOWN_TEXT = 'unknown';

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
 * Render the "Last backup" text of a node: when the last backup STARTED, in the
 * user's time zone, with that zone named so the wall clock is unambiguous.
 * @param {object|null} backup - The last backup, or null when there is none.
 * @param {string} timezone - A resolved IANA time zone.
 * @returns {string} e.g. "2026-08-19 02:00:00 (Europe/Paris)", or "unknown".
 */
export function formatLastBackup(backup, timezone) {
  if (!backup || !Number.isFinite(backup.starttime)) {
    return UNKNOWN_TEXT;
  }
  return `${formatTimestamp(backup.starttime, timezone)} (${timezone})`;
}

/**
 * Render the "Backup status" text of a node: the verdict, and the reason when
 * the backup did not go through.
 *
 * Text rather than an on/off state, because Proxmox answers with a sentence and
 * the sentence is what the user needs: "failed — no space left on device" is
 * actionable where "off" only sends them to the Proxmox task log. The verdict
 * still follows the configured success scope (`backup.success`), so a
 * `WARNINGS: n` run reads as a success or as a failure depending on what the
 * user declared a successful backup to be.
 * @param {object|null} backup - The last backup, or null when there is none.
 * @returns {string} "OK", "failed — <reason>", or "unknown".
 */
export function formatBackupStatus(backup) {
  if (!backup) {
    return UNKNOWN_TEXT;
  }
  if (backup.success) {
    return 'OK';
  }
  return `failed — ${formatStatus(backup.status, backup.statusType)}`;
}

/**
 * Render the "Status" text of a guest: the state word Proxmox reports.
 *
 * `running`, `stopped`, `paused`, `suspended`... — all of them are published as
 * they come, so a paused VM does not read like a stopped one.
 * @param {object|null} guest - A normalized guest, or null when it is gone.
 * @returns {string} The Proxmox state, or "unknown".
 */
export function formatGuestStatus(guest) {
  const status = String(guest?.status ?? '').trim();
  return status.length > 0 ? status : UNKNOWN_TEXT;
}

/**
 * One-line summary of a node's backup state, for the logs and the action
 * messages.
 * @param {string} node - Node name.
 * @param {object|null} backup - The last backup, or null when there is none.
 * @param {string} timezone - A resolved IANA time zone.
 * @returns {string} e.g. "pve1: 2026-08-19 02:00:00, 4 min 8 s, OK".
 */
export function formatBackupSummary(node, backup, timezone) {
  if (!backup) {
    return `${node}: no backup`;
  }
  const parts = [formatTimestamp(backup.starttime, timezone)];
  const duration = formatDuration(backup.duration);
  if (duration) {
    parts.push(duration);
  }
  parts.push(formatStatus(backup.status, backup.statusType));
  return `${node}: ${parts.join(', ')}`;
}
