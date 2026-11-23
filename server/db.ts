/**
 * server/db.ts — Ouverture de la base de données SQLite et création / mise à jour du schéma.
 *
 * À quoi sert ce fichier ?
 *   - Il décide OÙ sont stockées les données (dossier DATA_DIR, photos dans DATA_DIR/uploads).
 *   - Il ouvre UNE connexion SQLite partagée par tout le serveur (l'objet `db` exporté).
 *   - Il crée les tables si elles n'existent pas, puis applique de petites « migrations »
 *     (ajouts de colonnes, corrections de données) pour qu'une ancienne base reste compatible.
 *
 * Qui l'appelle ?
 *   - Presque tous les fichiers serveur font `import { db } from './db'` (auth.ts, events.ts,
 *     routes-*.ts…). Le simple fait d'importer ce module exécute tout le code ci-dessous UNE fois
 *     (Node met les modules en cache) : c'est donc au démarrage que le schéma est vérifié.
 *
 * Notions à connaître :
 *   - `node:sqlite` : module SQLite intégré à Node (pas besoin de paquet npm). `DatabaseSync`
 *     est SYNCHRONE : chaque requête bloque le fil d'exécution jusqu'à sa fin. Pour une petite
 *     app avec une base locale c'est simple et rapide ; il n'y a pas de `await`.
 *   - `db.exec(sql)` exécute du SQL brut sans renvoyer de résultat (idéal pour CREATE / ALTER).
 *   - `db.prepare(sql)` compile une requête réutilisable avec des `?` (paramètres) ; on l'exécute
 *     ensuite avec `.get()` (une ligne), `.all()` (toutes les lignes) ou `.run()` (écriture).
 *   - Les dates sont stockées en INTEGER = millisecondes depuis 1970 (résultat de `Date.now()`).
 *   - Les booléens sont stockés en INTEGER 0/1 (SQLite n'a pas de vrai type booléen).
 */
// `DatabaseSync` = la classe qui représente une connexion synchrone à un fichier SQLite.
import { DatabaseSync } from 'node:sqlite';
// `fs` = système de fichiers (créer des dossiers, lire des fichiers…).
import fs from 'node:fs';
// `path` = manipulation de chemins de fichiers, portable Windows / Linux (gère les / et \).
import path from 'node:path';

// Dossier des données et des fichiers envoyés : définis dans paths.ts (partagé avec backup.ts),
// et ré-exportés ici pour que les autres fichiers continuent d'écrire `import { UPLOAD_DIR } from './db'`.
import { DATA_DIR, UPLOAD_DIR } from './paths';
export { DATA_DIR, UPLOAD_DIR };
// Crée le dossier (et DATA_DIR au passage grâce à `recursive: true`) s'il n'existe pas.
// Sans `recursive`, mkdir planterait si le dossier parent manque ou si le dossier existe déjà.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// La connexion unique à la base. Le fichier terrain.db est créé automatiquement s'il n'existe pas.
// Exportée pour que tous les autres modules utilisent la MÊME connexion.
export const db = new DatabaseSync(path.join(DATA_DIR, 'terrain.db'));

