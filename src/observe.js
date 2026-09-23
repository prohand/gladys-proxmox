// -----------------------------------------------------------------------------
// What was last read from Proxmox, and what CHANGED since.
//
// Two jobs, fed by every read of a node or a guest (a poll, a widget, a scene
// action):
//
//   1. A short-lived SNAPSHOT of each node — its last backup and its disks — so
//      a dashboard widget or a scene action asking for a node that was polled a
//      minute ago reuses that read instead of hitting Proxmox again. An entry is
//      only served while it is younger than the refresh interval the user chose.
//
//   2. The TRANSITIONS the scene triggers stand for. A scene trigger is an
//      event — "this happened" — never a state: one event per transition, never
//      one per poll. So each read is compared with the previous one:
//        - a backup that FINISHED and was not seen before -> `backup_finished`;
//        - a guest whose state word changed               -> `guest_status_changed`;
//        - a disk whose SMART verdict turned to failed    -> `disk_failed`.
//      The very first read of a guest or of a disk only sets the baseline:
//      firing for what was already true when the integration started would
//      re-fire at every restart. A backup is the exception — one that finished
//      AFTER the integration started is new, even on its first read.
//
// Everything here is best-effort: a scene event or a widget nudge that cannot be
// sent is logged and dropped, never allowed to fail the read that found it.
// The memory is in-process: a restart forgets it, and the rules above make that
// safe (a restart never re-fires, at worst it misses what happened while down).
//
// No loop is possible through a scene action: an event is fired at most once
// per transition, whoever observed it — reading again sees no new transition.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { BACKUP_RESULT, SCENE_TRIGGER, WIDGET } from './capabilities.js';
import { formatBackupStatus, formatLastBackup, formatStatus, resolveTimezone } from './format.js';

const logger = createLogger({ name: 'observe' });

// `<serverId>|<node>` -> { at, backup, disks }: the last read of each node.
const nodeStates = new Map();
// `<serverId>|<node>` -> upid of the last FINISHED backup seen on that node.
const lastBackups = new Map();
// `<serverId>|<node>` -> Set of the device paths whose SMART verdict is failed.
const failedDisks = new Map();
// `<serverId>|<guest key>` -> the last state word seen.
const guestStatuses = new Map();

// When this process started watching, in epoch seconds: a backup that ended
// before it is history, not news.
let startedAt = Math.floor(Date.now() / 1000);

/**
 * The key of one node or one guest: its server, then its local id.
 * @param {object} server - The server it belongs to.
 * @param {string} localId - Node name or guest key.
 * @returns {string} The key.
 */
function keyOf(server, localId) {
  return `${server.id}|${localId}`;
}

/**
 * Forget every read and every transition (tests; a fresh start).
 * @param {number} [now] - Current time in milliseconds, injectable for the tests.
 * @returns {void}
 */
export function resetObservations(now = Date.now()) {
  nodeStates.clear();
  lastBackups.clear();
  failedDisks.clear();
  guestStatuses.clear();
  startedAt = Math.floor(now / 1000);
}

/**
 * Drop the snapshot, keep the transitions.
 *
 * Called on discovery: a new configuration can change what a read means (the
 * backup window, the success scope, the date format), so the next widget must
 * read again — but a backup already announced must not be announced twice.
 * @returns {void}
 */
export function clearSnapshot() {
  nodeStates.clear();
}

/**
 * The last read of a node, when it is recent enough to be served again.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Node name.
 * @param {number} maxAgeSeconds - How old the read may be.
 * @param {number} [now] - Current time in milliseconds, injectable for the tests.
 * @returns {{backup: object|null, disks: object[]|null}|null} The read, or null.
 */
export function recentNodeState(server, node, maxAgeSeconds, now = Date.now()) {
  const entry = nodeStates.get(keyOf(server, node));
  if (!entry || now - entry.at >= maxAgeSeconds * 1000) {
    return null;
  }
  return { backup: entry.backup, disks: entry.disks };
}

/**
 * Fire the scene events found by one read, then ask the widgets showing that
 * data to re-pull it. Never throws.
 * @param {object} gladys - The SDK instance.
 * @param {[string, object][]} events - `[trigger key, data]` pairs.
 * @param {string[]} widgets - The widget keys to nudge when something happened.
 * @returns {Promise<void>} Resolves once every event was tried.
 */
