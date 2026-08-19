import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  formatFailureDetails,
  formatStatus,
  formatTaskLabel,
  formatTimestamp,
  MAX_DETAILS_LENGTH,
  resolveTimezone,
} from '../src/format.js';
import { normalizeConfig } from '../src/config.js';

// 2026-08-19 00:00:00 UTC
const EPOCH = 1787097600;

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

test('formatTaskLabel appends the guest id when there is one', () => {
  assert.equal(formatTaskLabel({ type: 'vzdump', id: '101' }), 'vzdump (101)');
  assert.equal(formatTaskLabel({ type: 'srvreload', id: '' }), 'srvreload');
});

const config = normalizeConfig({
  timezone: 'Europe/Paris',
  lookback_hours: 24,
  max_failures_listed: 2,
});

test('formatFailureDetails says so plainly when nothing failed', () => {
  const text = formatFailureDetails({ node: 'pve1', tasks: [], config });
  assert.equal(text, 'No failed task on pve1 in the last 24 h.');
});

test('formatFailureDetails reports type, both timestamps, duration and status', () => {
  const tasks = [
    {
      type: 'vzdump',
      id: '101',
      starttime: EPOCH,
      endtime: EPOCH + 248,
      status: "command 'lvcreate' failed: exit code 5",
      statusType: 'error',
    },
  ];
  const text = formatFailureDetails({ node: 'pve1', tasks, config });
  assert.match(text, /^1 failed task on pve1 in the last 24 h \(times in Europe\/Paris\):/);
  assert.match(text, /• vzdump \(101\)/);
  assert.match(text, /2026-08-19 02:00:00 → 2026-08-19 02:04:08 \(4 min 8 s\)/);
  assert.match(text, /status: command 'lvcreate' failed: exit code 5/);
});

test('formatFailureDetails lists at most max_failures_listed and counts the rest', () => {
  const tasks = [1, 2, 3, 4, 5].map((index) => ({
    type: 'vzdump',
    id: String(100 + index),
    starttime: EPOCH - index * 60,
    endtime: EPOCH - index * 60 + 10,
    status: 'failed',
    statusType: 'error',
  }));
  const text = formatFailureDetails({ node: 'pve1', tasks, config });
  assert.match(text, /^5 failed tasks on pve1/);
  assert.equal(text.match(/• vzdump/g).length, 2);
  assert.match(text, /… and 3 more failure\(s\) in the window\./);
});

test('formatFailureDetails renders a task that never ended', () => {
  const tasks = [
    {
      type: 'qmigrate',
      id: '110',
      starttime: EPOCH,
      endtime: null,
      status: '',
      statusType: 'unknown',
    },
  ];
  const text = formatFailureDetails({ node: 'pve1', tasks, config });
  assert.match(text, /2026-08-19 02:00:00 → —/);
  assert.match(text, /status: no exit status \(worker crashed\?\)/);
});

test('formatFailureDetails stays within the length cap', () => {
  const tasks = Array.from({ length: 20 }, (_, index) => ({
    type: 'vzdump',
    id: String(index),
    starttime: EPOCH - index,
    endtime: EPOCH - index + 1,
    status: 'x'.repeat(150),
    statusType: 'error',
  }));
  const wide = normalizeConfig({ timezone: 'UTC', max_failures_listed: 20 });
  const text = formatFailureDetails({ node: 'pve1', tasks, config: wide });
  assert.ok(text.length <= MAX_DETAILS_LENGTH, `text is ${text.length} chars`);
});
