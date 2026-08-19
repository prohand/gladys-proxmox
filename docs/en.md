# Proxmox

Monitor the **backups** of your Proxmox VE nodes from Gladys — when the last one
ran, how long it took and whether it succeeded — plus the **running state of
every virtual machine and LXC container**.

This integration is **strictly read-only**. It performs `GET` requests on the
Proxmox VE API and nothing else — it never starts, stops, migrates, deletes or
reconfigures anything.

## What you get

After installation, one Gladys device appears per Proxmox node, named
`Proxmox <node>`, carrying three read-only features about its **last backup**
(a Proxmox `vzdump` task):

| Feature             | Type           | What it holds                                                                                                                             |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Last backup**     | Text           | When the last backup started, in your time zone — e.g. `2026-08-19 02:00:00 (Europe/Paris)`. Holds `unknown` when the node has no backup. |
| **Backup duration** | Integer sensor | How long that backup ran, in seconds. Kept in history, so you can chart it and trigger scenes on it.                                      |
| **Backup status**   | Binary sensor  | **On** when that backup succeeded, **off** for any other state.                                                                           |

And one Gladys device per virtual machine and per LXC container, named
`Proxmox <name> (<vmid>)`:

| Feature    | Type          | What it holds                                                    |
| ---------- | ------------- | ---------------------------------------------------------------- |
| **Status** | Binary sensor | **On** when the guest is `running`, **off** for any other state. |

A node with no backup inside the observation window publishes `unknown` on
**Last backup**, and leaves **Backup duration** and **Backup status** unknown
rather than showing a `0 s` backup that never happened. Templates never become
devices, and a guest that disappears (deleted, or no longer visible to the
token) keeps its last known state instead of being turned off.

Because the duration and both binary features keep history, the natural Gladys
usage is a scene triggered on them: _when "Backup status" on pve1 becomes off,
notify me_, or _when "Status" of my NAS VM becomes off, notify me_.

### Two Proxmox servers

The configuration has **two identical blocks**: fill in the second one and the
integration monitors a second, completely independent Proxmox — its own host,
its own API token, its own TLS settings and its own node filter. Everything
below (permissions, TLS, actions) applies to each of them separately.

Devices of the second server are named after its own label, so nothing
collides: a node called `pve1` on both servers shows up as **Proxmox pve1** and
**Proxmox 2 pve1**, and a VM 101 on each shows up twice as well. Set _Name of
this Proxmox_ on either block to name them yourself (`Home`, `Office`…).

If you only have one Proxmox, leave the second block empty and nothing changes.

---

## Required Proxmox permissions (read-only)

This is the part worth getting right. The integration needs **two audit (read)
privileges**, and nothing else:

| Privilege     | On path           | Why                                                       |
| ------------- | ----------------- | --------------------------------------------------------- |
| **Sys.Audit** | `/nodes` (or `/`) | Read the task log of the nodes, and read their status.    |
| **VM.Audit**  | `/vms` (or `/`)   | See the virtual machines and containers, and their state. |

Nothing else. No `Datastore.*`, no `Sys.Modify`, no `VM.PowerMgmt`, no
`Sys.Console`, no root access, no shell access.

### Which endpoints are called

| Endpoint                               | Method | Privilege required                |
| -------------------------------------- | ------ | --------------------------------- |
| `/api2/json/nodes`                     | GET    | none (any authenticated token)    |
| `/api2/json/nodes/{node}/tasks`        | GET    | `Sys.Audit` on `/nodes/{node}` \* |
| `/api2/json/nodes/{node}/status`       | GET    | `Sys.Audit` on `/nodes/{node}`    |
| `/api2/json/cluster/resources?type=vm` | GET    | `VM.Audit` on `/vms/{vmid}` \*    |

\* **Important subtlety.** Both lists are _permission-filtered_, not
permission-refused. Without `Sys.Audit` on `/nodes/{node}`, Proxmox answers
`200 OK` with only the tasks the token itself started — which, for a token that
never starts anything, is an empty list. Without `VM.Audit`, the guest list
comes back empty the same way. So an under-privileged setup does not look
broken: the backup features simply stay `unknown` forever, and no VM appears.
That is why the **Test the connection** button probes `/nodes/{node}/status`
(which _does_ return `403`) and tells you exactly which nodes are missing the
privilege, and how many guests the token can actually see.