async function announce(gladys, events, widgets) {
  if (events.length === 0) {
    return;
  }
  for (const [key, data] of events) {
    try {
      await gladys.publishSceneEvent(key, data);
      logger.info(`Scene event ${key}: ${JSON.stringify(data)}`);
    } catch (error) {
      logger.warn(`Scene event ${key} could not be sent: ${error.message}`);
    }
  }
  for (const widget of widgets) {
    try {
      // Fire-and-forget, rate-limited by Gladys: the widget re-pulls within
      // seconds instead of waiting for its TTL.
      gladys.requestWidgetRefresh(widget);
    } catch (error) {
      logger.debug(`Widget ${widget} could not be nudged: ${error.message}`);
    }
  }
}

/**
 * The `backup_finished` event of a read, if that read holds a new backup.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Node name.
 * @param {string} deviceId - External id of the node device.
 * @param {object|null} backup - The last backup read.
 * @returns {[string, object]|null} The event, or null.
 */
function backupEvent(server, node, deviceId, backup) {
  // A backup still running has no end time yet: it is announced once it ends.
  if (!backup || backup.endtime === null) {
    return null;
  }
  const key = keyOf(server, node);
  const seen = lastBackups.get(key);
  lastBackups.set(key, backup.upid);
  if (seen === backup.upid) {
    return null;
  }
  if (seen === undefined && backup.endtime < startedAt) {
    return null;
  }
  const timezone = resolveTimezone(server.timezone);
  return [
    SCENE_TRIGGER.BACKUP_FINISHED,
    {
      device: deviceId,
      server: server.label,
      node,
      result: backup.success ? BACKUP_RESULT.OK : BACKUP_RESULT.FAILED,
      status: formatBackupStatus(backup),
      started_at: formatLastBackup(backup, timezone, server.date_format),
      duration_seconds: backup.duration,
    },
  ];
}

/**
 * The `disk_failed` events of a read: one per disk newly reported failed.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Node name.
 * @param {string} deviceId - External id of the node device.
 * @param {object[]|null} disks - The disks read, or null when not read.
 * @returns {[string, object][]} The events.
 */
function diskEvents(server, node, deviceId, disks) {
  // No disk read (monitoring off), or an unreadable list: that says nothing
  // about a disk recovering or failing, so the memory is left as it is.
  if (!Array.isArray(disks) || disks.length === 0) {
    return [];
  }
  const key = keyOf(server, node);
  const previous = failedDisks.get(key);
  const failed = disks.filter((disk) => disk.healthy === false);
  failedDisks.set(key, new Set(failed.map((disk) => disk.devpath)));
  if (!previous) {
    return [];
  }
  return failed
    .filter((disk) => !previous.has(disk.devpath))
    .map((disk) => [
      SCENE_TRIGGER.DISK_FAILED,
      {
        device: deviceId,
        server: server.label,
        node,
        disk: disk.devpath,
        model: disk.model,
        health: formatStatus(disk.health, 'error'),
      },
    ]);
}

/**
 * Record a read of a node, and announce what changed.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the node belongs to.
 * @param {string} node - Node name.
 * @param {string} deviceId - External id of the node device.
 * @param {{backup: object|null, disks: object[]|null}} state - What was read.
 * @param {number} [now] - Current time in milliseconds, injectable for the tests.
 * @returns {Promise<void>} Resolves once the events were tried.
 */
export async function observeNode(gladys, server, node, deviceId, state, now = Date.now()) {
  nodeStates.set(keyOf(server, node), { at: now, backup: state.backup, disks: state.disks });
  const events = [];
  const backup = backupEvent(server, node, deviceId, state.backup);
  if (backup) {
    events.push(backup);
  }
  events.push(...diskEvents(server, node, deviceId, state.disks));
  await announce(gladys, events, [WIDGET.BACKUPS, WIDGET.NODE]);
}

/**
 * Record a read of a guest, and announce a change of its state.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - The server the guest belongs to.
 * @param {string} deviceId - External id of the guest device.
 * @param {object} guest - A normalized guest.
 * @returns {Promise<void>} Resolves once the event was tried.
 */
export async function observeGuest(gladys, server, deviceId, guest) {
  const key = keyOf(server, guest.key);
  const previous = guestStatuses.get(key);
  guestStatuses.set(key, guest.status);
  if (previous === undefined || previous === guest.status) {
    return;
  }
  await announce(
    gladys,
    [
      [
        SCENE_TRIGGER.GUEST_STATUS_CHANGED,
        {
          device: deviceId,
          server: server.label,
          node: guest.node,
          name: guest.name,
          vmid: guest.vmid,
          kind: guest.kind,
          status: guest.status,
          previous_status: previous,
        },
      ],
    ],
    [WIDGET.GUESTS],
  );
}
