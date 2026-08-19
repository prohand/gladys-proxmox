# Proxmox

Monitor the **failed tasks** of your Proxmox VE nodes from Gladys: a failed
task counter per node, and the details of the recent failures (task type,
start and end timestamps in your local time zone, and the status Proxmox
recorded).

This integration is **strictly read-only**. It performs `GET` requests on the
Proxmox VE API and nothing else — it never starts, stops, migrates, deletes or
reconfigures anything.

## What you get

After installation, one Gladys device appears per Proxmox node, named
`Proxmox <node>`. Each device carries two read-only features:

| Feature                    | Type           | What it holds                                                                                                                                                           |
| -------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Failed tasks (N h)**     | Integer sensor | How many tasks failed on that node inside the observation window. Kept in history, so you can chart it and trigger scenes on it.                                        |
| **Recent failure details** | Text           | One block per recent failure: task type (and the guest it acted on), start → end timestamps in your time zone, how long it ran, and the status string Proxmox recorded. |

Example of what the details feature holds:

```
2 failed tasks on pve1 in the last 24 h (times in Europe/Paris):
• vzdump (101)
  2026-08-19 02:00:00 → 2026-08-19 02:04:08 (4 min 8 s)
  status: command 'lvcreate' failed: exit code 5
• qmigrate (110)
  2026-08-19 09:12:31 → 2026-08-19 09:13:02 (31 s)
  status: no such logical volume pve/data
```

Because the counter keeps history, the natural Gladys usage is a scene
triggered on it: _when "Failed tasks" on pve1 becomes greater than 0, send me
the "Recent failure details" text_.

---

## Required Proxmox permissions (read-only)

This is the part worth getting right. The integration needs **one privilege**,
and it is an audit (read) privilege:

| Privilege     | On path           | Why                                                    |
| ------------- | ----------------- | ------------------------------------------------------ |
| **Sys.Audit** | `/nodes` (or `/`) | Read the task log of the nodes, and read their status. |

Nothing else. No `VM.*`, no `Datastore.*`, no `Sys.Modify`, no `Sys.Console`,
no root access, no shell access.

### Which endpoints are called

| Endpoint                         | Method | Privilege required               |
| -------------------------------- | ------ | -------------------------------- |
| `/api2/json/nodes`               | GET    | none (any authenticated token)   |
| `/api2/json/nodes/{node}/tasks`  | GET    | `Sys.Audit` on `/nodes/{node}` * |
| `/api2/json/nodes/{node}/status` | GET    | `Sys.Audit` on `/nodes/{node}`   |

\* **Important subtlety.** The task list is _permission-filtered_, not
permission-refused. Without `Sys.Audit` on `/nodes/{node}`, Proxmox answers
`200 OK` with only the tasks the token itself started — which, for a token that
never starts anything, is an empty list. So an under-privileged setup does not
look broken: the counter simply stays at `0` forever. That is why the
**Test the connection** button probes `/nodes/{node}/status` (which _does_
return `403`) and tells you exactly which nodes are missing the privilege.

### Option A — the built-in `PVEAuditor` role (simplest)

`PVEAuditor` is Proxmox's own read-only role. It grants `Sys.Audit` plus the
other audit privileges (`VM.Audit`, `Datastore.Audit`, `Pool.Audit`,
`SDN.Audit`, `Mapping.Audit`, `VM.GuestAgent.Audit`). It is read-only by
construction — it contains no `*.Modify`, no `*.Allocate`, no
`*.PowerMgmt`, no `Sys.Console` — but it is broader than what this integration
uses.

In the Proxmox web UI:

1. **Datacenter → Permissions → Users → Add**
   - User name: `gladys`, Realm: `Proxmox VE authentication server (pve)`
   - Set a password (it is never used by the integration, but Proxmox requires one)
2. **Datacenter → Permissions → Add → User Permission**
   - Path: `/nodes` — User: `gladys@pve` — Role: `PVEAuditor` — Propagate: ✔
