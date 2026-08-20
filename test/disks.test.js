// -----------------------------------------------------------------------------
// Reading the physical disks of a node: the health verdict, and the two SMART
// payload shapes a temperature can hide in.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diskId,
  normalizeHealth,
  parseSmartTemperature,
  readsDisks,
  readsDiskTemperature,
} from '../src/proxmox/disks.js';
import { DISKS_MONITORING, normalizeConfig } from '../src/config.js';
import { listServers } from '../src/servers.js';

/**
 * A configured server carrying one disk-monitoring mode.
 * @param {string} [mode] - The mode, or the default when omitted.
 * @returns {object} The server.
 */
function serverWith(mode) {
  return listServers(
    normalizeConfig({
      host: 'pve.lan',
      token_id: 'a@pve!b',
      token_secret: 's',
      ...(mode === undefined ? {} : { disks_monitoring: mode }),
    }),
  )[0];
}

test('the disk id is what a feature external id can hold', () => {
  assert.equal(diskId('/dev/sda'), 'sda');
  assert.equal(diskId('/dev/nvme0n1'), 'nvme0n1');
  assert.equal(diskId('/dev/disk/by-id/ata-ST4000VN008_ZDH'), 'disk-by-id-ata-ST4000VN008_ZDH');
  assert.equal(diskId(undefined), '');
});

test('a disk with no verdict is not a failing disk', () => {
  assert.equal(normalizeHealth('PASSED'), true);
  assert.equal(normalizeHealth('passed'), true);
  assert.equal(normalizeHealth('OK'), true);
  assert.equal(normalizeHealth('FAILED'), false);
  // Anything smartctl says that is not a pass is a failure worth showing.
  assert.equal(normalizeHealth('FAILED!'), false);
  // ...but "no answer" is neither: it stays unknown.
  assert.equal(normalizeHealth('UNKNOWN'), null);
  assert.equal(normalizeHealth(''), null);
  assert.equal(normalizeHealth(undefined), null);
});

test('the temperature is read from the SMART attribute table', () => {
  assert.equal(
    parseSmartTemperature({
      type: 'ata',
      attributes: [
        { id: 5, name: 'Reallocated_Sector_Ct', raw: '0' },
        { id: 194, name: 'Temperature_Celsius', raw: '31 (Min/Max 20/45)' },
      ],
    }),
    31,
  );
  // Some drives only report the airflow attribute (190).
  assert.equal(
    parseSmartTemperature({
      type: 'ata',
      attributes: [{ id: 190, name: 'Airflow_Temperature_Cel', raw: '38' }],
    }),
    38,
  );
});

test('the temperature is read from the smartctl text of an NVMe drive', () => {
  const text = [
    'SMART/Health Information (NVMe Log 0x02)',
    'Critical Warning:                   0x00',
    'Temperature:                        41 Celsius',
    'Available Spare:                    100%',
  ].join('\n');
  assert.equal(parseSmartTemperature({ type: 'text', text }), 41);

  assert.equal(
    parseSmartTemperature({ type: 'text', text: 'Current Drive Temperature:     29 C' }),
    29,
  );
  assert.equal(
    parseSmartTemperature({ type: 'text', text: 'Temperature Sensor 1:           35 Celsius' }),
    35,
  );
});

test('a payload with no plausible temperature reports none', () => {
  // A packed raw value is not a reading: publishing it would be the plausible
  // lie the integration refuses to tell.
  assert.equal(parseSmartTemperature({ attributes: [{ id: 194, raw: '2814749767106561' }] }), null);
  assert.equal(parseSmartTemperature({ attributes: [{ id: 5, raw: '0' }] }), null);
  assert.equal(parseSmartTemperature({ type: 'text', text: 'no SMART support' }), null);
  assert.equal(parseSmartTemperature(null), null);
  assert.equal(parseSmartTemperature({}), null);
});

test('the disk-monitoring mode decides which reads happen', () => {
  // The default is what the feature was asked for: health and temperatures.
  assert.equal(readsDisks(serverWith()), true);
  assert.equal(readsDiskTemperature(serverWith()), true);

  assert.equal(readsDisks(serverWith(DISKS_MONITORING.SMART)), true);
  assert.equal(readsDiskTemperature(serverWith(DISKS_MONITORING.SMART)), false);

  assert.equal(readsDisks(serverWith(DISKS_MONITORING.OFF)), false);
  assert.equal(readsDiskTemperature(serverWith(DISKS_MONITORING.OFF)), false);
});
