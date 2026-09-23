// -----------------------------------------------------------------------------
// Dashboard widgets and scene actions, against a fake Proxmox on a real socket.
//
// Every widget content goes through the SDK's own `validateWidgetContent()`:
// an empty report means Gladys renders it exactly as sent — nothing dropped by
// the content budget, no text truncated behind our back.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { startFakeProxmox } from './helpers/fakeProxmox.js';
import { TEST_FINGERPRINT } from './fixtures/tls.js';
import { normalizeConfig } from '../src/config.js';
import { discoverDevices } from '../src/devices/index.js';
import { resetTypeFilterSupport } from '../src/proxmox/backups.js';
import { clearGuestsCache } from '../src/proxmox/guests.js';
import { resetSkipSmartSupport } from '../src/proxmox/disks.js';
import { resetPollThrottle } from '../src/poll.js';
import { resetObservations } from '../src/observe.js';
import { backupsWidget, clip, guestsWidget, nodeWidget, widgetAction } from '../src/widgets.js';
import { getBackupStatus, getGuestStatus, getSmartStatus, refreshForScene } from '../src/scenes.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const NOW = Math.floor(Date.now() / 1000);

const NODE_1 = 'ext:proxmox:proxmox-node:pve1';
const NODE_2 = 'ext:proxmox:proxmox-node:pve2';
const GUEST_101 = 'ext:proxmox:proxmox-guest:qemu-101';

/**
 * A backup task, as the Proxmox task list returns it.
 * @param {string} node - Node name.
 * @param {string} status - Exit status.
 * @returns {object} The task.
 */
function vzdump(node, status) {
  return {
    upid: `UPID:${node}:vzdump::`,
    node,
    type: 'vzdump',
    id: '101',
    user: 'root@pam',
    starttime: NOW - 3600,
    endtime: NOW - 3352,
    status,
  };
}

const ROUTES = {
  '/nodes': [
    { node: 'pve1', status: 'online' },
    { node: 'pve2', status: 'online' },
    { node: 'pve3', status: 'online' },
  ],
  '/nodes/pve1/tasks': [vzdump('pve1', 'OK')],
  '/nodes/pve2/tasks': [vzdump('pve2', 'no space left on device')],
  '/nodes/pve3/tasks': [],
  '/nodes/pve1/disks/list': [
    { devpath: '/dev/sda', model: 'Samsung SSD 870', type: 'ssd', health: 'PASSED' },
    { devpath: '/dev/sdb', model: 'ST4000VN008', type: 'hdd', health: 'PASSED' },
  ],
  '/nodes/pve2/disks/list': [],
  '/nodes/pve3/disks/list': [],
  '/nodes/pve1/disks/smart': ({ query }) => ({
    data: {
      type: 'ata',
      attributes: [
        {
          id: 194,
          name: 'Temperature_Celsius',
          raw: query.disk === '/dev/sda' ? '55' : '38',
        },
      ],
    },
  }),
  '/cluster/resources': [
    { type: 'qemu', vmid: 101, node: 'pve1', name: 'nextcloud', status: 'running' },
    { type: 'lxc', vmid: 200, node: 'pve1', name: 'dns', status: 'stopped' },
    { type: 'qemu', vmid: 300, node: 'pve2', name: 'windows', status: 'paused' },
  ],
};

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
    date_format: 'year_month_day',
    ...overrides,
  });
}

/**
 * Start the fake cluster, discover it, and hand everything to the test.
 * @param {Function} body - `({ gladys, config, server }) => Promise`.
 * @param {object} [overrides] - Config overrides.
 * @returns {Promise<void>} Resolves once the test body and the cleanup ran.
 */
async function withCluster(body, overrides = {}) {
  const server = await startFakeProxmox(ROUTES);
  try {
    const gladys = createFakeGladys();
    const config = configFor(server.port, overrides);
    await discoverDevices(gladys, config);
    await body({ gladys, config, server });
  } finally {
    await server.close();
  }
}

/**
 * The components of one type.
 * @param {object} content - A widget content.
 * @param {string} type - Component type.
 * @returns {object[]} The components.
 */
