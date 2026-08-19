// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// `test_connection` is the important one. Both Proxmox endpoints this
// integration reads are permission-FILTERED rather than permission-checked: a
// token without `Sys.Audit` on `/nodes/<node>` gets a 200 with only its own
// tasks in it, and a token without `VM.Audit` gets a 200 with an empty guest
// list. An under-privileged setup therefore looks like "everything works, this
// node simply never backs anything up". This action probes each node explicitly
// and names what is missing.
//
// Both actions run on EVERY configured Proxmox server, and say which one they
// are talking about as soon as there is more than one.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ProxmoxError } from './proxmox/client.js';
import { listNodes, probeNodeAudit } from './proxmox/nodes.js';
import { fetchGuests } from './proxmox/guests.js';
import { listServers } from './servers.js';
import { pollAllDevices } from './devices/index.js';
import { formatBackupSummary, resolveTimezone } from './format.js';

const logger = createLogger({ name: 'actions' });

const NOT_CONFIGURED = {
  en: 'Fill in the Proxmox host, the API token ID and its secret first, then save.',
  fr: "Renseignez d'abord l'hôte Proxmox, l'identifiant du jeton d'API et son secret, puis enregistrez.",
};

/**
 * Turn a client error into the bilingual message shown under the button.
 * @param {Error} error - The failure.
 * @returns {{en: string, fr: string}} The message.
 */
export function describeError(error) {
  const kind = error instanceof ProxmoxError ? error.kind : 'unknown';
  switch (kind) {
    case 'auth':
      return {
        en: 'Proxmox refused the API token (401). Check the token ID (user@realm!name) and its secret.',
        fr: "Proxmox a refusé le jeton d'API (401). Vérifiez l'identifiant (utilisateur@realm!nom) et son secret.",
      };
    case 'permission':
      return {
        en: 'Proxmox refused the request (403): grant the token the PVEAuditor role on / (Sys.Audit on /nodes and VM.Audit on /vms).',
        fr: 'Proxmox a refusé la requête (403) : accordez au jeton le rôle PVEAuditor sur / (Sys.Audit sur /nodes et VM.Audit sur /vms).',
      };
    case 'tls':
      return {
        en: `TLS check failed: ${error.message}`,
        fr: `Échec de la vérification TLS : ${error.message}`,
      };
    case 'timeout':
      return {
        en: 'Proxmox did not answer in time. Check the host, the port and the network.',
        fr: "Proxmox n'a pas répondu à temps. Vérifiez l'hôte, le port et le réseau.",
      };
    case 'network':
      return {
        en: `Cannot reach Proxmox: ${error.message}`,
        fr: `Proxmox est injoignable : ${error.message}`,
      };
    default:
      return {
        en: `Proxmox request failed: ${error.message}`,
        fr: `La requête Proxmox a échoué : ${error.message}`,
      };
  }
}

/**
 * Name the server a message is about — but only when there is more than one:
 * a single-server setup has nothing to disambiguate.
 * @param {object} server - The server.
 * @param {{en: string, fr: string}} message - The message.
 * @param {boolean} named - Whether the label must be shown.
 * @returns {{en: string, fr: string}} The message, prefixed or not.
 */
function withServerLabel(server, message, named) {
  if (!named) {
    return message;
  }
  return {
    en: `[${server.label}] ${message.en}`,
    fr: `[${server.label}] ${message.fr}`,
  };
}

/**
 * Join one message per server into the single string shown under the button.
 * @param {{en: string, fr: string}[]} messages - The per-server messages.
 * @returns {{en: string, fr: string}} The joined message.
 */
function joinMessages(messages) {
  return {
    en: messages.map((message) => message.en).join(' '),
    fr: messages.map((message) => message.fr).join(' '),
  };
}

/**
 * Report what went wrong on the servers a discovery could not read.
 * @param {{server: object, error: Error}[]} failures - The failures.
 * @param {boolean} named - Whether the server labels must be shown.
 * @returns {{en: string, fr: string}} The message.
 */
export function describeFailures(failures, named = failures.length > 1) {
  return joinMessages(
    failures.map(({ server, error }) => withServerLabel(server, describeError(error), named)),
  );
}

/**
 * Count the guests the token can actually see, without failing the whole test
 * when that read is the only thing that went wrong.
 * @param {object} server - A configured server.
 * @returns {Promise<{en: string, fr: string}>} The sentence appended to the test result.
 */
async function describeGuestVisibility(server) {
  let guests;
  try {
    guests = await fetchGuests(server, { force: true });
  } catch (error) {
    logger.warn(`test_connection: the guest list of ${server.label} could not be read`, error);
    return {
      en: ` The VM/LXC list could not be read: ${error.message}`,
      fr: ` La liste des VM/LXC n'a pas pu être lue : ${error.message}`,
    };
  }

  if (guests.length === 0) {
    // /cluster/resources is filtered, not refused: an empty list is what a
    // token without VM.Audit sees, and also what an empty cluster looks like.
    return {
      en:
        ' No VM or LXC is visible: grant VM.Audit (role PVEAuditor) on /vms to the token' +
        ' if this cluster does host guests.',
      fr:
        " Aucune VM ni LXC n'est visible : accordez VM.Audit (rôle PVEAuditor) sur /vms au jeton" +
        ' si ce cluster héberge bien des invités.',
    };
  }
  return {
    en: ` ${guests.length} VM/LXC visible.`,
    fr: ` ${guests.length} VM/LXC visible(s).`,
  };
}

/**
 * Run the connection test against ONE server.
 * @param {object} server - A configured server.
 * @returns {Promise<{en: string, fr: string}>} What that server answered.
 */
