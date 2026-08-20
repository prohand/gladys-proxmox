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
import { listServers } from '../src/servers.js';
import { discoverDevices, pollDevice } from '../src/devices/index.js';
import { fetchLastBackup, resetTypeFilterSupport } from '../src/proxmox/backups.js';
import { clearGuestsCache, fetchGuests } from '../src/proxmox/guests.js';
import { fetchDisksHealth, resetSkipSmartSupport } from '../src/proxmox/disks.js';
import { GLADYS_POLL_FREQUENCIES, resetPollThrottle } from '../src/poll.js';
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

/**
 * The first (and usually only) server of such a configuration — what every
 * function of `src/proxmox/` takes.
 * @param {number} port - Port of the fake node.
 * @param {object} [overrides] - Extra config keys.
 * @returns {object} A configured server.
 */
function serverFor(port, overrides = {}) {
  return listServers(configFor(port, overrides))[0];
}

/**
 * Build a configuration pointing at TWO fake Proxmox servers.
 * @param {number} port - Port of the first fake node.
 * @param {number} secondPort - Port of the second fake node.
 * @param {object} [overrides] - Extra config keys.
 * @returns {object} A normalized configuration.
 */
function twoServerConfig(port, secondPort, overrides = {}) {
  return configFor(port, {
    host_2: '127.0.0.1',
    port_2: secondPort,
    token_id_2: 'gladys@pve!second',
    token_secret_2: 'oth3r',
    tls_fingerprint_2: TEST_FINGERPRINT,
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

// The physical disks of each node: two healthy ones on pve1, a dying one on
// pve2 — the case the SMART status exists for.
const DISKS = {
  pve1: [
    { devpath: '/dev/sda', model: 'Samsung SSD 870', type: 'ssd', health: 'PASSED' },
    { devpath: '/dev/nvme0n1', model: 'WD Blue SN570', type: 'nvme', health: 'PASSED' },
  ],
  pve2: [{ devpath: '/dev/sdb', model: 'ST4000VN008', type: 'hdd', health: 'FAILED' }],
};

// ...and what `/disks/smart` answers for each of them: the attribute table of a
// SATA drive, the text blob of an NVMe one, and a drive reporting no
// temperature at all.
const SMART = {
  '/dev/sda': {
    type: 'ata',
    attributes: [
      { id: 5, name: 'Reallocated_Sector_Ct', raw: '0' },
      { id: 194, name: 'Temperature_Celsius', raw: '31 (Min/Max 20/45)' },
    ],
  },
  '/dev/nvme0n1': {
    type: 'text',
    text: 'SMART/Health Information (NVMe Log 0x02)\nTemperature:      41 Celsius\n',
  },
  '/dev/sdb': { type: 'ata', attributes: [{ id: 5, name: 'Reallocated_Sector_Ct', raw: '1024' }] },
};

/**
 * Answer `/nodes/{node}/disks/list` like Proxmox does.
 * @param {string} node - Node name.
 * @returns {Function} A fake-server handler.
 */
function diskRoute(node) {
  return () => ({ data: DISKS[node] });
}

/**
 * Answer `/nodes/{node}/disks/smart` for the disk the query names.
 * @returns {Function} A fake-server handler.
 */
function smartRoute() {
  return ({ query }) => ({ data: SMART[query.disk] ?? null });
}

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
  resetSkipSmartSupport();
  clearGuestsCache();
  resetPollThrottle();
  return startFakeProxmox({
    '/nodes': NODES,
    '/nodes/pve1/tasks': taskRoute(TASKS),
    '/nodes/pve2/tasks': taskRoute([]),
    '/nodes/pve1/status': { uptime: 1000 },
    '/nodes/pve2/status': { uptime: 1000 },
    '/nodes/pve1/disks/list': diskRoute('pve1'),
    '/nodes/pve2/disks/list': diskRoute('pve2'),
    '/nodes/pve1/disks/smart': smartRoute(),
    '/nodes/pve2/disks/smart': smartRoute(),
    '/cluster/resources': RESOURCES,
    ...overrides,
  });
}

test('listNodes returns every node, sorted, when no filter is set', async () => {
  const server = await startCluster();
  try {
    assert.deepEqual(await listNodes(serverFor(server.port)), NODES);
  } finally {
    await server.close();
  }
});

test('listNodes honours the nodes filter, case-insensitively', async () => {
  const server = await startCluster();
  try {
    const nodes = await listNodes(serverFor(server.port, { nodes_filter: ' PVE2 ' }));
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
    const backup = await fetchLastBackup(serverFor(server.port), 'pve1');
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
    const first = serverFor(server.port);
    const backup = await fetchLastBackup(first, 'pve1');
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
    await fetchLastBackup(first, 'pve1');
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

    const narrow = await fetchLastBackup(serverFor(server.port), 'pve1');
    assert.equal(narrow, null);
  } finally {
    await server.close();
  }
});

test('a node whose task log holds no backup at all reports none', async () => {
  const server = await startCluster();
  try {
    assert.equal(await fetchLastBackup(serverFor(server.port), 'pve2'), null);
  } finally {
    await server.close();
  }
});

test('a failed backup is reported as the last one, and as a failure', async () => {
  const server = await startCluster({
    '/nodes/pve1/tasks': taskRoute([TASKS[2], TASKS[3]]),
  });
  try {
    const backup = await fetchLastBackup(serverFor(server.port), 'pve1');
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
    const strict = await fetchLastBackup(serverFor(server.port), 'pve1');
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
    const guests = await fetchGuests(serverFor(server.port), { force: true });
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
    const monitored = serverFor(server.port, { nodes_filter: 'pve1' });
    const guests = await fetchGuests(monitored, { force: true });
    assert.deepEqual(
      guests.map((guest) => guest.key),
      ['qemu-101', 'lxc-200'],
      'the guest of pve2 is out of scope',
    );

    await fetchGuests(monitored);
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
    const { devices } = await discoverDevices(gladys, configFor(server.port));
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
    const { devices } = await discoverDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);

    const [lastBackup, status, duration] = gladys.published;

    assert.equal(
      lastBackup.device_feature_external_id,
      'ext:proxmox:proxmox-node:pve1:last-backup',
    );
    // The configured format, and no time zone appended to it.
    assert.match(lastBackup.text, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
    // A text state must go out as `text`, never as a numeric `state`.
    assert.equal(lastBackup.state, undefined);

    assert.equal(status.device_feature_external_id, 'ext:proxmox:proxmox-node:pve1:backup-status');
    // What Proxmox itself said, as text: a switch could only have said "on".
    assert.equal(status.text, 'OK');
    assert.equal(status.state, undefined);

    assert.equal(
      duration.device_feature_external_id,
      'ext:proxmox:proxmox-node:pve1:backup-duration',
    );
    assert.equal(duration.state, 248);
  } finally {
    await server.close();
  }
});

test('polling a node publishes its SMART verdict and one temperature per disk', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const { devices } = await discoverDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);

    const smart = gladys.published.find((state) =>
      state.device_feature_external_id.endsWith(':smart-status'),
    );
    assert.equal(smart.text, 'OK (2 disks)');
    assert.equal(smart.state, undefined);

    // The temperature of each disk discovered on that node — the SATA one read
    // from the attribute table, the NVMe one from the smartctl text.
    assert.deepEqual(
      gladys.published.filter((state) =>
        state.device_feature_external_id.includes(':disk-temperature-'),
      ),
      [
        {
          device_feature_external_id: 'ext:proxmox:proxmox-node:pve1:disk-temperature-nvme0n1',
          state: 41,
        },
        {
          device_feature_external_id: 'ext:proxmox:proxmox-node:pve1:disk-temperature-sda',
          state: 31,
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test('a discovered node declares one temperature feature per physical disk', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  try {
    const { devices } = await discoverDevices(gladys, configFor(server.port));
    const [pve1] = devices;

    assert.deepEqual(
      pve1.features.map((feature) => feature.name),
      [
        'Last backup',
        'Backup duration',
        'Backup status',
        'SMART status',
        'Disk nvme0n1 temperature',
        'Disk sda temperature',
      ],
    );

    const temperature = pve1.features.at(-1);
    assert.equal(temperature.unit, 'celsius');
    assert.equal(temperature.keep_history, true, 'a temperature is worth charting');
    assert.equal(temperature.read_only, true);
    // Gladys stores min/max as NOT NULL columns: one feature without them and
    // the WHOLE publish is refused.
    for (const feature of pve1.features) {
      assert.equal(typeof feature.min, 'number');
      assert.equal(typeof feature.max, 'number');
    }

    // The disk list is enumerated with `skipsmart`: the health verdict is read
    // at poll time, discovery only needs the device paths.
    const listed = server.requests.filter((entry) => entry.path === '/nodes/pve1/disks/list');
    assert.deepEqual(
      listed.map((entry) => entry.query),
      [{ skipsmart: '1' }],
    );
  } finally {
    await server.close();
  }
});

test('a failing disk names itself on the SMART status of its node', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const { devices } = await discoverDevices(gladys, config);
    // pve2 holds the dying drive, and no backup at all.
    await pollDevice(gladys, config, devices[1]);

    assert.deepEqual(gladys.published, [
      {
        device_feature_external_id: 'ext:proxmox:proxmox-node:pve2:last-backup',
        text: 'unknown',
      },
      {
        device_feature_external_id: 'ext:proxmox:proxmox-node:pve2:backup-status',
        text: 'unknown',
      },
      {
        device_feature_external_id: 'ext:proxmox:proxmox-node:pve2:smart-status',
        text: 'failed — /dev/sdb: FAILED',
      },
    ]);
    // That drive reports no temperature: nothing at all is published for it,
    // rather than a 0 °C that would read like a measurement.
  } finally {
    await server.close();
  }
});

test('a node whose disks cannot be read says unknown, and keeps its backups', async () => {
  const server = await startCluster({
    '/nodes/pve1/disks/list': () => ({ status: 403, data: null }),
  });
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const { devices } = await discoverDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);

    const smart = gladys.published.find((state) =>
      state.device_feature_external_id.endsWith(':smart-status'),
    );
    assert.equal(smart.text, 'unknown');
    // The backup features are what the integration exists for: an
    // under-privileged token on the disks must not cost them.
    assert.ok(
      gladys.published.some(
        (state) =>
          state.device_feature_external_id.endsWith(':backup-status') && state.text === 'OK',
      ),
    );
  } finally {
    await server.close();
  }
});

