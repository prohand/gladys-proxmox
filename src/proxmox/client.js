// -----------------------------------------------------------------------------
// Proxmox VE API client.
//
// Everything this integration does is a GET on the read-only part of the
// Proxmox VE REST API (`/api2/json/...`), authenticated with an API token:
//
//     Authorization: PVEAPIToken=<user>@<realm>!<tokenid>=<secret>
//
// Why `node:https` instead of the global `fetch`: Proxmox nodes ship a
// self-signed certificate by default, and pinning it (or explicitly accepting
// it) requires per-request TLS options that Node's global `fetch` does not
// expose without pulling `undici` in. `node:https` gives that control with no
// dependency at all.
//
// Only GET verbs live here: this integration never writes to Proxmox.
// -----------------------------------------------------------------------------

import https from 'node:https';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'proxmox-client' });

// A task page is a few hundred kilobytes at most; refuse to buffer more than
// this so a misconfigured host cannot balloon the container's memory.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * An error raised while talking to the Proxmox API.
 * `kind` is what the caller acts on; the message is what the user reads.
 */
export class ProxmoxError extends Error {
  /**
   * @param {string} kind - 'auth' | 'permission' | 'tls' | 'network' | 'timeout' | 'http' | 'parse'.
   * @param {string} message - Human-readable reason.
   * @param {object} [details] - Extra context.
   * @param {number} [details.status] - HTTP status code, when there was a response.
   * @param {string} [details.path] - API path that failed.
   */
  constructor(kind, message, { status, path } = {}) {
    super(message);
    this.name = 'ProxmoxError';
    this.kind = kind;
    this.status = status;
    this.path = path;
  }
}

/**
 * Normalize a certificate fingerprint for comparison: upper case, no
 * separators. Proxmox displays `AA:BB:...`, users paste all sorts of variants.
 * @param {string} fingerprint - Raw fingerprint.
 * @returns {string} Comparable form.
 */
