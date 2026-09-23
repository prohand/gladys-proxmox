// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1): three cards the user can put on a dashboard.
//
//   - `backups` : the last backup of every node, failures first, with the
//                 number of nodes OK / failed / with no backup at all;
//   - `guests`  : the state of every VM/LXC, the ones not running first — or
//                 only those, depending on the widget setting;
//   - `node`    : one node, picked in the widget settings: its backup and SMART
//                 verdicts, its hottest disks, and the history of its backup
//                 duration (a live chart of the device feature).
//
// Gladys renders the content itself, from a small declarative vocabulary (text,
// value tiles, a status list, a chart, buttons): no HTML, and the same theme,
// dark mode and translations as its own widgets. Every text below is therefore
// an `{ en, fr }` pair, and every one is cut to the length Gladys allows — a
// text Gladys would have to truncate is cut here, with an ellipsis, instead.
//
// The data comes from the same readers as the polls. A node read less than one
// refresh interval ago is served from that read (`readNode()`), so a dashboard
// open all day costs Proxmox nothing more than the polls already do; Gladys, on
// its side, caches the content for `ttl_seconds` — the refresh interval too.
//
// Each card carries a "Refresh" button: it reads Proxmox again right away and
// publishes the states, exactly like the Configuration screen button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET, WIDGET_ACTION } from './capabilities.js';
import { describeError } from './actions.js';
import { describeDevice, monitoredNodes, pollAllDevices, pollDevice } from './devices/index.js';
import { FEATURE as NODE_FEATURE, nodeExternalIds, readNode } from './devices/proxmoxNode.js';
import { guestExternalIds } from './devices/proxmoxGuest.js';
import { listNodes } from './proxmox/nodes.js';
import { fetchGuests } from './proxmox/guests.js';
import { listServers, serverById } from './servers.js';
import { observeGuest } from './observe.js';
import {
  formatBackupStatus,
  formatDuration,
  formatLastBackup,
  formatSmartStatus,
  formatTimestamp,
  resolveTimezone,
} from './format.js';

// What Gladys keeps of each text, in characters (the widget vocabulary bounds).
const MAX = {
  HEADING: 40,
  CAPTION: 80,
  BODY: 300,
  TILE_LABEL: 24,
  STATUS_LABEL: 40,
  STATUS_VALUE: 40,
};

// A status list holds 10 rows, the value tiles of one card 6 — the node card
// keeps 4 of them for its disks, to fit its 8 components.
const MAX_STATUS_ROWS = 10;
const MAX_DISK_TILES = 4;

// Disk temperature colors, in °C: most drives are rated up to 60 °C, and run
// best under 50 °C.
const DISK_WARM_CELSIUS = 50;
const DISK_HOT_CELSIUS = 60;

// The values of the `show` setting of the guests widget.
export const GUESTS_SHOW = {
  ALL: 'all',
  NOT_RUNNING: 'not_running',
};

/**
 * Cut a text to the length Gladys keeps, with an ellipsis.
 * @param {string|object} text - A string, or an `{ en, fr }` pair.
 * @param {number} max - The bound, in characters.
 * @returns {string|object} The same shape, cut.
 */
export function clip(text, max) {
  if (typeof text !== 'string') {
    return Object.fromEntries(
      Object.entries(text).map(([lang, value]) => [lang, clip(value, max)]),
    );
  }
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * How long Gladys may keep a content: the refresh interval, within its bounds.
 * @param {object} config - Normalized configuration.
 * @returns {number} Seconds, 10 to 3600.
 */
function ttlOf(config) {
  return Math.min(3600, Math.max(10, Number(config.poll_frequency) || 60));
}

/**
 * The "Refresh" button every card ends with.
 * @returns {object} A `button` component.
 */
function refreshButton() {
  return {
    type: 'button',
    label: { en: 'Refresh', fr: 'Rafraîchir' },
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: WIDGET_ACTION.REFRESH },
  };
}

/**
 * A content with a single message in it — nothing configured, nothing to show.
 * @param {object} config - Normalized configuration.
 * @param {{en: string, fr: string}} message - The message.
 * @returns {object} The content.
 */
