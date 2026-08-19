// -----------------------------------------------------------------------------
// The guest key: what a Gladys external id of a VM/LXC is built on.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestKey, parseGuestKey } from '../src/proxmox/guests.js';

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
