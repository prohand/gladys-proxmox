// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike the static registry of the official template, the device list here is
// DISCOVERED: one Gladys device per Proxmox node, plus one per QEMU virtual
// machine and LXC container, and none of them is known before `GET /nodes` and
// `GET /cluster/resources` have answered — on EACH configured server. The disks
// of a node are discovered the same way, because each of them becomes one
// temperature feature of its node's device. This module owns that list and the
// mapping back from a Gladys `external_id` to what it stands for (which server,
// and what on it), which is what routes `onPoll` to the right reader.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { listNodes } from '../proxmox/nodes.js';
import { clearGuestsCache, fetchGuests, parseGuestKey } from '../proxmox/guests.js';
import { listDisks, readsDiskTemperature } from '../proxmox/disks.js';
import { listServers, parseScopedId, serverById } from '../servers.js';
import { claimPoll, markPolled, resetPollThrottle } from '../poll.js';
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

// external_id -> { kind: 'node' | 'guest', serverId, node? , key? }, refreshed
// on every discovery.
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
 * Recover what a Gladys device stands for: a Proxmox node, or a guest, on one
 * of the configured servers.
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
    const { serverId, localId } = parseScopedId(externalId.slice(nodePrefix.length));
    return localId.length > 0 ? { kind: 'node', serverId, node: localId } : null;
  }

  const guestPrefix = prefixOf(gladys, GUEST_DEVICE_TYPE);
  if (externalId.startsWith(guestPrefix)) {
    const { serverId, localId } = parseScopedId(externalId.slice(guestPrefix.length));
    const parsed = parseGuestKey(localId);
    return parsed ? { kind: 'guest', serverId, key: `${parsed.kind}-${parsed.vmid}` } : null;
  }

  return null;
}

/**
 * The disks of every node, when the configuration asks for their temperature.
 *
 * One temperature feature is declared PER DISK, so discovery is the moment the
 * disks have to be enumerated. `skipsmart` keeps that enumeration cheap — the
 * health verdict is read at poll time, not here — and a node whose disk list
 * cannot be read simply gets no temperature feature instead of failing the
 * whole discovery of that server: its backup features matter more.
 * @param {object} server - A configured server.
 * @param {{node: string}[]} nodes - The nodes of that server.
 * @returns {Promise<Map<string, object[]>>} The disks, by node name.
 */
async function discoverDisks(server, nodes) {
  const byNode = new Map();
  if (!readsDiskTemperature(server)) {
    return byNode;
  }
  for (const { node } of nodes) {
    try {
      byNode.set(node, await listDisks(server, node, { skipSmart: true }));
    } catch (error) {
      logger.warn(
        `${server.label}: the disks of ${node} could not be listed (${error.message}): ` +
          'no temperature feature for that node.',
      );
      byNode.set(node, []);
    }
  }
  return byNode;
}

/**
 * Discover the nodes and guests of ONE server, and build their payloads.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - A configured server.
 * @returns {Promise<object[]>} One device per node, then one per guest.
 */
async function discoverServer(gladys, server) {
  const nodes = await listNodes(server);
  // A discovery must never answer from a snapshot taken minutes ago.
  const guests = await fetchGuests(server, { force: true });
  const disksByNode = await discoverDisks(server, nodes);

  for (const { node } of nodes) {
    knownDevices.set(nodeExternalIds(gladys, server, node).device, {
      kind: 'node',
      serverId: server.id,
      node,
    });
  }
  for (const guest of guests) {
    knownDevices.set(guestExternalIds(gladys, server, guest.key).device, {
      kind: 'guest',
      serverId: server.id,
      key: guest.key,
    });
  }

  logger.info(
    `${server.label}: discovered ${nodes.length} Proxmox node(s): ` +
      `${nodes.map((entry) => entry.node).join(', ')} — and ${guests.length} guest(s): ` +
      guests.map((guest) => guest.key).join(', '),
  );
  for (const [node, disks] of disksByNode) {
    logger.info(
      `${server.label}: ${disks.length} disk(s) on ${node}: ` +
        disks.map((disk) => disk.devpath).join(', '),
    );
  }

  return [
    ...nodes.map(({ node }) => buildNodeDevice(gladys, server, node, disksByNode.get(node) ?? [])),
    ...guests.map((guest) => buildGuestDevice(gladys, server, guest)),
  ];
}

/**
 * Discover every monitored node and guest, on every configured server.
 *
 * One unreachable server must not hide the other: its failure is collected and
 * reported instead of aborting the whole discovery.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{devices: object[], failures: {server: object, error: Error}[]}>} What
 *   was discovered, and what failed.
 */
