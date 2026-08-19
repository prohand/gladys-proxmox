// -----------------------------------------------------------------------------
// End-to-end wiring, against a fake Proxmox node on a real socket: discovery,
// polling, published states, and the "Test the connection" action.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { startFakeProxmox } from './helpers/fakeProxmox.js';
import { TEST_FINGERPRINT } from './fixtures/tls.js';
import { normalizeConfig } from '../src/config.js';
import { buildDiscoveredDevices, pollDevice } from '../src/devices/index.js';
import { fetchLastBackup, resetTypeFilterSupport } from '../src/proxmox/backups.js';
import { clearGuestsCache, fetchGuests } from '../src/proxmox/guests.js';
import { listNodes } from '../src/proxmox/nodes.js';
import { refreshNow, testConnection } from '../src/actions.js';

const NOW = Math.floor(Date.now() / 1000);

/**
 * Build a configuration pointing at a fake node.
 * @param {number} port - Port of the fake node.
 * @param {object} [overrides] - Extra config keys.
 * @returns {object} A normalized configuration.
 */
function configFor(port, overrides = {}) {
  return normalizeConfig({
    host: '127.0.0.1',
    port,
    token_id: 'gladys@pve!tasks',
    token_secret: 's3cret',
    tls_fingerprint: TEST_FINGERPRINT,
    timezone: 'UTC',
    ...overrides,
  });
}

// A realistic task page: several task types, several backups, and one backup
// older than the default window.
const TASKS = [
  {
    upid: 'UPID:pve1:001:qmigrate::',
    node: 'pve1',
    type: 'qmigrate',
    id: '110',
    user: 'root@pam',
    starttime: NOW - 1800,
    endtime: NOW - 1700,
    status: 'OK',
  },
  {
    upid: 'UPID:pve1:002:vzdump::',
    node: 'pve1',
    type: 'vzdump',
    id: '101',
    user: 'root@pam',
    starttime: NOW - 3600,
    endtime: NOW - 3352,
    status: 'OK',
  },
  {
    upid: 'UPID:pve1:003:vzdump::',
    node: 'pve1',
    type: 'vzdump',
    id: '102',
    user: 'root@pam',
    starttime: NOW - 90000,
    endtime: NOW - 89000,
    status: "command 'lvcreate' failed: exit code 5",
  },
  {
    upid: 'UPID:pve1:004:vzdump::',
    node: 'pve1',
    type: 'vzdump',
    id: '103',
    user: 'root@pam',
    // 40 days old: outside every window used by these tests.
    starttime: NOW - 40 * 86400,
    endtime: NOW - 40 * 86400 + 60,
    status: 'OK',
  },
];

const NODES = [
  { node: 'pve1', status: 'online' },
  { node: 'pve2', status: 'online' },
];

const RESOURCES = [
  { id: 'qemu/101', type: 'qemu', vmid: 101, node: 'pve1', name: 'nextcloud', status: 'running' },
  { id: 'lxc/200', type: 'lxc', vmid: 200, node: 'pve1', name: 'dns', status: 'stopped' },
  { id: 'qemu/300', type: 'qemu', vmid: 300, node: 'pve2', name: 'windows', status: 'running' },
  // A template has no meaningful on/off state: it must never become a device.
  {
    id: 'qemu/900',
    type: 'qemu',
    vmid: 900,
    node: 'pve1',
    name: 'debian-tpl',
    status: 'stopped',
    template: 1,
  },
  // Storage entries share the endpoint on some generations: not a guest.
  { id: 'storage/pve1/local', type: 'storage', node: 'pve1', status: 'available' },
];

/**
 * Answer a task page like a modern Proxmox does, honouring `typefilter`.
 * @param {object[]} tasks - The tasks of the node.
 * @returns {Function} A fake-server handler.
 */
function taskRoute(tasks) {
  return ({ query }) => ({
    data: query.typefilter ? tasks.filter((task) => task.type === query.typefilter) : tasks,
  });
}