### Option A — the built-in `PVEAuditor` role (simplest)

`PVEAuditor` is Proxmox's own read-only role. It grants `Sys.Audit` and
`VM.Audit` plus the other audit privileges (`Datastore.Audit`, `Pool.Audit`,
`SDN.Audit`, `Mapping.Audit`, `VM.GuestAgent.Audit`). It is read-only by
construction — it contains no `*.Modify`, no `*.Allocate`, no `*.PowerMgmt`, no
`Sys.Console` — but it is broader than what this integration uses.

In the Proxmox web UI:

1. **Datacenter → Permissions → Users → Add**
   - User name: `gladys`, Realm: `Proxmox VE authentication server (pve)`
   - Set a password (it is never used by the integration, but Proxmox requires one)
2. **Datacenter → Permissions → Add → User Permission**
   - Path: `/` — User: `gladys@pve` — Role: `PVEAuditor` — Propagate: ✔
3. **Datacenter → Permissions → API Tokens → Add**
   - User: `gladys@pve` — Token ID: `tasks`
   - **Privilege Separation: keep it checked** (see the note below)
   - Proxmox now shows the secret **once** — copy it, it is never shown again
4. **Datacenter → Permissions → Add → API Token Permission**
   - Path: `/` — API Token: `gladys@pve!tasks` — Role: `PVEAuditor` — Propagate: ✔

Or, from a shell on any node:

```bash
pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify / --users gladys@pve --roles PVEAuditor

# Prints the secret once — copy it into Gladys.
pveum user token add gladys@pve tasks --privsep 1
pveum acl modify / --tokens 'gladys@pve!tasks' --roles PVEAuditor
```

Granting on `/` (rather than on `/nodes` and `/vms` separately) is the simplest
form and stays read-only: the role itself is what limits the token.

### Option B — a minimal custom role (least privilege)

If you would rather grant only what is actually used, create a role holding
`Sys.Audit` and `VM.Audit` and nothing else:

```bash
pveum role add GladysBackupAudit --privs "Sys.Audit,VM.Audit"

pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify /nodes --users gladys@pve --roles GladysBackupAudit
pveum acl modify /vms   --users gladys@pve --roles GladysBackupAudit

pveum user token add gladys@pve tasks --privsep 1
pveum acl modify /nodes --tokens 'gladys@pve!tasks' --roles GladysBackupAudit
pveum acl modify /vms   --tokens 'gladys@pve!tasks' --roles GladysBackupAudit
```

This is the tightest configuration the integration can run on.

### About privilege separation

When a token is created with **privilege separation** (`--privsep 1`, the
default and the recommended setting), its effective permissions are the
**intersection** of the user's permissions and the token's own ACL. So the
`pveum acl modify` lines above are all needed: some for the user, some for the
token.

Creating the token with `--privsep 0` makes it inherit the user's permissions
directly and skips the token ACLs — but it also means the token can do
everything the user can, forever. Prefer privilege separation.

### Verifying

Use the **Test the connection** button in the integration's Configuration tab.
It reports, node by node, whether the token can actually read the task log, how
many VMs and containers it can see, and names the missing privilege when
something is denied.

You can also check by hand:

```bash
curl -sS --insecure \
  -H "Authorization: PVEAPIToken=gladys@pve!tasks=YOUR-SECRET" \
  "https://192.168.1.10:8006/api2/json/nodes/pve1/tasks?typefilter=vzdump&limit=5"

curl -sS --insecure \
  -H "Authorization: PVEAPIToken=gladys@pve!tasks=YOUR-SECRET" \
  "https://192.168.1.10:8006/api2/json/cluster/resources?type=vm"
```

---

## Configuration

The first six fields below exist **twice**: once for the first Proxmox, once
for the optional second one. The last four are shared by both.

