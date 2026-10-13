// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// `test_connection` is the important one. The two LISTS this integration reads
// are permission-FILTERED rather than permission-checked: a token without
// `Sys.Audit` on `/nodes/<node>` gets a 200 with only its own tasks in it, and a
// token without `VM.Audit` gets a 200 with an empty guest list. An
// under-privileged setup therefore looks like "everything works, this node
// simply never backs anything up". This action probes each node explicitly and
// names what is missing. The disk endpoints are the other way round — they
// answer 403 — but the poll swallows that into an "unknown" SMART status, so
// this is where the refusal gets named too.
//
// Both actions run on EVERY configured Proxmox server, and say which one they
// are talking about as soon as there is more than one.
//
// The Configuration screen has two colours for a result: green when the
// handler resolves, red when it throws. So a problem must THROW (an
// `ActionFailure`), or it reads like a success. A thrown error reaches Gladys
// as a single string — never a `{ en, fr, de, es }` object — hence English
// then French in its message, one paragraph each (the result box keeps line
// breaks). Only those two, by choice: the thrown report stays English + French
// as it always was, while everything returned (green results, statuses,
// widgets) carries every language.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ProxmoxError } from './proxmox/client.js';
import { listNodes, probeNodeAudit } from './proxmox/nodes.js';
import { fetchGuests } from './proxmox/guests.js';
import { listDisks, readsDisks } from './proxmox/disks.js';
import { listServers } from './servers.js';
import { pollAllDevices } from './devices/index.js';
import { formatBackupSummary, resolveTimezone } from './format.js';
import { inLanguage, perLanguage } from './i18n.js';

const logger = createLogger({ name: 'actions' });

const NOT_CONFIGURED = {
  en: 'Fill in the Proxmox host, the API token ID and its secret first, then save.',
  fr: "Renseignez d'abord l'hôte Proxmox, l'identifiant du jeton d'API et son secret, puis enregistrez.",
  de: 'Trage zuerst den Proxmox-Host, die API-Token-ID und ihr Secret ein und speichere dann.',
  es: 'Indique primero el host de Proxmox, el ID del token de API y su secreto, y después guarde.',
};

/**
 * A result the Configuration screen must show as an error (red), not green.
 */
export class ActionFailure extends Error {
  /**
   * @param {{en: string, fr: string, de?: string, es?: string}} localized - The message;
   *   only its English and French reach the red box.
   */
  constructor(localized) {
    super(`${localized.en}\n\n${localized.fr}`);
    this.name = 'ActionFailure';
    this.localized = localized;
  }
}

/**
 * Turn a client error into the message, in every language, shown under the button.
 * @param {Error} error - The failure.
 * @returns {{en: string, fr: string, de: string, es: string}} The message.
 */
export function describeError(error) {
  const kind = error instanceof ProxmoxError ? error.kind : 'unknown';
  switch (kind) {
    case 'auth':
      return {
        en: 'Proxmox refused the API token (401). Check the token ID (user@realm!name) and its secret.',
        fr: "Proxmox a refusé le jeton d'API (401). Vérifiez l'identifiant (utilisateur@realm!nom) et son secret.",
        de: 'Proxmox hat das API-Token abgelehnt (401). Prüfe die Token-ID (benutzer@realm!name) und ihr Secret.',
        es: 'Proxmox ha rechazado el token de API (401). Compruebe el ID del token (usuario@realm!nombre) y su secreto.',
      };
    case 'permission':
      return {
        en: 'Proxmox refused the request (403): grant the token the PVEAuditor role on / (Sys.Audit on /nodes and VM.Audit on /vms).',
        fr: 'Proxmox a refusé la requête (403) : accordez au jeton le rôle PVEAuditor sur / (Sys.Audit sur /nodes et VM.Audit sur /vms).',
        de: 'Proxmox hat die Anfrage abgelehnt (403): Gib dem Token die Rolle PVEAuditor auf / (Sys.Audit auf /nodes und VM.Audit auf /vms).',
        es: 'Proxmox ha rechazado la petición (403): asigne al token el rol PVEAuditor en / (Sys.Audit en /nodes y VM.Audit en /vms).',
      };
    case 'tls':
      return {
        en: `TLS check failed: ${error.message}`,
        fr: `Échec de la vérification TLS : ${error.message}`,
        de: `TLS-Prüfung fehlgeschlagen: ${error.message}`,
        es: `Error en la verificación TLS: ${error.message}`,
      };
    case 'timeout':
      return {
        en: 'Proxmox did not answer in time. Check the host, the port and the network.',
        fr: "Proxmox n'a pas répondu à temps. Vérifiez l'hôte, le port et le réseau.",
        de: 'Proxmox hat nicht rechtzeitig geantwortet. Prüfe den Host, den Port und das Netzwerk.',
        es: 'Proxmox no ha respondido a tiempo. Compruebe el host, el puerto y la red.',
      };
    case 'network':
      // The client already names the host, the port and the fix: prefixing it
      // with "Cannot reach Proxmox" would only say it twice.
      return {
        en: error.message,
        fr: `Proxmox : ${error.message}`,
        de: `Proxmox: ${error.message}`,
        es: `Proxmox: ${error.message}`,
      };
    default:
      return {
        en: `Proxmox request failed: ${error.message}`,
        fr: `La requête Proxmox a échoué : ${error.message}`,
        de: `Proxmox-Anfrage fehlgeschlagen: ${error.message}`,
        es: `La petición a Proxmox ha fallado: ${error.message}`,
      };
  }
}

