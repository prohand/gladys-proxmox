// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike the static registry of the official template, the device list here is
// DISCOVERED: one Gladys device per Proxmox node, plus one per QEMU virtual
// machine and LXC container, and none of them is known before `GET /nodes` and
// `GET /cluster/resources` have answered. This module owns that list and the
// mapping back from a Gladys `external_id` to what it stands for, which is what
// routes `onPoll` to the right reader.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { listNodes } from '../proxmox/nodes.js';
import { clearGuestsCache, fetchGuests, parseGuestKey } from '../proxmox/guests.js';
import {
  buildNodeDevice,
  DEVICE_TYPE as NODE_DEVICE_TYPE,
  nodeExternalIds,
  pollNode,
} from './proxmoxNode.js';
import {
  buildGuestDevice,
  DEVICE_TYPE as GUEST_DEVICE_TYPE,
  guestExternalIds,
  pollGuest,
} from './proxmoxGuest.js';

const logger = createLogger({ name: 'devices' });

// external_id -> { kind: 'node' | 'guest', node? , key? }, refreshed on every
// discovery.
const knownDevices = new Map();

/**
 * Prefix shared by every device external id of one device type
 * (`ext:<selector>:<type>:`), used to recover what a device stands for when
 * Gladys hands it back after a restart, before any discovery ran.
 * @param {object} gladys - The SDK instance.
 * @param {string} type - Device type.
 * @returns {string} The prefix.
 */
function prefixOf(gladys, type) {
  return gladys.externalIds(type, '').device;
}

/**
 * Recover what a Gladys device stands for: a Proxmox node, or a guest.
 * @param {object} gladys - The SDK instance.
 * @param {object} device - The device Gladys sent.
 * @returns {object|null} The descriptor, or null when the id is not ours.
 */
export function describeDevice(gladys, device) {
  const externalId = device?.external_id;
  if (typeof externalId !== 'string') {
    return null;
  }
  const cached = knownDevices.get(externalId);
  if (cached) {
    return cached;
  }

  const nodePrefix = prefixOf(gladys, NODE_DEVICE_TYPE);
  if (externalId.startsWith(nodePrefix)) {
    const node = externalId.slice(nodePrefix.length);
    return node.length > 0 ? { kind: 'node', node } : null;
  }

  const guestPrefix = prefixOf(gladys, GUEST_DEVICE_TYPE);
  if (externalId.startsWith(guestPrefix)) {
    const parsed = parseGuestKey(externalId.slice(guestPrefix.length));
    return parsed ? { kind: 'guest', key: `${parsed.kind}-${parsed.vmid}` } : null;
  }

  return null;
}

/**
 * Discover the monitored Proxmox nodes and guests, and build their discovery
 * payloads.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<object[]>} One device per node, then one per guest.
 */
export async function buildDiscoveredDevices(gladys, config) {
  const nodes = await listNodes(config);
  // A discovery must never answer from a snapshot taken minutes ago.
  const guests = await fetchGuests(config, { force: true });

  knownDevices.clear();
  for (const { node } of nodes) {
    knownDevices.set(nodeExternalIds(gladys, node).device, { kind: 'node', node });
  }
  for (const guest of guests) {
    knownDevices.set(guestExternalIds(gladys, guest.key).device, {
      kind: 'guest',
      key: guest.key,
    });
  }

  logger.info(
    `Discovered ${nodes.length} Proxmox node(s): ${nodes.map((entry) => entry.node).join(', ')}` +
      ` — and ${guests.length} guest(s): ${guests.map((guest) => guest.key).join(', ')}`,
  );

  return [
    ...nodes.map(({ node }) => buildNodeDevice(gladys, config, node)),
    ...guests.map((guest) => buildGuestDevice(gladys, config, guest)),
  ];
}

/**
 * The node names discovered so far, in discovery order.
 * @returns {string[]} The node names.
 */
export function monitoredNodes() {
  return [...knownDevices.values()]
    .filter((entry) => entry.kind === 'node')
    .map((entry) => entry.node);
}

/**
 * The guest keys discovered so far, in discovery order.
 * @returns {string[]} The guest keys (`qemu-101`, `lxc-200`...).
 */
export function monitoredGuests() {
  return [...knownDevices.values()]
    .filter((entry) => entry.kind === 'guest')
    .map((entry) => entry.key);
}

/**
 * Poll one Gladys device: a Proxmox node, or a guest.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {object} device - The device Gladys asked to refresh.
 * @returns {Promise<void>} Resolves once the states are published.
 */
export async function pollDevice(gladys, config, device) {
  const descriptor = describeDevice(gladys, device);
  if (!descriptor) {
    logger.warn(`onPoll ignored: unknown device ${device?.external_id}`);
    return;
  }
  if (descriptor.kind === 'node') {
    await pollNode(gladys, config, descriptor.node);
    return;
  }
  await pollGuest(gladys, config, descriptor.key);
}

/**
 * Poll every known device, one after the other.
 *
 * Failures are collected instead of aborting the loop: one unreachable node
 * must not stop the others from being refreshed.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<object[]>} One result per device.
 */
export async function pollAllDevices(gladys, config) {
  // An explicit refresh must read Proxmox, not the last snapshot.
  clearGuestsCache();

  const results = [];
  for (const node of monitoredNodes()) {
    try {
      results.push({ kind: 'node', node, backup: await pollNode(gladys, config, node) });
    } catch (error) {
      logger.error(`Polling node ${node} failed`, error);
      results.push({ kind: 'node', node, error: error.message });
    }
  }
  for (const key of monitoredGuests()) {
    try {
      results.push({ kind: 'guest', key, guest: await pollGuest(gladys, config, key) });
    } catch (error) {
      logger.error(`Polling guest ${key} failed`, error);
      results.push({ kind: 'guest', key, error: error.message });
    }
  }
  return results;
}

export { NODE_DEVICE_TYPE, GUEST_DEVICE_TYPE };