function ofType(content, type) {
  return content.components.filter((component) => component.type === type);
}

beforeEach(() => {
  resetTypeFilterSupport();
  resetSkipSmartSupport();
  clearGuestsCache();
  resetPollThrottle();
  resetObservations();
});

test('clip keeps what fits, and cuts the rest with an ellipsis', () => {
  assert.equal(clip('  pve1 ', 10), 'pve1');
  assert.equal(clip('abcdefghij', 5), 'abcd…');
  assert.deepEqual(clip({ en: 'abcdef', fr: 'abc' }, 4), { en: 'abc…', fr: 'abc' });
});

test('the backups widget lists failures first and counts every verdict', async () => {
  await withCluster(async ({ gladys, config }) => {
    const content = await backupsWidget(gladys, config);
    assert.deepEqual(validateWidgetContent(content), []);
    assert.equal(content.ttl_seconds, 300, 'Gladys keeps it for one refresh interval');

    const tiles = ofType(content, 'value').map((tile) => [tile.label.en, tile.value, tile.color]);
    assert.deepEqual(tiles, [
      ['Backups OK', 1, 'success'],
      ['Failed', 1, 'danger'],
      ['No backup', 1, 'warning'],
    ]);

    const [status] = ofType(content, 'status');
    assert.deepEqual(
      status.items.map((item) => [item.label, item.color]),
      [
        ['pve2', 'danger'],
        ['pve3', 'warning'],
        ['pve1', 'success'],
      ],
    );
    assert.equal(status.items[0].value, 'failed — no space left on device');
    assert.match(status.items[2].value, /^OK — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const [button] = ofType(content, 'button');
    assert.deepEqual(button.action, { key: 'refresh' });
  });
});

test('the backups widget reuses a recent read instead of asking Proxmox again', async () => {
  await withCluster(async ({ gladys, config, server }) => {
    await backupsWidget(gladys, config);
    const reads = server.requests.filter((request) => request.path.endsWith('/tasks')).length;
    await backupsWidget(gladys, config);
    assert.equal(
      server.requests.filter((request) => request.path.endsWith('/tasks')).length,
      reads,
    );
  });
});

test('the backups widget names what it cannot read', async () => {
  const gladys = createFakeGladys();
  // Nothing listens there.
  const config = configFor(1, { poll_frequency: 60 });
  await discoverDevices(gladys, config);
  const content = await backupsWidget(gladys, config);
  assert.deepEqual(validateWidgetContent(content), []);
  const [caption] = ofType(content, 'text');
  assert.equal(caption.variant, 'caption');
  assert.ok(caption.text.en.length <= 80);
});

test('a widget of an unconfigured integration says what to do', async () => {
  const gladys = createFakeGladys();
  for (const content of [
    await backupsWidget(gladys, normalizeConfig()),
    await guestsWidget(gladys, normalizeConfig()),
  ]) {
    assert.deepEqual(validateWidgetContent(content), []);
    assert.match(ofType(content, 'text')[0].text.en, /not configured/);
  }
});

test('the guests widget puts what is not running first', async () => {
  await withCluster(async ({ gladys, config }) => {
    const content = await guestsWidget(gladys, config, { show: 'all' });
    assert.deepEqual(validateWidgetContent(content), []);

    const tiles = ofType(content, 'value').map((tile) => [tile.label.en, tile.value]);
    assert.deepEqual(tiles, [
      ['Running', 1],
      ['Stopped', 1],
      ['Other', 1],
    ]);
    const [status] = ofType(content, 'status');
    assert.deepEqual(
      status.items.map((item) => [item.label, item.value, item.color]),
      [
        ['dns (200)', 'stopped', 'neutral'],
        ['windows (300)', 'paused', 'warning'],
        ['nextcloud (101)', 'running', 'success'],
      ],
    );
  });
});

test('the guests widget can show only what is not running', async () => {
  await withCluster(async ({ gladys, config }) => {
    const content = await guestsWidget(gladys, config, { show: 'not_running' });
    assert.deepEqual(validateWidgetContent(content), []);
    const [status] = ofType(content, 'status');
    assert.deepEqual(
      status.items.map((item) => item.label),
      ['dns (200)', 'windows (300)'],
    );
  });
});

test('the guests widget fires the state changes it sees', async () => {
  await withCluster(async ({ gladys, config }) => {
    await guestsWidget(gladys, config);
    assert.equal(gladys.sceneEvents.length, 0, 'the first read is the baseline');
    ROUTES['/cluster/resources'][0].status = 'stopped';
    try {
      clearGuestsCache();
      await guestsWidget(gladys, config);
    } finally {
      ROUTES['/cluster/resources'][0].status = 'running';
    }
    assert.deepEqual(
      gladys.sceneEvents.map((event) => [event.key, event.data.device, event.data.status]),
      [['guest_status_changed', GUEST_101, 'stopped']],
    );
  });
});

test('the node widget shows the verdicts, the hottest disks and a live chart', async () => {
  await withCluster(async ({ gladys, config }) => {
    const content = await nodeWidget(gladys, config, { node: NODE_1 });
    assert.deepEqual(validateWidgetContent(content), []);

    assert.equal(ofType(content, 'text')[0].text, 'Proxmox pve1');
    assert.deepEqual(
      ofType(content, 'value').map((tile) => [tile.label, tile.value, tile.unit, tile.color]),
      [
        ['sda', 55, '°C', 'warning'],
        ['sdb', 38, '°C', 'success'],
      ],
    );
    const [chart] = ofType(content, 'chart');
    assert.deepEqual(chart.device_features, [`${NODE_1}:backup-duration`]);

    const [status] = ofType(content, 'status');
    assert.deepEqual(
      status.items.map((item) => [item.label.en, item.value]),
      [
        ['Last backup', status.items[0].value],
        ['Backup status', 'OK'],
        ['Duration', '4 min 8 s'],
        ['SMART status', 'OK (2 disks)'],
      ],
    );
  });
});

test('the node widget speaks Fahrenheit to a US dashboard', async () => {
  await withCluster(async ({ gladys, config }) => {
    const content = await nodeWidget(gladys, config, { node: NODE_1 }, 'us');
    assert.deepEqual(
      ofType(content, 'value').map((tile) => [tile.value, tile.unit]),
      [
        [131, '°F'],
        [100, '°F'],
      ],
    );
  });
});

test('the node widget refuses a VM/LXC with a message, not an error', async () => {
  await withCluster(async ({ gladys, config }) => {
    const content = await nodeWidget(gladys, config, { node: GUEST_101 });
    assert.deepEqual(validateWidgetContent(content), []);
    assert.match(ofType(content, 'text')[0].text.en, /Pick a Proxmox node/);
  });
});

test('the widget refresh button reads Proxmox again', async () => {
  await withCluster(async ({ gladys, config }) => {
    const toast = await widgetAction(gladys, config, 'backups', 'refresh');
    assert.deepEqual(toast, { en: 'Proxmox read again.', fr: 'Proxmox relu.' });
    assert.ok(
      gladys.published.some((state) => state.device_feature_external_id.startsWith(NODE_2)),
    );

    gladys.published.length = 0;
    await widgetAction(gladys, config, 'node', 'refresh', { node: NODE_1 });
    assert.ok(gladys.published.length > 0);
    assert.ok(
      gladys.published.every((state) => state.device_feature_external_id.startsWith(NODE_1)),
    );

    await assert.rejects(
      widgetAction(gladys, config, 'backups', 'reboot'),
      /Unknown widget action/,
    );
  });
});

/**
 * The output keys a scene action declares in the manifest.
 * @param {string} key - Scene action key.
 * @returns {string[]} The declared output keys.
 */
function declaredOutputs(key) {
  return manifest.scene_actions.find((action) => action.key === key).outputs.map((o) => o.key);
}

/**
 * Assert that every output is declared, with the declared type.
 * @param {string} key - Scene action key.
 * @param {object} outputs - What the handler resolved.
 * @returns {void}
 */
function assertDeclared(key, outputs) {
  const declared = manifest.scene_actions.find((action) => action.key === key).outputs;
  for (const [name, value] of Object.entries(outputs)) {
    const output = declared.find((entry) => entry.key === name);
    assert.ok(output, `${key} returns "${name}", which the manifest does not declare`);
    assert.equal(typeof value, output.type, `${key}.${name} must be a ${output.type}`);
  }
}

test('get_backup_status hands the scene the last backup of a node', async () => {
  await withCluster(async ({ gladys, config }) => {
    const failed = await getBackupStatus(gladys, config, { device: NODE_2 });
    assertDeclared('get_backup_status', failed);
    assert.equal(failed.node, 'pve2');
    assert.equal(failed.has_backup, true);
    assert.equal(failed.success, false);
    assert.equal(failed.status, 'failed — no space left on device');
    assert.equal(failed.duration_seconds, 248);

    const ok = await getBackupStatus(gladys, config, { device: NODE_1 });
    assert.deepEqual(Object.keys(ok).sort(), declaredOutputs('get_backup_status').sort());
    assert.equal(ok.success, true);
    assert.equal('smart_status' in ok, false, 'the disks have their own action');

    const none = await getBackupStatus(gladys, config, {
      device: 'ext:proxmox:proxmox-node:pve3',
    });
    assert.equal(none.has_backup, false);
    assert.equal(none.status, 'unknown');
    assert.equal('duration_seconds' in none, false, 'no duration rather than a fake 0');
  });
});

test('get_smart_status hands the scene the disks of a node', async () => {
  await withCluster(async ({ gladys, config }) => {
    const outputs = await getSmartStatus(gladys, config, { device: NODE_1 });
    assertDeclared('get_smart_status', outputs);
    assert.deepEqual(outputs, {
      node: 'pve1',
      status: 'OK (2 disks)',
      disk_count: 2,
      failed_disks: 0,
      unknown_disks: 0,
      max_temperature: 55,
    });

    // A node whose disk list is empty: no verdict, and no temperature at all
    // rather than a 0 °C.
    const empty = await getSmartStatus(gladys, config, { device: NODE_2 });
    assert.equal(empty.status, 'unknown');
    assert.equal(empty.disk_count, 0);
    assert.equal('max_temperature' in empty, false);

    await assert.rejects(getSmartStatus(gladys, config, { device: GUEST_101 }), /is a VM\/LXC/);
  });
});

test('get_smart_status says when disk monitoring is off', async () => {
  await withCluster(
    async ({ gladys, config }) => {
      await assert.rejects(
        getSmartStatus(gladys, config, { device: NODE_1 }),
        /Disk monitoring is off/,
      );
    },
    { disks_monitoring: 'off' },
  );
});

test('a scene action refuses a device of the wrong kind', async () => {
  await withCluster(async ({ gladys, config }) => {
    await assert.rejects(getBackupStatus(gladys, config, { device: GUEST_101 }), /is a VM\/LXC/);
    await assert.rejects(getGuestStatus(gladys, config, { device: NODE_1 }), /is a Proxmox node/);
    await assert.rejects(
      getBackupStatus(gladys, config, { device: 'ext:other:thing' }),
      /not a Proxmox device/,
    );
  });
});

test('get_guest_status hands the scene the state of a VM/LXC', async () => {
  await withCluster(async ({ gladys, config }) => {
    const outputs = await getGuestStatus(gladys, config, { device: GUEST_101 });
    assertDeclared('get_guest_status', outputs);
    assert.deepEqual(outputs, {
      status: 'running',
      running: true,
      name: 'nextcloud',
      node: 'pve1',
    });

    const gone = await getGuestStatus(gladys, config, {
      device: 'ext:proxmox:proxmox-guest:qemu-999',
    });
    assert.deepEqual(gone, { status: 'unknown', running: false });
  });
});

test('the refresh scene action counts what it read', async () => {
  await withCluster(async ({ gladys, config }) => {
    const outputs = await refreshForScene(gladys, config);
    assertDeclared('refresh', outputs);
    assert.deepEqual(outputs, {
      backups_ok: 1,
      backups_failed: 1,
      backups_unknown: 1,
      guests_running: 1,
      guests_not_running: 2,
      errors: 0,
    });
  });
});