3. **Datacenter → Permissions → API Tokens → Add**
   - User: `gladys@pve` — Token ID: `tasks`
   - **Privilege Separation: keep it checked** (see the note below)
   - Proxmox now shows the secret **once** — copy it, it is never shown again
4. **Datacenter → Permissions → Add → API Token Permission**
   - Path: `/nodes` — API Token: `gladys@pve!tasks` — Role: `PVEAuditor` — Propagate: ✔

Or, from a shell on any node:

```bash
pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify /nodes --users gladys@pve --roles PVEAuditor

# Prints the secret once — copy it into Gladys.
pveum user token add gladys@pve tasks --privsep 1
pveum acl modify /nodes --tokens 'gladys@pve!tasks' --roles PVEAuditor
```

### Option B — a minimal custom role (least privilege)

If you would rather grant only what is actually used, create a role holding
`Sys.Audit` and nothing else:

```bash
pveum role add GladysTaskAudit --privs "Sys.Audit"

pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify /nodes --users gladys@pve --roles GladysTaskAudit

pveum user token add gladys@pve tasks --privsep 1
pveum acl modify /nodes --tokens 'gladys@pve!tasks' --roles GladysTaskAudit
```

This is the tightest configuration the integration can run on.

### About privilege separation

When a token is created with **privilege separation** (`--privsep 1`, the
default and the recommended setting), its effective permissions are the
**intersection** of the user's permissions and the token's own ACL. So the two
`pveum acl modify` lines above are both needed: one for the user, one for the
token.

Creating the token with `--privsep 0` makes it inherit the user's permissions
directly and skips the second ACL — but it also means the token can do
everything the user can, forever. Prefer privilege separation.

### Verifying

Use the **Test the connection** button in the integration's Configuration tab.
It reports, node by node, whether the token can actually read the task log, and
names the missing privilege when it cannot.

You can also check by hand:

```bash
curl -sS --insecure \
  -H "Authorization: PVEAPIToken=gladys@pve!tasks=YOUR-SECRET" \
  "https://192.168.1.10:8006/api2/json/nodes/pve1/tasks?errors=1&limit=5"
```

---

## Configuration

| Field                           | Required | Default | Notes                                                                                      |
| ------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------ |
| **Proxmox host**                | yes      | —       | IP or hostname of any node — one node answers for the whole cluster.                       |
| **API port**                    | no       | `8006`  | The Proxmox VE API port.                                                                   |
| **API token ID**                | yes      | —       | The full `user@realm!tokenname` form, e.g. `gladys@pve!tasks`.                             |
| **API token secret**            | yes      | —       | The value Proxmox shows once. Stored encrypted by Gladys, never sent back to your browser. |
| **TLS certificate fingerprint** | no       | empty   | SHA-256 fingerprint of the node certificate. See below.                                    |
| **Verify the TLS certificate**  | no       | on      | Leave on. See below.                                                                       |
| **Nodes to monitor**            | no       | all     | Comma-separated node names, e.g. `pve1, pve2`.                                             |
| **Observation window**          | no       | `24` h  | Only tasks started inside this window are counted and listed.                              |
| **What counts as a failure**    | no       | errors  | Whether tasks that ended with `WARNINGS: n` count as failures.                             |
| **Task types to keep**          | no       | all     | Comma-separated Proxmox task types, e.g. `vzdump, replication`.                            |
| **Failures detailed**           | no       | `5`     | How many failures the details text describes (the counter always covers the whole window). |
| **Time zone**                   | no       | host    | IANA zone used to render the timestamps, e.g. `Europe/Paris`.                              |
| **Refresh interval**            | no       | `300` s | How often the task log is read.                                                            |

### TLS: the self-signed Proxmox certificate

Out of the box, a Proxmox node serves a **self-signed** certificate, which no
container trusts. You have three options, best first:

