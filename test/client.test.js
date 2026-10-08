import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  get,
  networkError,
  normalizeFingerprint,
  ProxmoxError,
  resolveTlsMode,
  tlsServername,
} from '../src/proxmox/client.js';
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
    // The pin is checked on the handshake, before anything is sent: the API
    // token never reached the impostor.
    assert.equal(server.requests.length, 0, 'no request reached the server');
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

test('a refused connection names the port, not the network', async () => {
  // Port 1 on the loopback: something answers for the address, nothing listens.
  await assert.rejects(get(configFor(1), '/nodes'), (error) => {
    assert.equal(error.kind, 'network');
    assert.match(error.message, /refused the connection/);
    return true;
  });
});

test('networkError names the fix behind each socket error code', () => {
  const server = { host: 'pve.lan', port: 8006 };

  // A host field holding a URL fails DNS resolution: point at the field, not
  // at the network.
  for (const code of ['EAI_AGAIN', 'ENOTFOUND']) {
    const error = networkError(server, '/nodes', Object.assign(new Error('getaddrinfo'), { code }));
    assert.equal(error.kind, 'network');
    assert.equal(error.path, '/nodes');
    assert.match(error.message, /Cannot resolve the host name "pve.lan"/);
    assert.match(error.message, new RegExp(code));
  }

  const refused = networkError(
    server,
    '/nodes',
    Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
  );
  assert.match(refused.message, /pve.lan:8006 refused the connection/);
  assert.match(refused.message, /8006/);

  const unreachable = networkError(
    server,
    '/nodes',
    Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }),
  );
  assert.match(unreachable.message, /unreachable \(EHOSTUNREACH\)/);

  const other = networkError(
    server,
    '/nodes',
    Object.assign(new Error('x'), { code: 'ECONNRESET' }),
  );
  assert.match(other.message, /Cannot reach pve.lan:8006 \(ECONNRESET\)/);
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

test('a host that trickles its answer is cut off by the total deadline', async () => {
  let timer;
  const server = await startFakeProxmox({
    '/nodes': () => ({
      raw(res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // A byte every 50 ms: the idle timeout never trips.
        timer = setInterval(() => res.write(' '), 50);
        res.on('close', () => clearInterval(timer));
      },
    }),
  });
  try {
    const started = Date.now();
    await assert.rejects(
      get(configFor(server.port), '/nodes', {}, { idleTimeoutMs: 200, totalTimeoutMs: 600 }),
      (error) => {
        assert.ok(error instanceof ProxmoxError);
        assert.equal(error.kind, 'timeout');
        assert.match(error.message, /did not finish answering on \/nodes within 0.6 s/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5000);
  } finally {
    clearInterval(timer);
    await server.close();
  }
});

test('a silent host still trips the idle timeout', async () => {
  const server = await startFakeProxmox({
    '/nodes': () => ({ raw: () => {} }),
  });
  try {
    await assert.rejects(
      get(configFor(server.port), '/nodes', {}, { idleTimeoutMs: 200, totalTimeoutMs: 5000 }),
      (error) => {
        assert.equal(error.kind, 'timeout');
        assert.match(error.message, /did not answer on \/nodes within 0.2 s/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('no TLS server name is sent for an IP address', async () => {
  assert.equal(tlsServername('192.168.1.10'), undefined);
  assert.equal(tlsServername('fe80::1'), undefined);
  assert.equal(tlsServername('pve.lan'), 'pve.lan');

  // On the wire: SNI only carries host names, and Node warns (DEP0123) when
  // handed an IP address.
  const server = await startFakeProxmox({ '/nodes': [] });
  try {
    await get(configFor(server.port), '/nodes');
    assert.equal(server.requests[0].servername, false);
  } finally {
    await server.close();
  }
});