function messageContent(config, message) {
  return {
    ttl_seconds: ttlOf(config),
    components: [{ type: 'text', variant: 'body', text: clip(message, MAX.BODY) }],
  };
}

const NOT_CONFIGURED = {
  en: 'Proxmox is not configured yet: fill in the host and the API token in the integration settings.',
  fr: "Proxmox n'est pas encore configuré : renseignez l'hôte et le jeton d'API dans les réglages de l'intégration.",
};

/**
 * Prefix a row with the server label — only when two servers are configured.
 * @param {object} server - The server.
 * @param {string} text - The row label.
 * @param {boolean} named - Whether the label must be shown.
 * @returns {string} The label.
 */
function rowLabel(server, text, named) {
  return named ? `${server.label} ${text}` : text;
}

/**
 * What went wrong on one server, named when two servers are configured.
 * @param {object} server - The server.
 * @param {Error} error - The failure.
 * @param {boolean} named - Whether the label must be shown.
 * @returns {{en: string, fr: string}} The message.
 */
function serverProblem(server, error, named) {
  const message = describeError(error);
  if (!named) {
    return message;
  }
  return { en: `${server.label}: ${message.en}`, fr: `${server.label} : ${message.fr}` };
}

/**
 * The caption listing what could not be read, and what did not fit.
 * @param {{en: string, fr: string}[]} problems - One message per failed server.
 * @param {number} hidden - Rows left out of the status list.
 * @returns {object|null} A `text` component, or null when there is nothing to say.
 */
function footnote(problems, hidden) {
  const parts = [...problems];
  if (hidden > 0) {
    parts.push({ en: `+${hidden} more`, fr: `+${hidden} de plus` });
  }
  if (parts.length === 0) {
    return null;
  }
  return {
    type: 'text',
    variant: 'caption',
    text: clip(
      {
        en: parts.map((part) => part.en).join(' '),
        fr: parts.map((part) => part.fr).join(' '),
      },
      MAX.CAPTION,
    ),
  };
}

/**
 * A count tile.
 * @param {{en: string, fr: string}} label - The tile label.
 * @param {number} value - The count.
 * @param {string} color - A `WIDGET_COLORS` value.
 * @returns {object} A `value` component.
 */
function countTile(label, value, color) {
  return { type: 'value', label: clip(label, MAX.TILE_LABEL), value, color };
}

// Which rows come first in the backups list: what needs a look.
const BACKUP_ORDER = { failed: 0, error: 1, none: 2, ok: 3 };

/**
 * One row of the backups list.
 * @param {object} entry - `{ server, node, backup?, error? }`.
 * @param {boolean} named - Whether the server label must be shown.
 * @returns {object} A status item.
 */
function backupRow(entry, named) {
  const { server, node, backup, error } = entry;
  const label = clip(rowLabel(server, node, named), MAX.STATUS_LABEL);
  if (error) {
    return {
      label,
      value: { en: 'read failed', fr: 'lecture impossible' },
      color: WIDGET_COLORS.DANGER,
    };
  }
  if (!backup) {
    const days = server.backup_lookback_days;
    return {
      label,
      value: { en: `no backup in ${days} d`, fr: `aucune sur ${days} j` },
      color: WIDGET_COLORS.WARNING,
    };
  }
  if (!backup.success) {
    return {
      label,
      value: clip(formatBackupStatus(backup), MAX.STATUS_VALUE),
      color: WIDGET_COLORS.DANGER,
    };
  }
  const when = formatTimestamp(
    backup.starttime,
    resolveTimezone(server.timezone),
    server.date_format,
  );
  return { label, value: clip(`OK — ${when}`, MAX.STATUS_VALUE), color: WIDGET_COLORS.SUCCESS };
}

/**
 * The verdict of one entry of the backups list.
 * @param {object} entry - `{ backup?, error? }`.
 * @returns {string} 'failed', 'error', 'none' or 'ok'.
 */
