// -----------------------------------------------------------------------------
// The guest key: what a Gladys external id of a VM/LXC is built on, and the
// guest list cache.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearGuestsCache,
  fetchGuests,
  guestKey,
  GUESTS_CACHE_TTL_MS,
  parseGuestKey,
} from '../src/proxmox/guests.js';
import { normalizeConfig } from '../src/config.js';
import { listServers } from '../src/servers.js';
import { startFakeProxmox } from './helpers/fakeProxmox.js';
import { TEST_FINGERPRINT } from './fixtures/tls.js';

test('a guest key pairs the guest kind with its VMID', () => {
  assert.equal(guestKey('qemu', 101), 'qemu-101');
  assert.equal(guestKey('lxc', '200'), 'lxc-200');
});

test('parseGuestKey round-trips a key it built', () => {
  assert.deepEqual(parseGuestKey(guestKey('qemu', 101)), { kind: 'qemu', vmid: 101 });
  assert.deepEqual(parseGuestKey(guestKey('lxc', 200)), { kind: 'lxc', vmid: 200 });
});

test('parseGuestKey rejects anything that is not one of ours', () => {
  assert.equal(parseGuestKey('vm-101'), null);
  assert.equal(parseGuestKey('qemu-'), null);
  assert.equal(parseGuestKey('qemu-abc'), null);
  assert.equal(parseGuestKey(''), null);
  assert.equal(parseGuestKey(undefined), null);
});

test('one snapshot serves a whole poll round, and every interval reads a fresh one', async (t) => {
  const proxmox = await startFakeProxmox({
    '/cluster/resources': [{ type: 'qemu', vmid: 101, node: 'pve1', status: 'running' }],
  });
  t.after(() => proxmox.close());
  const [server] = listServers(
    normalizeConfig({
      host: '127.0.0.1',
      port: proxmox.port,
      token_id: 'gladys@pve!tasks',
      token_secret: 's3cret',
      tls_fingerprint: TEST_FINGERPRINT,
    }),
  );
  clearGuestsCache();
  t.after(() => clearGuestsCache());
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

  const reads = () => proxmox.requests.length;
  await fetchGuests(server);
  // Late in a slow round of the one-minute loop: still the same snapshot.
  t.mock.timers.tick(40_000);
  await fetchGuests(server);
  assert.equal(reads(), 1);

  // The shortest interval (60 s, polled up to 5 s early) always reads afresh.
  assert.ok(GUESTS_CACHE_TTL_MS < 55_000);
  t.mock.timers.tick(15_000);
  await fetchGuests(server);
  assert.equal(reads(), 2);
});
