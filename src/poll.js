// -----------------------------------------------------------------------------
// Poll frequency: what Gladys accepts, and what the user actually asked for.
//
// Gladys does NOT take an arbitrary refresh interval. A discovered device may
// only carry one of six values, expressed in MILLISECONDS
// (`DEVICE_POLL_FREQUENCIES` in the core): 1 s, 2 s, 10 s, 15 s, 30 s, 60 s.
// Anything else makes `setDiscoveredDevices` reject the WHOLE publish with
// `devices[0].poll_frequency: invalid poll frequency` — so a single bad value
// does not degrade one device, it aborts the entire discovery.
//
// The configured "Refresh interval" is in seconds and goes up to an hour, which
// no accepted value can express. So the two concerns are split:
//
//   - the device declares the SLOWEST frequency Gladys accepts (60 s), which is
//     the only way to be called back at all;
//   - the integration then enforces the configured interval itself, skipping
//     the polls that arrive too early. Reading a Proxmox every minute when the
//     user asked for every five is exactly the load the setting exists to
//     avoid, and a skipped poll publishes nothing: the last known state stays.
// -----------------------------------------------------------------------------

// The values Gladys accepts on a discovered device, in milliseconds, ascending.
// Mirrored from the core's `DEVICE_POLL_FREQUENCIES`.
export const GLADYS_POLL_FREQUENCIES = [1000, 2000, 10000, 15000, 30000, 60000];

// Gladys ticks are not metronomes: one arriving a few seconds early must not
// push the whole schedule to the next tick (a 300 s interval polled on a 60 s
// tick would silently become 360 s).
const EARLY_TOLERANCE_MS = 5000;

// external_id -> timestamp of the last poll we let through.
const lastPolledAt = new Map();

/**
 * The poll frequency to declare on a device, for a configured interval.
 *
 * The largest accepted value that does not overshoot the interval: asking to be
 * called back LESS often than the user wants would make the setting
 * unreachable, whereas being called back more often is fine — the extra calls
 * are skipped by `claimPoll()`.
 * @param {number} intervalSeconds - The configured refresh interval, seconds.
 * @returns {number} One of `GLADYS_POLL_FREQUENCIES`, in milliseconds.
 */
export function devicePollFrequency(intervalSeconds) {
  const wanted = Number(intervalSeconds) * 1000;
  if (!Number.isFinite(wanted)) {
    return GLADYS_POLL_FREQUENCIES[GLADYS_POLL_FREQUENCIES.length - 1];
  }
  const accepted = GLADYS_POLL_FREQUENCIES.filter((value) => value <= wanted);
  // An interval shorter than the fastest accepted value still has to publish
  // one: the fastest is then the closest we can get.
  return accepted.length > 0 ? accepted[accepted.length - 1] : GLADYS_POLL_FREQUENCIES[0];
}

/**
 * Is this device due for a read — and if so, count it as read.
 *
 * Called on every `onPoll`, hence the side effect: the timestamp is recorded
 * when the poll is let through, so the next one is measured from here. It is
 * recorded BEFORE the Proxmox read rather than after, so a failing server is
 * retried at the configured interval instead of once a minute.
 * @param {string} externalId - The Gladys device external id.
 * @param {number} intervalSeconds - The configured refresh interval, seconds.
 * @param {number} [now] - Current time, injectable for the tests.
 * @returns {boolean} True when the device must be read now.
 */
export function claimPoll(externalId, intervalSeconds, now = Date.now()) {
  const last = lastPolledAt.get(externalId);
  const interval = Number(intervalSeconds) * 1000;
  if (
    last !== undefined &&
    Number.isFinite(interval) &&
    now - last < interval - EARLY_TOLERANCE_MS
  ) {
    return false;
  }
  lastPolledAt.set(externalId, now);
  return true;
}

/**
 * Record a read that did NOT go through `claimPoll()` — an immediate refresh.
 *
 * A device the user has just added is read right away (`onDeviceCreated`), and
 * so is a device refreshed by hand: the next scheduled poll must then be
 * measured from that read, not from the previous one, otherwise the forced read
 * is followed a minute later by a second one.
 * @param {string} externalId - The Gladys device external id.
 * @param {number} [now] - Current time, injectable for the tests.
 * @returns {void}
 */
export function markPolled(externalId, now = Date.now()) {
  lastPolledAt.set(externalId, now);
}

/**
 * Forget every recorded poll, so the next one of each device happens at once.
 *
 * Called on discovery: a re-discovery follows a (re)connection or a
 * configuration change — including a change of the interval itself — and the
 * user watching the screen expects fresh values, not the remainder of the
 * previous schedule.
 * @returns {void}
 */
export function resetPollThrottle() {
  lastPolledAt.clear();
}