async function testServer(server) {
  let nodes;
  try {
    nodes = await listNodes(server);
  } catch (error) {
    logger.error(`test_connection: node listing failed on ${server.label}`, error);
    return describeError(error);
  }

  if (nodes.length === 0) {
    return {
      en: 'Connected, but no node matched. Clear the "Nodes to monitor" field, or check the names you listed.',
      fr: 'Connexion réussie, mais aucun nœud ne correspond. Videz le champ « Nœuds à surveiller » ou vérifiez les noms saisis.',
    };
  }

  const probes = await Promise.all(nodes.map(({ node }) => probeNodeAudit(server, node)));
  const granted = probes.filter((probe) => probe.granted).map((probe) => probe.node);
  const denied = probes.filter((probe) => !probe.granted).map((probe) => probe.node);
  const guestsMessage = await describeGuestVisibility(server);

  if (denied.length === 0) {
    return {
      en: `Connection OK. Read access granted on ${granted.length} node(s): ${granted.join(', ')}.${guestsMessage.en}`,
      fr: `Connexion OK. Accès en lecture accordé sur ${granted.length} nœud(s) : ${granted.join(', ')}.${guestsMessage.fr}`,
    };
  }

  // Partial or total denial: say which nodes, and what to grant. Without
  // Sys.Audit the task list is silently filtered down to the token's own
  // tasks, so the backup features would stay unknown instead of raising.
  const grantedPart = granted.length > 0 ? ` Working on: ${granted.join(', ')}.` : '';
  const grantedPartFr = granted.length > 0 ? ` Fonctionne sur : ${granted.join(', ')}.` : '';
  return {
    en:
      `Connected, but the token cannot read the task log of: ${denied.join(', ')}.` +
      ` Grant Sys.Audit (role PVEAuditor) on /nodes to ${server.token_id}.${grantedPart}${guestsMessage.en}`,
    fr:
      `Connexion établie, mais le jeton ne peut pas lire le journal des tâches de : ${denied.join(', ')}.` +
      ` Accordez Sys.Audit (rôle PVEAuditor) sur /nodes à ${server.token_id}.${grantedPartFr}${guestsMessage.fr}`,
  };
}

/**
 * `test_connection`: reachability, authentication, then the read-only
 * privileges on every monitored node and on the guests — on every configured
 * Proxmox server.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{en: string, fr: string}>} The message shown under the button.
 */
export async function testConnection(config) {
  const servers = listServers(config);
  if (servers.length === 0) {
    return NOT_CONFIGURED;
  }

  // The servers are independent: testing them in parallel keeps the action
  // inside its manifest timeout however many are configured.
  const messages = await Promise.all(servers.map((server) => testServer(server)));
  return joinMessages(
    messages.map((message, index) => withServerLabel(servers[index], message, servers.length > 1)),
  );
}

/**
 * Summarize what one server answered during a refresh.
 * @param {object} server - The server.
 * @param {object[]} results - Its results, as returned by `pollAllDevices()`.
 * @param {string} timezone - A resolved IANA time zone.
 * @returns {{en: string, fr: string}} The summary.
 */
function summarizeServer(server, results, timezone) {
  const failed = results.filter((result) => result.error);
  const nodes = results.filter((result) => result.kind === 'node' && !result.error);
  const guests = results.filter((result) => result.kind === 'guest' && !result.error);
  const running = guests.filter((result) => result.guest?.running).length;

  const backups = nodes
    .map((result) => formatBackupSummary(result.node, result.backup, timezone))
    .join(' | ');
  const guestSummary =
    guests.length > 0 ? ` ${running}/${guests.length} VM/LXC running.` : ' No VM/LXC monitored.';
  const guestSummaryFr =
    guests.length > 0
      ? ` ${running}/${guests.length} VM/LXC en cours d'exécution.`
      : ' Aucune VM/LXC surveillée.';

  const failedLabels = failed.map((result) => result.node ?? result.key).join(', ');
  const failedPart = failed.length > 0 ? ` Failed on: ${failedLabels}.` : '';
  const failedPartFr = failed.length > 0 ? ` Échec sur : ${failedLabels}.` : '';

  return {
    en: `Last backup — ${backups}.${guestSummary}${failedPart}`,
    fr: `Dernière sauvegarde — ${backups}.${guestSummaryFr}${failedPartFr}`,
  };
}

/**
 * `refresh_now`: read every configured Proxmox immediately, on every monitored
 * node and guest.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{en: string, fr: string}>} The message shown under the button.
 */
export async function refreshNow(gladys, config) {
  const servers = listServers(config);
  if (servers.length === 0) {
    return NOT_CONFIGURED;
  }

  const results = await pollAllDevices(gladys, config);
  if (results.length === 0) {
    return {
      en: 'No device is being monitored yet. Run "Test the connection", then save the configuration.',
      fr: 'Aucun appareil surveillé pour le moment. Lancez « Tester la connexion », puis enregistrez la configuration.',
    };
  }

  const timezone = resolveTimezone(config.timezone);
  const failed = results.filter((result) => result.error);
  const head =
    failed.length === 0
      ? { en: 'Refreshed.', fr: 'Rafraîchi.' }
      : {
          en: `Refreshed ${results.length - failed.length}/${results.length} device(s).`,
          fr: `${results.length - failed.length}/${results.length} appareil(s) rafraîchi(s).`,
        };

  const perServer = servers
    .map((server) => ({
      server,
      results: results.filter((result) => result.server?.id === server.id),
    }))
    .filter((entry) => entry.results.length > 0)
    .map((entry) =>
      withServerLabel(
        entry.server,
        summarizeServer(entry.server, entry.results, timezone),
        servers.length > 1,
      ),
    );

  return joinMessages([head, ...perServer]);
}
