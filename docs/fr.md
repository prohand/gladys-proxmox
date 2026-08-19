# Proxmox

Surveillez les **sauvegardes** de vos nœuds Proxmox VE depuis Gladys — quand la
dernière a eu lieu, combien de temps elle a duré et si elle a réussi — ainsi que
l'**état de marche de chaque machine virtuelle et conteneur LXC**.

Cette intégration est **strictement en lecture seule**. Elle n'effectue que des
requêtes `GET` sur l'API Proxmox VE — elle ne démarre, n'arrête, ne migre, ne
supprime et ne reconfigure jamais quoi que ce soit.

## Ce que vous obtenez

Après l'installation, un appareil Gladys apparaît par nœud Proxmox, nommé
`Proxmox <nœud>`, portant trois fonctionnalités en lecture seule décrivant sa
**dernière sauvegarde** (une tâche `vzdump` Proxmox) :

| Fonctionnalité      | Type            | Contenu                                                                                                                                    |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Last backup**     | Texte           | Le début de la dernière sauvegarde, dans votre fuseau — ex. `2026-08-19 02:00:00 (Europe/Paris)`. Vaut `unknown` si le nœud n'en a aucune. |
| **Backup duration** | Capteur entier  | La durée de cette sauvegarde, en secondes. Historisée : vous pouvez en tracer la courbe et déclencher des scènes dessus.                   |
| **Backup status**   | Capteur binaire | **Allumé** si cette sauvegarde a réussi, **éteint** dans tout autre cas.                                                                   |

Et un appareil Gladys par machine virtuelle et par conteneur LXC, nommé
`Proxmox <nom> (<vmid>)` :

| Fonctionnalité | Type            | Contenu                                                               |
| -------------- | --------------- | --------------------------------------------------------------------- |
| **Status**     | Capteur binaire | **Allumé** si l'invité est `running`, **éteint** dans tout autre cas. |

Un nœud sans sauvegarde dans la fenêtre d'observation publie `unknown` sur
**Last backup**, et laisse **Backup duration** et **Backup status** inconnus
plutôt que d'afficher une sauvegarde de `0 s` qui n'a jamais eu lieu. Les
modèles (templates) ne deviennent jamais des appareils, et un invité qui
disparaît (supprimé, ou plus visible par le jeton) conserve son dernier état
connu au lieu d'être éteint artificiellement.

La durée et les deux fonctionnalités binaires étant historisées, l'usage
naturel dans Gladys est une scène déclenchée dessus : _quand « Backup status »
sur pve1 s'éteint, préviens-moi_, ou _quand « Status » de ma VM NAS s'éteint,
préviens-moi_.

---

## Droits Proxmox nécessaires (lecture seule)

C'est le point à ne pas rater. L'intégration a besoin de **deux privilèges
d'audit (lecture)**, et de rien d'autre :

| Privilège     | Sur le chemin     | Pourquoi                                                      |
| ------------- | ----------------- | ------------------------------------------------------------- |
| **Sys.Audit** | `/nodes` (ou `/`) | Lire le journal des tâches des nœuds, et lire leur statut.    |
| **VM.Audit**  | `/vms` (ou `/`)   | Voir les machines virtuelles et les conteneurs, et leur état. |

Rien d'autre. Aucun `Datastore.*`, aucun `Sys.Modify`, aucun `VM.PowerMgmt`,
aucun `Sys.Console`, aucun accès root, aucun accès shell.

### Points d'API appelés

| Point d'API                            | Méthode | Privilège requis                   |
| -------------------------------------- | ------- | ---------------------------------- |
| `/api2/json/nodes`                     | GET     | aucun (tout jeton authentifié)     |
| `/api2/json/nodes/{node}/tasks`        | GET     | `Sys.Audit` sur `/nodes/{node}` \* |
| `/api2/json/nodes/{node}/status`       | GET     | `Sys.Audit` sur `/nodes/{node}`    |
| `/api2/json/cluster/resources?type=vm` | GET     | `VM.Audit` sur `/vms/{vmid}` \*    |

