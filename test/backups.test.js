// -----------------------------------------------------------------------------
// The classification rules that decide whether a backup succeeded.
// They mirror Proxmox's own `PVE::UPID::normalize_status_type`, so they are
// pinned here: a drift would silently flip the "Backup status" feature.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatusType, successStatusTypes } from '../src/proxmox/backups.js';

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

test('the default scope calls a backup successful only when it ended OK', () => {
  const success = successStatusTypes('ok_only');
  assert.equal(success.has('ok'), true);
  assert.equal(success.has('warning'), false);
  assert.equal(success.has('error'), false);
  assert.equal(success.has('unknown'), false);
});

test('the wide scope also accepts a backup that ended with warnings', () => {
  const success = successStatusTypes('ok_and_warnings');
  assert.equal(success.has('ok'), true);
  assert.equal(success.has('warning'), true);
  assert.equal(success.has('error'), false);
  // A task that left no exit status behind is a crashed worker, never a
  // success, whatever the scope.
  assert.equal(success.has('unknown'), false);
});
