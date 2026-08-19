// -----------------------------------------------------------------------------
// A throwaway HTTPS server that answers like a Proxmox VE node.
//
// The client is the one piece of this integration that cannot be tested by
// calling a pure function: TLS posture, the Authorization header, the status
// mapping and the query string only exist on the wire. So the tests put a real
// server on the wire — self-signed, exactly like a stock Proxmox node.
// -----------------------------------------------------------------------------

import https from 'node:https';
import { TEST_CERT, TEST_KEY } from '../fixtures/tls.js';

/**
 * Start a fake Proxmox node on an ephemeral port.
 * @param {object} routes - Map of `/api2/json` sub-path to a handler or a value.
 *   A handler receives `{ query, headers }` and returns `{ status?, data?, body? }`;
 *   anything else is served as the `data` member of a 200 answer.
 * @returns {Promise<object>} `{ port, requests, close() }`.
 */
export async function startFakeProxmox(routes) {
  const requests = [];

  const server = https.createServer({ cert: TEST_CERT, key: TEST_KEY }, (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    const path = url.pathname.replace(/^\/api2\/json/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    requests.push({ path, query, headers: req.headers });

    const route = routes[path];
    if (route === undefined) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: null, errors: { path: 'no such route' } }));
      return;
    }

    const answer =
      typeof route === 'function' ? route({ query, headers: req.headers }) : { data: route };
    const status = answer.status ?? 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      answer.body !== undefined ? answer.body : JSON.stringify({ data: answer.data ?? null }),
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
