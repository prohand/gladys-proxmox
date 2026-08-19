import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, normalizeFingerprint, ProxmoxError, resolveTlsMode } from '../src/proxmox/client.js';
import { normalizeConfig } from '../src/config.js';
import { startFakeProxmox } from './helpers/fakeProxmox.js';
import { TEST_FINGERPRINT } from './fixtures/tls.js';

/**
 * Build a configuration pointing at a fake node, pinned on its certificate.
 * @param {number} port - Port of the fake node.
 * @param {object} [overrides] - Extra config keys.
 * @returns {object} A normalized configuration.
 */
function configFor(port, overrides = {}) {
  return normalizeConfig({
    host: '127.0.0.1',
    port,
    token_id: 'gladys@pve!tasks',
    token_secret: 's3cret',
    tls_fingerprint: TEST_FINGERPRINT,
    ...overrides,
  });
}

test('normalizeFingerprint accepts every form users paste', () => {
  assert.equal(normalizeFingerprint('aa:bb:cc'), 'AABBCC');
  assert.equal(normalizeFingerprint('AA BB CC'), 'AABBCC');
  assert.equal(normalizeFingerprint('aabbcc'), 'AABBCC');
  assert.equal(normalizeFingerprint(undefined), '');
});

test('resolveTlsMode prefers pinning, then the chain of trust', () => {
  assert.equal(resolveTlsMode(normalizeConfig({ tls_fingerprint: 'aa:bb' })).mode, 'fingerprint');
  // Pinning wins even when the chain check is also on: it IS the check.
  assert.equal(
    resolveTlsMode(normalizeConfig({ tls_fingerprint: 'aa:bb', tls_verify: true })).mode,
    'fingerprint',
  );
  assert.equal(resolveTlsMode(normalizeConfig({})).mode, 'ca');
  assert.equal(resolveTlsMode(normalizeConfig({ tls_verify: false })).mode, 'none');
});

test('a pinned certificate is accepted and the API token is sent', async () => {
  const server = await startFakeProxmox({ '/nodes': [{ node: 'pve1', status: 'online' }] });
  try {
    const data = await get(configFor(server.port), '/nodes');
    assert.deepEqual(data, [{ node: 'pve1', status: 'online' }]);
    assert.equal(server.requests[0].headers.authorization, 'PVEAPIToken=gladys@pve!tasks=s3cret');
  } finally {
    await server.close();
  }
});

test('a certificate that does not match the pin is refused', async () => {
  const server = await startFakeProxmox({ '/nodes': [] });
  try {
    const config = configFor(server.port, { tls_fingerprint: 'AA:BB:CC:DD' });
    await assert.rejects(get(config, '/nodes'), (error) => {
      assert.ok(error instanceof ProxmoxError);
      assert.equal(error.kind, 'tls');
      return true;
    });
  } finally {
    await server.close();
  }
});

test('a self-signed certificate without a pin is refused, with an actionable message', async () => {
  const server = await startFakeProxmox({ '/nodes': [] });
  try {
    const config = configFor(server.port, { tls_fingerprint: '' });
    await assert.rejects(get(config, '/nodes'), (error) => {
      assert.equal(error.kind, 'tls');
      assert.match(error.message, /fingerprint/i);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('turning the verification off accepts the self-signed certificate', async () => {
  const server = await startFakeProxmox({ '/nodes': [{ node: 'pve1' }] });
  try {
    const config = configFor(server.port, { tls_fingerprint: '', tls_verify: false });
    assert.deepEqual(await get(config, '/nodes'), [{ node: 'pve1' }]);
  } finally {
    await server.close();
  }
});

test('a 401 is reported as an authentication problem', async () => {
  const server = await startFakeProxmox({ '/nodes': () => ({ status: 401 }) });
  try {
    await assert.rejects(get(configFor(server.port), '/nodes'), (error) => {
      assert.equal(error.kind, 'auth');
      assert.equal(error.status, 401);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('a 403 is reported as a permission problem naming Sys.Audit', async () => {
  const server = await startFakeProxmox({ '/nodes/pve1/status': () => ({ status: 403 }) });
  try {
    await assert.rejects(get(configFor(server.port), '/nodes/pve1/status'), (error) => {
      assert.equal(error.kind, 'permission');
      assert.match(error.message, /Sys\.Audit/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('a non-JSON answer is reported rather than thrown raw', async () => {
  const server = await startFakeProxmox({ '/nodes': () => ({ body: '<html>login</html>' }) });
  try {
    await assert.rejects(get(configFor(server.port), '/nodes'), (error) => {
      assert.equal(error.kind, 'parse');
      return true;
    });
  } finally {
    await server.close();
  }
});

test('an unreachable host is reported as a network problem', async () => {
  // Port 1 on the loopback: nothing listens there.
  await assert.rejects(get(configFor(1), '/nodes'), (error) => {
    assert.equal(error.kind, 'network');
    return true;
  });
});

test('empty query parameters are dropped from the URL', async () => {
  const server = await startFakeProxmox({ '/nodes': [] });
  try {
    await get(configFor(server.port), '/nodes', { errors: 1, limit: 200, userfilter: '' });
    assert.deepEqual(server.requests[0].query, { errors: '1', limit: '200' });
  } finally {
    await server.close();
  }
});
