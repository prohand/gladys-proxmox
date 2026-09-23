// -----------------------------------------------------------------------------
// Scene triggers: one event per TRANSITION, never one per read — and never one
// for what was already true when the integration started.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  clearSnapshot,
  observeGuest,
  observeNode,
  recentNodeState,
  resetObservations,
} from '../src/observe.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/**
 * Assert that an event carries exactly what its trigger declares: every
 * filter field and every variable, nothing Gladys would drop.
 * @param {{key: string, data: object}} event - A recorded scene event.
 * @returns {void}
 */
function assertDeclared(event) {
  const trigger = manifest.scene_triggers.find((entry) => entry.key === event.key);
  assert.ok(trigger, `"${event.key}" is not declared in the manifest`);
  const declared = new Set([
    ...(trigger.fields ?? []).map((field) => field.key),
    ...(trigger.variables ?? []).map((variable) => variable.key),
  ]);
  assert.deepEqual(Object.keys(event.data).sort(), [...declared].sort());
  for (const variable of trigger.variables ?? []) {
    const value = event.data[variable.key];
    assert.ok(value === null || typeof value === variable.type, `${event.key}.${variable.key}`);
  }
}

// The integration "started" at T0 (epoch seconds).
const T0 = 1_800_000_000;
const SERVER = {
  id: 1,
  label: 'Proxmox',
  timezone: 'UTC',
  date_format: 'year_month_day',
  poll_frequency: 300,
};
const DEVICE = 'ext:proxmox:proxmox-node:pve1';

/**
 * A finished backup.
 * @param {string} upid - Task id.
 * @param {number} endtime - End, epoch seconds.
 * @param {boolean} [success] - Verdict.
 * @returns {object} A backup, as `fetchLastBackup()` returns it.
 */
function backup(upid, endtime, success = true) {
  return {
    upid,
    starttime: endtime - 60,
    endtime,
    duration: 60,
    status: success ? 'OK' : 'no space left on device',
    statusType: success ? 'ok' : 'error',
    success,
  };
}

/**
 * A disk, as `fetchDisksHealth()` returns it.
 * @param {string} devpath - Device path.
 * @param {boolean|null} healthy - Verdict.
 * @returns {object} The disk.
 */
function disk(devpath, healthy) {
  return {
    devpath,
    id: devpath.slice(5),
    model: 'ST4000',
    health: healthy === false ? 'FAILED' : 'PASSED',
    healthy,
  };
}

beforeEach(() => {
  resetObservations(T0 * 1000);
});

test('a backup that ended after the start is announced once', async () => {
  const gladys = createFakeGladys();
  const state = { backup: backup('UPID:1', T0 + 10), disks: null };
  await observeNode(gladys, SERVER, 'pve1', DEVICE, state);
  await observeNode(gladys, SERVER, 'pve1', DEVICE, state);

  assert.equal(gladys.sceneEvents.length, 1);
  assert.deepEqual(gladys.sceneEvents[0], {
    key: 'backup_finished',
    data: {
      device: DEVICE,
      server: 'Proxmox',
      node: 'pve1',
      result: 'ok',
      status: 'OK',
      started_at: '2027-01-15 07:59:10',
      duration_seconds: 60,
    },
  });
  assertDeclared(gladys.sceneEvents[0]);
  assert.deepEqual(gladys.widgetRefreshes, ['backups', 'node']);
});

test('a backup that ended before the start is history, the next one is news', async () => {
  const gladys = createFakeGladys();
  await observeNode(gladys, SERVER, 'pve1', DEVICE, {
    backup: backup('UPID:old', T0 - 3600),
    disks: null,
  });
  assert.equal(gladys.sceneEvents.length, 0, 'a restart must not re-announce the last backup');

  await observeNode(gladys, SERVER, 'pve1', DEVICE, {
    backup: backup('UPID:new', T0 + 86400, false),
    disks: null,
  });
  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].data.result, 'failed');
  assert.equal(gladys.sceneEvents[0].data.status, 'failed — no space left on device');
});

