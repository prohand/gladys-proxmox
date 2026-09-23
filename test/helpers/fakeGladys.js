// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the integration modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishStates                 -> record calls so tests can assert them
//   - setConnectionStatus           -> record calls so tests can assert them
//   - publishSceneEvent             -> record the scene events fired
//   - requestWidgetRefresh          -> record the widget nudges
// This lets us test the wiring (discovery payloads, dispatch, published
// states) without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

/**
 * Build a fake Gladys SDK instance.
 * @param {string} [selector] - Integration selector used to build external ids.
 * @returns {object} The fake instance, with its recorded calls.
 */
export function createFakeGladys(selector = 'proxmox') {
  const published = [];
  const connectionStatuses = [];
  const sceneEvents = [];
  const widgetRefreshes = [];

  return {
    published,
    connectionStatuses,
    sceneEvents,
    widgetRefreshes,

    externalIds(type, platformId) {
      const device = `ext:${selector}:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishStates(states) {
      published.push(...states);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async publishSceneEvent(key, data) {
      sceneEvents.push({ key, data });
      return { success: true };
    },

    requestWidgetRefresh(key) {
      widgetRefreshes.push(key);
    },
  };
}