test('disk monitoring turned off reads no disk endpoint and declares no feature', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port, { disks_monitoring: 'off' });
  try {
    const { devices } = await discoverDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);

    assert.deepEqual(
      devices[0].features.map((feature) => feature.name),
      ['Last backup', 'Backup duration', 'Backup status'],
    );
    assert.equal(
      server.requests.filter((entry) => entry.path.includes('/disks/')).length,
      0,
      'nothing at all is read from the disks',
    );
    assert.equal(
      gladys.published.filter((state) => state.device_feature_external_id.includes(':smart-'))
        .length,
      0,
    );
  } finally {
    await server.close();
  }
});

test('the SMART-only mode reads the health but never runs a smartctl per disk', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port, { disks_monitoring: 'smart' });
  try {
    const { devices } = await discoverDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);

    assert.deepEqual(
      devices[0].features.map((feature) => feature.name),
      ['Last backup', 'Backup duration', 'Backup status', 'SMART status'],
    );
    assert.equal(
      server.requests.filter((entry) => entry.path === '/nodes/pve1/disks/smart').length,
      0,
      'the temperature is the expensive half: it is only read when asked for',
    );
    assert.ok(
      gladys.published.some(
        (state) =>
          state.device_feature_external_id.endsWith(':smart-status') &&
          state.text === 'OK (2 disks)',
      ),
    );
  } finally {
    await server.close();
  }
});

