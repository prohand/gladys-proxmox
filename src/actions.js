// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// `test_connection` is the important one. The Proxmox task endpoint is
// permission-FILTERED rather than permission-checked: a token without
// `Sys.Audit` on `/nodes/<node>` gets a 200 with only its own tasks in it, so
// an under-privileged setup looks like "everything works, there is just never
// any failure". This action probes each node explicitly and names what is
// missing.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ProxmoxError } from './proxmox/client.js';
import { listNodes, probeNodeAudit } from './proxmox/tasks.js';
import { isConfigured } from './config.js';
import { pollAllNodes } from './devices/index.js';

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
        en: 'Proxmox refused the request (403): grant the token the Sys.Audit privilege on /nodes (role PVEAuditor).',
        fr: 'Proxmox a refusé la requête (403) : accordez au jeton le privilège Sys.Audit sur /nodes (rôle PVEAuditor).',
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
 * `test_connection`: reachability, authentication, then the read-only
 * privilege on every monitored node.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{en: string, fr: string}>} The message shown under the button.
 */
export async function testConnection(config) {
  if (!isConfigured(config)) {
    return NOT_CONFIGURED;
  }

  let nodes;
  try {
    nodes = await listNodes(config);
  } catch (error) {
    logger.error('test_connection: node listing failed', error);
    return describeError(error);
  }

  if (nodes.length === 0) {
    return {
      en: 'Connected, but no node matched. Clear the "Nodes to monitor" field, or check the names you listed.',
      fr: 'Connexion réussie, mais aucun nœud ne correspond. Videz le champ « Nœuds à surveiller » ou vérifiez les noms saisis.',
    };
  }

  const probes = await Promise.all(nodes.map(({ node }) => probeNodeAudit(config, node)));
  const granted = probes.filter((probe) => probe.granted).map((probe) => probe.node);
  const denied = probes.filter((probe) => !probe.granted).map((probe) => probe.node);

  if (denied.length === 0) {
    return {
      en: `Connection OK. Read access granted on ${granted.length} node(s): ${granted.join(', ')}.`,
      fr: `Connexion OK. Accès en lecture accordé sur ${granted.length} nœud(s) : ${granted.join(', ')}.`,
    };
  }

  // Partial or total denial: say which nodes, and what to grant. Without
  // Sys.Audit the task list is silently filtered down to the token's own
  // tasks, so the counter would sit at zero instead of raising an error.
  const grantedPart = granted.length > 0 ? ` Working on: ${granted.join(', ')}.` : '';
  const grantedPartFr = granted.length > 0 ? ` Fonctionne sur : ${granted.join(', ')}.` : '';
  return {
    en:
      `Connected, but the token cannot read the task log of: ${denied.join(', ')}.` +
      ` Grant Sys.Audit (role PVEAuditor) on /nodes to ${config.token_id}.${grantedPart}`,
    fr:
      `Connexion établie, mais le jeton ne peut pas lire le journal des tâches de : ${denied.join(', ')}.` +
      ` Accordez Sys.Audit (rôle PVEAuditor) sur /nodes à ${config.token_id}.${grantedPartFr}`,
  };
}

/**
 * `refresh_now`: read the task log immediately, on every monitored node.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{en: string, fr: string}>} The message shown under the button.
 */
export async function refreshNow(gladys, config) {
  if (!isConfigured(config)) {
    return NOT_CONFIGURED;
  }

  const results = await pollAllNodes(gladys, config);
  if (results.length === 0) {
    return {
      en: 'No node is being monitored yet. Run "Test the connection", then save the configuration.',
      fr: 'Aucun nœud surveillé pour le moment. Lancez « Tester la connexion », puis enregistrez la configuration.',
    };
  }

  const failed = results.filter((result) => result.error);
  const refreshed = results.filter((result) => !result.error);
  const summary = refreshed.map((result) => `${result.node}: ${result.failedTasks}`).join(', ');

  if (failed.length === 0) {
    return {
      en: `Refreshed. Failed tasks in the last ${config.lookback_hours} h — ${summary}.`,
      fr: `Rafraîchi. Tâches en échec sur les ${config.lookback_hours} dernières heures — ${summary}.`,
    };
  }
  return {
    en: `Refreshed ${refreshed.length}/${results.length} node(s) (${summary}). Failed on: ${failed
      .map((result) => result.node)
      .join(', ')}.`,
    fr: `${refreshed.length}/${results.length} nœud(s) rafraîchi(s) (${summary}). Échec sur : ${failed
      .map((result) => result.node)
      .join(', ')}.`,
  };
}