/**
 * Name the server a message is about — but only when there is more than one:
 * a single-server setup has nothing to disambiguate.
 * @param {object} server - The server.
 * @param {{en: string, fr: string, de: string, es: string}} message - The message.
 * @param {boolean} named - Whether the label must be shown.
 * @returns {{en: string, fr: string, de: string, es: string}} The message, prefixed or not.
 */
function withServerLabel(server, message, named) {
  if (!named) {
    return message;
  }
  return perLanguage((lang) => `[${server.label}] ${inLanguage(message, lang)}`);
}

/**
 * Join one message per server into the single string shown under the button.
 * @param {{en: string, fr: string, de: string, es: string}[]} messages - The per-server messages.
 * @returns {{en: string, fr: string, de: string, es: string}} The joined message.
 */
function joinMessages(messages) {
  return perLanguage((lang) => messages.map((message) => inLanguage(message, lang)).join(' '));
}

/**
 * Report what went wrong on the servers a discovery could not read.
 * @param {{server: object, error: Error}[]} failures - The failures.
 * @param {boolean} named - Whether the server labels must be shown.
 * @returns {{en: string, fr: string, de: string, es: string}} The message.
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
 * @returns {Promise<{en: string, fr: string, de: string, es: string, failed?: boolean}>} The sentence appended to the test result.
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
      de: ` Die VM/LXC-Liste konnte nicht gelesen werden: ${error.message}`,
      es: ` No se pudo leer la lista de VM/LXC: ${error.message}`,
      failed: true,
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
      de:
        ' Keine VM und kein LXC ist sichtbar: Gib dem Token VM.Audit (Rolle PVEAuditor) auf /vms,' +
        ' falls dieser Cluster tatsächlich Gäste beherbergt.',
      es:
        ' No hay ninguna VM ni LXC visible: conceda VM.Audit (rol PVEAuditor) en /vms al token' +
        ' si este clúster aloja invitados.',
    };
  }
  return {
    en: ` ${guests.length} VM/LXC visible.`,
    fr: ` ${guests.length} VM/LXC visible(s).`,
    de: ` ${guests.length} VM/LXC sichtbar.`,
    es: ` ${guests.length} VM/LXC visible(s).`,
  };
}

/**
 * Count the disks the token can read, node by node.
 *
 * `/nodes/{node}/disks/list` is one of the two endpoints Proxmox really does
 * refuse (403) instead of silently filtering, so this is the place where an
 * under-privileged token is named — the poll itself only reports "unknown" on
 * the SMART status, which reads like a node with no SMART data.
 * @param {object} server - A configured server.
 * @param {{node: string}[]} nodes - The nodes of that server.
 * @returns {Promise<{en: string, fr: string, de: string, es: string, failed?: boolean}>} The sentence appended to the test result.
 */
async function describeDiskVisibility(server, nodes) {
  if (!readsDisks(server)) {
    return perLanguage(() => '');
  }

  const reads = await Promise.all(
    nodes.map(async ({ node }) => {
      try {
        return { node, disks: await listDisks(server, node, { skipSmart: true }) };
      } catch (error) {
        logger.warn(`test_connection: the disks of ${node} (${server.label}) could not be read`);
        return { node, error };
      }
    }),
  );

  const failed = reads.filter((read) => read.error);
  const total = reads
    .filter((read) => !read.error)
    .reduce((count, read) => count + read.disks.length, 0);

  if (failed.length === 0) {
    return {
      en: ` ${total} disk(s) readable for the SMART status.`,
      fr: ` ${total} disque(s) lisible(s) pour l'état SMART.`,
      de: ` ${total} Festplatte(n) für den SMART-Status lesbar.`,
      es: ` ${total} disco(s) legible(s) para el estado SMART.`,
    };
  }
  const names = failed.map((read) => read.node).join(', ');
  const reason = failed[0].error.message;
  return {
    en: ` The disk list could not be read on: ${names} (${reason}).`,
    fr: ` La liste des disques n'a pas pu être lue sur : ${names} (${reason}).`,
    de: ` Die Festplattenliste konnte nicht gelesen werden auf: ${names} (${reason}).`,
    es: ` No se pudo leer la lista de discos en: ${names} (${reason}).`,
    failed: true,
  };
}

