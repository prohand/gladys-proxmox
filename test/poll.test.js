import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimPoll,
  devicePollFrequency,
  GLADYS_POLL_FREQUENCIES,
  resetPollThrottle,
} from '../src/poll.js';

beforeEach(() => {
  resetPollThrottle();
});

test('the declared frequency is always one Gladys accepts', () => {
  // The values Gladys validates against (`DEVICE_POLL_FREQUENCIES` in the
  // core), in milliseconds. Anything else makes it reject the WHOLE publish
  // with "devices[0].poll_frequency: invalid poll frequency".
  assert.deepEqual(GLADYS_POLL_FREQUENCIES, [1000, 2000, 10000, 15000, 30000, 60000]);

  for (const seconds of [60, 120, 300, 900, 3600]) {
    assert.ok(
      GLADYS_POLL_FREQUENCIES.includes(devicePollFrequency(seconds)),
      `${seconds}s must map to an accepted frequency`,
    );
  }
});

test('an interval Gladys cannot express falls back to its slowest frequency', () => {
  // Every configured interval is at least a minute, and a minute is the
  // slowest Gladys knows: the rest of the wait is ours to enforce.
  assert.equal(devicePollFrequency(300), 60000);
  assert.equal(devicePollFrequency(3600), 60000);
  assert.equal(devicePollFrequency(60), 60000);
});

test('a shorter interval takes the closest frequency without overshooting it', () => {
  assert.equal(devicePollFrequency(30), 30000);
  assert.equal(devicePollFrequency(20), 15000);
  assert.equal(devicePollFrequency(1), 1000);
  // Below the fastest Gladys offers, and on garbage: still a valid value.
  assert.equal(devicePollFrequency(0.5), 1000);
  assert.equal(devicePollFrequency('soon'), 60000);
});

test('a poll arriving before the configured interval is skipped', () => {
  const id = 'ext:proxmox:proxmox-node:pve1';
  const start = 1_000_000;

  assert.equal(claimPoll(id, 300, start), true, 'the first poll always goes through');
  // Gladys keeps calling every minute: four of those five are ours to drop.
  assert.equal(claimPoll(id, 300, start + 60_000), false);
  assert.equal(claimPoll(id, 300, start + 120_000), false);
  assert.equal(claimPoll(id, 300, start + 180_000), false);
  assert.equal(claimPoll(id, 300, start + 240_000), false);
  assert.equal(claimPoll(id, 300, start + 300_000), true);
  // ...and the schedule restarts from there, not from the first poll.
  assert.equal(claimPoll(id, 300, start + 360_000), false);
});

test('a tick arriving slightly early still counts, instead of drifting a period', () => {
  const id = 'ext:proxmox:proxmox-guest:qemu-101';
  assert.equal(claimPoll(id, 60, 0), true);
  // A 60 s interval polled on a 60 s tick: without tolerance, one early tick
  // would push every read to the next one and turn it into 120 s.
  assert.equal(claimPoll(id, 60, 59_000), true);
});

test('each device carries its own schedule', () => {
  assert.equal(claimPoll('ext:proxmox:proxmox-node:pve1', 300, 0), true);
  assert.equal(claimPoll('ext:proxmox:proxmox-node:pve2', 300, 0), true);
  assert.equal(claimPoll('ext:proxmox:proxmox-node:pve1', 300, 60_000), false);
});

test('a discovery clears the schedule so the next poll reads at once', () => {
  assert.equal(claimPoll('ext:proxmox:proxmox-node:pve1', 300, 0), true);
  resetPollThrottle();
  assert.equal(claimPoll('ext:proxmox:proxmox-node:pve1', 300, 1000), true);
});
