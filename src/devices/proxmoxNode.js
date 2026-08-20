// -----------------------------------------------------------------------------
// Device type: PROXMOX NODE
//
// One Gladys device per Proxmox node. Three read-only features describe the
// LAST BACKUP (`vzdump` task) of that node:
//   - Last backup      : when it started, in the user's time zone and in the
//                        configured date format (text feature; text states are
//                        stored as `last_value_string` and carry no history,
//                        hence `keep_history: false`). Holds "unknown" when the
//                        window contains no backup at all;
//   - Backup duration  : how long it ran, in seconds (integer sensor, kept in
//                        history so the dashboard can chart it);
//   - Backup status    : the verdict and, when it failed, what Proxmox said —
//                        "OK", "failed — WARNINGS: 2", "failed — no space left
//                        on device" (text feature).
//
// Two more describe the PHYSICAL DISKS of the node, when disk monitoring is on:
//   - SMART status         : the health verdict of every disk, and the name of
//                            the ones that are not healthy (text feature);
//   - Disk <name> temperature : one temperature sensor per disk found at
//                            discovery, in °C, kept in history.
//
// The statuses are text rather than on/off switches on purpose: Proxmox answers
// with a sentence, and the sentence is the actionable part. A binary feature
// could only say "not on", leaving the user to open the Proxmox task log to
// learn that the datastore was full — and it rendered as a switch, an actuator
// shape for something this integration never controls. The configured success
// scope still decides the backup verdict, so a `WARNINGS: n` run reads "OK" or
// "failed — WARNINGS: n" as the user asked.
//
// Backup duration and the temperatures are the features left unknown — no state
// published at all — when there is nothing to report: a numeric feature cannot
// say "unknown", and a duration of 0 s or a disk at 0 °C would be a lie. The
// text features say it in words instead.
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
import {
  diskId,
  fetchDisksHealth,
  MAX_DISK_TEMPERATURE,
  MIN_DISK_TEMPERATURE,
  readsDisks,
  readsDiskTemperature,
} from '../proxmox/disks.js';
import { devicePollFrequency } from '../poll.js';
import { scopeId } from '../servers.js';
import {
  formatBackupStatus,
  formatBackupSummary,
  formatLastBackup,
  formatSmartStatus,
  resolveTimezone,
} from '../format.js';
import { textFeature } from './features.js';

export const DEVICE_TYPE = 'proxmox-node';

const logger = createLogger({ name: DEVICE_TYPE });

export const FEATURE = {
  LAST_BACKUP: 'last-backup',
  BACKUP_DURATION: 'backup-duration',
  BACKUP_STATUS: 'backup-status',
  SMART_STATUS: 'smart-status',
};

// Prefix of the per-disk temperature features: one feature per disk, so the id
// carries the disk it belongs to (`disk-temperature-sda`).
export const DISK_TEMPERATURE_FEATURE_PREFIX = 'disk-temperature-';

// A backup running for more than a week is a stuck task, not a measurement: the
// ceiling only exists because a numeric feature must declare one.
const MAX_BACKUP_DURATION_SECONDS = 7 * 86400;

/**
 * The feature key holding the temperature of one disk.
 * @param {string} devpath - The disk device path, e.g. `/dev/sda`.
 * @returns {string} e.g. `disk-temperature-sda`.
 */
export function diskTemperatureFeature(devpath) {
  return `${DISK_TEMPERATURE_FEATURE_PREFIX}${diskId(devpath)}`;
}

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
 * Build the temperature feature of one disk.
 * @param {object} ids - The external ids of the node device.
 * @param {object} disk - A disk, as returned by `listDisks()`.
 * @returns {object} The feature, in the standard Gladys format.
 */