/**
 * Run the connection test against ONE server.
 * @param {object} server - A configured server.
 * @returns {Promise<{message: {en: string, fr: string, de: string, es: string}, failed: boolean}>} What that server
 *   answered, and whether it is a problem to show in red. An empty guest list
 *   is not one: an empty cluster looks exactly the same.
 */
async function testServer(server) {
  let nodes;
  try {
    nodes = await listNodes(server);
  } catch (error) {
    logger.error(`test_connection: node listing failed on ${server.label}`, error);
    return { message: describeError(error), failed: true };
  }

  if (nodes.length === 0) {
    return {
      failed: true,
      message: {
        en: 'Connected, but no node matched. Clear the "Nodes to monitor" field, or check the names you listed.',
        fr: 'Connexion réussie, mais aucun nœud ne correspond. Videz le champ « Nœuds à surveiller » ou vérifiez les noms saisis.',
        de: 'Verbunden, aber kein Knoten passt. Leere das Feld „Zu überwachende Knoten“ oder prüfe die eingetragenen Namen.',
        es: 'Conectado, pero ningún nodo coincide. Vacíe el campo "Nodos que supervisar" o compruebe los nombres indicados.',
      },
    };
  }

  const probes = await Promise.all(nodes.map(({ node }) => probeNodeAudit(server, node)));
  const granted = probes.filter((probe) => probe.granted).map((probe) => probe.node);
  const denied = probes.filter((probe) => !probe.granted).map((probe) => probe.node);
  const guestsMessage = await describeGuestVisibility(server);
  const disksMessage = await describeDiskVisibility(server, nodes);

  const partial = Boolean(guestsMessage.failed || disksMessage.failed);

  if (denied.length === 0) {
    return {
      failed: partial,
      message: {
        en: `Connection OK. Read access granted on ${granted.length} node(s): ${granted.join(', ')}.${guestsMessage.en}${disksMessage.en}`,
        fr: `Connexion OK. Accès en lecture accordé sur ${granted.length} nœud(s) : ${granted.join(', ')}.${guestsMessage.fr}${disksMessage.fr}`,
        de: `Verbindung OK. Lesezugriff auf ${granted.length} Knoten gewährt: ${granted.join(', ')}.${guestsMessage.de}${disksMessage.de}`,
        es: `Conexión OK. Acceso de lectura concedido en ${granted.length} nodo(s): ${granted.join(', ')}.${guestsMessage.es}${disksMessage.es}`,
      },
    };
  }

  // Partial or total denial: say which nodes, and what to grant. Without
  // Sys.Audit the task list is silently filtered down to the token's own
  // tasks, so the backup features would stay unknown instead of raising.
  const grantedList = granted.join(', ');
  const grantedPart =
    granted.length > 0
      ? {
          en: ` Working on: ${grantedList}.`,
          fr: ` Fonctionne sur : ${grantedList}.`,
          de: ` Funktioniert auf: ${grantedList}.`,
          es: ` Funciona en: ${grantedList}.`,
        }
      : perLanguage(() => '');
  return {
    failed: true,
    message: {
      en:
        `Connected, but the token cannot read the task log of: ${denied.join(', ')}.` +
        ` Grant Sys.Audit (role PVEAuditor) on /nodes to ${server.token_id}.${grantedPart.en}${guestsMessage.en}${disksMessage.en}`,
      fr:
        `Connexion établie, mais le jeton ne peut pas lire le journal des tâches de : ${denied.join(', ')}.` +
        ` Accordez Sys.Audit (rôle PVEAuditor) sur /nodes à ${server.token_id}.${grantedPart.fr}${guestsMessage.fr}${disksMessage.fr}`,
      de:
        `Verbunden, aber das Token kann das Aufgabenprotokoll folgender Knoten nicht lesen: ${denied.join(', ')}.` +
        ` Gib ${server.token_id} Sys.Audit (Rolle PVEAuditor) auf /nodes.${grantedPart.de}${guestsMessage.de}${disksMessage.de}`,
      es:
        `Conectado, pero el token no puede leer el registro de tareas de: ${denied.join(', ')}.` +
        ` Conceda Sys.Audit (rol PVEAuditor) en /nodes a ${server.token_id}.${grantedPart.es}${guestsMessage.es}${disksMessage.es}`,
    },
  };
}

/**
 * `test_connection`: reachability, authentication, then the read-only
 * privileges on every monitored node and on the guests — on every configured
 * Proxmox server.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{en: string, fr: string, de: string, es: string}>} The message shown under the button.
 * @throws {ActionFailure} When anything went wrong on any server — with the
 *   full report, the servers that answered fine included.
 */
