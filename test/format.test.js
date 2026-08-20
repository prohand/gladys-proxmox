import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATE_FORMATS,
  formatBackupStatus,
  formatBackupSummary,
  formatDuration,
  formatGuestStatus,
  formatLastBackup,
  formatSmartStatus,
  formatStatus,
  formatTimestamp,
  resolveDateFormat,
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
  // The default format is the day-first one, and it never names the zone.
  assert.equal(formatTimestamp(EPOCH, 'UTC'), '19/08/2026 00:00:00');
  // Europe/Paris is UTC+2 in August (CEST).
  assert.equal(formatTimestamp(EPOCH, 'Europe/Paris'), '19/08/2026 02:00:00');
  // America/New_York is UTC-4 in August (EDT): the previous day, locally.
  assert.equal(formatTimestamp(EPOCH, 'America/New_York'), '18/08/2026 20:00:00');
});

test('formatTimestamp orders the date fields the way the setting asks', () => {
  assert.equal(formatTimestamp(EPOCH, 'UTC', DATE_FORMATS.DAY_MONTH_YEAR), '19/08/2026 00:00:00');
  assert.equal(formatTimestamp(EPOCH, 'UTC', DATE_FORMATS.MONTH_DAY_YEAR), '08/19/2026 00:00:00');
  assert.equal(formatTimestamp(EPOCH, 'UTC', DATE_FORMATS.YEAR_MONTH_DAY), '2026-08-19 00:00:00');
  // The zone is named by the format that asks for it, never by the clock.
  assert.equal(
    formatTimestamp(EPOCH, 'UTC', DATE_FORMATS.YEAR_MONTH_DAY_TIMEZONE),
    '2026-08-19 00:00:00',
  );
  // A format nobody declared falls back to the default rather than breaking.
  assert.equal(formatTimestamp(EPOCH, 'UTC', 'klingon'), '19/08/2026 00:00:00');
});