/**
 * Start a fake cluster: two nodes, backups on pve1, none on pve2.
 * @param {object} [overrides] - Routes replacing the default ones.
 * @returns {Promise<object>} The fake server.
 */
function startCluster(overrides = {}) {
  resetTypeFilterSupport();
  clearGuestsCache();
  return startFakeProxmox({
    '/nodes': NODES,
    '/nodes/pve1/tasks': taskRoute(TASKS),
    '/nodes/pve2/tasks': taskRoute([]),
    '/nodes/pve1/status': { uptime: 1000 },
    '/nodes/pve2/status': { uptime: 1000 },
    '/cluster/resources': RESOURCES,
    ...overrides,
  });
}

test('listNodes returns every node, sorted, when no filter is set', async () => {
  const server = await startCluster();
  try {
    assert.deepEqual(await listNodes(configFor(server.port)), NODES);
  } finally {
    await server.close();
  }
});

test('listNodes honours the nodes filter, case-insensitively', async () => {
  const server = await startCluster();
  try {
    const nodes = await listNodes(configFor(server.port, { nodes_filter: ' PVE2 ' }));
    assert.deepEqual(
      nodes.map((entry) => entry.node),
      ['pve2'],
    );
  } finally {
    await server.close();
  }
});

test('fetchLastBackup asks Proxmox to filter on the backup task type', async () => {
  const server = await startCluster();
  try {
    const backup = await fetchLastBackup(configFor(server.port), 'pve1');
    const request = server.requests.find((entry) => entry.path === '/nodes/pve1/tasks');
    assert.deepEqual(request.query, { typefilter: 'vzdump', limit: '200', start: '0' });

    assert.equal(backup.id, '101', 'the most recent backup, not the most recent task');
    assert.equal(backup.duration, 248);
    assert.equal(backup.status, 'OK');
    assert.equal(backup.success, true);
  } finally {
    await server.close();
  }
});

test('a node that does not know typefilter is filtered here instead', async () => {
  // Older Proxmox generations declare `additionalProperties => 0` on the task
  // endpoint: an unknown parameter is a 400, not something they ignore.
  const server = await startCluster({
    '/nodes/pve1/tasks': ({ query }) =>
      query.typefilter
        ? { status: 400, body: JSON.stringify({ errors: { typefilter: 'unknown parameter' } }) }
        : { data: TASKS },
  });
  try {
    const config = configFor(server.port);
    const backup = await fetchLastBackup(config, 'pve1');
    assert.equal(backup.id, '101');

    const queries = server.requests
      .filter((entry) => entry.path === '/nodes/pve1/tasks')
      .map((entry) => entry.query);
    assert.deepEqual(queries, [
      { typefilter: 'vzdump', limit: '200', start: '0' },
      { limit: '500', start: '0' },
    ]);

    // The rejection is remembered: the second read goes straight to the
    // fallback instead of paying for a doomed request again.
    await fetchLastBackup(config, 'pve1');
    assert.equal(server.requests.filter((entry) => entry.query.typefilter !== undefined).length, 1);
  } finally {
    await server.close();
  }
});

test('a backup older than the window is not the last backup any more', async () => {
  // Only the 40-day-old backup is left on the node: inside a 90-day window it
  // is the last backup, inside the default 7-day one there is none at all.
  const server = await startCluster({ '/nodes/pve1/tasks': taskRoute([TASKS[3]]) });
  try {
    const wide = await fetchLastBackup(
      configFor(server.port, { backup_lookback_days: 90 }),
      'pve1',
    );
    assert.equal(wide.id, '103');

    const narrow = await fetchLastBackup(configFor(server.port), 'pve1');
    assert.equal(narrow, null);
  } finally {
    await server.close();
  }
});

test('a node whose task log holds no backup at all reports none', async () => {
  const server = await startCluster();
  try {
    assert.equal(await fetchLastBackup(configFor(server.port), 'pve2'), null);
  } finally {
    await server.close();
  }
});