function backupVerdict(entry) {
  if (entry.error) {
    return 'error';
  }
  if (!entry.backup) {
    return 'none';
  }
  return entry.backup.success ? 'ok' : 'failed';
}

/**
 * Read the last backup of every node of one server.
 * @param {object} gladys - The SDK instance.
 * @param {object} server - A configured server.
 * @returns {Promise<object[]>} One `{ server, node, backup?, error? }` per node.
 */
async function readBackups(gladys, server) {
  // The nodes discovered at startup; a fresh list only when discovery found
  // none yet (the widget can be pulled before it ran).
  let nodes = monitoredNodes(server.id);
  if (nodes.length === 0) {
    nodes = (await listNodes(server)).map((entry) => entry.node);
  }
  return Promise.all(
    nodes.map(async (node) => {
      try {
        const { backup } = await readNode(gladys, server, node);
        return { server, node, backup };
      } catch (error) {
        return { server, node, error };
      }
    }),
  );
}

/**
 * Content of the `backups` widget.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<object>} The content.
 */
export async function backupsWidget(gladys, config) {
  const servers = listServers(config);
  if (servers.length === 0) {
    return messageContent(config, NOT_CONFIGURED);
  }
  const named = servers.length > 1;

  const entries = [];
  const problems = [];
  for (const server of servers) {
    try {
      const read = await readBackups(gladys, server);
      entries.push(...read);
      // A row only says "read failed": the reason goes under the list, once.
      const failed = read.find((entry) => entry.error);
      if (failed) {
        problems.push(serverProblem(server, failed.error, named));
      }
    } catch (error) {
      problems.push(serverProblem(server, error, named));
    }
  }

  const count = (verdict) => entries.filter((entry) => backupVerdict(entry) === verdict).length;
  const failed = count('failed');
  const none = count('none');
  const sorted = [...entries].sort(
    (a, b) => BACKUP_ORDER[backupVerdict(a)] - BACKUP_ORDER[backupVerdict(b)],
  );

  const components = [
    countTile({ en: 'Backups OK', fr: 'Sauvegardes OK' }, count('ok'), WIDGET_COLORS.SUCCESS),
    countTile(
      { en: 'Failed', fr: 'En échec' },
      failed,
      failed > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    ),
    countTile(
      { en: 'No backup', fr: 'Sans sauvegarde' },
      none,
      none > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    ),
  ];
  if (sorted.length > 0) {
    components.push({
      type: 'status',
      items: sorted.slice(0, MAX_STATUS_ROWS).map((entry) => backupRow(entry, named)),
    });
  }
  const note = footnote(problems, Math.max(0, sorted.length - MAX_STATUS_ROWS));
  if (note) {
    components.push(note);
  }
  components.push(refreshButton());

  return { ttl_seconds: ttlOf(config), components };
}

/**
 * The color of a guest state.
 * @param {string} status - The Proxmox state word.
 * @returns {string} A `WIDGET_COLORS` value.
 */
function guestColor(status) {
  if (status === 'running') {
    return WIDGET_COLORS.SUCCESS;
  }
  return status === 'stopped' ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.WARNING;
}

/**
 * Content of the `guests` widget.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {{show?: string}} [settings] - The widget settings.
 * @returns {Promise<object>} The content.
 */
