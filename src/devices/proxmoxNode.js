// -----------------------------------------------------------------------------
// Device type: PROXMOX NODE
//
// One Gladys device per Proxmox node, carrying two read-only features:
//   - failed task count   : how many tasks failed inside the observation
//                           window (integer sensor, kept in history so the
//                           dashboard can chart it);
//   - failure details     : the recent failures, one block each — task type,
//                           start and end timestamps in the user's time zone,
//                           and the status Proxmox recorded (text feature;
//                           text states are stored as `last_value_string` and
//                           carry no history, hence `keep_history: false`).
//
// The device is never controllable: this integration only reads Proxmox.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { fetchFailedTasks } from '../proxmox/tasks.js';
import { formatFailureDetails } from '../format.js';

export const DEVICE_TYPE = 'proxmox-node';

const logger = createLogger({ name: DEVICE_TYPE });

export const FEATURE = {
  FAILED_TASK_COUNT: 'failed-task-count',
  FAILURE_DETAILS: 'failure-details',
};

// A node with more failures than this in one window is a broken node, not a
// measurement: the ceiling only exists because a feature must declare one.
const MAX_FAILED_TASKS = 1000;

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
        name: `Failed tasks (${config.lookback_hours} h)`,
        external_id: ids.feature(FEATURE.FAILED_TASK_COUNT),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: MAX_FAILED_TASKS,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Recent failure details',
        external_id: ids.feature(FEATURE.FAILURE_DETAILS),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        // Text states live in `last_value_string`: Gladys keeps no history for
        // them, so asking for one would be a lie.
        keep_history: false,
      },
    ],
  };
}

/**
 * Read the Proxmox task log of one node and publish both features.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {string} node - Proxmox node name.
 * @returns {Promise<number>} The number of failed tasks found.
 */
export async function pollNode(gladys, config, node) {
  const ids = nodeExternalIds(gladys, node);
  const tasks = await fetchFailedTasks(config, node);
  const details = formatFailureDetails({ node, tasks, config });

  logger.info(
    `Node ${node}: ${tasks.length} failed task(s) in the last ${config.lookback_hours} h`,
  );

  // Both features in a single request (batch, up to 100 states): a numeric
  // state uses `state`, a text state uses `text`.
  await gladys.publishStates([
    { device_feature_external_id: ids.feature(FEATURE.FAILED_TASK_COUNT), state: tasks.length },
    { device_feature_external_id: ids.feature(FEATURE.FAILURE_DETAILS), text: details },
  ]);

  return tasks.length;
}
