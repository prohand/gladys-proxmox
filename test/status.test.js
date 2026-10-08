import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { ProxmoxError } from '../src/proxmox/client.js';
import { createStatusTracker } from '../src/status.js';

const NODE = 'ext:proxmox:proxmox-node:pve1';
const GUEST = 'ext:proxmox:proxmox-guest:qemu-101';

test('the status turns red on a failed read and green once every read works', async () => {
  const gladys = createFakeGladys();
  const status = createStatusTracker(gladys);
  status.written(true);

  await status.report(NODE, new ProxmoxError('network', 'down'));
  await status.report(GUEST, new ProxmoxError('network', 'down'));
  await status.report(NODE, null);
  assert.deepEqual(
    gladys.connectionStatuses.map((entry) => entry.connected),
    [false],
    'still red: the guest has not been read again',
  );
  await status.report(GUEST, null);
  assert.deepEqual(
    gladys.connectionStatuses.map((entry) => entry.connected),
    [false, true],
  );
});

test('a failing device the user deleted no longer keeps the status red', async () => {
  const gladys = createFakeGladys();
  const status = createStatusTracker(gladys);
  status.written(true);

  await status.report(GUEST, new ProxmoxError('network', 'down'));
  await status.forget(GUEST);
  assert.deepEqual(
    gladys.connectionStatuses.map((entry) => entry.connected),
    [false, true],
  );

  // Deleting a device that was fine writes nothing.
  await status.forget(NODE);
  assert.equal(gladys.connectionStatuses.length, 2);
});