\* **Subtilité importante.** Ces deux listes sont _filtrées_ par les droits,
elles ne sont pas _refusées_. Sans `Sys.Audit` sur `/nodes/{node}`, Proxmox
répond `200 OK` en ne renvoyant que les tâches lancées par le jeton lui-même —
ce qui, pour un jeton qui ne lance jamais rien, donne une liste vide. Sans
`VM.Audit`, la liste des invités revient vide de la même façon. Une
configuration sous-privilégiée n'a donc pas l'air cassée : les fonctionnalités
de sauvegarde restent simplement `unknown` indéfiniment, et aucune VM
n'apparaît. C'est la raison d'être du bouton **Tester la connexion** : il
interroge `/nodes/{node}/status` (qui, lui, renvoie bien `403`), vous indique
précisément quels nœuds manquent du privilège, et combien d'invités le jeton
voit réellement.

### Option A — le rôle intégré `PVEAuditor` (le plus simple)

`PVEAuditor` est le rôle en lecture seule fourni par Proxmox. Il accorde
`Sys.Audit` et `VM.Audit` ainsi que les autres privilèges d'audit
(`Datastore.Audit`, `Pool.Audit`, `SDN.Audit`, `Mapping.Audit`,
`VM.GuestAgent.Audit`). Il est en lecture seule par construction — il ne
contient aucun `*.Modify`, aucun `*.Allocate`, aucun `*.PowerMgmt`, aucun
`Sys.Console` — mais il est plus large que ce que cette intégration utilise.

Dans l'interface web Proxmox :

