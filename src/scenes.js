// -----------------------------------------------------------------------------
// Scene actions: what a Gladys scene can ask this integration for.
//
// All four READ — this integration is read-only by construction, a scene can
// no more start a VM than the Configuration screen can:
//   - `refresh`           : read every Proxmox now, publish the states, and
//                           hand the scene a few counts to test (backups
//                           failed, guests running...);
//   - `get_backup_status` : the last backup of ONE node, as values the next
//                           actions of the scene can use (send a message...);
//   - `get_smart_status`  : the SMART verdict and the disks of ONE node — its
//                           own action, so the backup one stays about backups;
//   - `get_guest_status`  : the state of ONE VM/LXC, the same way.
//
// The node or the guest is picked in the scene editor among this integration's
// devices (`source: "devices"`), so the handler receives a device external id
// and maps it back to a server and a node or a guest, exactly like a poll. A
// device of the wrong kind — a VM picked for a backup — fails that action only,
// with a message saying so: the scene logs it and carries on.
//
// The outputs are scalars under the keys the manifest declares. A value that
// does not exist (no duration for a backup with no end time) is left out rather
// than faked: same rule as the device features.
// -----------------------------------------------------------------------------

import { describeDevice, pollAllDevices } from './devices/index.js';
import { readNode } from './devices/proxmoxNode.js';
import { fetchGuest } from './proxmox/guests.js';
import { serverById } from './servers.js';
import {
  formatBackupStatus,
  formatGuestStatus,
  formatLastBackup,
  formatSmartStatus,
  resolveTimezone,
} from './format.js';

/**
 * Map the device picked in the scene editor back to what it stands for.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {string} externalId - The device external id chosen by the scene author.
 * @param {string} kind - The kind expected: 'node' or 'guest'.
 * @returns {{server: object, descriptor: object}} The server and the descriptor.
 */
function resolveDevice(gladys, config, externalId, kind) {
  const descriptor = describeDevice(gladys, { external_id: externalId });
  if (!descriptor) {
    throw new Error(`${externalId ?? 'No device'} is not a Proxmox device.`);
  }
  if (descriptor.kind !== kind) {
    throw new Error(
      kind === 'node'
        ? `${externalId} is a VM/LXC: pick a Proxmox node.`
        : `${externalId} is a Proxmox node: pick a VM/LXC.`,
    );
  }
  const server = serverById(config, descriptor.serverId);
  if (!server) {
    throw new Error(`${externalId} belongs to a Proxmox server that is not configured any more.`);
  }
  return { server, descriptor };
}

/**
 * `get_backup_status`: the last backup of one node.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {{device: string}} fields - The resolved fields of the action.
 * @returns {Promise<object>} The declared outputs.
 */
export async function getBackupStatus(gladys, config, fields) {
  const { server, descriptor } = resolveDevice(gladys, config, fields?.device, 'node');
  const { backup } = await readNode(gladys, server, descriptor.node);
  const outputs = {
    node: descriptor.node,
    has_backup: backup !== null,
    success: backup?.success === true,
    status: formatBackupStatus(backup),
    last_backup: formatLastBackup(backup, resolveTimezone(server.timezone), server.date_format),
  };
  if (backup && backup.duration !== null) {
    outputs.duration_seconds = backup.duration;
  }
  return outputs;
}

/**
 * `get_smart_status`: the SMART verdict of the disks of one node.
 *
 * A disk with no verdict is counted apart (`unknown_disks`), never as failed —
 * same rule as the "SMART status" feature.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {{device: string}} fields - The resolved fields of the action.
 * @returns {Promise<object>} The declared outputs.
 */
export async function getSmartStatus(gladys, config, fields) {
  const { server, descriptor } = resolveDevice(gladys, config, fields?.device, 'node');
  const { disks } = await readNode(gladys, server, descriptor.node);
  if (!disks) {
    throw new Error('Disk monitoring is off in the settings of the Proxmox integration.');
  }
  const outputs = {
    node: descriptor.node,
    status: formatSmartStatus(disks),
    disk_count: disks.length,
    failed_disks: disks.filter((disk) => disk.healthy === false).length,
    unknown_disks: disks.filter((disk) => disk.healthy === null).length,
  };
  const temperatures = disks
    .map((disk) => disk.temperature)
    .filter((temperature) => Number.isFinite(temperature));
  // No temperature read (SMART only, or drives that report none): no output,
  // rather than a 0 °C that would read like a measurement.
  if (temperatures.length > 0) {
    outputs.max_temperature = Math.max(...temperatures);
  }
  return outputs;
}

/**
 * `get_guest_status`: the state of one VM/LXC.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {{device: string}} fields - The resolved fields of the action.
 * @returns {Promise<object>} The declared outputs.
 */
export async function getGuestStatus(gladys, config, fields) {
  const { server, descriptor } = resolveDevice(gladys, config, fields?.device, 'guest');
  const guest = await fetchGuest(server, descriptor.key);
  if (!guest) {
    // Gone, or no longer visible to the token: say it, never guess `stopped`.
    return { status: formatGuestStatus(null), running: false };
  }
  return {
    status: formatGuestStatus(guest),
    running: guest.running,
    name: guest.name,
    node: guest.node,
  };
}

/**
 * `refresh`: read every configured Proxmox now, and count what came back.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<object>} The declared outputs.
 */
export async function refreshForScene(gladys, config) {
  const results = await pollAllDevices(gladys, config);
  const nodes = results.filter((result) => result.kind === 'node' && !result.error);
  const guests = results.filter((result) => result.kind === 'guest' && !result.error);
  const readGuests = guests.filter((result) => result.guest);
  return {
    backups_ok: nodes.filter((result) => result.backup?.success === true).length,
    backups_failed: nodes.filter((result) => result.backup && !result.backup.success).length,
    backups_unknown: nodes.filter((result) => !result.backup).length,
    guests_running: readGuests.filter((result) => result.guest.running).length,
    guests_not_running: readGuests.filter((result) => !result.guest.running).length,
    errors: results.filter((result) => result.error).length,
  };
}
