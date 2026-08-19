import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig, splitList } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps the user values over the defaults', () => {
  const config = normalizeConfig({
    host: 'pve.lan',
    port: 8006,
    token_id: 'gladys@pve!tasks',
    token_secret: 'secret',
    backup_lookback_days: 30,
  });
  assert.equal(config.host, 'pve.lan');
  assert.equal(config.token_id, 'gladys@pve!tasks');
  assert.equal(config.backup_lookback_days, 30);
});

test('normalizeConfig coerces numeric strings coming from the form', () => {
  const config = normalizeConfig({
    port: '8006',
    backup_lookback_days: '14',
    poll_frequency: '600',
  });
  assert.equal(config.port, 8006);
  assert.equal(config.backup_lookback_days, 14);
  assert.equal(config.poll_frequency, 600);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig clamps numbers to the manifest bounds', () => {
  const config = normalizeConfig({ poll_frequency: 5, backup_lookback_days: 100000, port: 0 });
  assert.equal(config.poll_frequency, 60);
  assert.equal(config.backup_lookback_days, 365);
  assert.equal(config.port, 1);
});

test('normalizeConfig falls back to the default for a non-numeric value', () => {
  assert.equal(normalizeConfig({ poll_frequency: 'soon' }).poll_frequency, 300);
  assert.equal(normalizeConfig({ backup_lookback_days: 'a week' }).backup_lookback_days, 7);
});

test('normalizeConfig trims the credential fields', () => {
  const config = normalizeConfig({
    host: '  pve.lan  ',
    token_id: ' a@pve!b ',
    token_secret: ' s ',
  });
  assert.equal(config.host, 'pve.lan');
  assert.equal(config.token_id, 'a@pve!b');
  assert.equal(config.token_secret, 's');
});

test('only an explicit false turns the TLS verification off', () => {
  assert.equal(normalizeConfig().tls_verify, true);
  assert.equal(normalizeConfig({ tls_verify: undefined }).tls_verify, true);
  assert.equal(normalizeConfig({ tls_verify: true }).tls_verify, true);
  assert.equal(normalizeConfig({ tls_verify: false }).tls_verify, false);
});

test('backup_success_scope only accepts the two declared options', () => {
  assert.equal(
    normalizeConfig({ backup_success_scope: 'ok_and_warnings' }).backup_success_scope,
    'ok_and_warnings',
  );
  assert.equal(
    normalizeConfig({ backup_success_scope: 'anything-else' }).backup_success_scope,
    'ok_only',
  );
  assert.equal(normalizeConfig().backup_success_scope, 'ok_only');
});

test('splitList trims the entries and drops the empty ones', () => {
  assert.deepEqual(splitList(' pve1 , pve2 ,, '), ['pve1', 'pve2']);
  assert.deepEqual(splitList(''), []);
  assert.deepEqual(splitList(undefined), []);
});

test('the second server block is normalized exactly like the first', () => {
  const config = normalizeConfig({
    host_2: '  pve2.lan  ',
    port_2: '8007',
    token_id_2: ' b@pve!c ',
    token_secret_2: ' s2 ',
    tls_verify_2: false,
    nodes_filter_2: ' pveB ',
  });
  assert.equal(config.host_2, 'pve2.lan');
  assert.equal(config.port_2, 8007);
  assert.equal(config.token_id_2, 'b@pve!c');
  assert.equal(config.token_secret_2, 's2');
  assert.equal(config.tls_verify_2, false);
  assert.equal(config.nodes_filter_2, 'pveB');
  // The two blocks are independent: filling the second one changes nothing of
  // the first.
  assert.equal(config.host, '');
  assert.equal(config.tls_verify, true);
});

test('an untouched second block keeps its defaults', () => {
  const config = normalizeConfig({ host: 'pve.lan', token_id: 'a@pve!b', token_secret: 's' });
  assert.equal(config.host_2, '');
  assert.equal(config.port_2, 8006);
  assert.equal(config.tls_verify_2, true);
  assert.equal(config.label_2, '');
});

test('isConfigured requires the host and both token fields', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ host: 'pve.lan', token_id: 'a@pve!b' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ host: 'pve.lan', token_id: 'a@pve!b', token_secret: 's' })),
    true,
  );
});