1. **Datacenter → Permissions → Utilisateurs → Ajouter**
   - Nom d'utilisateur : `gladys`, Domaine : `Proxmox VE authentication server (pve)`
   - Définissez un mot de passe (jamais utilisé par l'intégration, mais Proxmox en exige un)
2. **Datacenter → Permissions → Ajouter → Permission utilisateur**
   - Chemin : `/` — Utilisateur : `gladys@pve` — Rôle : `PVEAuditor` — Propager : ✔
3. **Datacenter → Permissions → Jetons d'API → Ajouter**
   - Utilisateur : `gladys@pve` — ID du jeton : `tasks`
   - **Séparation des privilèges : laissez la case cochée** (voir la note plus bas)
   - Proxmox affiche alors le secret **une seule fois** — copiez-le, il ne sera plus jamais affiché
4. **Datacenter → Permissions → Ajouter → Permission de jeton d'API**
   - Chemin : `/` — Jeton d'API : `gladys@pve!tasks` — Rôle : `PVEAuditor` — Propager : ✔

Ou, depuis un shell sur n'importe quel nœud :

```bash
pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify / --users gladys@pve --roles PVEAuditor

# Affiche le secret une seule fois — copiez-le dans Gladys.
pveum user token add gladys@pve tasks --privsep 1
pveum acl modify / --tokens 'gladys@pve!tasks' --roles PVEAuditor
```

Accorder sur `/` (plutôt que sur `/nodes` et `/vms` séparément) est la forme la
plus simple et reste en lecture seule : c'est le rôle qui limite le jeton.

### Option B — un rôle personnalisé minimal (moindre privilège)

Si vous préférez n'accorder que ce qui est réellement utilisé, créez un rôle ne
contenant que `Sys.Audit` et `VM.Audit` :

```bash
pveum role add GladysBackupAudit --privs "Sys.Audit,VM.Audit"

pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify /nodes --users gladys@pve --roles GladysBackupAudit
pveum acl modify /vms   --users gladys@pve --roles GladysBackupAudit

pveum user token add gladys@pve tasks --privsep 1
pveum acl modify /nodes --tokens 'gladys@pve!tasks' --roles GladysBackupAudit
pveum acl modify /vms   --tokens 'gladys@pve!tasks' --roles GladysBackupAudit
```

C'est la configuration la plus restrictive sur laquelle l'intégration peut
fonctionner.

### À propos de la séparation des privilèges

Quand un jeton est créé avec la **séparation des privilèges** (`--privsep 1`,
la valeur par défaut et celle recommandée), ses droits effectifs sont
l'**intersection** des droits de l'utilisateur et de l'ACL propre au jeton. Les
lignes `pveum acl modify` ci-dessus sont donc toutes nécessaires : certaines
pour l'utilisateur, d'autres pour le jeton.

Créer le jeton avec `--privsep 0` lui fait hériter directement des droits de
l'utilisateur et évite les ACL de jeton — mais cela signifie aussi que le jeton
peut tout ce que l'utilisateur peut, définitivement. Préférez la séparation des
privilèges.

### Vérification

Utilisez le bouton **Tester la connexion** dans l'onglet Configuration de
l'intégration. Il indique, nœud par nœud, si le jeton peut réellement lire le
journal des tâches, combien de VM et de conteneurs il voit, et nomme le
privilège manquant le cas échéant.

Vous pouvez aussi vérifier à la main :

```bash
curl -sS --insecure \
  -H "Authorization: PVEAPIToken=gladys@pve!tasks=VOTRE-SECRET" \
  "https://192.168.1.10:8006/api2/json/nodes/pve1/tasks?typefilter=vzdump&limit=5"

curl -sS --insecure \
  -H "Authorization: PVEAPIToken=gladys@pve!tasks=VOTRE-SECRET" \
  "https://192.168.1.10:8006/api2/json/cluster/resources?type=vm"
```

---

## Configuration

| Champ                                          | Requis | Défaut  | Remarques                                                                                                       |
| ---------------------------------------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------- |
| **Hôte Proxmox**                               | oui    | —       | IP ou nom d'hôte de n'importe quel nœud — un nœud répond pour tout le cluster.                                  |
| **Port de l'API**                              | non    | `8006`  | Le port de l'API Proxmox VE.                                                                                    |
| **Identifiant du jeton d'API**                 | oui    | —       | La forme complète `utilisateur@realm!nomdujeton`, ex. `gladys@pve!tasks`.                                       |
| **Secret du jeton d'API**                      | oui    | —       | La valeur affichée une seule fois par Proxmox. Stockée chiffrée par Gladys, jamais renvoyée à votre navigateur. |
| **Empreinte du certificat TLS**                | non    | vide    | Empreinte SHA-256 du certificat du nœud. Voir plus bas.                                                         |
| **Vérifier le certificat TLS**                 | non    | activé  | À laisser activé. Voir plus bas.                                                                                |
| **Nœuds à surveiller**                         | non    | tous    | Noms séparés par des virgules, ex. `pve1, pve2`. Filtre aussi les VM/LXC remontées.                             |
| **Ancienneté maximale d'une sauvegarde**       | non    | `7` j   | La dernière sauvegarde est recherchée dans cette fenêtre.                                                       |
| **Ce qui compte comme une sauvegarde réussie** | non    | OK seul | Si une sauvegarde terminée en `WARNINGS: n` compte quand même comme réussie.                                    |
| **Fuseau horaire**                             | non    | hôte    | Fuseau IANA utilisé pour l'affichage, ex. `Europe/Paris`.                                                       |
| **Intervalle de rafraîchissement**             | non    | `300` s | Fréquence de lecture de Proxmox.                                                                                |

### TLS : le certificat auto-signé de Proxmox

Par défaut, un nœud Proxmox présente un certificat **auto-signé**, qu'aucun
conteneur ne reconnaît. Vous avez trois options, de la meilleure à la moins
bonne :

1. **Épingler l'empreinte (recommandé).** Collez l'empreinte SHA-256 du nœud
   dans le champ _Empreinte du certificat TLS_. La connexion est alors chiffrée
   _et_ authentifiée, sans aucune autorité de certification publique. Trouvez
   l'empreinte dans l'interface sous **Nœud → Système → Certificats →
   `pveproxy-ssl.pem`**, ou depuis un shell :

   ```bash
   openssl x509 -in /etc/pve/local/pveproxy-ssl.pem -noout -fingerprint -sha256
   # retombe sur le certificat propre au nœud si aucun certificat personnalisé n'est installé :
   openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256
   ```

   Tous les formats sont acceptés (`AA:BB:CC…`, `aabbcc…`, avec ou sans
   espaces).

   Attention : l'empreinte change au renouvellement ou au remplacement du
   certificat — mettez alors le champ à jour, ou passez à l'option 2.

2. **Installer un certificat reconnu** sur le nœud (Let's Encrypt via le
   support ACME de Proxmox, ou votre propre AC installée dans le magasin de
   confiance du conteneur). Laissez les deux champs TLS à leur valeur par
   défaut.

3. **Désactiver _Vérifier le certificat TLS_**. En dernier recours, sur un
   réseau local de confiance uniquement : le trafic reste chiffré, mais rien ne
   prouve que le serveur atteint est bien votre nœud — et le secret du jeton
   d'API transite sur cette connexion.

### Ce qui compte comme une sauvegarde réussie

Proxmox enregistre une sauvegarde terminée avec l'un de ces statuts :

| Statut Proxmox     | Signification                          | « OK uniquement » (défaut) | « OK et avertissements » |
| ------------------ | -------------------------------------- | -------------------------- | ------------------------ |
| `OK`               | succès                                 | **allumé**                 | **allumé**               |
| `WARNINGS: 3`      | terminée, avec des avertissements      | éteint                     | **allumé**               |
| toute autre chaîne | message d'erreur                       | éteint                     | éteint                   |
| _(vide)_           | aucun statut de sortie — worker planté | éteint                     | éteint                   |

Une sauvegarde qui s'est terminée mais a sauté un invité finit en
`WARNINGS: n`. Choisissez _OK et avertissements_ si cela vous convient.

Seules les sauvegardes **terminées** sont lues (la liste archivée de Proxmox) :
une sauvegarde encore en cours n'est pas encore la dernière sauvegarde.

## Actions

- **Tester la connexion** — vérifie que l'hôte répond, que le jeton d'API est
  accepté, qu'il peut réellement lire le journal des tâches de chaque nœud
  surveillé, et combien de VM/LXC il voit. À lancer en premier dès que quelque
  chose semble anormal.
- **Rafraîchir maintenant** — lit les sauvegardes et l'état des VM/LXC
  immédiatement, sans attendre le prochain rafraîchissement.

## Dépannage

**« Proxmox a refusé le jeton d'API (401) »** — l'identifiant ou le secret est
incorrect. L'identifiant doit être la forme _complète_
`utilisateur@realm!nomdujeton` (`gladys@pve!tasks`), pas seulement le nom du
jeton. Si vous avez perdu le secret, supprimez le jeton et recréez-en un :
Proxmox ne l'affiche qu'une fois.

**« le jeton ne peut pas lire le journal des tâches de : … »** — il manque
`Sys.Audit` sur ces nœuds. Relisez la section sur les droits ci-dessus ; avec
la séparation des privilèges activée, souvenez-vous que l'utilisateur _et_ le
jeton ont chacun besoin de l'ACL.

**« Aucune VM ni LXC n'est visible »** — il manque `VM.Audit` au jeton (sur
`/vms`, ou sur `/`). La liste des invités est filtrée et non refusée : un jeton
sous-privilégié ne voit tout simplement rien.

