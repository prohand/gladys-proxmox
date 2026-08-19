// -----------------------------------------------------------------------------
// Device type: PROXMOX NODE
//
// One Gladys device per Proxmox node, carrying three read-only features that
// all describe the LAST BACKUP (`vzdump` task) of that node:
//   - Last backup      : when it started, in the user's time zone (text
//                        feature; text states are stored as
//                        `last_value_string` and carry no history, hence
//                        `keep_history: false`). Holds "unknown" when the
//                        window contains no backup at all;
//   - Backup duration  : how long it ran, in seconds (integer sensor, kept in
//                        history so the dashboard can chart it);
//   - Backup status    : the verdict and, when it failed, what Proxmox said —
//                        "OK", "failed — WARNINGS: 2", "failed — no space left
//                        on device" (text feature).
//
// The status is text rather than an on/off switch on purpose: Proxmox answers
// with a sentence, and the sentence is the actionable part. A binary feature
// could only say "not on", leaving the user to open the Proxmox task log to
// learn that the datastore was full — and it rendered as a switch, an actuator
// shape for something this integration never controls. The configured success
// scope still decides the verdict, so a `WARNINGS: n` run reads "OK" or
// "failed — WARNINGS: n" as the user asked.
//
// Backup duration is the one feature left unknown — no state published at all —
// when the node has no backup in the window: a numeric feature cannot say
// "unknown", and a duration of 0 s would be a lie. The two text features say it
// in words instead.
//
// The device is never controllable: this integration only reads Proxmox.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchLastBackup } from '../proxmox/backups.js';
import { devicePollFrequency } from '../poll.js';
import { scopeId } from '../servers.js';
import {
  formatBackupStatus,
  formatBackupSummary,
  formatLastBackup,
  resolveTimezone,
} from '../format.js';
import { textFeature } from './features.js';

export const DEVICE_TYPE = 'proxmox-node';

const logger = createLogger({ name: DEVICE_TYPE });

export const FEATURE = {
  LAST_BACKUP: 'last-backup',
  BACKUP_DURATION: 'backup-duration',
  BACKUP_STATUS: 'backup-status',
};

// A backup running for more than a week is a stuck task, not a measurement: the
// ceiling only exists because a numeric feature must declare one.
const MAX_BACKUP_DURATION_SECONDS = 7 * 86400;

/**
 * External ids of the Gladys device representing a Proxmox node.
 *
 * The platform id is the node name, scoped to the server it belongs to: a name
 * is unique inside one cluster and stable across restarts, but two configured
 * Proxmox servers can perfectly well both hold a node called `pve`. The first
 * server's ids stay unscoped, so nothing is renamed under an installation that
 * only ever had one server.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Proxmox node name.
 * @returns {object} `{ device, feature(key) }`.
 */
export function nodeExternalIds(gladys, server, node) {
  return gladys.externalIds(DEVICE_TYPE, scopeId(server.id, node));
}

/**
 * Build the discovery payload of one node.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Proxmox node name.
 * @returns {object} The device, in the standard Gladys format.
 */
export function buildNodeDevice(gladys, server, node) {
  const ids = nodeExternalIds(gladys, server, node);
  return {
    // The server label prefixes every device name: with two Proxmox servers
    // configured, two nodes called `pve` must not both show up as "Proxmox pve".
    name: `${server.label} ${node}`,
    external_id: ids.device,
    // Gladys only accepts a fixed set of frequencies, in milliseconds, the
    // slowest being one minute: the configured interval is enforced by
    // `claimPoll()` instead. See `src/poll.js`.
    poll_frequency: devicePollFrequency(server.poll_frequency),
    features: [
      textFeature('Last backup', ids.feature(FEATURE.LAST_BACKUP)),
      {
        name: 'Backup duration',
        external_id: ids.feature(FEATURE.BACKUP_DURATION),
        category: DEVICE_FEATURE_CATEGORIES.DURATION,
        type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        unit: DEVICE_FEATURE_UNITS.SECONDS,
        min: 0,
        max: MAX_BACKUP_DURATION_SECONDS,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      textFeature('Backup status', ids.feature(FEATURE.BACKUP_STATUS)),
    ],
  };
}

/**
 * Read the last backup of one node and publish its features.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Proxmox node name.
 * @returns {Promise<object|null>} The last backup, or null when there is none.
 */
export async function pollNode(gladys, server, node) {
  const ids = nodeExternalIds(gladys, server, node);
  const timezone = resolveTimezone(server.timezone);
  const backup = await fetchLastBackup(server, node);

  // The two text features always get a state: "unknown" is an answer too, and
  // it is the one the user needs when a backup job silently stopped running —
  // where publishing nothing would leave last week's "OK" on screen forever.
  const states = [
    {
      device_feature_external_id: ids.feature(FEATURE.LAST_BACKUP),
      text: formatLastBackup(backup, timezone),
    },
    {
      device_feature_external_id: ids.feature(FEATURE.BACKUP_STATUS),
      text: formatBackupStatus(backup),
    },
  ];

  // A task with no end time reported no duration: unknown, which is not zero.
  if (backup && backup.duration !== null) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.BACKUP_DURATION),
      state: Math.min(backup.duration, MAX_BACKUP_DURATION_SECONDS),
    });
  }

  logger.info(
    `${server.label}: last backup in the last ${server.backup_lookback_days} day(s) — ` +
      formatBackupSummary(node, backup, timezone),
  );

  // One request for every feature of the device (batch, up to 100 states): a
  // numeric state uses `state`, a text state uses `text`.
  await gladys.publishStates(states);

  return backup;
}