export async function guestsWidget(gladys, config, settings = {}) {
  const servers = listServers(config);
  if (servers.length === 0) {
    return messageContent(config, NOT_CONFIGURED);
  }
  const named = servers.length > 1;
  const onlyNotRunning = settings?.show === GUESTS_SHOW.NOT_RUNNING;

  const entries = [];
  const problems = [];
  for (const server of servers) {
    try {
      const guests = await fetchGuests(server);
      for (const guest of guests) {
        await observeGuest(
          gladys,
          server,
          guestExternalIds(gladys, server, guest.key).device,
          guest,
        );
        entries.push({ server, guest });
      }
    } catch (error) {
      problems.push(serverProblem(server, error, named));
    }
  }

  const running = entries.filter((entry) => entry.guest.running).length;
  const stopped = entries.filter((entry) => entry.guest.status === 'stopped').length;
  const other = entries.length - running - stopped;

  const components = [
    countTile({ en: 'Running', fr: 'En marche' }, running, WIDGET_COLORS.SUCCESS),
    countTile({ en: 'Stopped', fr: 'Arrêtées' }, stopped, WIDGET_COLORS.NEUTRAL),
  ];
  if (other > 0) {
    // paused, suspended, unknown...: rare, and worth a look when it happens.
    components.push(countTile({ en: 'Other', fr: 'Autre' }, other, WIDGET_COLORS.WARNING));
  }

  const shown = entries
    .filter((entry) => !onlyNotRunning || !entry.guest.running)
    // Not running first, then in server and VMID order.
    .sort(
      (a, b) =>
        Number(a.guest.running) - Number(b.guest.running) ||
        a.server.id - b.server.id ||
        a.guest.vmid - b.guest.vmid,
    );

  if (shown.length > 0) {
    components.push({
      type: 'status',
      items: shown.slice(0, MAX_STATUS_ROWS).map(({ server, guest }) => {
        const name = guest.name.length > 0 ? guest.name : guest.kind.toUpperCase();
        return {
          label: clip(rowLabel(server, `${name} (${guest.vmid})`, named), MAX.STATUS_LABEL),
          value: clip(guest.status, MAX.STATUS_VALUE),
          color: guestColor(guest.status),
        };
      }),
    });
  } else if (entries.length > 0) {
    components.push({
      type: 'text',
      variant: 'body',
      text: { en: 'Every VM/LXC is running.', fr: 'Toutes les VM/LXC sont en marche.' },
    });
  } else if (problems.length === 0) {
    components.push({
      type: 'text',
      variant: 'body',
      text: {
        en: 'No VM/LXC is visible: grant VM.Audit on /vms to the API token.',
        fr: "Aucune VM/LXC visible : accordez VM.Audit sur /vms au jeton d'API.",
      },
    });
  }
  const note = footnote(problems, Math.max(0, shown.length - MAX_STATUS_ROWS));
  if (note) {
    components.push(note);
  }
  components.push(refreshButton());

  return { ttl_seconds: ttlOf(config), components };
}

/**
 * The color of a verdict text: "OK...", "failed — ...", or "unknown".
 * @param {string} text - The verdict, as published on the device.
 * @returns {string} A `WIDGET_COLORS` value.
 */
function verdictColor(text) {
  if (text.startsWith('OK')) {
    return WIDGET_COLORS.SUCCESS;
  }
  return text.startsWith('failed') ? WIDGET_COLORS.DANGER : WIDGET_COLORS.WARNING;
}

/**
 * A disk temperature tile, in the unit system of the reader.
 * @param {object} disk - A disk with a temperature, in °C.
 * @param {string} units - 'metric' or 'us'.
 * @returns {object} A `value` component.
 */
function diskTile(disk, units) {
  const celsius = disk.temperature;
  let color = WIDGET_COLORS.SUCCESS;
  if (celsius >= DISK_HOT_CELSIUS) {
    color = WIDGET_COLORS.DANGER;
  } else if (celsius >= DISK_WARM_CELSIUS) {
    color = WIDGET_COLORS.WARNING;
  }
  const us = units === 'us';
  return {
    type: 'value',
    label: clip(disk.id, MAX.TILE_LABEL),
    value: us ? Math.round((celsius * 9) / 5 + 32) : celsius,
    unit: us ? '°F' : '°C',
    icon: 'thermometer',
    color,
  };
}

/**
 * Content of the `node` widget.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {{node?: string}} [settings] - The widget settings: the node device.
 * @param {string} [units] - 'metric' or 'us'.
 * @returns {Promise<object>} The content.
 */
