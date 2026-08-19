// -----------------------------------------------------------------------------
// Turning the flat configuration form into a list of Proxmox servers, and the
// scoping of the external ids that keeps their devices apart.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  hasConfiguredServer,
  listServers,
  parseScopedId,
  scopeId,
  serverById,
} from '../src/servers.js';

const FIRST = { host: 'pve.lan', token_id: 'a@pve!b', token_secret: 's' };
const SECOND = { host_2: 'pve2.lan', token_id_2: 'c@pve!d', token_secret_2: 's2' };

test('a configuration with one filled block yields one server', () => {
  const servers = listServers(normalizeConfig(FIRST));
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, 1);
  assert.equal(servers[0].host, 'pve.lan');
  // The historical device-name prefix, so nothing is renamed by this feature.
  assert.equal(servers[0].label, 'Proxmox');
});

test('a filled second block yields a second, independent server', () => {
  const servers = listServers(
    normalizeConfig({ ...FIRST, ...SECOND, port_2: 8007, nodes_filter_2: 'pveB' }),
  );
  assert.deepEqual(
    servers.map((server) => [server.id, server.host, server.port, server.label]),
    [
      [1, 'pve.lan', 8006, 'Proxmox'],
      [2, 'pve2.lan', 8007, 'Proxmox 2'],
    ],
  );
  assert.equal(servers[1].token_id, 'c@pve!d');
  assert.equal(servers[1].nodes_filter, 'pveB');
  assert.equal(servers[0].nodes_filter, '');
});

test('the user labels override the defaults', () => {
  const servers = listServers(
    normalizeConfig({ ...FIRST, ...SECOND, label: 'Home', label_2: 'Office' }),
  );
  assert.deepEqual(
    servers.map((server) => server.label),
    ['Home', 'Office'],
  );
});

test('every server carries the settings shared by both', () => {
  const servers = listServers(
    normalizeConfig({ ...FIRST, ...SECOND, backup_lookback_days: 30, poll_frequency: 600 }),
  );
  for (const server of servers) {
    assert.equal(server.backup_lookback_days, 30);
    assert.equal(server.poll_frequency, 600);
  }
});

test('an incomplete block is not a server', () => {
  // Host without credentials: half-typed, not configured.
  const servers = listServers(normalizeConfig({ ...FIRST, host_2: 'pve2.lan' }));
  assert.equal(servers.length, 1);
  assert.equal(hasConfiguredServer(normalizeConfig({ ...FIRST })), true);
  assert.equal(hasConfiguredServer(normalizeConfig()), false);
});

test('only the second block filled in still gives a working server', () => {
  const servers = listServers(normalizeConfig(SECOND));
  assert.deepEqual(
    servers.map((server) => server.id),
    [2],
  );
});

test('serverById only returns configured servers', () => {
  const config = normalizeConfig(FIRST);
  assert.equal(serverById(config, 1).host, 'pve.lan');
  assert.equal(serverById(config, 2), null);
});

test('the first server keeps unscoped ids, the second gets scoped ones', () => {
  // The unscoped form is what every single-Proxmox installation already stores:
  // scoping it would orphan every device it has.
  assert.equal(scopeId(1, 'pve1'), 'pve1');
  assert.equal(scopeId(1, 'qemu-101'), 'qemu-101');
  assert.equal(scopeId(2, 'pve1'), '2@pve1');
  assert.equal(scopeId(2, 'qemu-101'), '2@qemu-101');
});

test('parseScopedId round-trips what scopeId built', () => {
  assert.deepEqual(parseScopedId(scopeId(1, 'pve1')), { serverId: 1, localId: 'pve1' });
  assert.deepEqual(parseScopedId(scopeId(2, 'lxc-200')), { serverId: 2, localId: 'lxc-200' });
});

test('a scope with nothing behind it has no local part', () => {
  assert.deepEqual(parseScopedId('2@'), { serverId: 2, localId: '' });
});

test('an unscoped id belongs to the first server', () => {
  assert.deepEqual(parseScopedId('pve-a:b'), { serverId: 1, localId: 'pve-a:b' });
  assert.deepEqual(parseScopedId(''), { serverId: 1, localId: '' });
  assert.deepEqual(parseScopedId(undefined), { serverId: 1, localId: '' });
});