export function normalizeFingerprint(fingerprint) {
  return String(fingerprint ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
}

/**
 * Decide how the TLS handshake must be validated, from the user configuration.
 *
 * Three mutually exclusive postures, in order of preference:
 *   - `fingerprint`: the certificate is checked against a pinned SHA-256
 *     fingerprint. The right answer for the default self-signed Proxmox
 *     certificate: the connection is authenticated, without a public CA.
 *   - `ca`: the standard chain-of-trust check (the node serves a certificate
 *     signed by a CA the container trusts).
 *   - `none`: no verification at all. Encrypted, but not authenticated.
 * @param {object} server - A configured server.
 * @returns {{mode: string, fingerprint: string}} The TLS posture.
 */
export function resolveTlsMode(server) {
  const fingerprint = normalizeFingerprint(server.tls_fingerprint);
  if (fingerprint.length > 0) {
    return { mode: 'fingerprint', fingerprint };
  }
  return { mode: server.tls_verify === false ? 'none' : 'ca', fingerprint: '' };
}

/**
 * Build the Authorization header value of a Proxmox API token.
 * @param {object} server - A configured server.
 * @returns {string} The `PVEAPIToken=...` header value.
 */
function authorizationHeader(server) {
  return `PVEAPIToken=${server.token_id}=${server.token_secret}`;
}

/**
 * Turn an HTTP status into the error the rest of the code reasons about.
 * The three interesting cases are distinguished on purpose: the user fixes
 * them in three very different places.
 * @param {number} status - HTTP status code.
 * @param {string} path - API path.
 * @param {string} body - Response body, used as a fallback message.
 * @returns {ProxmoxError} The mapped error.
 */
function httpError(status, path, body) {
  if (status === 401) {
    return new ProxmoxError(
      'auth',
      'Proxmox refused the API token (401): check the token ID and its secret.',
      { status, path },
    );
  }
  if (status === 403) {
    return new ProxmoxError(
      'permission',
      `Proxmox refused the request on ${path} (403): the token is missing the Sys.Audit ` +
        'privilege on that path (see the integration documentation).',
      { status, path },
    );
  }
  const excerpt = String(body ?? '').slice(0, 200);
  return new ProxmoxError('http', `Proxmox answered HTTP ${status} on ${path}. ${excerpt}`.trim(), {
    status,
    path,
  });
}

/**
 * Perform one authenticated GET on the Proxmox API and return its `data`.
 * @param {object} server - A configured server.
 * @param {string} path - API path below `/api2/json`, e.g. `/nodes`.
 * @param {Record<string, string|number>} [query] - Query string parameters.
 * @returns {Promise<unknown>} The `data` member of the Proxmox response.
 */
export function get(server, path, query = {}) {
  const tls = resolveTlsMode(server);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const queryString = search.toString();
  const fullPath = `/api2/json${path}${queryString ? `?${queryString}` : ''}`;

  logger.debug(`GET https://${server.host}:${server.port}${fullPath} (tls: ${tls.mode})`);

  return new Promise((resolve, reject) => {
    let settled = false;
    /**
     * Reject once, ignoring the late events that follow a destroyed request.
     * @param {Error} error - The failure.
     */
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const request = https.request(
      {
        host: server.host,
        port: server.port,
        path: fullPath,
        method: 'GET',
        // No connection pooling: the fingerprint below is checked on the TLS
        // handshake, and a pooled socket would skip it on reuse. A poll every
        // few minutes has nothing to gain from keep-alive anyway.
        agent: false,
        servername: server.host,
        // Pinning replaces the chain check: accept the handshake here, then
        // compare the certificate ourselves on `secureConnect` below.
        rejectUnauthorized: tls.mode === 'ca',
        headers: {
          Authorization: authorizationHeader(server),
          Accept: 'application/json',
          'User-Agent': 'gladys-proxmox-integration',
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            fail(
              new ProxmoxError('http', `Proxmox answer on ${path} exceeded the size limit.`, {
                path,
              }),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) {
            return;
          }
          const body = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            fail(httpError(status, path, body));
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            fail(
              new ProxmoxError('parse', `Proxmox answer on ${path} is not valid JSON.`, {
                status,
                path,
              }),
            );
            return;
          }
          settled = true;
          resolve(parsed?.data);
        });
        response.on('error', (error) =>
          fail(
            new ProxmoxError('network', `Proxmox answer on ${path} failed: ${error.message}`, {
              path,
            }),
          ),
        );
      },
    );

    if (tls.mode === 'fingerprint') {
      request.on('socket', (socket) => {
        socket.on('secureConnect', () => {
          const certificate = socket.getPeerCertificate();
          const presented = normalizeFingerprint(certificate?.fingerprint256);
          if (presented !== tls.fingerprint) {
            const error = new ProxmoxError(
              'tls',
              'The certificate presented by Proxmox does not match the pinned fingerprint ' +
                `(server: ${certificate?.fingerprint256 ?? 'none'}).`,
              { path },
            );
            fail(error);
            request.destroy(error);
          }
        });
      });
    }

    request.setTimeout(DEFAULT_TIMEOUT_MS, () => {
      const error = new ProxmoxError(
        'timeout',
        `Proxmox did not answer on ${path} within ${DEFAULT_TIMEOUT_MS / 1000} s.`,
        { path },
      );
      fail(error);
      request.destroy(error);
    });

    request.on('error', (error) => {
      if (error instanceof ProxmoxError) {
        fail(error);
        return;
      }
      // Self-signed certificate with neither a pinned fingerprint nor a
      // trusted CA: name the actual fix instead of leaking the raw Node code.
      if (
        error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        error.code === 'SELF_SIGNED_CERT_IN_CHAIN'
      ) {
        fail(
          new ProxmoxError(
            'tls',
            'Proxmox presents a self-signed certificate: pin its SHA-256 fingerprint in the ' +
              'integration configuration (or turn the TLS verification off on a trusted LAN).',
            { path },
          ),
        );
        return;
      }
      fail(
        new ProxmoxError(
          'network',
          `Cannot reach ${server.host}:${server.port} (${error.code ?? error.message}).`,
          {
            path,
          },
        ),
      );
    });

    request.end();
  });
}
