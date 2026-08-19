import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { normalizeConfig } from '../src/config.js';
import { listServers } from '../src/servers.js';
import { buildNodeDevice, FEATURE, nodeExternalIds } from '../src/devices/proxmoxNode.js';
import {
  buildGuestDevice,
  FEATURE as GUEST_FEATURE,
  guestDeviceName,
} from '../src/devices/proxmoxGuest.js';
import { describeDevice } from '../src/devices/index.js';

const CONFIG = normalizeConfig({
  host: 'pve.lan',
  token_id: 'a@pve!b',
  token_secret: 's',
  host_2: 'pve2.lan',
  token_id_2: 'c@pve!d',
  token_secret_2: 's2',
  backup_lookback_days: 12,
  poll_frequency: 600,
});
const [server, secondServer] = listServers(CONFIG);

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
  const device = buildNodeDevice(gladys, server, 'pve1');

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
  const device = buildGuestDevice(gladys, server, GUEST);

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
    guestDeviceName(server, { ...GUEST, name: '', kind: 'lxc', vmid: 200 }),
    'Proxmox LXC (200)',
  );
});

test('the second server names and identifies its devices apart from the first', () => {
  const gladys = createFakeGladys();
  const node = buildNodeDevice(gladys, secondServer, 'pve1');
  const guest = buildGuestDevice(gladys, secondServer, GUEST);

  // Same node name, same VMID, on the other Proxmox: neither the id nor the
  // name may collide with the first server's.
  assert.equal(node.name, 'Proxmox 2 pve1');
  assert.equal(node.external_id, 'ext:proxmox:proxmox-node:2@pve1');
  assert.equal(guest.name, 'Proxmox 2 nextcloud (101)');
  assert.equal(guest.external_id, 'ext:proxmox:proxmox-guest:2@qemu-101');
  assert.notEqual(node.external_id, buildNodeDevice(gladys, server, 'pve1').external_id);
  assert.notEqual(guest.external_id, buildGuestDevice(gladys, server, GUEST).external_id);
});

test('a labelled server prefixes its device names with that label', () => {
  const gladys = createFakeGladys();
  const [home, office] = listServers(
    normalizeConfig({
      host: 'pve.lan',
      token_id: 'a@pve!b',
      token_secret: 's',
      label: 'Home',
      host_2: 'pve2.lan',
      token_id_2: 'c@pve!d',
      token_secret_2: 's2',
      label_2: 'Office',
    }),
  );
  assert.equal(buildNodeDevice(gladys, home, 'pve1').name, 'Home pve1');
  assert.equal(buildGuestDevice(gladys, office, GUEST).name, 'Office nextcloud (101)');
  // The label is cosmetic: it must never leak into an external id, or renaming
  // a server would orphan all of its devices.
  assert.equal(buildNodeDevice(gladys, home, 'pve1').external_id, 'ext:proxmox:proxmox-node:pve1');
});

test('no feature of the integration is controllable', () => {
  const gladys = createFakeGladys();
  const devices = [
    buildNodeDevice(gladys, server, 'pve1'),
    buildGuestDevice(gladys, server, GUEST),
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
  assert.notEqual(
    nodeExternalIds(gladys, server, 'pve1').device,
    nodeExternalIds(gladys, server, 'pve2').device,
  );
  assert.equal(
    nodeExternalIds(gladys, server, 'pve1').device,
    nodeExternalIds(gladys, server, 'pve1').device,
  );
});

test('describeDevice recovers a node from its external id, without a discovery', () => {
  const gladys = createFakeGladys();
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:pve1' }), {
    kind: 'node',
    serverId: 1,
    node: 'pve1',
  });
  // A node name containing the separator still round-trips: the prefix is
  // stripped, the remainder is the name.
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:pve-a:b' }), {
    kind: 'node',
    serverId: 1,
    node: 'pve-a:b',
  });
});

test('describeDevice recovers a guest from its external id', () => {
  const gladys = createFakeGladys();
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-guest:qemu-101' }), {
    kind: 'guest',
    serverId: 1,
    key: 'qemu-101',
  });
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-guest:lxc-200' }), {
    kind: 'guest',
    serverId: 1,
    key: 'lxc-200',
  });
});

test('describeDevice tells which server a scoped external id belongs to', () => {
  // A poll arriving after a restart, before any discovery ran: the id alone
  // has to say which Proxmox to read.
  const gladys = createFakeGladys();
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:2@pve1' }), {
    kind: 'node',
    serverId: 2,
    node: 'pve1',
  });
  assert.deepEqual(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-guest:2@lxc-200' }), {
    kind: 'guest',
    serverId: 2,
    key: 'lxc-200',
  });
});

test('describeDevice ignores a device that is not ours', () => {
  const gladys = createFakeGladys();
  assert.equal(describeDevice(gladys, { external_id: 'ext:other:light:1' }), null);
  assert.equal(describeDevice(gladys, {}), null);
  assert.equal(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:' }), null);
  assert.equal(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-guest:vm-101' }), null);
  assert.equal(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-guest:2@vm-101' }), null);
  assert.equal(describeDevice(gladys, { external_id: 'ext:proxmox:proxmox-node:2@' }), null);
});