test('one unreadable disk does not cost the temperature of the others', async () => {
  const server = await startCluster({
    '/nodes/pve1/disks/smart': ({ query }) =>
      query.disk === '/dev/sda' ? { status: 500, data: null } : { data: SMART[query.disk] },
  });
  try {
    const disks = await fetchDisksHealth(serverFor(server.port), 'pve1');
    assert.deepEqual(
      disks.map((disk) => [disk.devpath, disk.healthy, disk.temperature]),
      [
        ['/dev/nvme0n1', true, 41],
        ['/dev/sda', true, null],
      ],
    );
  } finally {
    await server.close();
  }
});

test('every discovered device declares a poll frequency Gladys accepts', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  try {
    // Gladys validates `poll_frequency` against a fixed list of values in
    // MILLISECONDS and rejects the WHOLE publish otherwise, with
    // "devices[0].poll_frequency: invalid poll frequency" — one bad value and
    // not a single device is discovered.
    const { devices } = await discoverDevices(gladys, configFor(server.port));
    assert.ok(devices.length > 0);
    for (const device of devices) {
      assert.ok(
        GLADYS_POLL_FREQUENCIES.includes(device.poll_frequency),
        `${device.external_id} publishes ${device.poll_frequency}`,
      );
    }
  } finally {
    await server.close();
  }
});

