import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { normalizeConfig } from '../src/config.js';
import { buildNodeDevice, FEATURE, nodeExternalIds } from '../src/devices/proxmoxNode.js';
import {
  buildGuestDevice,
  FEATURE as GUEST_FEATURE,
  guestDeviceName,
} from '../src/devices/proxmoxGuest.js';
import { describeDevice } from '../src/devices/index.js';

const config = normalizeConfig({ backup_lookback_days: 12, poll_frequency: 600 });

const GUEST = {
  key: 'qemu-101',
  kind: 'qemu',
  vmid: 101,
  node: 'pve1',
  name: 'nextcloud',
  status: 'running',
  running: true,
};

test('a node device carries the three read-only backup features', () => {
  const gladys = createFakeGladys();
  const device = buildNodeDevice(gladys, config, 'pve1');

  assert.equal(device.name, 'Proxmox pve1');
  assert.equal(device.external_id, 'ext:proxmox:proxmox-node:pve1');
  assert.equal(device.poll_frequency, 600);
  assert.equal(device.features.length, 3);

  const [lastBackup, duration, status] = device.features;

  assert.equal(lastBackup.name, 'Last backup');
  assert.equal(lastBackup.external_id, `ext:proxmox:proxmox-node:pve1:${FEATURE.LAST_BACKUP}`);
  assert.equal(lastBackup.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(lastBackup.type, DEVICE_FEATURE_TYPES.TEXT.TEXT);
  // Text states are stored as `last_value_string`, which Gladys keeps no
  // history for: asking for one would be a lie.
  assert.equal(lastBackup.keep_history, false);

  assert.equal(duration.name, 'Backup duration');
  assert.equal(duration.external_id, `ext:proxmox:proxmox-node:pve1:${FEATURE.BACKUP_DURATION}`);
  assert.equal(duration.category, DEVICE_FEATURE_CATEGORIES.DURATION);
  assert.equal(duration.type, DEVICE_FEATURE_TYPES.DURATION.INTEGER);
  assert.equal(duration.unit, DEVICE_FEATURE_UNITS.SECONDS);
  assert.equal(duration.min, 0);
  assert.equal(duration.keep_history, true);

  assert.equal(status.name, 'Backup status');
  assert.equal(status.external_id, `ext:proxmox:proxmox-node:pve1:${FEATURE.BACKUP_STATUS}`);
  assert.equal(status.category, DEVICE_FEATURE_CATEGORIES.SWITCH);
  assert.equal(status.type, DEVICE_FEATURE_TYPES.SWITCH.BINARY);
  assert.equal(status.min, 0);
  assert.equal(status.max, 1);
  assert.equal(status.keep_history, true);
});

test('a guest device carries a single binary status feature', () => {
  const gladys = createFakeGladys();
  const device = buildGuestDevice(gladys, config, GUEST);

  assert.equal(device.name, 'Proxmox nextcloud (101)');
  assert.equal(device.external_id, 'ext:proxmox:proxmox-guest:qemu-101');
  assert.equal(device.poll_frequency, 600);
  assert.equal(device.features.length, 1);

  const [status] = device.features;
  assert.equal(status.name, 'Status');
  assert.equal(status.external_id, `ext:proxmox:proxmox-guest:qemu-101:${GUEST_FEATURE.STATUS}`);
  assert.equal(status.category, DEVICE_FEATURE_CATEGORIES.SWITCH);
  assert.equal(status.type, DEVICE_FEATURE_TYPES.SWITCH.BINARY);
  assert.equal(status.min, 0);
  assert.equal(status.max, 1);
});

test('a guest with no name still gets a distinguishable device name', () => {
  assert.equal(
    guestDeviceName({ ...GUEST, name: '', kind: 'lxc', vmid: 200 }),
    'Proxmox LXC (200)',
  );
});

test('no feature of the integration is controllable', () => {
  const gladys = createFakeGladys();
  const devices = [
    buildNodeDevice(gladys, config, 'pve1'),
    buildGuestDevice(gladys, config, GUEST),
  ];
  for (const device of devices) {
    for (const feature of device.features) {
      assert.equal(feature.read_only, true, `${feature.external_id} must be read-only`);
      assert.equal(feature.has_feedback, false);
    }
  }
});

test('external ids are unique per node and stable', () => {
  const gladys = createFakeGladys();
  assert.notEqual(nodeExternalIds(gladys, 'pve1').device, nodeExternalIds(gladys, 'pve2').device);
  assert.equal(nodeExternalIds(gladys, 'pve1').device, nodeExternalIds(gladys, 'pve1').device);
});

test('describeDevice recovers a node from its external id, without a discovery', () => {
  const gladys = createFakeGladys();
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:pve1' }), {
    kind: 'node',
    node: 'pve1',
  });
  // A node name containing the separator still round-trips: the prefix is
  // stripped, the remainder is the name.
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:pve-a:b' }), {
    kind: 'node',
    node: 'pve-a:b',
  });
});

test('describeDevice recovers a guest from its external id', () => {
  const gladys = createFakeGladys();
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-guest:qemu-101' }), {
    kind: 'guest',
    key: 'qemu-101',
  });
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-guest:lxc-200' }), {
    kind: 'guest',
    key: 'lxc-200',
  });
});

test('describeDevice ignores a device that is not ours', () => {
  const gladys = createFakeGladys();
  assert.equal(describeDevice(gladys, { external_id: 'ext:other:light:1' }), null);
  assert.equal(describeDevice(gladys, {}), null);
  assert.equal(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:' }), null);
  assert.equal(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-guest:vm-101' }), null);
});
