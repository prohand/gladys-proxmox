// -----------------------------------------------------------------------------
// Entry point of the Proxmox external integration.
//
// Role of this file: wire the SDK to the Proxmox modules. It holds no Proxmox
// logic of its own — the API client lives in `src/proxmox/`, the device shape
// in `src/devices/` — it only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects, discovers the nodes and guests of every configured Proxmox
//      server, and publishes them.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { hasConfiguredServer, listServers } from './src/servers.js';
import { discoverDevices, pollDevice } from './src/devices/index.js';
import { describeError, describeFailures, refreshNow, testConnection } from './src/actions.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded through onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> discovering Proxmox nodes and guests');
  if (!hasConfiguredServer(config)) {
    // Throw: the SDK acknowledges with success:false, and the user sees why in
    // the Discovery tab instead of an empty list with no explanation.
    throw new Error('The Proxmox host and API token must be configured first.');
  }
  const { devices, failures } = await publishDevices();
  if (devices.length === 0 && failures.length > 0) {
    // Nothing at all came back: say why rather than showing an empty list. A
    // partial failure (one server of two) is reported by the connection status
    // instead, so the devices that WERE found still land in the Discovery tab.
    throw new Error(describeFailures(failures).en);
  }
});

// --- Polling: Gladys asks to refresh one device (a node, or a guest) ---------
gladys.onPoll(async (device) => {
  if (!hasConfiguredServer(config)) {
    logger.warn('onPoll ignored: the integration is not configured yet');
    return;
  }
  await pollDevice(gladys, config, device);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', () => testConnection(config));
gladys.onAction('refresh_now', () => refreshNow(gladys, config));

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // The node list, the guest list and the poll frequency all depend on the
  // configuration: re-publish. publishDiscoveredDevices is idempotent (upsert
  // by external_id).
  await initialize();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name):
// this handler only runs the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
  } catch (error) {
    // Losing the configuration read is not fatal: keep the values we already
    // hold (or the defaults) and let initialize() report the resulting state.
    logger.error('Could not read the configuration from Gladys', error);
  }
  await initialize();
});

/**
 * Discover the nodes, publish them, and report the application-level status
 * shown in the Configuration screen.
 *
 * The status is deliberately distinct from the container state: the
 * integration can be RUNNING and still unable to talk to Proxmox (wrong token,
 * unreachable host, untrusted certificate), and that is exactly what the user
 * needs to see.
 * @returns {Promise<void>} Resolves once the status has been reported.
 */
async function initialize() {
  if (!hasConfiguredServer(config)) {
    logger.info('Waiting for the configuration (host, token ID and token secret)');
    await gladys
      .setConnectionStatus(false, {
        en: 'Not configured yet: fill in the Proxmox host and the API token.',
        fr: "Pas encore configurée : renseignez l'hôte Proxmox et le jeton d'API.",
      })
      .catch(() => {});
    return;
  }

  try {
    const { failures } = await publishDevices();
    if (failures.length === 0) {
      await gladys.setConnectionStatus(true);
      return;
    }
    // One of the configured servers did not answer. The status is the only
    // place that can say so: the devices of the other one keep updating.
    await gladys
      .setConnectionStatus(false, describeFailures(failures, listServers(config).length > 1))
      .catch(() => {});
  } catch (error) {
    logger.error('Initialization failed', error);
    await gladys.setConnectionStatus(false, describeError(error)).catch(() => {});
  }
}

/**
 * Discover the nodes and guests of every configured Proxmox, and publish them
 * as Gladys devices.
 * @returns {Promise<{devices: object[], failures: object[]}>} What was
 *   discovered, and which servers failed.
 */
async function publishDevices() {
  const { devices, failures } = await discoverDevices(gladys, config);
  await gladys.publishDiscoveredDevices(devices);
  return { devices, failures };
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT). Nothing of ours to tear down: every Proxmox
// request is a short-lived HTTPS call with no pooled connection.
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Proxmox integration...');
gladys.connect().catch((error) => {
  logger.error('Initial connection failed', error);
  process.exit(1);
});