test('a poll arriving before the configured interval reads nothing', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const { devices } = await discoverDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);

    // Gladys cannot poll slower than once a minute, so the configured interval
    // (300 s by default) is enforced here: the next four ticks must not touch
    // Proxmox at all, and must not overwrite the states already published.
    const readsBefore = server.requests.length;
    gladys.published.length = 0;
    await pollDevice(gladys, config, devices[0]);

    assert.equal(server.requests.length, readsBefore, 'Proxmox must not be read again');
    assert.equal(gladys.published.length, 0, 'the last known state stays untouched');
  } finally {
    await server.close();
  }
});

test('a device just added is read at once, without waiting for the next tick', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const { devices } = await discoverDevices(gladys, config);
    // Gladys creates a discovered device with no state at all and only polls it
    // on its next tick: `onDeviceCreated` reads it right away instead, so the
    // user who has just added it sees a value immediately.
    await pollDevice(gladys, config, devices[0], { force: true });
    assert.ok(gladys.published.length > 0, 'the added device gets its states at once');

    // Even inside the interval already consumed by a scheduled poll: the forced
    // read is the whole point.
    gladys.published.length = 0;
    await pollDevice(gladys, config, devices[0], { force: true });
    assert.ok(gladys.published.length > 0, 'a forced read is never throttled');

    // ...but it counts as a read, so the tick that follows is skipped like any
    // other early one.
    const readsBefore = server.requests.length;
    gladys.published.length = 0;
    await pollDevice(gladys, config, devices[0]);
    assert.equal(server.requests.length, readsBefore, 'Proxmox must not be read again');
    assert.equal(gladys.published.length, 0);
  } finally {
    await server.close();
  }
});

test('a node with no backup publishes "unknown" and leaves the duration unknown', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  // Disks off: what this test is about is the BACKUP features of an idle node.
  const config = configFor(server.port, { disks_monitoring: 'off' });
  try {
    const { devices } = await discoverDevices(gladys, config);
    await pollDevice(gladys, config, devices[1]);

    // Both text features say "unknown"; the duration publishes nothing at all,
    // because a numeric feature cannot say it and 0 s would be a lie.
    assert.equal(gladys.published.length, 2, 'no fake 0 s duration');
    assert.deepEqual(gladys.published, [
      {
        device_feature_external_id: 'ext:proxmox:proxmox-node:pve2:last-backup',
        text: 'unknown',
      },
      {
        device_feature_external_id: 'ext:proxmox:proxmox-node:pve2:backup-status',
        text: 'unknown',
      },
    ]);
  } finally {
    await server.close();
  }
});

test('a failed backup publishes the Proxmox error as the node status', async () => {
  const server = await startCluster({ '/nodes/pve1/tasks': taskRoute([TASKS[2]]) });
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const { devices } = await discoverDevices(gladys, config);
    await pollDevice(gladys, config, devices[0]);
    const status = gladys.published.find((state) =>
      state.device_feature_external_id.endsWith(':backup-status'),
    );
    // The reason, not just "not on": this is the whole point of the text
    // feature — the user reads why the backup failed without opening Proxmox.
    assert.equal(status.text, "failed — command 'lvcreate' failed: exit code 5");
  } finally {
    await server.close();
  }
});

test('polling a guest publishes the Proxmox state word', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const { devices } = await discoverDevices(gladys, config);
    const [running, stopped] = devices.slice(2);

    await pollDevice(gladys, config, running);
    assert.deepEqual(gladys.published.at(-1), {
      device_feature_external_id: 'ext:proxmox:proxmox-guest:qemu-101:status',
      text: 'running',
    });

    await pollDevice(gladys, config, stopped);
    assert.deepEqual(gladys.published.at(-1), {
      device_feature_external_id: 'ext:proxmox:proxmox-guest:lxc-200:status',
      text: 'stopped',
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
    await discoverDevices(gladys, config);
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
    await discoverDevices(gladys, config);
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
    // Two disks on pve1, one on pve2.
    assert.match(message.en, /3 disk\(s\) readable for the SMART status/);
    assert.match(message.fr, /3 disque\(s\) lisible\(s\)/);
  } finally {
    await server.close();
  }
});

