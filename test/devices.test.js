import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { normalizeConfig } from '../src/config.js';
import { buildNodeDevice, FEATURE, nodeExternalIds } from '../src/devices/proxmoxNode.js';
import { nodeNameFromDevice } from '../src/devices/index.js';

const config = normalizeConfig({ lookback_hours: 12, poll_frequency: 600 });

test('a node device carries the two read-only features', () => {
  const gladys = createFakeGladys();
  const device = buildNodeDevice(gladys, config, 'pve1');

  assert.equal(device.name, 'Proxmox pve1');
  assert.equal(device.external_id, 'ext:proxmox:proxmox-node:pve1');
  assert.equal(device.poll_frequency, 600);
  assert.equal(device.features.length, 2);

  const [count, details] = device.features;

  assert.equal(count.name, 'Failed tasks (12 h)');
  assert.equal(count.external_id, `ext:proxmox:proxmox-node:pve1:${FEATURE.FAILED_TASK_COUNT}`);
  assert.equal(count.category, DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR);
  assert.equal(count.type, DEVICE_FEATURE_TYPES.SENSOR.INTEGER);
  assert.equal(count.read_only, true);
  assert.equal(count.keep_history, true);

  assert.equal(details.external_id, `ext:proxmox:proxmox-node:pve1:${FEATURE.FAILURE_DETAILS}`);
  assert.equal(details.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(details.type, DEVICE_FEATURE_TYPES.TEXT.TEXT);
  assert.equal(details.read_only, true);
  // Text states are stored as `last_value_string`, which Gladys keeps no
  // history for: asking for one would be a lie.
  assert.equal(details.keep_history, false);
});

test('no feature of the integration is controllable', () => {
  const gladys = createFakeGladys();
  const device = buildNodeDevice(gladys, config, 'pve1');
  for (const feature of device.features) {
    assert.equal(feature.read_only, true, `${feature.external_id} must be read-only`);
    assert.equal(feature.has_feedback, false);
  }
});

test('external ids are unique per node and stable', () => {
  const gladys = createFakeGladys();
  assert.notEqual(nodeExternalIds(gladys, 'pve1').device, nodeExternalIds(gladys, 'pve2').device);
  assert.equal(nodeExternalIds(gladys, 'pve1').device, nodeExternalIds(gladys, 'pve1').device);
});

test('nodeNameFromDevice recovers the node from an external id, without a discovery', () => {
  const gladys = createFakeGladys();
  assert.equal(
    nodeNameFromDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:pve1' }),
    'pve1',
  );
  // A node name containing the separator still round-trips: the prefix is
  // stripped, the remainder is the name.
  assert.equal(
    nodeNameFromDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:pve-a:b' }),
    'pve-a:b',
  );
});

test('nodeNameFromDevice ignores a device that is not ours', () => {
  const gladys = createFakeGladys();
  assert.equal(nodeNameFromDevice(gladys, { external_id: 'ext:other:light:1' }), null);
  assert.equal(nodeNameFromDevice(gladys, {}), null);
  assert.equal(nodeNameFromDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:' }), null);
});