export async function testConnection(config) {
  const servers = listServers(config);
  if (servers.length === 0) {
    throw new ActionFailure(NOT_CONFIGURED);
  }

  // The servers are independent: testing them in parallel keeps the action
  // inside its manifest timeout however many are configured.
  const results = await Promise.all(servers.map((server) => testServer(server)));
  const message = joinMessages(
    results.map((result, index) =>
      withServerLabel(servers[index], result.message, servers.length > 1),
    ),
  );
  if (results.some((result) => result.failed)) {
    throw new ActionFailure(message);
  }
  return message;
}

/**
 * Summarize what one server answered during a refresh.
 * @param {object} server - The server.
 * @param {object[]} results - Its results, as returned by `pollAllDevices()`.
 * @param {string} timezone - A resolved IANA time zone.
 * @param {string} dateFormat - The configured date format.
 * @returns {{en: string, fr: string, de: string, es: string}} The summary.
 */
function summarizeServer(server, results, timezone, dateFormat) {
  const failed = results.filter((result) => result.error);
  const nodes = results.filter((result) => result.kind === 'node' && !result.error);
  const guests = results.filter((result) => result.kind === 'guest' && !result.error);
  const running = guests.filter((result) => result.guest?.running).length;

  const backups = nodes
    .map((result) => formatBackupSummary(result.node, result.backup, timezone, dateFormat))
    .join(' | ');
  const guestSummary =
    guests.length > 0
      ? {
          en: ` ${running}/${guests.length} VM/LXC running.`,
          fr: ` ${running}/${guests.length} VM/LXC en cours d'exécution.`,
          de: ` ${running}/${guests.length} VM/LXC laufen.`,
          es: ` ${running}/${guests.length} VM/LXC en ejecución.`,
        }
      : {
          en: ' No VM/LXC monitored.',
          fr: ' Aucune VM/LXC surveillée.',
          de: ' Keine VM/LXC überwacht.',
          es: ' Ninguna VM/LXC supervisada.',
        };

  const failedLabels = failed.map((result) => result.node ?? result.key).join(', ');
  const failedPart =
    failed.length > 0
      ? {
          en: ` Failed on: ${failedLabels}.`,
          fr: ` Échec sur : ${failedLabels}.`,
          de: ` Fehlgeschlagen auf: ${failedLabels}.`,
          es: ` Fallo en: ${failedLabels}.`,
        }
      : perLanguage(() => '');

  const head = {
    en: 'Last backup',
    fr: 'Dernière sauvegarde',
    de: 'Letztes Backup',
    es: 'Última copia de seguridad',
  };
  return perLanguage(
    (lang) => `${head[lang]} — ${backups}.${guestSummary[lang]}${failedPart[lang]}`,
  );
}

/**
 * `refresh_now`: read every configured Proxmox immediately, on every monitored
 * node and guest.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<{en: string, fr: string, de: string, es: string}>} The message shown under the button.
 * @throws {ActionFailure} When nothing is configured, or a device could not be read.
 */
export async function refreshNow(gladys, config) {
  const servers = listServers(config);
  if (servers.length === 0) {
    throw new ActionFailure(NOT_CONFIGURED);
  }

  const results = await pollAllDevices(gladys, config);
  if (results.length === 0) {
    return {
      en: 'No device is being monitored yet. Run "Test the connection", then save the configuration.',
      fr: 'Aucun appareil surveillé pour le moment. Lancez « Tester la connexion », puis enregistrez la configuration.',
      de: 'Noch wird kein Gerät überwacht. Führe „Verbindung testen“ aus und speichere dann die Konfiguration.',
      es: 'Todavía no se supervisa ningún dispositivo. Ejecute "Probar la conexión" y después guarde la configuración.',
    };
  }

  const timezone = resolveTimezone(config.timezone);
  const failed = results.filter((result) => result.error);
  const head =
    failed.length === 0
      ? { en: 'Refreshed.', fr: 'Rafraîchi.', de: 'Aktualisiert.', es: 'Actualizado.' }
      : {
          en: `Refreshed ${results.length - failed.length}/${results.length} device(s).`,
          fr: `${results.length - failed.length}/${results.length} appareil(s) rafraîchi(s).`,
          de: `${results.length - failed.length}/${results.length} Gerät(e) aktualisiert.`,
          es: `${results.length - failed.length}/${results.length} dispositivo(s) actualizado(s).`,
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
        summarizeServer(entry.server, entry.results, timezone, config.date_format),
        servers.length > 1,
      ),
    );

  const message = joinMessages([head, ...perServer]);
  if (failed.length > 0) {
    throw new ActionFailure(message);
  }
  return message;
}
