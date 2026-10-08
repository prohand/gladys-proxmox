// -----------------------------------------------------------------------------
// The connection status of the Configuration screen, kept in step with the reads.
//
// The status used to be written by initialize() alone: a Proxmox that booted
// after Gladys stayed red for good once it answered again, and one that went
// down later stayed green. So every read reports its outcome here, and the
// status is red while at least one device's last read failed.
//
// That set has to forget a device the user DELETED: nothing reads it any more,
// so nothing would ever clear its failure, and the status stayed red until the
// next reconnection over a device that no longer exists.
// -----------------------------------------------------------------------------

import { describeError } from './actions.js';

/**
 * Build the status tracker of one SDK instance.
 * @param {object} gladys - The SDK instance.
 * @returns {object} `{ report, forget, clear, written }`.
 */
export function createStatusTracker(gladys) {
  // Devices whose last read failed, and the status last written.
  const failingDevices = new Map();
  let reportedConnected = null;

  /**
   * Write the status when it moved.
   * @returns {Promise<void>} Resolves once Gladys stored the status, if it moved.
   */
  async function sync() {
    const connected = failingDevices.size === 0;
    if (connected === reportedConnected) {
      return;
    }
    reportedConnected = connected;
    const [firstError] = failingDevices.values();
    await gladys
      .setConnectionStatus(connected, connected ? undefined : describeError(firstError))
      .catch(() => {});
  }

  return {
    /**
     * Record the outcome of one read.
     * @param {string} externalId - The device just read.
     * @param {Error|null} error - Why its read failed, or null when it worked.
     * @returns {Promise<void>} Resolves once the status is up to date.
     */
    async report(externalId, error) {
      if (error) {
        failingDevices.set(externalId, error);
      } else {
        failingDevices.delete(externalId);
      }
      await sync();
    },

    /**
     * Forget a device the user deleted.
     * @param {string} externalId - The deleted device.
     * @returns {Promise<void>} Resolves once the status is up to date.
     */
    async forget(externalId) {
      if (failingDevices.delete(externalId)) {
        await sync();
      }
    },

    /**
     * Start over: a discovery is about to write the status itself.
     * @returns {void}
     */
    clear() {
      failingDevices.clear();
    },

    /**
     * Record a status written by someone else (the discovery).
     * @param {boolean} connected - The status written.
     * @returns {void}
     */
    written(connected) {
      reportedConnected = connected;
    },
  };
}
