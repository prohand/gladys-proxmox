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
    lookback_hours: 48,
  });
  assert.equal(config.host, 'pve.lan');
  assert.equal(config.token_id, 'gladys@pve!tasks');
  assert.equal(config.lookback_hours, 48);
});

test('normalizeConfig coerces numeric strings coming from the form', () => {
  const config = normalizeConfig({ port: '8006', lookback_hours: '12', poll_frequency: '600' });
  assert.equal(config.port, 8006);
  assert.equal(config.lookback_hours, 12);
  assert.equal(config.poll_frequency, 600);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig clamps numbers to the manifest bounds', () => {
  const config = normalizeConfig({ poll_frequency: 5, lookback_hours: 100000, port: 0 });
  assert.equal(config.poll_frequency, 60);
  assert.equal(config.lookback_hours, 720);
  assert.equal(config.port, 1);
});

test('normalizeConfig falls back to the default for a non-numeric value', () => {
  assert.equal(normalizeConfig({ poll_frequency: 'soon' }).poll_frequency, 300);
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

test('failure_scope only accepts the two declared options', () => {
  assert.equal(
    normalizeConfig({ failure_scope: 'errors_and_warnings' }).failure_scope,
    'errors_and_warnings',
  );
  assert.equal(normalizeConfig({ failure_scope: 'anything-else' }).failure_scope, 'errors');
  assert.equal(normalizeConfig().failure_scope, 'errors');
});

test('splitList trims the entries and drops the empty ones', () => {
  assert.deepEqual(splitList(' pve1 , pve2 ,, '), ['pve1', 'pve2']);
  assert.deepEqual(splitList(''), []);
  assert.deepEqual(splitList(undefined), []);
});

test('isConfigured requires the host and both token fields', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ host: 'pve.lan', token_id: 'a@pve!b' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ host: 'pve.lan', token_id: 'a@pve!b', token_secret: 's' })),
    true,
  );
});