test('resolveDateFormat only keeps a declared format', () => {
  assert.equal(resolveDateFormat(DATE_FORMATS.YEAR_MONTH_DAY), DATE_FORMATS.YEAR_MONTH_DAY);
  assert.equal(resolveDateFormat(' year_month_day '), DATE_FORMATS.YEAR_MONTH_DAY);
  assert.equal(resolveDateFormat(''), DATE_FORMATS.DAY_MONTH_YEAR);
  assert.equal(resolveDateFormat(undefined), DATE_FORMATS.DAY_MONTH_YEAR);
  assert.equal(resolveDateFormat('dd-mm'), DATE_FORMATS.DAY_MONTH_YEAR);
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

test('formatLastBackup writes the wall clock without repeating the time zone', () => {
  // The dashboard is read by someone who knows which zone they live in: the
  // zone is noise on every tile, so only the format that asks for it gets it.
  assert.equal(formatLastBackup(BACKUP, 'Europe/Paris'), '19/08/2026 02:00:00');
  assert.equal(formatLastBackup(BACKUP, 'UTC'), '19/08/2026 00:00:00');
  assert.equal(
    formatLastBackup(BACKUP, 'Europe/Paris', DATE_FORMATS.MONTH_DAY_YEAR),
    '08/19/2026 02:00:00',
  );
  assert.equal(
    formatLastBackup(BACKUP, 'Europe/Paris', DATE_FORMATS.YEAR_MONTH_DAY),
    '2026-08-19 02:00:00',
  );
  assert.equal(
    formatLastBackup(BACKUP, 'Europe/Paris', DATE_FORMATS.YEAR_MONTH_DAY_TIMEZONE),
    '2026-08-19 02:00:00 (Europe/Paris)',
  );
});

test('formatLastBackup says "unknown" when the node has no backup', () => {
  assert.equal(formatLastBackup(null, 'UTC'), UNKNOWN_TEXT);
  assert.equal(formatLastBackup({ starttime: null }, 'UTC'), UNKNOWN_TEXT);
});

test('formatBackupStatus gives the verdict AND the reason it failed', () => {
  assert.equal(formatBackupStatus(BACKUP), 'OK');
  assert.equal(
    formatBackupStatus({
      ...BACKUP,
      status: "command 'lvcreate' failed: exit code 5",
      statusType: 'error',
      success: false,
    }),
    "failed — command 'lvcreate' failed: exit code 5",
  );
  assert.equal(
    formatBackupStatus({ ...BACKUP, status: '', statusType: 'unknown', success: false }),
    'failed — no exit status (worker crashed?)',
  );
});

test('formatBackupStatus follows the configured success scope on warnings', () => {
  const warned = { ...BACKUP, status: 'WARNINGS: 2', statusType: 'warning' };
  // `success` is what `successStatusTypes()` decided from the configured scope.
  assert.equal(formatBackupStatus({ ...warned, success: false }), 'failed — WARNINGS: 2');
  assert.equal(formatBackupStatus({ ...warned, success: true }), 'OK');
});

test('formatBackupStatus says "unknown" when the node has no backup', () => {
  assert.equal(formatBackupStatus(null), UNKNOWN_TEXT);
});

test('formatGuestStatus keeps the Proxmox state word as it comes', () => {
  // A paused guest must not read like a stopped one, which is exactly what a
  // binary feature made of both.
  assert.equal(formatGuestStatus({ status: 'running', running: true }), 'running');
  assert.equal(formatGuestStatus({ status: 'stopped', running: false }), 'stopped');
  assert.equal(formatGuestStatus({ status: 'paused', running: false }), 'paused');
  assert.equal(formatGuestStatus({ status: '  ' }), UNKNOWN_TEXT);
  assert.equal(formatGuestStatus(null), UNKNOWN_TEXT);
});

test('formatBackupSummary shows when, how long and how it ended', () => {
  assert.equal(
    formatBackupSummary('pve1', BACKUP, 'UTC'),
    'pve1: 19/08/2026 00:00:00, 4 min 8 s, OK',
  );
  assert.equal(
    formatBackupSummary('pve1', BACKUP, 'UTC', DATE_FORMATS.YEAR_MONTH_DAY),
    'pve1: 2026-08-19 00:00:00, 4 min 8 s, OK',
  );
});

test('formatSmartStatus gives the verdict AND names the failing disks', () => {
  const healthy = [
    { devpath: '/dev/sda', health: 'PASSED', healthy: true },
    { devpath: '/dev/nvme0n1', health: 'PASSED', healthy: true },
  ];
  assert.equal(formatSmartStatus(healthy), 'OK (2 disks)');
  assert.equal(formatSmartStatus([healthy[0]]), 'OK (1 disk)');

  // The disk, and what smartctl said about it: "not on" would send the user
  // hunting through the Proxmox interface for which disk is dying.
  assert.equal(
    formatSmartStatus([...healthy, { devpath: '/dev/sdb', health: 'FAILED', healthy: false }]),
    'failed — /dev/sdb: FAILED',
  );

  // A disk with no verdict is not a failing disk: it is counted apart.
  assert.equal(
    formatSmartStatus([...healthy, { devpath: '/dev/sdc', health: '', healthy: null }]),
    'OK (2 disks), 1 unknown: /dev/sdc',
  );
});

test('formatSmartStatus says "unknown" when nothing could be read', () => {
  assert.equal(formatSmartStatus([]), UNKNOWN_TEXT);
  assert.equal(formatSmartStatus(null), UNKNOWN_TEXT);
  assert.equal(
    formatSmartStatus([{ devpath: '/dev/sda', health: 'UNKNOWN', healthy: null }]),
    UNKNOWN_TEXT,
  );
});

test('formatBackupSummary drops the duration of a backup that never ended', () => {
  const crashed = { ...BACKUP, endtime: null, duration: null, status: '', statusType: 'unknown' };
  assert.equal(
    formatBackupSummary('pve1', crashed, 'UTC'),
    'pve1: 19/08/2026 00:00:00, no exit status (worker crashed?)',
  );
});

test('formatBackupSummary says so plainly when there is no backup at all', () => {
  assert.equal(formatBackupSummary('pve2', null, 'UTC'), 'pve2: no backup');
});