export async function discoverDevices(gladys, config) {
  knownDevices.clear();
  // A discovery is a fresh start: whatever the previous interval had already
  // consumed must not delay the first read of the devices published here.
  resetPollThrottle();

  const devices = [];
  const failures = [];
  for (const server of listServers(config)) {
    try {
      devices.push(...(await discoverServer(gladys, server)));
    } catch (error) {
      logger.error(`Discovery failed on ${server.label} (${server.host})`, error);
      failures.push({ server, error });
    }
  }
  return { devices, failures };
}

/**
 * The devices discovered so far, in discovery order.
 * @param {string} kind - 'node' or 'guest'.
 * @param {number} [serverId] - Restrict to one server.
 * @returns {object[]} The matching descriptors.
 */
function monitored(kind, serverId) {
  return [...knownDevices.values()].filter(
    (entry) => entry.kind === kind && (serverId === undefined || entry.serverId === serverId),
  );
}

/**
 * The node names discovered so far, in discovery order.
 * @param {number} [serverId] - Restrict to one server.
 * @returns {string[]} The node names.
 */
export function monitoredNodes(serverId) {
  return monitored('node', serverId).map((entry) => entry.node);
}

/**
 * The guest keys discovered so far, in discovery order.
 * @param {number} [serverId] - Restrict to one server.
 * @returns {string[]} The guest keys (`qemu-101`, `lxc-200`...).
 */
export function monitoredGuests(serverId) {
  return monitored('guest', serverId).map((entry) => entry.key);
}

/**
 * Poll one Gladys device: a Proxmox node, or a guest.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {object} device - The device Gladys asked to refresh.
 * @param {object} [options] - Reading options.
 * @param {boolean} [options.force] - Read now, whatever the interval says
 *   (a device the user has just added has no state at all yet).
 * @returns {Promise<void>} Resolves once the states are published.
 */
export async function pollDevice(gladys, config, device, { force = false } = {}) {
  const descriptor = describeDevice(gladys, device);
  if (!descriptor) {
    logger.warn(`onPoll ignored: unknown device ${device?.external_id}`);
    return;
  }
  const server = serverById(config, descriptor.serverId);
  if (!server) {
    // The device outlived the server it was discovered on: the user emptied
    // that block of the configuration. Publishing nothing keeps its last known
    // state instead of inventing one.
    logger.warn(
      `onPoll ignored: ${device?.external_id} belongs to Proxmox #${descriptor.serverId}, ` +
        'which is not configured any more.',
    );
    return;
  }
  // Gladys polls at the slowest frequency it accepts (once a minute, see
  // `src/poll.js`); the configured refresh interval is enforced here. A poll
  // that arrives too early publishes nothing at all, which leaves the last
  // known state on screen — it does not overwrite it with anything.
  if (force) {
    // The read happens whatever the interval says, but it still counts as one:
    // the next scheduled poll is measured from here.
    markPolled(device.external_id);
  } else if (!claimPoll(device.external_id, server.poll_frequency)) {
    logger.debug(
      `onPoll skipped: ${device.external_id} was refreshed less than ` +
        `${server.poll_frequency}s ago.`,
    );
    return;
  }

  if (descriptor.kind === 'node') {
    await pollNode(gladys, server, descriptor.node);
    return;
  }
  await pollGuest(gladys, server, descriptor.key);
}

/**
 * Poll every known device of every configured server, one after the other.
 *
 * Failures are collected instead of aborting the loop: one unreachable node —
 * or one unreachable server — must not stop the others from being refreshed.
 * The servers are walked one at a time so the guest snapshot of each is read
 * once, not once per guest.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<object[]>} One result per device.
 */
export async function pollAllDevices(gladys, config) {
  // An explicit refresh must read Proxmox, not the last snapshot.
  clearGuestsCache();

  const results = [];
  for (const server of listServers(config)) {
    for (const node of monitoredNodes(server.id)) {
      try {
        // An explicit refresh counts as a read: the next scheduled poll is
        // measured from here, not from the previous tick.
        markPolled(nodeExternalIds(gladys, server, node).device);
        results.push({ kind: 'node', server, node, backup: await pollNode(gladys, server, node) });
      } catch (error) {
        logger.error(`Polling node ${node} of ${server.label} failed`, error);
        results.push({ kind: 'node', server, node, error: error.message });
      }
    }
    for (const key of monitoredGuests(server.id)) {
      try {
        markPolled(guestExternalIds(gladys, server, key).device);
        results.push({ kind: 'guest', server, key, guest: await pollGuest(gladys, server, key) });
      } catch (error) {
        logger.error(`Polling guest ${key} of ${server.label} failed`, error);
        results.push({ kind: 'guest', server, key, error: error.message });
      }
    }
  }
  return results;
}

export { NODE_DEVICE_TYPE, GUEST_DEVICE_TYPE };
