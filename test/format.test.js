import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBackupSummary,
  formatDuration,
  formatLastBackup,
  formatStatus,
  formatTimestamp,
  resolveTimezone,
  UNKNOWN_TEXT,
} from '../src/format.js';

// 2026-08-19 00:00:00 UTC
const EPOCH = 1787097600;

const BACKUP = {
  type: 'vzdump',
  id: '101',
  starttime: EPOCH,
  endtime: EPOCH + 248,
  duration: 248,
  status: 'OK',
  statusType: 'ok',
  success: true,
};

test('formatTimestamp renders the epoch in the requested time zone', () => {
  assert.equal(formatTimestamp(EPOCH, 'UTC'), '2026-08-19 00:00:00');
  // Europe/Paris is UTC+2 in August (CEST).
  assert.equal(formatTimestamp(EPOCH, 'Europe/Paris'), '2026-08-19 02:00:00');
  // America/New_York is UTC-4 in August (EDT): the previous day, locally.
  assert.equal(formatTimestamp(EPOCH, 'America/New_York'), '2026-08-18 20:00:00');
});

test('formatTimestamp renders an unknown timestamp as a dash', () => {
  assert.equal(formatTimestamp(null, 'UTC'), '—');
  assert.equal(formatTimestamp(undefined, 'UTC'), '—');
});

test('resolveTimezone falls back to the host zone for an empty or bogus value', () => {
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  assert.equal(resolveTimezone(''), hostZone);
  assert.equal(resolveTimezone('   '), hostZone);
  assert.equal(resolveTimezone('Mars/Olympus_Mons'), hostZone);
  assert.equal(resolveTimezone('Europe/Paris'), 'Europe/Paris');
});

test('formatDuration stays readable at every scale', () => {
  assert.equal(formatDuration(0), '0 s');
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(60), '1 min');
  assert.equal(formatDuration(248), '4 min 8 s');
  assert.equal(formatDuration(3600), '1 h');
  assert.equal(formatDuration(5400), '1 h 30 min');
  assert.equal(formatDuration(null), '');
});

test('formatStatus names the status-less case instead of showing nothing', () => {
  assert.equal(formatStatus('OK', 'ok'), 'OK');
  assert.equal(formatStatus('', 'unknown'), 'no exit status (worker crashed?)');
  assert.ok(formatStatus('x'.repeat(500), 'error').length <= 160);
});

test('formatLastBackup names the time zone the wall clock belongs to', () => {
  assert.equal(formatLastBackup(BACKUP, 'Europe/Paris'), '2026-08-19 02:00:00 (Europe/Paris)');
  assert.equal(formatLastBackup(BACKUP, 'UTC'), '2026-08-19 00:00:00 (UTC)');
});

test('formatLastBackup says "unknown" when the node has no backup', () => {
  assert.equal(formatLastBackup(null, 'UTC'), UNKNOWN_TEXT);
  assert.equal(formatLastBackup({ starttime: null }, 'UTC'), UNKNOWN_TEXT);
});

test('formatBackupSummary shows when, how long and how it ended', () => {
  assert.equal(
    formatBackupSummary('pve1', BACKUP, 'UTC'),
    'pve1: 2026-08-19 00:00:00, 4 min 8 s, OK',
  );
});

test('formatBackupSummary drops the duration of a backup that never ended', () => {
  const crashed = { ...BACKUP, endtime: null, duration: null, status: '', statusType: 'unknown' };
  assert.equal(
    formatBackupSummary('pve1', crashed, 'UTC'),
    'pve1: 2026-08-19 00:00:00, no exit status (worker crashed?)',
  );
});

test('formatBackupSummary says so plainly when there is no backup at all', () => {
  assert.equal(formatBackupSummary('pve2', null, 'UTC'), 'pve2: no backup');
});