function diskTemperatureFeatureOf(ids, disk) {
  return {
    name: `Disk ${disk.id} temperature`,
    external_id: ids.feature(diskTemperatureFeature(disk.devpath)),
    category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    min: MIN_DISK_TEMPERATURE,
    max: MAX_DISK_TEMPERATURE,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

/**
 * Build the discovery payload of one node.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Proxmox node name.
 * @param {object[]} [disks] - The disks discovered on that node, if any.
 * @returns {object} The device, in the standard Gladys format.
 */
export function buildNodeDevice(gladys, server, node, disks = []) {
  const ids = nodeExternalIds(gladys, server, node);
  const features = [
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
  ];

  if (readsDisks(server)) {
    // Declared whether or not the disk list could be read: a node whose disks
    // stay unreadable must say "unknown" somewhere, and this is that place.
    features.push(textFeature('SMART status', ids.feature(FEATURE.SMART_STATUS)));
  }
  if (readsDiskTemperature(server)) {
    features.push(...disks.map((disk) => diskTemperatureFeatureOf(ids, disk)));
  }

  return {
    // The server label prefixes every device name: with two Proxmox servers
    // configured, two nodes called `pve` must not both show up as "Proxmox pve".
    name: `${server.label} ${node}`,
    external_id: ids.device,
    // Gladys only accepts a fixed set of frequencies, in milliseconds, the
    // slowest being one minute: the configured interval is enforced by
    // `claimPoll()` instead. See `src/poll.js`.
    poll_frequency: devicePollFrequency(server.poll_frequency),
    features,
  };
}

/**
 * Read the disks of a node without ever failing the poll over it.
 *
 * The backup features are what this integration exists for; the disks are read
 * alongside them, so a node whose SMART data cannot be read (an
 * under-privileged token, a controller smartctl knows nothing about) reports
 * "unknown" on its SMART status instead of losing its backup states too.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Proxmox node name.
 * @returns {Promise<object[]|null>} The disks, or null when the feature is off.
 */
async function readDisks(server, node) {
  if (!readsDisks(server)) {
    return null;
  }
  try {
    return await fetchDisksHealth(server, node);
  } catch (error) {
    logger.warn(`${server.label}: the disks of ${node} could not be read: ${error.message}`);
    return [];
  }
}

/**
 * Publish the temperature of every disk that reported one.
 *
 * Its own publish, and a best-effort one: the features are those DISCOVERED on
 * that node, so a disk plugged in since then has no feature to publish to and
 * would take the whole batch down with it — including the SMART status, which
 * has already been published with the backup states by then.
 * @param {object} gladys - The SDK instance.
 * @param {object} ids - The external ids of the node device.
 * @param {object[]} disks - The disks, as returned by `fetchDisksHealth()`.
 * @returns {Promise<void>} Resolves once the states are published.
 */
async function publishDiskTemperatures(gladys, ids, disks) {
  const states = disks
    .filter((disk) => Number.isFinite(disk.temperature))
    .map((disk) => ({
      device_feature_external_id: ids.feature(diskTemperatureFeature(disk.devpath)),
      state: disk.temperature,
    }));
  if (states.length === 0) {
    return;
  }
  await gladys.publishStates(states);
}

/**
 * Read the last backup of one node — and its disks — and publish its features.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Proxmox node name.
 * @returns {Promise<object|null>} The last backup, or null when there is none.
 */
export async function pollNode(gladys, server, node) {
  const ids = nodeExternalIds(gladys, server, node);
  const timezone = resolveTimezone(server.timezone);
  const backup = await fetchLastBackup(server, node);
  const disks = await readDisks(server, node);

  // The text features always get a state: "unknown" is an answer too, and it is
  // the one the user needs when a backup job silently stopped running — where
  // publishing nothing would leave last week's "OK" on screen forever.
  const states = [
    {
      device_feature_external_id: ids.feature(FEATURE.LAST_BACKUP),
      text: formatLastBackup(backup, timezone, server.date_format),
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

  if (disks) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.SMART_STATUS),
      text: formatSmartStatus(disks),
    });
  }

  logger.info(
    `${server.label}: last backup in the last ${server.backup_lookback_days} day(s) — ` +
      formatBackupSummary(node, backup, timezone, server.date_format),
  );
  if (disks) {
    logger.debug(`${server.label}: disks of ${node} — ${formatSmartStatus(disks)}`);
  }

  // One request for every feature of the device (batch, up to 100 states): a
  // numeric state uses `state`, a text state uses `text`.
  await gladys.publishStates(states);

  if (disks && disks.length > 0) {
    try {
      await publishDiskTemperatures(gladys, ids, disks);
    } catch (error) {
      logger.warn(
        `${server.label}: the disk temperatures of ${node} could not be published: ` +
          `${error.message}. Re-run a scan if you added a disk.`,
      );
    }
  }

  return backup;
}