| Field                                  | Required | Default | Notes                                                                                      |
| -------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------ |
| **Name of this Proxmox**               | no       | Proxmox | Prefixes the name of every device of that server. Second block defaults to `Proxmox 2`.    |
| **Proxmox host**                       | yes      | —       | IP or hostname of any node — one node answers for the whole cluster.                       |
| **API port**                           | no       | `8006`  | The Proxmox VE API port.                                                                   |
| **API token ID**                       | yes      | —       | The full `user@realm!tokenname` form, e.g. `gladys@pve!tasks`.                             |
| **API token secret**                   | yes      | —       | The value Proxmox shows once. Stored encrypted by Gladys, never sent back to your browser. |
| **TLS certificate fingerprint**        | no       | empty   | SHA-256 fingerprint of the node certificate. See below.                                    |
| **Verify the TLS certificate**         | no       | on      | Leave on. See below.                                                                       |
| **Nodes to monitor**                   | no       | all     | Comma-separated node names, e.g. `pve1, pve2`. Also scopes the VMs/LXC reported.           |
| **How far back to look for a backup**  | no       | `7` d   | The last backup is searched inside this window.                                            |
| **What counts as a successful backup** | no       | OK only | Whether a backup that ended with `WARNINGS: n` still counts as successful.                 |
| **Time zone**                          | no       | host    | IANA zone used to render the timestamp, e.g. `Europe/Paris`.                               |
| **Refresh interval**                   | no       | `300` s | How often Proxmox is read.                                                                 |

Only the first server's host and token are mandatory: the whole second block is
optional. _How far back to look for a backup_, _What counts as a successful
backup_, _Time zone_ and _Refresh interval_ are configured once and apply to
every server.

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

### What counts as a successful backup

Proxmox records a finished backup with one of these statuses:

| Proxmox status | Meaning                         | "OK only" (default) | "OK and warnings" |
| -------------- | ------------------------------- | ------------------- | ----------------- |
| `OK`           | success                         | **on**              | **on**            |
| `WARNINGS: 3`  | finished, with warnings         | off                 | **on**            |
| anything else  | error string                    | off                 | off               |
| _(empty)_      | no exit status — worker crashed | off                 | off               |

A backup that completed but skipped a guest ends in `WARNINGS: n`. Choose
_OK and warnings_ if you consider those good enough.

Only **finished** backups are read (Proxmox's archived task list): a backup
still running is not the last backup yet.

## Actions

- **Test the connection** — checks that the host answers, that the API token is
  accepted, that it can actually read the task log of every monitored node, and
  how many VMs/LXC it can see. Run this first whenever something looks wrong.
- **Refresh now** — reads the backups and the VM/LXC states immediately, instead
  of waiting for the next refresh.

Both run on every configured server, and prefix each result with `[<name>]` when
there are two — so a message like `[Office] Proxmox refused the API token (401)`
tells you which one to fix.

## Troubleshooting

**"Proxmox refused the API token (401)"** — the token ID or the secret is
wrong. The ID must be the _full_ `user@realm!tokenname` form (`gladys@pve!tasks`),
not just the token name. If you lost the secret, delete the token and create a
new one: Proxmox only shows it once.

**"the token cannot read the task log of: …"** — the token is missing
`Sys.Audit` on those nodes. Re-read the permissions section above; with
privilege separation on, remember that _both_ the user and the token need the
ACL.

**"No VM or LXC is visible"** — the token is missing `VM.Audit` (on `/vms`, or
on `/`). The guest list is filtered rather than refused, so an under-privileged
token simply sees nothing.

**"Last backup" stays `unknown` while the Proxmox UI shows backups** — either
the missing `Sys.Audit` privilege above (run **Test the connection**), or a
window shorter than your backup schedule: a node backed up every two weeks
reports nothing with the default 7-day window. Raise _How far back to look for
a backup_.

**"Backup status" is off while the backup looks fine** — the backup probably
ended in `WARNINGS: n` (a guest was skipped, a hook returned non-zero…). Open
the task in the Proxmox UI to see why, or switch _What counts as a successful
backup_ to _OK and warnings_.

**A VM I deleted is still listed** — the Gladys device stays until you delete
it in Gladys; the integration stops publishing states for it, so it simply
freezes on its last value.

**"Proxmox presents a self-signed certificate"** — pin its fingerprint, see the
TLS section above.

**"Cannot reach …"** — check the host and the port (`8006`), and that the
Gladys container can reach the node on your network. With two servers
configured, the message names the one that did not answer; the other keeps
being refreshed normally.

**Two devices with the same name** — both servers use the same label. Set
_Name of this Proxmox_ on at least one block. Renaming a server changes the
names of the devices it discovers from then on; devices Gladys already created
keep the name you see in Gladys and can be renamed there.

**The devices of my second server disappeared from the dashboard** — emptying
the second block stops it from being monitored, but its Gladys devices remain,
frozen on their last known value, until you delete them in Gladys.

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
