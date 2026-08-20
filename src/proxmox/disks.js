// -----------------------------------------------------------------------------
// The physical disks of a node: their SMART verdict, and how hot they run.
//
// Two read-only endpoints:
//
//   GET /api2/json/nodes/{node}/disks/list          -> every disk, with its
//                                                      SMART health verdict
//   GET /api2/json/nodes/{node}/disks/smart?disk=…  -> the SMART data of ONE
//                                                      disk, temperature included
//
// Unlike the task list and `/cluster/resources`, these two are permission
// CHECKED rather than permission filtered: a token without `Sys.Audit` on
// `/nodes/{node}` gets a real 403, which is what "Test the connection" reports.
//
// Temperature is not part of the disk list — Proxmox only exposes it inside the
// SMART payload of each disk — so reading it costs one request PER DISK, each
// running a `smartctl` on the Proxmox side. That is why it is a separate
// setting ("Disk monitoring") rather than something always on.
//
// Two SMART payload shapes exist, and both are handled: the structured `ata`
// attribute table (temperature is attribute 194, sometimes 190), and the `text`
// blob smartctl produces for NVMe drives and for controllers it has no table
// for (temperature is a "Temperature: 35 Celsius" line in it).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { get, ProxmoxError } from './client.js';
import { DISKS_MONITORING } from '../config.js';

const logger = createLogger({ name: 'proxmox-disks' });

// The SMART attribute ids carrying a temperature, in order of preference:
// 194 is `Temperature_Celsius`, 190 `Airflow_Temperature_Cel` — some drives
// only report the second one.
const TEMPERATURE_ATTRIBUTE_IDS = [194, 190];

// What a plausible disk temperature is. Anything outside is a packed raw value
// (some drives encode min/max in the same field) rather than a reading, and
// publishing it would be a lie the "unknown beats a plausible lie" rule forbids.
export const MIN_DISK_TEMPERATURE = 0;
export const MAX_DISK_TEMPERATURE = 120;

// The health verdicts smartctl hands Proxmox for a disk that is fine.
const HEALTHY_VERDICTS = new Set(['PASSED', 'OK']);
// ...and the ones that mean "no verdict at all", which is not a failure.
const UNKNOWN_VERDICTS = new Set(['', 'UNKNOWN', 'N/A', '-']);

// Nodes that answered 400 to `skipsmart`, so the fallback is taken directly on
// the next discovery instead of paying for a doomed request every time.
const noSkipSmart = new Set();

/**
 * Forget which nodes rejected `skipsmart` (a reconfiguration, or a test that
 * must not inherit the previous one).
 * @returns {void}
 */
export function resetSkipSmartSupport() {
  noSkipSmart.clear();
}

/**
 * Does this server read the disks at all?
 * @param {object} server - A configured server.
 * @returns {boolean} True unless disk monitoring is turned off.
 */
export function readsDisks(server) {
  return server?.disks_monitoring !== DISKS_MONITORING.OFF;
}

/**
 * Does this server read the temperature of each disk?
 * @param {object} server - A configured server.
 * @returns {boolean} True when the temperature mode is selected.
 */
export function readsDiskTemperature(server) {
  return server?.disks_monitoring === DISKS_MONITORING.SMART_AND_TEMPERATURE;
}

/**
 * The identifier a disk carries inside a Gladys feature external id.
 *
 * `/dev/sda` -> `sda`, `/dev/nvme0n1` -> `nvme0n1`. The path is stable across
 * reboots far more often than it is not, and it is what Proxmox itself shows;
 * anything a feature id cannot hold is folded to a dash.
 * @param {string} devpath - The device path Proxmox reported.
 * @returns {string} The identifier.
 */
