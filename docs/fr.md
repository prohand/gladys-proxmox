# Proxmox

Surveillez les **tâches en échec** de vos nœuds Proxmox VE depuis Gladys : un
compteur d'échecs par nœud, et le détail des échecs récents (type de tâche,
horodatages de début et de fin dans votre fuseau horaire, et statut enregistré
par Proxmox).

Cette intégration est **strictement en lecture seule**. Elle n'effectue que des
requêtes `GET` sur l'API Proxmox VE — elle ne démarre, n'arrête, ne migre, ne
supprime et ne reconfigure jamais quoi que ce soit.

## Ce que vous obtenez

Après l'installation, un appareil Gladys apparaît par nœud Proxmox, nommé
`Proxmox <nœud>`. Chaque appareil porte deux fonctionnalités en lecture seule :

| Fonctionnalité             | Type           | Contenu                                                                                                                                                             |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Failed tasks (N h)**     | Capteur entier | Nombre de tâches en échec sur ce nœud dans la fenêtre d'observation. Historisé : vous pouvez en tracer la courbe et déclencher des scènes dessus.                   |
| **Recent failure details** | Texte          | Un bloc par échec récent : type de tâche (et l'invité concerné), horodatages début → fin dans votre fuseau, durée d'exécution, et le statut enregistré par Proxmox. |

Exemple de ce que contient la fonctionnalité de détail :

```
2 failed tasks on pve1 in the last 24 h (times in Europe/Paris):
• vzdump (101)
  2026-08-19 02:00:00 → 2026-08-19 02:04:08 (4 min 8 s)
  status: command 'lvcreate' failed: exit code 5
• qmigrate (110)
  2026-08-19 09:12:31 → 2026-08-19 09:13:02 (31 s)
  status: no such logical volume pve/data
```

Le compteur étant historisé, l'usage naturel dans Gladys est une scène
déclenchée dessus : _quand « Failed tasks » sur pve1 devient supérieur à 0,
envoie-moi le texte « Recent failure details »_.

---

## Droits Proxmox nécessaires (lecture seule)

C'est le point à ne pas rater. L'intégration a besoin d'**un seul privilège**,
et c'est un privilège d'audit (lecture) :

| Privilège     | Sur le chemin     | Pourquoi                                                   |
| ------------- | ----------------- | ---------------------------------------------------------- |
| **Sys.Audit** | `/nodes` (ou `/`) | Lire le journal des tâches des nœuds, et lire leur statut. |

Rien d'autre. Aucun `VM.*`, aucun `Datastore.*`, aucun `Sys.Modify`, aucun
`Sys.Console`, aucun accès root, aucun accès shell.

### Points d'API appelés

| Point d'API                      | Méthode | Privilège requis                  |
| -------------------------------- | ------- | --------------------------------- |
| `/api2/json/nodes`               | GET     | aucun (tout jeton authentifié)    |
| `/api2/json/nodes/{node}/tasks`  | GET     | `Sys.Audit` sur `/nodes/{node}` * |
| `/api2/json/nodes/{node}/status` | GET     | `Sys.Audit` sur `/nodes/{node}`   |

\* **Subtilité importante.** La liste des tâches est _filtrée_ par les droits,
elle n'est pas _refusée_. Sans `Sys.Audit` sur `/nodes/{node}`, Proxmox répond
`200 OK` en ne renvoyant que les tâches lancées par le jeton lui-même — ce qui,
pour un jeton qui ne lance jamais rien, donne une liste vide. Une configuration
sous-privilégiée n'a donc pas l'air cassée : le compteur reste simplement à `0`
indéfiniment. C'est la raison d'être du bouton **Tester la connexion** : il
interroge `/nodes/{node}/status` (qui, lui, renvoie bien `403`) et vous indique
précisément quels nœuds manquent du privilège.

### Option A — le rôle intégré `PVEAuditor` (le plus simple)

`PVEAuditor` est le rôle en lecture seule fourni par Proxmox. Il accorde
`Sys.Audit` ainsi que les autres privilèges d'audit (`VM.Audit`,
`Datastore.Audit`, `Pool.Audit`, `SDN.Audit`, `Mapping.Audit`,
`VM.GuestAgent.Audit`). Il est en lecture seule par construction — il ne
contient aucun `*.Modify`, aucun `*.Allocate`, aucun `*.PowerMgmt`, aucun
`Sys.Console` — mais il est plus large que ce que cette intégration utilise.