test('a failed backup is reported as the last one, and as a failure', async () => {
  const server = await startCluster({
    '/nodes/pve1/tasks': taskRoute([TASKS[2], TASKS[3]]),
  });
  try {
    const backup = await fetchLastBackup(configFor(server.port), 'pve1');
    assert.equal(backup.id, '102');
    assert.equal(backup.success, false);
    assert.equal(backup.statusType, 'error');
  } finally {
    await server.close();
  }
});

test('a backup that ended with warnings follows the configured scope', async () => {
  const warned = [{ ...TASKS[1], status: 'WARNINGS: 2' }];
  const server = await startCluster({ '/nodes/pve1/tasks': taskRoute(warned) });
  try {
    const strict = await fetchLastBackup(configFor(server.port), 'pve1');
    assert.equal(strict.success, false, 'the default scope only accepts OK');

    const wide = await fetchLastBackup(
      configFor(server.port, { backup_success_scope: 'ok_and_warnings' }),
      'pve1',
    );
    assert.equal(wide.success, true);
  } finally {
    await server.close();
  }
});

test('fetchGuests keeps the running guests and drops templates and storages', async () => {
  const server = await startCluster();
  try {
    const guests = await fetchGuests(configFor(server.port), { force: true });
    assert.deepEqual(
      guests.map((guest) => guest.key),
      ['qemu-101', 'lxc-200', 'qemu-300'],
    );
    assert.equal(guests[0].running, true);
    assert.equal(guests[1].running, false);
  } finally {
    await server.close();
  }
});

test('fetchGuests honours the nodes filter and caches its answer', async () => {
  const server = await startCluster();
  try {
    const config = configFor(server.port, { nodes_filter: 'pve1' });
    const guests = await fetchGuests(config, { force: true });
    assert.deepEqual(
      guests.map((guest) => guest.key),
      ['qemu-101', 'lxc-200'],
      'the guest of pve2 is out of scope',
    );

    await fetchGuests(config);
    assert.equal(
      server.requests.filter((entry) => entry.path === '/cluster/resources').length,
      1,
      'the second read is served from the cache',
    );
  } finally {
    await server.close();
  }
});

test('discovery publishes one device per node and one per guest', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  try {
    const devices = await buildDiscoveredDevices(gladys, configFor(server.port));
    assert.deepEqual(
      devices.map((device) => device.name),
      [
        'Proxmox pve1',
        'Proxmox pve2',
        'Proxmox nextcloud (101)',
        'Proxmox dns (200)',
        'Proxmox windows (300)',
      ],
    );
  } finally {
    await server.close();
  }
});

test('polling a node publishes the last backup, its duration and its status', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const devices = await buildDiscoveredDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);

    assert.equal(gladys.published.length, 3);
    const [lastBackup, status, duration] = gladys.published;

    assert.equal(
      lastBackup.device_feature_external_id,
      'ext:proxmox:proxmox-node:pve1:last-backup',
    );
    assert.match(lastBackup.text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC\)$/);
    // A text state must go out as `text`, never as a numeric `state`.
    assert.equal(lastBackup.state, undefined);

    assert.equal(status.device_feature_external_id, 'ext:proxmox:proxmox-node:pve1:backup-status');
    assert.equal(status.state, 1);

    assert.equal(
      duration.device_feature_external_id,
      'ext:proxmox:proxmox-node:pve1:backup-duration',
    );
    assert.equal(duration.state, 248);
  } finally {
    await server.close();
  }
});

test('a node with no backup publishes "unknown" and leaves the rest unknown', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const devices = await buildDiscoveredDevices(gladys, config);
    await pollDevice(gladys, config, devices[1]);

    assert.equal(gladys.published.length, 1, 'no fake 0 s duration, no fake OFF status');
    assert.equal(
      gladys.published[0].device_feature_external_id,
      'ext:proxmox:proxmox-node:pve2:last-backup',
    );
    assert.equal(gladys.published[0].text, 'unknown');
  } finally {
    await server.close();
  }
});