test('a backup still running is announced when it ends, not before', async () => {
  const gladys = createFakeGladys();
  const running = { ...backup('UPID:run', T0 + 100), endtime: null, duration: null };
  await observeNode(gladys, SERVER, 'pve1', DEVICE, { backup: running, disks: null });
  assert.equal(gladys.sceneEvents.length, 0);

  await observeNode(gladys, SERVER, 'pve1', DEVICE, {
    backup: backup('UPID:run', T0 + 100),
    disks: null,
  });
  assert.equal(gladys.sceneEvents.length, 1);
});

test('a disk is announced when it turns failed, not when it was already failed', async () => {
  const gladys = createFakeGladys();
  const read = (disks) => observeNode(gladys, SERVER, 'pve1', DEVICE, { backup: null, disks });

  await read([disk('/dev/sda', true), disk('/dev/sdb', false)]);
  assert.equal(gladys.sceneEvents.length, 0, 'the first read only sets the baseline');

  // An unreadable list says nothing: it must not make /dev/sdb "new" again.
  await read([]);
  await read([disk('/dev/sda', true), disk('/dev/sdb', false)]);
  assert.equal(gladys.sceneEvents.length, 0);

  await read([disk('/dev/sda', false), disk('/dev/sdb', false)]);
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: 'disk_failed',
      data: {
        device: DEVICE,
        server: 'Proxmox',
        node: 'pve1',
        disk: '/dev/sda',
        model: 'ST4000',
        health: 'FAILED',
      },
    },
  ]);
  assertDeclared(gladys.sceneEvents[0]);
});

test('a guest is announced when its state changes, with the previous one', async () => {
  const gladys = createFakeGladys();
  const guest = {
    key: 'qemu-101',
    kind: 'qemu',
    vmid: 101,
    node: 'pve1',
    name: 'nextcloud',
    status: 'running',
    running: true,
  };
  const id = 'ext:proxmox:proxmox-guest:qemu-101';

  await observeGuest(gladys, SERVER, id, guest);
  await observeGuest(gladys, SERVER, id, guest);
  assert.equal(gladys.sceneEvents.length, 0);

  await observeGuest(gladys, SERVER, id, { ...guest, status: 'stopped', running: false });
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: 'guest_status_changed',
      data: {
        device: id,
        server: 'Proxmox',
        node: 'pve1',
        name: 'nextcloud',
        vmid: 101,
        kind: 'qemu',
        status: 'stopped',
        previous_status: 'running',
      },
    },
  ]);
  assertDeclared(gladys.sceneEvents[0]);
  assert.deepEqual(gladys.widgetRefreshes, ['guests']);
});

test('the same guest on two servers is two guests', async () => {
  const gladys = createFakeGladys();
  const guest = { key: 'qemu-101', vmid: 101, status: 'running', running: true };
  await observeGuest(gladys, SERVER, 'a', guest);
  await observeGuest(gladys, { ...SERVER, id: 2 }, 'b', { ...guest, status: 'stopped' });
  assert.equal(gladys.sceneEvents.length, 0, 'server 2 sets its own baseline');
});

test('a failing Gladys never fails the read', async () => {
  const gladys = createFakeGladys();
  gladys.publishSceneEvent = async () => {
    throw new Error('404 — unknown scene trigger');
  };
  gladys.requestWidgetRefresh = () => {
    throw new Error('disconnected');
  };
  await observeNode(gladys, SERVER, 'pve1', DEVICE, {
    backup: backup('UPID:1', T0 + 10),
    disks: null,
  });
});

test('the snapshot is served while younger than the refresh interval', async () => {
  const gladys = createFakeGladys();
  const at = T0 * 1000;
  const state = { backup: backup('UPID:1', T0 - 10), disks: null };
  await observeNode(gladys, SERVER, 'pve1', DEVICE, state, at);

  assert.deepEqual(recentNodeState(SERVER, 'pve1', 300, at + 299_000), state);
  assert.equal(recentNodeState(SERVER, 'pve1', 300, at + 300_000), null);
  assert.equal(recentNodeState({ ...SERVER, id: 2 }, 'pve1', 300, at), null);

  clearSnapshot();
  assert.equal(recentNodeState(SERVER, 'pve1', 300, at), null);
});