1. **Pin the fingerprint (recommended).** Paste the node's SHA-256 fingerprint
   into the _TLS certificate fingerprint_ field. The connection is then
   encrypted _and_ authenticated, without any public certificate authority.
   Find the fingerprint in the UI under **Node → System → Certificates →
   `pveproxy-ssl.pem`**, or from a shell:

   ```bash
   openssl x509 -in /etc/pve/local/pveproxy-ssl.pem -noout -fingerprint -sha256
   # falls back to the node's own certificate when no custom one is installed:
   openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256
   ```

   Any format is accepted (`AA:BB:CC…`, `aabbcc…`, with or without spaces).

   Note that the fingerprint changes when the certificate is renewed or
   replaced — update the field then, or switch to option 2.

2. **Install a trusted certificate** on the node (Let's Encrypt through the
   Proxmox ACME support, or your own CA installed in the container's trust
   store). Leave both TLS fields at their defaults.

3. **Turn _Verify the TLS certificate_ off.** Last resort, on a trusted LAN
   only: the traffic stays encrypted, but nothing proves the server you reach
   is really your node — and the API token secret travels on that connection.

### What counts as a failure

Proxmox records a finished task with one of these statuses:

| Proxmox status | Meaning                         | Counted with "Errors only" | Counted with "Errors and warnings" |
| -------------- | ------------------------------- | -------------------------- | ---------------------------------- |
| `OK`           | success                         | no                         | no                                 |
| `WARNINGS: 3`  | finished, with warnings         | no                         | **yes**                            |
| anything else  | error string                    | **yes**                    | **yes**                            |
| _(empty)_      | no exit status — worker crashed | **yes**                    | **yes**                            |

A backup that completed but skipped a guest ends in `WARNINGS: n`. Choose
_Errors and warnings_ if you want to hear about those too.

Only **finished** tasks are read (Proxmox's archived task list): a task still
running is not a failure and is never counted.

## Actions

- **Test the connection** — checks that the host answers, that the API token is
  accepted, and that it can actually read the task log of every monitored node.
  Run this first whenever something looks wrong.
- **Refresh now** — reads the task log immediately, on every node, instead of
  waiting for the next refresh.

## Troubleshooting

**"Proxmox refused the API token (401)"** — the token ID or the secret is
wrong. The ID must be the _full_ `user@realm!tokenname` form (`gladys@pve!tasks`),
not just the token name. If you lost the secret, delete the token and create a
new one: Proxmox only shows it once.

**"the token cannot read the task log of: …"** — the token is missing
`Sys.Audit` on those nodes. Re-read the permissions section above; with
privilege separation on, remember that _both_ the user and the token need the
ACL.

**The counter stays at 0 while the Proxmox UI shows failures** — almost always
the same missing privilege. Run **Test the connection**. If it reports OK,
check the observation window (a failure older than the window is not counted),
the _Task types to keep_ filter, and whether the failures you are looking at
are `WARNINGS:` ones excluded by the default scope.

**"Proxmox presents a self-signed certificate"** — pin its fingerprint, see the
TLS section above.

**"Cannot reach …"** — check the host and the port (`8006`), and that the
Gladys container can reach the node on your network.

**Timestamps are off by a few hours** — set the _Time zone_ field to your IANA
zone (`Europe/Paris`, `America/New_York`…). Left empty, the integration uses the
time zone of the machine Gladys runs on, which is often UTC inside a container.

The integration logs everything it does: check the integration logs from the
Gladys UI (or `docker logs` on the host), with `LOG_LEVEL=debug` for the full
detail. The API token secret is never logged.

## Privacy and security

- **Read-only by construction.** The client only implements `GET`; there is no
  code path in this integration that writes to Proxmox.
- The API token secret is stored encrypted by Gladys, is never returned to the
  browser (it is a `secret` config field), and is never written to the logs.
- The integration talks to nothing but your Proxmox host: no cloud service, no
  telemetry, no outbound call of any kind.
