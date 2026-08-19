// -----------------------------------------------------------------------------
// The classification rules that decide what "a failed task" means.
// They mirror Proxmox's own `PVE::UPID::normalize_status_type`, so they are
// pinned here: a drift would silently change what the counter counts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingStatusTypes, normalizeStatusType } from '../src/proxmox/tasks.js';

test('normalizeStatusType classifies a status like Proxmox does', () => {
  assert.equal(normalizeStatusType('OK'), 'ok');
  assert.equal(normalizeStatusType('WARNINGS: 3'), 'warning');
  assert.equal(normalizeStatusType('unexpected status'), 'unknown');
  assert.equal(normalizeStatusType(''), 'unknown');
  assert.equal(normalizeStatusType(undefined), 'unknown');
  assert.equal(normalizeStatusType("command 'lvcreate' failed: exit code 5"), 'error');
});

test('a status that merely mentions warnings is an error, not a warning', () => {
  // Only the exact "WARNINGS: <n>" shape is a warning for Proxmox.
  assert.equal(normalizeStatusType('WARNINGS: many'), 'error');
  assert.equal(normalizeStatusType('job failed with WARNINGS: 2'), 'error');
});

test('the default scope counts errors and status-less tasks, not warnings', () => {
  const failing = failingStatusTypes('errors');
  assert.equal(failing.has('error'), true);
  assert.equal(failing.has('unknown'), true);
  assert.equal(failing.has('warning'), false);
  assert.equal(failing.has('ok'), false);
});

test('the wide scope also counts warnings', () => {
  const failing = failingStatusTypes('errors_and_warnings');
  assert.equal(failing.has('warning'), true);
  assert.equal(failing.has('error'), true);
  assert.equal(failing.has('ok'), false);
});
