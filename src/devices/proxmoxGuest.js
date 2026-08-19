// -----------------------------------------------------------------------------
// Device type: PROXMOX GUEST (a QEMU virtual machine or an LXC container)
//
// One Gladys device per guest, carrying a single read-only feature:
//   - Status : ON when the guest state is `running`, OFF for any other state
//              (stopped, paused, suspended, unknown...).
//
// The platform id is the guest kind plus its VMID (`qemu-101`, `lxc-200`), not
// the node it runs on: a VMID is unique cluster-wide and survives a migration,
// a node name does not.
//
// The device is never controllable: this integration only reads Proxmox — it
// never starts, stops nor migrates a guest.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { fetchGuest } from '../proxmox/guests.js';
import { scopeId } from '../servers.js';
import { devicePollFrequency } from '../poll.js';

export const DEVICE_TYPE = 'proxmox-guest';

const logger = createLogger({ name: DEVICE_TYPE });

export const FEATURE = {
  STATUS: 'status',
};

/**
 * External ids of the Gladys device representing one guest.
 *
 * A VMID is unique inside ONE cluster: with a second Proxmox configured, the
 * key is scoped to the server it was read from. The first server's ids stay
 * unscoped, so an installation that only ever had one server keeps its devices.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the guest belongs to.
 * @param {string} key - The guest key (`qemu-101`, `lxc-200`).
 * @returns {object} `{ device, feature(key) }`.
 */
export function guestExternalIds(gladys, server, key) {
  return gladys.externalIds(DEVICE_TYPE, scopeId(server.id, key));
}

/**
 * The name shown in Gladys: the server label, the Proxmox guest name, and its
 * VMID so two guests that share a name stay distinguishable.
 * @param {object} server - The server the guest belongs to.
 * @param {object} guest - A normalized guest.
 * @returns {string} e.g. "Proxmox nextcloud (101)".
 */
export function guestDeviceName(server, guest) {
  const label = guest.name.length > 0 ? guest.name : guest.kind.toUpperCase();
  return `${server.label} ${label} (${guest.vmid})`;
}

/**
 * Build the discovery payload of one guest.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the guest belongs to.
 * @param {object} guest - A normalized guest.
 * @returns {object} The device, in the standard Gladys format.
 */
export function buildGuestDevice(gladys, server, guest) {
  const ids = guestExternalIds(gladys, server, guest.key);
  return {
    name: guestDeviceName(server, guest),
    external_id: ids.device,
    // One of the frequencies Gladys accepts (milliseconds); the configured
    // interval is enforced by `claimPoll()`. See `src/poll.js`.
    poll_frequency: devicePollFrequency(server.poll_frequency),
    features: [
      {
        name: 'Status',
        external_id: ids.feature(FEATURE.STATUS),
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
 * Read the state of one guest and publish it.
 *
 * A guest that has disappeared (deleted, or no longer visible to the token)
 * publishes nothing: its last known state stays on screen rather than being
 * turned into a fake OFF.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the guest belongs to.
 * @param {string} key - The guest key (`qemu-101`, `lxc-200`).
 * @returns {Promise<object|null>} The guest, or null when it is gone.
 */
export async function pollGuest(gladys, server, key) {
  const guest = await fetchGuest(server, key);
  if (!guest) {
    logger.warn(
      `${server.label}: guest ${key} is not visible to the token any more: nothing published.`,
    );
    return null;
  }

  logger.debug(`${server.label}: guest ${key} (${guest.node}): ${guest.status}`);

  await gladys.publishStates([
    {
      device_feature_external_id: guestExternalIds(gladys, server, key).feature(FEATURE.STATUS),
      state: guest.running ? 1 : 0,
    },
  ]);

  return guest;
}