test('test_connection names the nodes whose disks the token cannot read', async () => {
  // Unlike the task list, `/disks/list` is refused rather than filtered: the
  // poll can only say "unknown", so the test is where the 403 gets named.
  const server = await startCluster({
    '/nodes/pve2/disks/list': () => ({ status: 403, data: null }),
  });
  try {
    const message = await testConnection(configFor(server.port));
    assert.match(message.en, /The disk list could not be read on: pve2/);
    assert.match(message.fr, /La liste des disques/);
  } finally {
    await server.close();
  }
});

test('test_connection says nothing about the disks when they are not monitored', async () => {
  const server = await startCluster();
  try {
    const message = await testConnection(configFor(server.port, { disks_monitoring: 'off' }));
    assert.match(message.en, /Connection OK/);
    assert.doesNotMatch(message.en, /disk/);
    assert.equal(server.requests.filter((entry) => entry.path.includes('/disks/')).length, 0);
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

// --- Two Proxmox servers -----------------------------------------------------

// The second cluster deliberately reuses the node name and the VMID of the
// first: a cluster-wide VMID is only unique INSIDE its cluster, and nothing
// stops two installations from both calling a node `pve1`.
const SECOND_NODES = [{ node: 'pve1', status: 'online' }];
const SECOND_RESOURCES = [
  { id: 'qemu/101', type: 'qemu', vmid: 101, node: 'pve1', name: 'archive', status: 'stopped' },
];

/**
 * Start a second fake cluster, on its own port.
 * @returns {Promise<object>} The fake server.
 */
function startSecondCluster() {
  return startFakeProxmox({
    '/nodes': SECOND_NODES,
    '/nodes/pve1/tasks': taskRoute([TASKS[1]]),
    '/nodes/pve1/status': { uptime: 2000 },
    // This one's token cannot read the disks: unlike the task list, Proxmox
    // really does refuse that endpoint instead of filtering it.
    '/nodes/pve1/disks/list': () => ({ status: 403, data: null }),
    '/cluster/resources': SECOND_RESOURCES,
  });
}

test('discovery covers both servers, without either colliding with the other', async () => {
  const first = await startCluster();
  const second = await startSecondCluster();
  const gladys = createFakeGladys();
  try {
    const { devices, failures } = await discoverDevices(
      gladys,
      twoServerConfig(first.port, second.port),
    );
    assert.deepEqual(failures, []);
    assert.deepEqual(
      devices.map((device) => device.name),
      [
        'Proxmox pve1',
        'Proxmox pve2',
        'Proxmox nextcloud (101)',
        'Proxmox dns (200)',
        'Proxmox windows (300)',
        'Proxmox 2 pve1',
        'Proxmox 2 archive (101)',
      ],
    );
    // The first server's ids stay exactly what a single-Proxmox install stored.
    assert.deepEqual(devices.map((device) => device.external_id).slice(-2), [
      'ext:proxmox:proxmox-node:2@pve1',
      'ext:proxmox:proxmox-guest:2@qemu-101',
    ]);
    assert.equal(new Set(devices.map((device) => device.external_id)).size, devices.length);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a device of the second server is polled against the second server', async () => {
  const first = await startCluster();
  const second = await startSecondCluster();
  const gladys = createFakeGladys();
  const config = twoServerConfig(first.port, second.port);
  try {
    const { devices } = await discoverDevices(gladys, config);
    const secondNode = devices.find((device) => device.external_id.endsWith(':2@pve1'));
    const firstReadsBefore = first.requests.length;
    gladys.published.length = 0;

    await pollDevice(gladys, config, secondNode);

    assert.equal(first.requests.length, firstReadsBefore, 'the first server must not be read');
    assert.ok(second.requests.some((entry) => entry.path === '/nodes/pve1/tasks'));
    assert.deepEqual(
      gladys.published.map((state) => state.device_feature_external_id),
      [
        'ext:proxmox:proxmox-node:2@pve1:last-backup',
        'ext:proxmox:proxmox-node:2@pve1:backup-status',
        'ext:proxmox:proxmox-node:2@pve1:backup-duration',
        'ext:proxmox:proxmox-node:2@pve1:smart-status',
      ],
    );
    // That server's token cannot read the disks: "unknown", not a fake verdict.
    assert.equal(gladys.published.at(-1).text, 'unknown');

    // The guest of the same VMID reports the state of ITS cluster: stopped
    // here, running on the first server.
    gladys.published.length = 0;
    await pollDevice(gladys, config, { external_id: 'ext:proxmox:proxmox-guest:2@qemu-101' });
    assert.deepEqual(gladys.published, [
      {
        device_feature_external_id: 'ext:proxmox:proxmox-guest:2@qemu-101:status',
        text: 'stopped',
      },
    ]);
  } finally {
    await first.close();
    await second.close();
  }
});

test('each server keeps its own guest snapshot instead of evicting the other', async () => {
  const first = await startCluster();
  const second = await startSecondCluster();
  const gladys = createFakeGladys();
  const config = twoServerConfig(first.port, second.port);
  try {
    await discoverDevices(gladys, config);
    const reads = (fake) => fake.requests.filter((entry) => entry.path === '/cluster/resources');
    const before = [reads(first).length, reads(second).length];

    // One poll round alternating between the two servers: with a single cache
    // slot, each poll would evict the snapshot the next one needs.
    await pollDevice(gladys, config, { external_id: 'ext:proxmox:proxmox-guest:qemu-101' });
    await pollDevice(gladys, config, { external_id: 'ext:proxmox:proxmox-guest:2@qemu-101' });
    await pollDevice(gladys, config, { external_id: 'ext:proxmox:proxmox-guest:lxc-200' });

    assert.deepEqual([reads(first).length, reads(second).length], before, 'all cache hits');
  } finally {
    await first.close();
    await second.close();
  }
});

test('an unreachable second server does not hide the first', async () => {
  const first = await startCluster();
  const dead = await startSecondCluster();
  const deadPort = dead.port;
  await dead.close();
  const gladys = createFakeGladys();
  try {
    const { devices, failures } = await discoverDevices(
      gladys,
      twoServerConfig(first.port, deadPort),
    );
    assert.equal(devices.length, 5, 'the first server is published as usual');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].server.id, 2);
    assert.equal(failures[0].error.kind, 'network');
    assert.match(failures[0].error.message, /refused the connection/);
  } finally {
    await first.close();
  }
});

test('a device whose server is gone from the configuration publishes nothing', async () => {
  const first = await startCluster();
  const second = await startSecondCluster();
  const gladys = createFakeGladys();
  try {
    await discoverDevices(gladys, twoServerConfig(first.port, second.port));
    gladys.published.length = 0;
    // The user emptied the second block: its devices keep their last known
    // state rather than being refreshed against the wrong server.
    await pollDevice(gladys, configFor(first.port), {
      external_id: 'ext:proxmox:proxmox-node:2@pve1',
    });
    assert.equal(gladys.published.length, 0);
  } finally {
    await first.close();
    await second.close();
  }
});

test('refresh_now and test_connection name each server when there are two', async () => {
  const first = await startCluster();
  const second = await startSecondCluster();
  const gladys = createFakeGladys();
  const config = twoServerConfig(first.port, second.port, { label_2: 'Office' });
  try {
    await discoverDevices(gladys, config);

    const refreshed = await refreshNow(gladys, config);
    assert.match(refreshed.en, /^Refreshed\. \[Proxmox\] Last backup — pve1: /);
    assert.match(refreshed.en, /\[Office\] Last backup — pve1: /);
    assert.match(refreshed.en, /\[Office\] .*0\/1 VM\/LXC running/);
    assert.match(refreshed.fr, /\[Office\] Dernière sauvegarde/);

    const tested = await testConnection(config);
    assert.match(tested.en, /\[Proxmox\] Connection OK.*3 VM\/LXC visible/);
    assert.match(tested.en, /\[Office\] Connection OK.*1 VM\/LXC visible/);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a single server is never labelled: the message stays what it always was', async () => {
  const server = await startCluster();
  try {
    const message = await testConnection(configFor(server.port));
    assert.ok(!message.en.includes('['), message.en);
  } finally {
    await server.close();
  }
});
