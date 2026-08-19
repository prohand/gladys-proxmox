# Gladys ⇄ Proxmox VE — failed task monitoring

External integration for [Gladys Assistant](https://gladysassistant.com) that
surfaces the **failed tasks** of your Proxmox VE nodes: a failed task counter
per node, plus the details of the recent failures (task type, start and end
timestamps in your local time zone, and the status Proxmox recorded).

Built on the official
[JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
and the [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

> **Read-only by construction.** The API client implements `GET` and nothing
> else. The integration needs a single Proxmox privilege — `Sys.Audit` on
> `/nodes` — and never starts, stops, migrates or reconfigures anything.

## What it publishes

One Gladys device per Proxmox node (`Proxmox <node>`), each with two read-only
features:

| Feature                    | Category / type              | Contents                                                                                                                                       |
| -------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Failed tasks (N h)**     | `counter-sensor` / `integer` | Number of failed tasks on that node inside the observation window. `keep_history: true` → chartable, usable as a scene trigger.                |
| **Recent failure details** | `text` / `text`              | One block per recent failure: task type (+ guest id), start → end timestamps in the user's time zone, duration, and the Proxmox status string. |

```
2 failed tasks on pve1 in the last 24 h (times in Europe/Paris):
• vzdump (101)
  2026-08-19 02:00:00 → 2026-08-19 02:04:08 (4 min 8 s)
  status: command 'lvcreate' failed: exit code 5
• qmigrate (110)
  2026-08-19 09:12:31 → 2026-08-19 09:13:02 (31 s)
  status: no such logical volume pve/data
```

## Required Proxmox permissions

**`Sys.Audit` on `/nodes`.** That is the whole list. Either through the
built-in read-only role:

```bash
pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify /nodes --users gladys@pve --roles PVEAuditor

pveum user token add gladys@pve tasks --privsep 1   # prints the secret ONCE
pveum acl modify /nodes --tokens 'gladys@pve!tasks' --roles PVEAuditor
```

…or through a minimal custom role, if you prefer least privilege:

```bash
pveum role add GladysTaskAudit --privs "Sys.Audit"
```

With privilege separation on (the default, and recommended), the **user and the
token each need the ACL** — the effective permissions are the intersection of
the two.

Endpoints called, and what each needs:

| Endpoint                         | Method | Privilege                        |
| -------------------------------- | ------ | -------------------------------- |
| `/api2/json/nodes`               | GET    | none (any authenticated token)   |
| `/api2/json/nodes/{node}/tasks`  | GET    | `Sys.Audit` on `/nodes/{node}` * |
| `/api2/json/nodes/{node}/status` | GET    | `Sys.Audit` on `/nodes/{node}`   |

\* The task list is permission-**filtered**, not permission-refused: without
`Sys.Audit`, Proxmox answers `200 OK` with only the token's own tasks — so an
under-privileged setup silently reports zero failures forever. That is why the
**Test the connection** action probes `/nodes/{node}/status`, which does return
`403`, and names the nodes that are missing the privilege.

The full step-by-step (web UI and CLI, TLS, troubleshooting) is in
[`docs/en.md`](docs/en.md) / [`docs/fr.md`](docs/fr.md) — Gladys re-hosts those
and links them from the Configuration screen.

## TLS

Proxmox nodes serve a self-signed certificate by default. The integration
supports, best first:

1. **Fingerprint pinning** (`TLS certificate fingerprint` field) — encrypted
   _and_ authenticated, no public CA needed. Get it with
   `openssl x509 -in /etc/pve/local/pveproxy-ssl.pem -noout -fingerprint -sha256`.
2. **A CA-trusted certificate** on the node — leave both TLS fields at their
   defaults.
3. **Verification off** — last resort, trusted LAN only.

`node:https` is used directly rather than the global `fetch`: per-request TLS
options (pinning, explicit acceptance) are not reachable through `fetch`
without pulling `undici` in, and this integration ships **zero runtime
dependencies** beyond the SDK.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no Proxmox logic)
├─ src/
│  ├─ proxmox/
│  │  ├─ client.js                   #   HTTPS GET client: token auth, TLS posture, error mapping
│  │  └─ tasks.js                    #   node listing, failed-task reading, status classification
│  ├─ devices/
│  │  ├─ index.js                    #   registry: one device per discovered node
│  │  └─ proxmoxNode.js              #   the node device: its two features, and its poll
│  ├─ actions.js                     # the Configuration screen buttons
│  ├─ format.js                      # timestamps in the user's time zone, details text
│  └─ config.js                      # config defaults, normalization, bounds
├─ docs/
│  ├─ en.md                          # user documentation (re-hosted by Gladys and
│  └─ fr.md                          #   linked from the Configuration screen)
├─ gladys-assistant-integration.json # manifest (name, config schema, actions, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ test/                             # node --test, incl. a real HTTPS fake Proxmox node
```

## Configuration

| Key                   | Type    | Default | Purpose                                                       |
| --------------------- | ------- | ------- | ------------------------------------------------------------- |
| `host`                | string  | —       | IP/hostname of any node (one answers for the whole cluster)   |
| `port`                | number  | `8006`  | Proxmox VE API port                                           |
| `token_id`            | string  | —       | `user@realm!tokenname`                                        |
| `token_secret`        | secret  | —       | Shown once by Proxmox; stored encrypted, never logged         |
| `tls_fingerprint`     | string  | empty   | SHA-256 fingerprint to pin                                    |
| `tls_verify`          | boolean | `true`  | Chain-of-trust check when no fingerprint is pinned            |
| `nodes_filter`        | string  | all     | Comma-separated node names                                    |
| `lookback_hours`      | number  | `24`    | Observation window                                            |
| `failure_scope`       | select  | errors  | Whether `WARNINGS: n` counts as a failure                     |
| `task_type_filter`    | string  | all     | Comma-separated Proxmox task types (`vzdump`, `replication`…) |
| `max_failures_listed` | number  | `5`     | Failures described in the details text                        |
| `timezone`            | string  | host    | IANA zone for the rendered timestamps                         |
| `poll_frequency`      | number  | `300`   | Refresh interval, seconds                                     |

### What counts as a failure

Mirrors Proxmox's own `PVE::UPID::normalize_status_type`:

| Proxmox `status` | Type      | `errors` (default) | `errors_and_warnings` |
| ---------------- | --------- | ------------------ | --------------------- |
| `OK`             | `ok`      | —                  | —                     |
| `WARNINGS: 3`    | `warning` | —                  | ✔                     |
| _(empty)_        | `unknown` | ✔                  | ✔                     |
| anything else    | `error`   | ✔                  | ✔                     |

Only finished (archived) tasks are read: a running task is never a failure.

The query sent to Proxmox is deliberately limited to `errors`, `limit` and
`start` — the parameters every Proxmox VE generation accepts. The newer
`since` / `until` / `statusfilter` / `source` parameters would be rejected with
a `400` by older nodes (the endpoint declares `additionalProperties => 0`), so
the time window and the status scope are applied client-side instead.
`errors=1` returns everything that is not `OK`, a superset of both scopes.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="proxmox" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs in its sandboxed container; the SDK reads them automatically.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test
```

The same three gates run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

Tests use Node's built-in runner — no test framework to install. The client and
end-to-end tests spin up a **real HTTPS server** answering like a Proxmox node
(`test/helpers/fakeProxmox.js`, self-signed exactly like a stock node), so TLS
pinning, the `Authorization` header, the query string and the `401`/`403`
mapping are exercised on the wire rather than mocked away.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the exact checks the store indexer applies — manifest schema and code
rules, Docker image availability, cover contract, mandatory `docs/en.md` +
`docs/fr.md` — and reports everything at once.

## Publishing

1. Push this repo public and add the GitHub topic `gladys-assistant-integration`.
2. **Actions → Release → Run workflow**, pick `patch` / `minor` / `major`. It
   bumps `package.json`, `package-lock.json` and the manifest
   (`version` + `docker_image` tag), pushes the `vX.Y.Z` tag and builds the
   `linux/amd64` + `linux/arm64` image to `ghcr.io`.
3. The decentralized indexer picks up the new manifest `version` and Gladys
   offers a one-click install / update.

`docker_image` and `cover_image` in the manifest point at `prohand/gladys-proxmox`
— change them if you fork this elsewhere.

## License

Apache-2.0
