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
//   - Backup status    : ON when that backup succeeded, OFF for any other
//                        state (binary sensor).
//
// The two numeric features are simply left unknown — no state published at all
// — when the node has no backup in the window: a duration of 0 s and an OFF
// status would both be lies.
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
import { formatBackupSummary, formatLastBackup, resolveTimezone } from '../format.js';

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
 * The node name is the platform id: it is unique inside a cluster and stable
 * across restarts, which is exactly what an external id must be.
 * @param {object} gladys - The SDK instance.
 * @param {string} node - Proxmox node name.
 * @returns {object} `{ device, feature(key) }`.
 */
export function nodeExternalIds(gladys, node) {
  return gladys.externalIds(DEVICE_TYPE, node);
}

/**
 * Build the discovery payload of one node.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {string} node - Proxmox node name.
 * @returns {object} The device, in the standard Gladys format.
 */
export function buildNodeDevice(gladys, config, node) {
  const ids = nodeExternalIds(gladys, node);
  return {
    name: `Proxmox ${node}`,
    external_id: ids.device,
    // Gladys calls onPoll at this interval (seconds).
    poll_frequency: config.poll_frequency,
    features: [
      {
        name: 'Last backup',
        external_id: ids.feature(FEATURE.LAST_BACKUP),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        // Text states live in `last_value_string`: Gladys keeps no history for
        // them, so asking for one would be a lie.
        keep_history: false,
      },
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
      {
        name: 'Backup status',
        external_id: ids.feature(FEATURE.BACKUP_STATUS),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

/**
 * Read the last backup of one node and publish its features.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {string} node - Proxmox node name.
 * @returns {Promise<object|null>} The last backup, or null when there is none.
 */
export async function pollNode(gladys, config, node) {
  const ids = nodeExternalIds(gladys, node);
  const timezone = resolveTimezone(config.timezone);
  const backup = await fetchLastBackup(config, node);

  // The text feature always gets a state: "unknown" is an answer too, and it is
  // the one the user needs when a backup job silently stopped running.
  const states = [
    {
      device_feature_external_id: ids.feature(FEATURE.LAST_BACKUP),
      text: formatLastBackup(backup, timezone),
    },
  ];

  if (backup) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.BACKUP_STATUS),
      state: backup.success ? 1 : 0,
    });
    if (backup.duration !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.BACKUP_DURATION),
        state: Math.min(backup.duration, MAX_BACKUP_DURATION_SECONDS),
      });
    }
  }

  logger.info(
    `Last backup in the last ${config.backup_lookback_days} day(s) — ` +
      formatBackupSummary(node, backup, timezone),
  );

  // One request for every feature of the device (batch, up to 100 states): a
  // numeric state uses `state`, a text state uses `text`.
  await gladys.publishStates(states);

  return backup;
}
