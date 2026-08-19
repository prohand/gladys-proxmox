# Gladys ⇄ Proxmox VE — backup and guest monitoring

External integration for [Gladys Assistant](https://gladysassistant.com) that
surfaces the **backups** of your Proxmox VE nodes — when the last one ran, how
long it took and whether it succeeded — plus the **running state of every VM
and LXC container**.

Built on the official
[JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
and the [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

> **Read-only by construction.** The API client implements `GET` and nothing
> else. The integration needs two audit privileges — `Sys.Audit` on `/nodes`
> and `VM.Audit` on `/vms` — and never starts, stops, migrates or reconfigures
> anything.

Up to **two Proxmox servers** can be monitored at once: the configuration form
carries two identical blocks, each with its own host, API token, TLS posture
and node filter.

## What it publishes

**One Gladys device per Proxmox node** (`Proxmox <node>`), with three
read-only features describing its last backup (`vzdump` task):

| Feature             | Category / type        | Contents                                                                                                              |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Last backup**     | `text` / `text`        | When the last backup started, in your time zone (`2026-08-19 02:00:00 (Europe/Paris)`). `unknown` when there is none. |
| **Backup duration** | `duration` / `integer` | How long that backup ran, in seconds. `keep_history: true` → chartable, usable as a scene trigger.                    |
| **Backup status**   | `text` / `text`        | `OK`, or `failed — <what Proxmox said>` (`failed — WARNINGS: 2`). `unknown` when there is no backup.                  |

**One Gladys device per VM and LXC container**
(`Proxmox <name> (<vmid>)`), with a single read-only feature:

| Feature    | Category / type | Contents                                                                          |
| ---------- | --------------- | --------------------------------------------------------------------------------- |
| **Status** | `text` / `text` | The Proxmox state word, as it comes: `running`, `stopped`, `paused`, `suspended`… |

Both statuses are **text**, not binary sensors: Proxmox answers with a word or a
whole error line, where an on/off switch could only say "not on" — a paused VM
read exactly like a stopped one, and finding out why a backup failed meant
opening the Proxmox task log. A `switch` feature is also an actuator shape, and
this integration never controls anything. The verdict still follows _What counts
as a successful backup_: with the default scope a `WARNINGS: n` run reads
`failed — WARNINGS: 2`, and `OK` once warnings are accepted.

A node with no backup inside the observation window publishes `unknown` on
**Last backup** and on **Backup status**, and nothing at all on the duration: a
numeric feature cannot say "unknown", and `0 s` would be a lie. Templates are
never turned into devices, and a guest that disappears keeps its last known
state rather than being faked to `stopped`.

## Required Proxmox permissions

**`Sys.Audit` on `/nodes`** (read the backup task log) and **`VM.Audit` on
`/vms`** (see the VMs and containers). The built-in read-only role grants both:

```bash
pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify / --users gladys@pve --roles PVEAuditor

pveum user token add gladys@pve tasks --privsep 1   # prints the secret ONCE
pveum acl modify / --tokens 'gladys@pve!tasks' --roles PVEAuditor
```

…or, if you prefer least privilege, a custom role holding exactly those two:

```bash
pveum role add GladysBackupAudit --privs "Sys.Audit,VM.Audit"
```

With privilege separation on (the default, and recommended), the **user and the
token each need the ACL** — the effective permissions are the intersection of
the two.

Endpoints called, and what each needs:

| Endpoint                               | Method | Privilege                         |
| -------------------------------------- | ------ | --------------------------------- |
| `/api2/json/nodes`                     | GET    | none (any authenticated token)    |
| `/api2/json/nodes/{node}/tasks`        | GET    | `Sys.Audit` on `/nodes/{node}` \* |
| `/api2/json/nodes/{node}/status`       | GET    | `Sys.Audit` on `/nodes/{node}`    |
| `/api2/json/cluster/resources?type=vm` | GET    | `VM.Audit` on `/vms/{vmid}` \*    |

\* Both lists are permission-**filtered**, not permission-refused: without the
privilege, Proxmox answers `200 OK` with only the token's own tasks, or with an
empty guest list — so an under-privileged setup silently reports "no backup,
no VM" forever. That is why the **Test the connection** action probes
`/nodes/{node}/status`, which does return `403`, and reports how many guests the
token can actually see.

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
│  │  ├─ nodes.js                    #   node listing and the Sys.Audit privilege probe
│  │  ├─ backups.js                  #   last backup of a node, and what "successful" means
│  │  └─ guests.js                   #   VM/LXC listing, with its short-lived snapshot cache
│  ├─ devices/
│  │  ├─ index.js                    #   registry: one device per node, one per guest
│  │  ├─ proxmoxNode.js              #   the node device: its three backup features, and its poll
│  │  └─ proxmoxGuest.js             #   the guest device: its status feature, and its poll
│  ├─ actions.js                     # the Configuration screen buttons
│  ├─ poll.js                        # the frequencies Gladys accepts, and the real interval
│  ├─ format.js                      # timestamps in the user's time zone, durations, summaries
│  ├─ servers.js                     # the flat form -> the list of Proxmox servers, and id scoping
│  └─ config.js                      # config defaults, normalization, bounds
├─ docs/
│  ├─ en.md                          # user documentation (re-hosted by Gladys and
│  └─ fr.md                          #   linked from the Configuration screen)
├─ gladys-assistant-integration.json # manifest (name, config schema, actions, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ test/                             # node --test, incl. a real HTTPS fake Proxmox node
```

## Configuration

Per server — the same keys again with a `_2` suffix for the second one
(`host_2`, `token_id_2`…), all optional:

| Key               | Type    | Default   | Purpose                                                                     |
| ----------------- | ------- | --------- | --------------------------------------------------------------------------- |
| `label`           | string  | `Proxmox` | Prefixes the device names of that server (`Proxmox 2` for the second block) |
| `host`            | string  | —         | IP/hostname of any node (one answers for the whole cluster)                 |
| `port`            | number  | `8006`    | Proxmox VE API port                                                         |
| `token_id`        | string  | —         | `user@realm!tokenname`                                                      |
| `token_secret`    | secret  | —         | Shown once by Proxmox; stored encrypted, never logged                       |
| `tls_fingerprint` | string  | empty     | SHA-256 fingerprint to pin                                                  |
| `tls_verify`      | boolean | `true`    | Chain-of-trust check when no fingerprint is pinned                          |
| `nodes_filter`    | string  | all       | Comma-separated node names; also scopes the guests                          |

Shared by every configured server:

| Key                    | Type   | Default   | Purpose                                                   |
| ---------------------- | ------ | --------- | --------------------------------------------------------- |
| `backup_lookback_days` | number | `7`       | How far back the last backup is looked for                |
| `backup_success_scope` | select | `ok_only` | Whether `WARNINGS: n` still counts as a successful backup |
| `timezone`             | string | host      | IANA zone for the rendered timestamp                      |
| `poll_frequency`       | number | `300`     | Refresh interval, seconds (60-3600)                       |

Gladys only accepts six device poll frequencies, the slowest being one minute,
so the devices declare that one and `src/poll.js` enforces the configured
interval itself: a poll arriving early is skipped and publishes nothing, which
leaves the last known state alone.
A device the user has just added is read at once instead (`onDeviceCreated`):
Gladys creates a discovered device with no state, and waiting for the next tick
left it empty on screen. That forced read still counts as one (`markPolled()`),
so it does not add a second read a minute later.

A server exists as soon as its host and both token fields are filled in. The
first server's Gladys external ids are unscoped (`…:proxmox-node:pve1`), the
second server's carry its id (`…:proxmox-node:2@pve1`), so adding a second
Proxmox never renames or orphans the devices of the first.

### What counts as a successful backup

Mirrors Proxmox's own `PVE::UPID::normalize_status_type`:

| Proxmox `status` | Type      | `ok_only` (default) | `ok_and_warnings` |
| ---------------- | --------- | ------------------- | ----------------- |
| `OK`             | `ok`      | ✔ on                | ✔ on              |
| `WARNINGS: 3`    | `warning` | off                 | ✔ on              |
| _(empty)_        | `unknown` | off                 | off               |
| anything else    | `error`   | off                 | off               |

Only finished (archived) tasks are read: a backup still running is not the last
backup yet.

The task page is asked for with `typefilter=vzdump` so Proxmox does the
filtering; a node that answers `400` (older generations declare
`additionalProperties => 0` on that endpoint) is remembered, and its whole task
page is filtered here instead. The observation window is always applied
client-side, for the same portability reason.

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