export function diskId(devpath) {
  return String(devpath ?? '')
    .replace(/^\/dev\//, '')
    .replace(/[^A-Za-z0-9_.-]/g, '-');
}

/**
 * Classify a SMART health verdict.
 * @param {string|undefined} health - The `health` field Proxmox reported.
 * @returns {boolean|null} True when healthy, false when failing, null when
 *   Proxmox has no verdict for that disk.
 */
export function normalizeHealth(health) {
  const verdict = String(health ?? '')
    .trim()
    .toUpperCase();
  if (UNKNOWN_VERDICTS.has(verdict)) {
    return null;
  }
  return HEALTHY_VERDICTS.has(verdict);
}

/**
 * Keep a temperature only when it reads like one.
 * @param {unknown} value - A parsed number.
 * @returns {number|null} The temperature in °C, or null.
 */
function plausibleTemperature(value) {
  const celsius = Number(value);
  if (!Number.isFinite(celsius)) {
    return null;
  }
  return celsius >= MIN_DISK_TEMPERATURE && celsius <= MAX_DISK_TEMPERATURE
    ? Math.round(celsius)
    : null;
}

/**
 * Pull the temperature out of a SMART payload, whichever shape it has.
 *
 * The structured shape is an attribute table: the raw value of 194/190 starts
 * with the temperature, sometimes followed by the min/max the drive also packs
 * in there (`35 (Min/Max 20/45)`). The text shape is the smartctl output as it
 * came, where NVMe drives report a `Temperature: 35 Celsius` line.
 * @param {object|null} smart - The `data` of `/disks/smart`.
 * @returns {number|null} The temperature in °C, or null when there is none.
 */
export function parseSmartTemperature(smart) {
  if (!smart || typeof smart !== 'object') {
    return null;
  }

  if (Array.isArray(smart.attributes)) {
    for (const wanted of TEMPERATURE_ATTRIBUTE_IDS) {
      const attribute = smart.attributes.find((entry) => Number(entry?.id) === wanted);
      if (!attribute) {
        continue;
      }
      const raw = String(attribute.raw ?? '').trim();
      const temperature = plausibleTemperature(/^-?\d+/.exec(raw)?.[0]);
      if (temperature !== null) {
        return temperature;
      }
    }
  }

  const text = String(smart.text ?? '');
  if (text.length > 0) {
    // `Temperature:            35 Celsius`, `Current Drive Temperature: 35 C`,
    // `Temperature Sensor 1:   35 Celsius`.
    const labelled = /^[^\S\n]*(?:current drive )?temperature(?:[^:\n]*)?:[^\S\n]*(-?\d+)/im.exec(
      text,
    );
    const temperature = plausibleTemperature(labelled?.[1]);
    if (temperature !== null) {
      return temperature;
    }
    const celsius = /(-?\d+)\s*Celsius/i.exec(text);
    return plausibleTemperature(celsius?.[1]);
  }

  return null;
}

/**
 * List the physical disks of one node.
 *
 * `skipsmart` is asked for when only the device list is needed (discovery):
 * without it Proxmox runs a `smartctl` on every disk just to answer. Older
 * nodes declare `additionalProperties => 0` on that endpoint and answer 400
 * instead of ignoring the parameter, so the rejection is remembered and the
 * plain request used from then on.
 * @param {object} server - A configured server.
 * @param {string} node - Node name.
 * @param {object} [options] - Options.
 * @param {boolean} [options.skipSmart] - Ask Proxmox not to run smartctl.
 * @returns {Promise<object[]>} The disks, sorted by device path.
 */
export async function listDisks(server, node, { skipSmart = false } = {}) {
  const path = `/nodes/${encodeURIComponent(node)}/disks/list`;
  const cacheKey = `${server.host}:${server.port}/${node}`;
  const wantsSkip = skipSmart && !noSkipSmart.has(cacheKey);

  let data;
  try {
    data = await get(server, path, wantsSkip ? { skipsmart: 1 } : {});
  } catch (error) {
    if (!wantsSkip || !(error instanceof ProxmoxError) || error.status !== 400) {
      throw error;
    }
    // This node does not know `skipsmart`: remember it, and pay for the full
    // read from now on instead of a doomed request before each one.
    logger.debug(`${node} rejected skipsmart on ${path}: reading the full disk list instead.`);
    noSkipSmart.add(cacheKey);
    data = await get(server, path);
  }

  if (!Array.isArray(data)) {
    throw new ProxmoxError('parse', `Proxmox returned an unexpected answer for ${path}.`);
  }

  return data
    .filter((entry) => typeof entry?.devpath === 'string' && entry.devpath.length > 0)
    .map((entry) => ({
      devpath: entry.devpath,
      id: diskId(entry.devpath),
      model: String(entry.model ?? '').trim(),
      type: String(entry.type ?? '').trim(),
      health: String(entry.health ?? '').trim(),
      healthy: normalizeHealth(entry.health),
    }))
    .sort((a, b) => a.devpath.localeCompare(b.devpath));
}

/**
 * Read the temperature of one disk.
 *
 * A drive that reports none — and a controller that hides the SMART data
 * altogether — yields null: no state is published for it, rather than a 0 °C
 * that would read like a measurement.
 * @param {object} server - A configured server.
 * @param {string} node - Node name.
 * @param {string} devpath - The disk device path.
 * @returns {Promise<number|null>} The temperature in °C, or null.
 */
export async function fetchDiskTemperature(server, node, devpath) {
  const data = await get(server, `/nodes/${encodeURIComponent(node)}/disks/smart`, {
    disk: devpath,
  });
  return parseSmartTemperature(data);
}

/**
 * Read the disks of one node: their health, and their temperature when the
 * configuration asks for it.
 *
 * One unreadable disk must not hide the others: a SMART read that fails leaves
 * that disk without a temperature and keeps going. A failure of the disk LIST
 * itself does throw — there is nothing to report at all then, and the caller
 * turns it into an "unknown" SMART status.
 * @param {object} server - A configured server.
 * @param {string} node - Node name.
 * @returns {Promise<object[]>} The disks, temperature included when asked for.
 */
export async function fetchDisksHealth(server, node) {
  const disks = await listDisks(server, node);
  if (!readsDiskTemperature(server)) {
    return disks.map((disk) => ({ ...disk, temperature: null }));
  }

  return Promise.all(
    disks.map(async (disk) => {
      try {
        return { ...disk, temperature: await fetchDiskTemperature(server, node, disk.devpath) };
      } catch (error) {
        logger.debug(
          `${server.label ?? server.host}: no SMART data for ${disk.devpath} on ${node}: ` +
            error.message,
        );
        return { ...disk, temperature: null };
      }
    }),
  );
}
