// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike the static registry of the official template, the device list here is
// DISCOVERED: there is one Gladys device per Proxmox node, and the nodes are
// only known once `GET /nodes` has answered. This module owns that list and
// the mapping back from a Gladys `external_id` to a Proxmox node name, which
// is what routes `onPoll` to the right node.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { listNodes } from '../proxmox/tasks.js';
import { buildNodeDevice, DEVICE_TYPE, nodeExternalIds, pollNode } from './proxmoxNode.js';

const logger = createLogger({ name: 'devices' });

// external_id -> node name, refreshed on every discovery.
const knownNodes = new Map();

/**
 * Prefix shared by every device external id of this integration
 * (`ext:<selector>:proxmox-node:`), used to recover a node name from a device
 * Gladys hands back after a restart, before any discovery ran.
 * @param {object} gladys - The SDK instance.
 * @returns {string} The prefix.
 */
function devicePrefix(gladys) {
  return nodeExternalIds(gladys, '').device;
}

/**
 * Recover the Proxmox node name a Gladys device stands for.
 * @param {object} gladys - The SDK instance.
 * @param {object} device - The device Gladys sent.
 * @returns {string|null} The node name, or null when the id is not ours.
 */
export function nodeNameFromDevice(gladys, device) {
  const externalId = device?.external_id;
  if (typeof externalId !== 'string') {
    return null;
  }
  const cached = knownNodes.get(externalId);
  if (cached) {
    return cached;
  }
  const prefix = devicePrefix(gladys);
  if (!externalId.startsWith(prefix)) {
    return null;
  }
  const node = externalId.slice(prefix.length);
  return node.length > 0 ? node : null;
}

/**
 * Discover the monitored Proxmox nodes and build their discovery payloads.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<object[]>} One device per node.
 */
export async function buildDiscoveredDevices(gladys, config) {
  const nodes = await listNodes(config);
  knownNodes.clear();
  for (const { node } of nodes) {
    knownNodes.set(nodeExternalIds(gladys, node).device, node);
  }
  logger.info(`Discovered ${nodes.length} Proxmox node(s): ${nodes.map((n) => n.node).join(', ')}`);
  return nodes.map(({ node }) => buildNodeDevice(gladys, config, node));
}

/**
 * The node names discovered so far, in discovery order.
 * @returns {string[]} The node names.
 */
export function monitoredNodes() {
  return [...knownNodes.values()];
}

/**
 * Poll one Gladys device (i.e. one Proxmox node).
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {object} device - The device Gladys asked to refresh.
 * @returns {Promise<void>} Resolves once the states are published.
 */
export async function pollDevice(gladys, config, device) {
  const node = nodeNameFromDevice(gladys, device);
  if (!node) {
    logger.warn(`onPoll ignored: unknown device ${device?.external_id}`);
    return;
  }
  await pollNode(gladys, config, node);
}

/**
 * Poll every known node, one after the other.
 *
 * Failures are collected instead of aborting the loop: one unreachable node
 * must not stop the others from being refreshed.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{node: string, failedTasks?: number, error?: string}[]>} One result per node.
 */
export async function pollAllNodes(gladys, config) {
  const results = [];
  for (const node of monitoredNodes()) {
    try {
      const failedTasks = await pollNode(gladys, config, node);
      results.push({ node, failedTasks });
    } catch (error) {
      logger.error(`Polling node ${node} failed`, error);
      results.push({ node, error: error.message });
    }
  }
  return results;
}

export { DEVICE_TYPE };
