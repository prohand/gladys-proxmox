# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 20+, ESM, zero runtime deps
beyond `@gladysassistant/integration-sdk`) that reads one or two Proxmox VE
clusters and publishes one Gladys device per node (last `vzdump` backup:
timestamp, duration, success) and one per VM/LXC (running or not). It runs as a
sandboxed container next to Gladys, talking to it over the SDK's WebSocket.

## Commands

```bash
npm install
npm test                 # node --test (built-in runner, no framework)
npm run lint             # eslint .
npm run format:check     # prettier --check .   (CI gate — run it before committing)
npm run format           # prettier --write .

node --test test/backups.test.js                        # one file
node --test --test-name-pattern 'typefilter' test/       # one test by name

npx github:GladysAssistant/integration-store .          # the store's admission checks
```

CI (`.github/workflows/ci.yml`) runs exactly `format:check`, `lint`, `test` on Node 24.

Run it against a live Gladys:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="proxmox" LOG_LEVEL=debug npm start
```

## Architecture

`index.js` is wiring only — it registers SDK handlers **before** `connect()` and
holds no Proxmox logic. Three layers below it:

- `src/proxmox/` — the API surface. `client.js` is a **GET-only** HTTPS client
  (`node:https`, not `fetch`, because per-request TLS options — fingerprint
  pinning, explicit acceptance — are not reachable through `fetch` without
  pulling in `undici`). It throws `ProxmoxError` with a `kind`
  (`auth`/`permission`/`tls`/`network`/`timeout`/`http`/`parse`); every layer
  above dispatches on that `kind`, never on the message. `nodes.js`,
  `backups.js`, `guests.js` each own one endpoint.
- `src/devices/` — Gladys device shapes. `index.js` is the registry: devices are
  **discovered**, not static, and it maps a Gladys `external_id` back to a
  server plus a node name or a guest key so `onPoll` reaches the right reader
  (it can rebuild that mapping from the id alone, for a poll arriving after a
  restart with no discovery yet). `proxmoxNode.js` / `proxmoxGuest.js` build the
  discovery payload and publish states for their type.
- `src/servers.js` — the flat configuration form (one block of fields per
  server, the second suffixed `_2`) turned into a list of **server objects**.
  A server object is config-shaped — per-server fields merged with the shared
  settings — so every function of `src/proxmox/` takes one and knows nothing
  about there being several. It also owns the external-id scoping
  (`scopeId()` / `parseScopedId()`).
- `src/config.js`, `src/format.js`, `src/actions.js` — normalization/bounds,
  timezone and duration rendering, and the Configuration-screen buttons.

Data flow: `onScanRequest` / `onConfigUpdated` / `connected` →
`discoverDevices()` (per configured server) → `publishDiscoveredDevices()`;
`onPoll(device)` → `pollDevice()` → `pollNode()` or `pollGuest()` →
`publishStates()`.

### Invariants worth keeping

- **Read-only by construction.** `client.js` implements GET and nothing else;
  the token only ever needs `Sys.Audit` on `/nodes` and `VM.Audit` on `/vms`.
  Do not add a write path.
- **Unknown beats a plausible lie.** A node with no backup in the window
  publishes `unknown` on "Last backup" and _nothing at all_ on duration and
  status; a guest that disappears keeps its last known state instead of being
  faked to `off`.
- **Both Proxmox endpoints are permission-FILTERED, not permission-refused.** A
  token missing `Sys.Audit` gets `200` with only its own tasks; one missing
  `VM.Audit` gets `200` with an empty guest list. That silent degradation is why
  `probeNodeAudit()` (`GET /nodes/{node}/status`, which does return `403`)
  exists and why `test_connection` reports visible guest counts rather than just
  "OK".
- **`poll_frequency` is a Gladys enum, in milliseconds.** A discovered device may
  only carry 1 s / 2 s / 10 s / 15 s / 30 s / 60 s (`DEVICE_POLL_FREQUENCIES` in
  the core); anything else makes `setDiscoveredDevices` reject the WHOLE publish
  with `devices[0].poll_frequency: invalid poll frequency`. The configured
  interval is in seconds and goes up to an hour, so `src/poll.js` declares the
  slowest accepted value and enforces the real interval itself (`claimPoll()`);
  an early poll publishes nothing rather than a stale re-read.
- **Guest ids are `<kind>-<vmid>`**, never node-based: the VMID is cluster-wide
  and survives a migration.
- **The first server's external ids stay unscoped.** `scopeId()` prefixes only
  the second server (`2@pve1`, `2@qemu-101`); server 1 keeps the bare id every
  single-Proxmox installation already stores. Changing that would orphan every
  existing device. The label is cosmetic and must never enter an external id.
- **One unreachable server must not hide the other.** `discoverDevices()`
  returns `{ devices, failures }` instead of throwing; the connection status
  names the server that failed while the other keeps polling.
- **Portability fallbacks are cached, not retried.** A node that answers `400`
  to `typefilter=vzdump` is remembered in `backups.js` and filtered client-side
  from then on. `/cluster/resources` answers are cached ~15 s so one poll round
  of a 40-guest cluster is one request; `force: true` / `clearGuestsCache()`
  bypass it for discovery and explicit refreshes.
- **User-facing strings are bilingual** `{ en, fr }` objects — connection status
  messages, action results, manifest labels. Keep both, and mirror any manifest
  change in `docs/en.md` _and_ `docs/fr.md`.

## The manifest is a contract

`gladys-assistant-integration.json` drives the Configuration screen and the
store indexer. It must stay in sync with the code, and `test/manifest.test.js`
pins that: manifest defaults ≡ `DEFAULT_CONFIG`, every action key has an
`onAction` handler, both server blocks declare the same fields with the same
types (only the first is `required`), `docker_image` tag ≡ `version`,
`description.{en,fr}` ≤ 100 characters. Validate with `npx github:GladysAssistant/integration-store .`
before publishing — the image-not-found error it reports is expected until the
Release workflow has actually built that tag.

Version bumps are the **Release** workflow's job (Actions → Release → patch /
minor / major): it writes `package.json`, `package-lock.json` and both manifest
fields, tags `vX.Y.Z` and builds the multi-arch image. Don't hand-edit versions
unless deliberately overriding it.

## Tests

`test/helpers/fakeProxmox.js` starts a **real self-signed HTTPS server** on an
ephemeral port — two of them, for the multi-server tests — so TLS posture, the `Authorization: PVEAPIToken=…` header, the
query string and the `401`/`403` mapping are exercised on the wire rather than
mocked. `test/helpers/fakeGladys.js` is an in-memory stand-in for the SDK
recording `publishStates` / `setConnectionStatus`. Module-level caches
(`clearGuestsCache()`, `resetTypeFilterSupport()`) leak between tests — reset
them in `beforeEach`.