/*
 * Schéma de base (exécuté à chaque démarrage, sans danger grâce à « IF NOT EXISTS »).
 *
 * PRAGMA journal_mode = WAL : mode « Write-Ahead Log ». Les écritures vont d'abord dans un
 *   fichier à part (terrain.db-wal) ; les lectures ne sont pas bloquées pendant une écriture.
 *   Cela permet aussi au script de sauvegarde (backup.ts) de lire pendant que l'app tourne.
 * PRAGMA foreign_keys = ON : SQLite n'applique PAS les clés étrangères (REFERENCES) par défaut ;
 *   il faut l'activer à chaque connexion. Sans ça, « ON DELETE CASCADE » ne ferait rien.
 *
 * Table devices : un « appareil » = un téléphone / navigateur autorisé (il n'y a pas de comptes
 *   avec mot de passe). Colonnes notables :
 *   - role : CHECK limite les valeurs possibles à admin / relais / membre (la base refuse le reste).
 *   - token_hash : empreinte SHA-256 du jeton de session stocké dans le cookie. On ne garde JAMAIS
 *     le jeton en clair : si la base fuit, les jetons ne sont pas directement réutilisables.
 *     UNIQUE garantit qu'aucun deux appareils n'ont le même jeton.
 *   - invited_by / invite_id : qui a fait entrer cet appareil et avec quelle invitation (traçabilité,
 *     et base de la révocation « en cascade »).
 *   - revoked_at : NULL = actif ; une date = accès retiré (on ne supprime pas la ligne, on la marque).
 *
 * Table invites : liens / QR codes d'invitation. max_uses / uses limitent le nombre d'utilisations,
 *   expires_at la durée de validité. Là aussi seul le hash du jeton est stocké.
 *
 * Table points : tout ce qui apparaît sur la carte (événements, points fixes…).
 *   - mode : nature du point (par ex. 'event' ou 'fixe', voir shared/model.ts).
 *   - lat / lng : coordonnées GPS en nombres à virgule (REAL).
 *   - starts_at / ends_at / recurrence / recurrence_until : horaires et répétition d'un événement.
 *   - expires_at : date à laquelle le point doit disparaître (le ménage est fait par cleanup()).
 *   - created_by : id de l'appareil auteur (pas de REFERENCES : un auteur révoqué garde ses points).
 *
 * Index points_expires : accélère la recherche des points expirés (WHERE expires_at < …).
 *
 * Table problems : signalements sur un point (« ce point n'est plus valable »…).
 *   - point_id REFERENCES points(id) ON DELETE CASCADE : si le point est supprimé, ses
 *     signalements le sont automatiquement (grâce au PRAGMA foreign_keys plus haut).
 *   - resolved_at / resolved_by : signalement traité, et par qui.
 *
 * Index problems_point : accélère « tous les signalements de tel point ».
 *
 * Attention : on ne met pas de commentaires DANS la chaîne SQL ci-dessous, parce que tout ce qui
 * est entre les accents graves (`) est envoyé tel quel à SQLite.
 */
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('admin','relais','membre')),
    token_hash  TEXT NOT NULL UNIQUE,
    invited_by  TEXT,
    invite_id   TEXT,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER,
    revoked_at  INTEGER,
    user_agent  TEXT
  );

  CREATE TABLE IF NOT EXISTS invites (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL CHECK (role IN ('admin','relais','membre')),
    label       TEXT,
    max_uses    INTEGER NOT NULL,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    revoked_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS points (
    id                TEXT PRIMARY KEY,
    mode              TEXT NOT NULL,
    type              TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    lat               REAL NOT NULL,
    lng               REAL NOT NULL,
    color             TEXT,
    photo             TEXT,
    starts_at         INTEGER,
    ends_at           INTEGER,
    recurrence        TEXT NOT NULL DEFAULT 'none',
    recurrence_until  INTEGER,
    expires_at        INTEGER,
    status            TEXT,
    created_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS points_expires ON points(expires_at);

  CREATE TABLE IF NOT EXISTS problems (
    id           TEXT PRIMARY KEY,
    point_id     TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    message      TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    resolved_at  INTEGER,
    resolved_by  TEXT
  );

  CREATE INDEX IF NOT EXISTS problems_point ON problems(point_id);
`);

// Engagements sur un événement : « je participe » et « je fournis tel matériel » (indépendants).
/*
 * Détail de la table pledges :
 *   - kind : 'participe' (je viens) ou 'fournit' (j'apporte quelque chose, décrit dans `item`).
 *   - item vaut '' (et non NULL) par défaut : en SQL, NULL n'est jamais égal à NULL, donc une
 *     clé primaire contenant NULL ne garantirait pas l'unicité. Avec '' elle fonctionne.
 *   - PRIMARY KEY composite (point_id, device_id, kind, item) : un même appareil ne peut pas
 *     s'engager deux fois exactement de la même façon sur le même point (pas de doublons).
 *   - ON DELETE CASCADE : supprimer le point supprime ses engagements.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS pledges (
    point_id    TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('participe','fournit')),
    item        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (point_id, device_id, kind, item)
  );
`);

// Migrations légères (ajout de colonnes sur une base existante).
// `cols(table)` renvoie la liste des noms de colonnes d'une table.
//   - `PRAGMA table_info(nom)` est une requête spéciale de SQLite qui liste les colonnes
//     (une ligne par colonne, avec entre autres un champ `name`).
//   - `${table}` est inséré directement dans le SQL : acceptable ici UNIQUEMENT parce que les
//     noms de tables sont écrits en dur dans ce fichier (jamais une donnée venant d'un utilisateur).
//   - `as { name: string }[]` : `.all()` renvoie un type générique ; on dit à TypeScript
//     « fais-moi confiance, chaque ligne a un champ name de type string ».
//   - `.map((c) => c.name)` transforme la liste de lignes en simple liste de noms.
// Principe : si la colonne n'existe pas encore, on l'ajoute (ALTER TABLE … ADD COLUMN).
// Le code est donc « idempotent » : on peut le relancer à chaque démarrage sans effet en double.
const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
// parent_id : permet de rattacher un point à un autre (ex. un sous-événement à un événement).
if (!cols('points').includes('parent_id')) db.exec('ALTER TABLE points ADD COLUMN parent_id TEXT');
// arrive_at : heure d'arrivée annoncée par quelqu'un qui participe.
if (!cols('pledges').includes('arrive_at')) db.exec('ALTER TABLE pledges ADD COLUMN arrive_at INTEGER');
// Espaces LFI / Mouvement : chaque point appartient à un espace, chaque appareil a accès à un ou deux espaces.
// Ajout de la colonne `space` sur les points. NOT NULL exige une valeur par défaut pour les lignes
// déjà présentes : elles deviennent 'lfi' (espace Campagne).
if (!cols('points').includes('space')) {
  db.exec("ALTER TABLE points ADD COLUMN space TEXT NOT NULL DEFAULT 'lfi'");
  // Les types de points propres au « Mouvement » (blocus, blocage, police) sont rangés dans 'mvt'.
  // Ce UPDATE ne tourne qu'une fois : au moment où la colonne est créée.
  db.exec("UPDATE points SET space = 'mvt' WHERE type IN ('blocus', 'blocage', 'police')");
}
// Espaces accessibles à un appareil, stockés en texte séparé par des virgules ('lfi', 'mvt' ou
// 'lfi,mvt'). Les appareils existants reçoivent les deux espaces pour ne perdre aucun accès.
if (!cols('devices').includes('spaces')) db.exec("ALTER TABLE devices ADD COLUMN spaces TEXT NOT NULL DEFAULT 'lfi,mvt'");
// owner : 1 pour l'appareil « propriétaire » (super-admin unique), 0 pour les autres.
if (!cols('devices').includes('owner')) db.exec('ALTER TABLE devices ADD COLUMN owner INTEGER NOT NULL DEFAULT 0');
// Une invitation précise aussi les espaces que recevra l'appareil invité.
if (!cols('invites').includes('spaces')) db.exec("ALTER TABLE invites ADD COLUMN spaces TEXT NOT NULL DEFAULT 'lfi,mvt'");
// Un seul propriétaire : s'il n'y en a pas encore, c'est le plus ancien admin.
// Lecture de la requête :
//   - la sous-requête (SELECT id … ORDER BY created_at LIMIT 1) trouve l'admin actif le plus ancien ;
//   - `AND NOT EXISTS (…)` : on ne fait la mise à jour QUE s'il n'existe aucun propriétaire actif.
//   Résultat : exécutée à chaque démarrage, elle ne change rien tant qu'un propriétaire existe,
//   et en désigne automatiquement un nouveau si l'ancien a été révoqué.
db.exec(`UPDATE devices SET owner = 1, spaces = 'lfi,mvt' WHERE id = (
  SELECT id FROM devices WHERE role = 'admin' AND revoked_at IS NULL ORDER BY created_at LIMIT 1
) AND NOT EXISTS (SELECT 1 FROM devices WHERE owner = 1 AND revoked_at IS NULL)`);
// Index pour filtrer rapidement les points par espace (requête faite à chaque chargement de carte).
db.exec('CREATE INDEX IF NOT EXISTS points_space ON points(space)');
// public : 1 si le point peut être vu sans compte (pages publiques).
if (!cols('points').includes('public')) db.exec('ALTER TABLE points ADD COLUMN public INTEGER NOT NULL DEFAULT 0');
// confirmed_at : dernière fois que quelqu'un a confirmé « ce point est toujours d'actualité ».
if (!cols('points').includes('confirmed_at')) db.exec('ALTER TABLE points ADD COLUMN confirmed_at INTEGER');
// Même idée pour un signalement : quelqu'un d'autre confirme le problème.
if (!cols('problems').includes('confirmed_at')) db.exec('ALTER TABLE problems ADD COLUMN confirmed_at INTEGER');
// flash : point « urgent » mis en avant (0/1).
if (!cols('points').includes('flash')) db.exec('ALTER TABLE points ADD COLUMN flash INTEGER NOT NULL DEFAULT 0');
// material : matériel demandé pour un événement (texte libre ou liste encodée, voir routes-points.ts).
if (!cols('points').includes('material')) db.exec('ALTER TABLE points ADD COLUMN material TEXT');
// status_at : date du dernier changement de `status` (sert par ex. à libérer un blocage après un délai).
if (!cols('points').includes('status_at')) db.exec('ALTER TABLE points ADD COLUMN status_at INTEGER');
// Index pour retrouver vite les « enfants » d'un point (WHERE parent_id = ?).
db.exec('CREATE INDEX IF NOT EXISTS points_parent ON points(parent_id)');
// Les blocages étaient des événements : ce sont désormais des points fixes (la barricade reste en place).
// Correction de données : on efface les horaires/récurrence devenus sans objet et on donne un statut
// 'vide' par défaut. `COALESCE(status, 'vide')` = garde le statut existant s'il y en a un, sinon 'vide'.
// Le WHERE ne cible que les blocages encore en mode 'event' : relancée, la requête ne touche plus rien.
db.exec(`UPDATE points SET mode = 'fixe', starts_at = NULL, ends_at = NULL, recurrence = 'none', recurrence_until = NULL,
         expires_at = NULL, status = COALESCE(status, 'vide') WHERE type = 'blocage' AND mode = 'event'`);

/**
 * Exécute `fn` dans une transaction : soit TOUTES ses écritures sont appliquées, soit AUCUNE
 * (si `fn` lève une erreur, tout est annulé). Évite qu'un plantage au milieu d'une suite de
 * requêtes laisse la base à moitié modifiée.
 * SAVEPOINT plutôt que BEGIN : les savepoints s'imbriquent, on peut donc appeler tx() depuis une
 * fonction elle-même déjà dans tx() sans erreur « transaction déjà ouverte ».
 */
let txDepth = 0;
export function tx<T>(fn: () => T): T {
  const name = `sp${++txDepth}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (e) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw e;
  } finally {
    txDepth--;
  }
}