**« Last backup » reste `unknown` alors que l'interface Proxmox montre des
sauvegardes** — soit le privilège `Sys.Audit` manquant ci-dessus (lancez
**Tester la connexion**), soit une fenêtre plus courte que votre planification :
un nœud sauvegardé toutes les deux semaines ne remonte rien avec la fenêtre par
défaut de 7 jours. Augmentez _Ancienneté maximale d'une sauvegarde_.

**« Backup status » est éteint alors que la sauvegarde semble bonne** — elle
s'est probablement terminée en `WARNINGS: n` (un invité sauté, un hook non
nul…). Ouvrez la tâche dans l'interface Proxmox pour en voir la raison, ou
passez _Ce qui compte comme une sauvegarde réussie_ sur _OK et avertissements_.

**Une VM supprimée apparaît encore** — l'appareil Gladys reste tant que vous ne
le supprimez pas dans Gladys ; l'intégration cesse simplement de publier des
états pour lui, il se fige donc sur sa dernière valeur.

**« Proxmox presents a self-signed certificate »** — épinglez son empreinte,
voir la section TLS ci-dessus.

**« Cannot reach … »** — vérifiez l'hôte et le port (`8006`), et que le
conteneur Gladys peut joindre le nœud sur votre réseau.

**Les horodatages sont décalés de quelques heures** — renseignez le champ
_Fuseau horaire_ avec votre fuseau IANA (`Europe/Paris`, `America/New_York`…).
Laissé vide, l'intégration utilise le fuseau de la machine où tourne Gladys,
qui est souvent UTC dans un conteneur.

L'intégration journalise tout ce qu'elle fait : consultez les logs de
l'intégration depuis l'interface Gladys (ou `docker logs` sur l'hôte), avec
`LOG_LEVEL=debug` pour le détail complet. Le secret du jeton d'API n'est jamais
journalisé.

## Vie privée et sécurité

- **Lecture seule par construction.** Le client n'implémente que `GET` ; aucun
  chemin de code de cette intégration n'écrit dans Proxmox.
- Le secret du jeton d'API est stocké chiffré par Gladys, n'est jamais renvoyé
  au navigateur (c'est un champ de configuration `secret`), et n'est jamais
  écrit dans les logs.
- L'intégration ne dialogue avec rien d'autre que votre hôte Proxmox : aucun
  service cloud, aucune télémétrie, aucun appel sortant d'aucune sorte.