export async function nodeWidget(gladys, config, settings = {}, units = 'metric') {
  const descriptor = describeDevice(gladys, { external_id: settings?.node });
  if (!descriptor || descriptor.kind !== 'node') {
    return messageContent(config, {
      en: 'Pick a Proxmox node in the settings of this widget (not a VM/LXC).',
      fr: 'Choisissez un nœud Proxmox dans les réglages de ce widget (pas une VM/LXC).',
    });
  }
  const server = serverById(config, descriptor.serverId);
  if (!server) {
    return messageContent(config, {
      en: 'This node belongs to a Proxmox server that is not configured any more.',
      fr: "Ce nœud appartient à un serveur Proxmox qui n'est plus configuré.",
    });
  }

  const { node } = descriptor;
  const heading = {
    type: 'text',
    variant: 'heading',
    text: clip(`${server.label} ${node}`, MAX.HEADING),
  };

  let state;
  try {
    state = await readNode(gladys, server, node);
  } catch (error) {
    return {
      ttl_seconds: ttlOf(config),
      components: [
        heading,
        { type: 'text', variant: 'body', text: clip(describeError(error), MAX.BODY) },
        refreshButton(),
      ],
    };
  }

  const { backup, disks } = state;
  const timezone = resolveTimezone(server.timezone);
  const status = formatBackupStatus(backup);
  const items = [
    {
      label: { en: 'Last backup', fr: 'Dernière sauvegarde' },
      value: clip(formatLastBackup(backup, timezone, server.date_format), MAX.STATUS_VALUE),
      color: verdictColor(status),
    },
    {
      label: { en: 'Backup status', fr: 'Statut de la sauvegarde' },
      value: clip(status, MAX.STATUS_VALUE),
      color: verdictColor(status),
    },
  ];
  const duration = formatDuration(backup?.duration);
  if (duration) {
    items.push({ label: { en: 'Duration', fr: 'Durée' }, value: duration });
  }
  if (disks) {
    const smart = formatSmartStatus(disks);
    items.push({
      label: { en: 'SMART status', fr: 'État SMART' },
      value: clip(smart, MAX.STATUS_VALUE),
      color: verdictColor(smart),
    });
  }

  const hottest = (disks ?? [])
    .filter((disk) => Number.isFinite(disk.temperature))
    .sort((a, b) => b.temperature - a.temperature)
    .slice(0, MAX_DISK_TILES);

  return {
    ttl_seconds: ttlOf(config),
    components: [
      heading,
      ...hottest.map((disk) => diskTile(disk, units)),
      {
        // Live: follows the published states, with the history Gladys keeps.
        type: 'chart',
        chart_type: 'bar',
        title: { en: 'Backup duration', fr: 'Durée des sauvegardes' },
        unit: 's',
        device_features: [
          nodeExternalIds(gladys, server, node).feature(NODE_FEATURE.BACKUP_DURATION),
        ],
        interval: 'last-month',
      },
      { type: 'status', items },
      refreshButton(),
    ],
  };
}

/**
 * The "Refresh" button of a widget: read Proxmox again and publish the states.
 * Gladys then drops the cached content, and the card re-pulls it.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @param {string} widget - The widget key.
 * @param {string} actionKey - The button action key.
 * @param {object} [settings] - The widget settings.
 * @returns {Promise<{en: string, fr: string}>} The toast.
 */
export async function widgetAction(gladys, config, widget, actionKey, settings = {}) {
  if (actionKey !== WIDGET_ACTION.REFRESH) {
    throw new Error(`Unknown widget action "${actionKey}".`);
  }
  if (listServers(config).length === 0) {
    return { en: 'Proxmox is not configured yet.', fr: "Proxmox n'est pas encore configuré." };
  }
  if (widget === WIDGET.NODE) {
    // Only the node on screen: the others are not what the user is looking at.
    await pollDevice(gladys, config, { external_id: settings?.node }, { force: true });
    return { en: 'Node read again.', fr: 'Nœud relu.' };
  }
  const results = await pollAllDevices(gladys, config);
  const failed = results.filter((result) => result.error).length;
  if (failed === 0) {
    return { en: 'Proxmox read again.', fr: 'Proxmox relu.' };
  }
  return {
    en: `Read again, ${failed} device(s) failed.`,
    fr: `Relu, échec sur ${failed} appareil(s).`,
  };
}
