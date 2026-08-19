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
import { fetchFailedTasks, listNodes } from '../src/proxmox/tasks.js';
import { testConnection } from '../src/actions.js';

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

// A realistic `errors=1` page: Proxmox already filtered the OK tasks out, but
// still returns warnings and status-less entries.
const TASKS = [
  {
    upid: 'UPID:pve1:001:vzdump::',
    node: 'pve1',
    type: 'vzdump',
    id: '101',
    user: 'root@pam',
    starttime: NOW - 3600,
    endtime: NOW - 3352,
    status: "command 'lvcreate' failed: exit code 5",
  },
  {
    upid: 'UPID:pve1:002:qmigrate::',
    node: 'pve1',
    type: 'qmigrate',
    id: '110',
    user: 'root@pam',
    starttime: NOW - 7200,
    endtime: NOW - 7100,
    status: 'WARNINGS: 2',
  },
  {
    upid: 'UPID:pve1:003:vzdump::',
    node: 'pve1',
    type: 'vzdump',
    id: '102',
    user: 'root@pam',
    // Outside a 24 h window: must never be counted.
    starttime: NOW - 40 * 3600,
    endtime: NOW - 40 * 3600 + 60,
    status: 'job errors',
  },
];

const NODES = [
  { node: 'pve1', status: 'online' },
  { node: 'pve2', status: 'online' },
];

/**
 * Start a fake cluster: two nodes, tasks on pve1, none on pve2.
 * @returns {Promise<object>} The fake server.
 */
function startCluster() {
  return startFakeProxmox({
    '/nodes': NODES,
    '/nodes/pve1/tasks': TASKS,
    '/nodes/pve2/tasks': [],
    '/nodes/pve1/status': { uptime: 1000 },
    '/nodes/pve2/status': { uptime: 1000 },
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

test('fetchFailedTasks asks Proxmox for errors only, with the portable parameters', async () => {
  const server = await startCluster();
  try {
    await fetchFailedTasks(configFor(server.port), 'pve1');
    const request = server.requests.find((entry) => entry.path === '/nodes/pve1/tasks');
    assert.deepEqual(request.query, { errors: '1', limit: '200', start: '0' });
  } finally {
    await server.close();
  }
});

test('fetchFailedTasks drops the tasks outside the observation window', async () => {
  const server = await startCluster();
  try {
    const tasks = await fetchFailedTasks(configFor(server.port, { lookback_hours: 24 }), 'pve1');
    assert.deepEqual(
      tasks.map((task) => task.id),
      ['101'],
      'only the error inside the window, warnings excluded by the default scope',
    );
  } finally {
    await server.close();
  }
});

test('the wide scope also counts the tasks that ended with warnings', async () => {
  const server = await startCluster();
  try {
    const config = configFor(server.port, { failure_scope: 'errors_and_warnings' });
    const tasks = await fetchFailedTasks(config, 'pve1');
    assert.deepEqual(
      tasks.map((task) => task.id),
      ['101', '110'],
      'most recent first',
    );
  } finally {
    await server.close();
  }
});

test('the task type filter keeps only the listed types', async () => {
  const server = await startCluster();
  try {
    const config = configFor(server.port, {
      failure_scope: 'errors_and_warnings',
      task_type_filter: 'QMIGRATE',
    });
    const tasks = await fetchFailedTasks(config, 'pve1');
    assert.deepEqual(
      tasks.map((task) => task.type),
      ['qmigrate'],
    );
  } finally {
    await server.close();
  }
});

test('discovery publishes one device per node, and polling publishes both features', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const devices = await buildDiscoveredDevices(gladys, config);
    assert.deepEqual(
      devices.map((device) => device.name),
      ['Proxmox pve1', 'Proxmox pve2'],
    );

    await pollDevice(gladys, config, devices[0]);

    assert.equal(gladys.published.length, 2);
    const [count, details] = gladys.published;
    assert.equal(
      count.device_feature_external_id,
      'ext:proxmox:proxmox-node:pve1:failed-task-count',
    );
    assert.equal(count.state, 1);
    assert.equal(
      details.device_feature_external_id,
      'ext:proxmox:proxmox-node:pve1:failure-details',
    );
    assert.match(details.text, /1 failed task on pve1 in the last 24 h \(times in UTC\)/);
    assert.match(details.text, /• vzdump \(101\)/);
    assert.match(details.text, /status: command 'lvcreate' failed: exit code 5/);
    // A text state must go out as `text`, never as a numeric `state`.
    assert.equal(details.state, undefined);
  } finally {
    await server.close();
  }
});

test('a node with nothing to report publishes a zero count and says so', async () => {
  const server = await startCluster();
  const gladys = createFakeGladys();
  const config = configFor(server.port);
  try {
    const devices = await buildDiscoveredDevices(gladys, config);
    await pollDevice(gladys, config, devices[1]);
    assert.equal(gladys.published[0].state, 0);
    assert.equal(gladys.published[1].text, 'No failed task on pve2 in the last 24 h.');
  } finally {
    await server.close();
  }
});

test('test_connection confirms the read access node by node', async () => {
  const server = await startCluster();
  try {
    const message = await testConnection(configFor(server.port));
    assert.match(message.en, /Connection OK/);
    assert.match(message.en, /pve1, pve2/);
  } finally {
    await server.close();
  }
});

test('test_connection names the nodes whose task log the token cannot read', async () => {
  // pve2 answers 403 on the permission-checked endpoint: the task list would
  // have answered 200 with a silently filtered result, which is precisely the
  // trap this probe exists to catch.
  const server = await startFakeProxmox({
    '/nodes': NODES,
    '/nodes/pve1/status': { uptime: 1000 },
    '/nodes/pve2/status': () => ({ status: 403 }),
  });
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