Dans l'interface web Proxmox :

1. **Datacenter → Permissions → Utilisateurs → Ajouter**
   - Nom d'utilisateur : `gladys`, Domaine : `Proxmox VE authentication server (pve)`
   - Définissez un mot de passe (jamais utilisé par l'intégration, mais Proxmox en exige un)
2. **Datacenter → Permissions → Ajouter → Permission utilisateur**
   - Chemin : `/nodes` — Utilisateur : `gladys@pve` — Rôle : `PVEAuditor` — Propager : ✔
3. **Datacenter → Permissions → Jetons d'API → Ajouter**
   - Utilisateur : `gladys@pve` — ID du jeton : `tasks`
   - **Séparation des privilèges : laissez la case cochée** (voir la note plus bas)
   - Proxmox affiche alors le secret **une seule fois** — copiez-le, il ne sera plus jamais affiché
4. **Datacenter → Permissions → Ajouter → Permission de jeton d'API**
   - Chemin : `/nodes` — Jeton d'API : `gladys@pve!tasks` — Rôle : `PVEAuditor` — Propager : ✔

Ou, depuis un shell sur n'importe quel nœud :

```bash
pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify /nodes --users gladys@pve --roles PVEAuditor

# Affiche le secret une seule fois — copiez-le dans Gladys.
pveum user token add gladys@pve tasks --privsep 1
pveum acl modify /nodes --tokens 'gladys@pve!tasks' --roles PVEAuditor
```

### Option B — un rôle personnalisé minimal (moindre privilège)

Si vous préférez n'accorder que ce qui est réellement utilisé, créez un rôle ne
contenant que `Sys.Audit` :

```bash
pveum role add GladysTaskAudit --privs "Sys.Audit"

pveum user add gladys@pve --password "$(openssl rand -base64 24)"
pveum acl modify /nodes --users gladys@pve --roles GladysTaskAudit

pveum user token add gladys@pve tasks --privsep 1
pveum acl modify /nodes --tokens 'gladys@pve!tasks' --roles GladysTaskAudit
```

C'est la configuration la plus restrictive sur laquelle l'intégration peut
fonctionner.

### À propos de la séparation des privilèges

Quand un jeton est créé avec la **séparation des privilèges** (`--privsep 1`,
la valeur par défaut et celle recommandée), ses droits effectifs sont
l'**intersection** des droits de l'utilisateur et de l'ACL propre au jeton. Les
deux lignes `pveum acl modify` ci-dessus sont donc toutes les deux nécessaires :
une pour l'utilisateur, une pour le jeton.

Créer le jeton avec `--privsep 0` lui fait hériter directement des droits de
l'utilisateur et évite la seconde ACL — mais cela signifie aussi que le jeton
peut tout ce que l'utilisateur peut, définitivement. Préférez la séparation des
privilèges.

### Vérification

Utilisez le bouton **Tester la connexion** dans l'onglet Configuration de
l'intégration. Il indique, nœud par nœud, si le jeton peut réellement lire le
journal des tâches, et nomme le privilège manquant le cas échéant.

Vous pouvez aussi vérifier à la main :

```bash
curl -sS --insecure \
  -H "Authorization: PVEAPIToken=gladys@pve!tasks=VOTRE-SECRET" \
  "https://192.168.1.10:8006/api2/json/nodes/pve1/tasks?errors=1&limit=5"
```

---

## Configuration

| Champ                              | Requis | Défaut  | Remarques                                                                                                       |
| ---------------------------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------- |
| **Hôte Proxmox**                   | oui    | —       | IP ou nom d'hôte de n'importe quel nœud — un nœud répond pour tout le cluster.                                  |
| **Port de l'API**                  | non    | `8006`  | Le port de l'API Proxmox VE.                                                                                    |
| **Identifiant du jeton d'API**     | oui    | —       | La forme complète `utilisateur@realm!nomdujeton`, ex. `gladys@pve!tasks`.                                       |
| **Secret du jeton d'API**          | oui    | —       | La valeur affichée une seule fois par Proxmox. Stockée chiffrée par Gladys, jamais renvoyée à votre navigateur. |
| **Empreinte du certificat TLS**    | non    | vide    | Empreinte SHA-256 du certificat du nœud. Voir plus bas.                                                         |
| **Vérifier le certificat TLS**     | non    | activé  | À laisser activé. Voir plus bas.                                                                                |
| **Nœuds à surveiller**             | non    | tous    | Noms séparés par des virgules, ex. `pve1, pve2`.                                                                |
| **Fenêtre d'observation**          | non    | `24` h  | Seules les tâches démarrées dans cette fenêtre sont comptées et listées.                                        |
| **Ce qui compte comme un échec**   | non    | erreurs | Si les tâches terminées en `WARNINGS: n` comptent comme des échecs.                                             |
| **Types de tâches à conserver**    | non    | tous    | Types Proxmox séparés par des virgules, ex. `vzdump, replication`.                                              |
| **Échecs détaillés**               | non    | `5`     | Nombre d'échecs décrits dans le texte de détail (le compteur couvre toujours toute la fenêtre).                 |
| **Fuseau horaire**                 | non    | hôte    | Fuseau IANA utilisé pour l'affichage, ex. `Europe/Paris`.                                                       |
| **Intervalle de rafraîchissement** | non    | `300` s | Fréquence de lecture du journal des tâches.                                                                     |

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

### Ce qui compte comme un échec

Proxmox enregistre une tâche terminée avec l'un de ces statuts :

| Statut Proxmox     | Signification                          | Compté en « Erreurs uniquement » | Compté en « Erreurs et avertissements » |
| ------------------ | -------------------------------------- | -------------------------------- | --------------------------------------- |
| `OK`               | succès                                 | non                              | non                                     |
| `WARNINGS: 3`      | terminée, avec des avertissements      | non                              | **oui**                                 |
| toute autre chaîne | message d'erreur                       | **oui**                          | **oui**                                 |
| _(vide)_           | aucun statut de sortie — worker planté | **oui**                          | **oui**                                 |

Une sauvegarde qui s'est terminée mais a sauté un invité finit en
`WARNINGS: n`. Choisissez _Erreurs et avertissements_ si vous voulez en être
informé.

Seules les tâches **terminées** sont lues (la liste archivée de Proxmox) : une
tâche encore en cours n'est pas un échec et n'est jamais comptée.

## Actions

- **Tester la connexion** — vérifie que l'hôte répond, que le jeton d'API est
  accepté, et qu'il peut réellement lire le journal des tâches de chaque nœud
  surveillé. À lancer en premier dès que quelque chose semble anormal.
- **Rafraîchir maintenant** — lit le journal des tâches immédiatement, sur tous
  les nœuds, sans attendre le prochain rafraîchissement.

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

**Le compteur reste à 0 alors que l'interface Proxmox montre des échecs** —
c'est presque toujours ce privilège manquant. Lancez **Tester la connexion**.
Si le test est bon, vérifiez la fenêtre d'observation (un échec plus ancien que
la fenêtre n'est pas compté), le filtre _Types de tâches à conserver_, et si
les échecs que vous regardez ne sont pas des `WARNINGS:` exclus par le
périmètre par défaut.

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