test('a failed backup turns the node status feature off', async () => {
  const server = await startCluster({ '/nodes/pve1/tasks': taskRoute([TASKS[2]]) });
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const devices = await buildDiscoveredDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);
    const status = gladys.published.find((state) =>
      state.device_feature_external_id.endsWith(':backup-status'),
    );
    assert.equal(status.state, 0);
  } finally {
    await server.close();
  }
});

test('polling a guest publishes 1 when it runs, 0 otherwise', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const devices = await buildDiscoveredDevices(gladys, config);
    const [running, stopped] = devices.slice(2);

    await pollDevice(gladys, config, running);
    assert.deepEqual(gladys.published.at(-1), {
      device_feature_external_id: 'ext:proxmox:proxmox-guest:qemu-101:status',
      state: 1,
    });

    await pollDevice(gladys, config, stopped);
    assert.deepEqual(gladys.published.at(-1), {
      device_feature_external_id: 'ext:proxmox:proxmox-guest:lxc-200:status',
      state: 0,
    });
  } finally {
    await server.close();
  }
});

test('a guest that vanished publishes nothing instead of a fake OFF', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    await buildDiscoveredDevices(gladys, config);
    clearGuestsCache();
    gladys.published.length = 0;
    await pollDevice(gladys, config, { external_id: 'ext:proxmox:proxmox-guest:qemu-999' });
    assert.equal(gladys.published.length, 0);
  } finally {
    await server.close();
  }
});

test('refresh_now summarizes the backups and the running guests', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    await buildDiscoveredDevices(gladys, config);
    const message = await refreshNow(gladys, config);
    assert.match(message.en, /Last backup — pve1: .*, 4 min 8 s, OK \| pve2: no backup/);
    assert.match(message.en, /2\/3 VM\/LXC running/);
    assert.match(message.fr, /Dernière sauvegarde/);
  } finally {
    await server.close();
  }
});

test('test_connection confirms the read access node by node, and counts the guests', async () => {
  const server = await startCluster();
  try {
    const message = await testConnection(configFor(server.port));
    assert.match(message.en, /Connection OK/);
    assert.match(message.en, /pve1, pve2/);
    assert.match(message.en, /3 VM\/LXC visible/);
  } finally {
    await server.close();
  }
});

test('test_connection points at VM.Audit when no guest is visible', async () => {
  const server = await startCluster({ '/cluster/resources': [] });
  try {
    const message = await testConnection(configFor(server.port));
    assert.match(message.en, /No VM or LXC is visible/);
    assert.match(message.en, /VM\.Audit/);
  } finally {
    await server.close();
  }
});

test('test_connection names the nodes whose task log the token cannot read', async () => {
  // pve2 answers 403 on the permission-checked endpoint: the task list would
  // have answered 200 with a silently filtered result, which is precisely the
  // trap this probe exists to catch.
  const server = await startCluster({ '/nodes/pve2/status': () => ({ status: 403 }) });
  try {
    const message = await testConnection(configFor(server.port));
    assert.match(message.en, /cannot read the task log of: pve2/);
    assert.match(message.en, /Sys\.Audit/);
    assert.match(message.en, /Working on: pve1/);
  } finally {
    await server.close();
  }
});

test('test_connection reports a bad token instead of a raw error', async () => {
  const server = await startFakeProxmox({ '/nodes': () => ({ status: 401 }) });
  try {
    const message = await testConnection(configFor(server.port));
    assert.match(message.en, /refused the API token/);
    assert.match(message.fr, /refusé le jeton/);
  } finally {
    await server.close();
  }
});

test('test_connection asks for the configuration before anything else', async () => {
  const message = await testConnection(normalizeConfig());
  assert.match(message.en, /Fill in the Proxmox host/);
});

test('test_connection reports an empty node filter match', async () => {
  const server = await startCluster();
  try {
    const message = await testConnection(configFor(server.port, { nodes_filter: 'nope' }));
    assert.match(message.en, /no node matched/);
  } finally {
    await server.close();
  }
});
