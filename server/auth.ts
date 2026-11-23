/**
 * server/auth.ts — Authentification des appareils, droits, protections, invitations.
 *
 * À quoi sert ce fichier ?
 *   Terrain n'a pas de comptes « email + mot de passe ». Un téléphone devient un « appareil »
 *   autorisé en ouvrant un lien d'invitation (QR code). Le serveur lui donne alors un jeton secret
 *   aléatoire, rangé dans un cookie. À chaque requête, on relit ce cookie, on calcule l'empreinte
 *   (hash) du jeton et on cherche l'appareil correspondant dans la table `devices`.
 *
 *   Ce fichier contient :
 *   - les outils de lecture/écriture de la liste d'espaces ('lfi', 'mvt') stockée en texte ;
 *   - la gestion du cookie de session ;
 *   - des « middlewares » Express : requireDevice (être connecté), requireRole (avoir un rôle),
 *     csrf (protection contre les requêtes forgées), rateLimit (anti-bourrinage) ;
 *   - la création d'invitations et la conversion ligne SQL -> objet envoyé au client (« DTO ») ;
 *   - la création de l'invitation de tout premier lancement (ensureBootstrapAdmin).
 *
 * Qui l'appelle ?
 *   - index.ts (csrf, requireDevice, ensureBootstrapAdmin) ;
 *   - routes-access.ts (presque tout) et les autres routes-*.ts (requireDevice, hasSpace…) ;
 *   - events.ts (parseSpaces) et cli-invite.ts (createInvite).
 *
 * Notions à connaître :
 *   - Middleware Express : une fonction (req, res, next). Elle peut répondre elle-même
 *     (et donc arrêter la chaîne) ou appeler `next()` pour passer au suivant.
 *   - Codes HTTP utilisés : 401 = « tu n'es pas identifié », 403 = « identifié mais pas le droit »,
 *     429 = « trop de requêtes ».
 *   - Hash SHA-256 : fonction à sens unique. On stocke sha256(jeton), jamais le jeton : à partir de
 *     la base seule, on ne peut pas reconstituer le cookie.
 *   - DTO (Data Transfer Object) : la forme « propre » d'une donnée envoyée au navigateur
 *     (camelCase, booléens réels, sans le token_hash), différente de la ligne SQL brute.
 */
// Module cryptographique de Node : hash et génération de nombres aléatoires sûrs.
import crypto from 'node:crypto';
// `import type` : on n'importe que des TYPES (effacés à la compilation), pas du code exécuté.
import type { Request, Response, NextFunction } from 'express';
import { db } from './db';
// SPACES est une vraie valeur (le tableau ['lfi', 'mvt']) ; `type X` dans les accolades marque
// les imports qui ne sont que des types TypeScript.
import { SPACES, type Device, type Invite, type Role, type Space } from '../shared/model';

// Nom du cookie de session (exporté car d'autres modules peuvent en avoir besoin).
export const COOKIE = 'terrain_sid';
// Durée de vie du cookie : 400 jours en millisecondes (86400 secondes par jour × 1000).
// 400 jours est le maximum accepté par les navigateurs modernes (Chrome plafonne à 400 jours).
const COOKIE_MAX_AGE = 400 * 86400 * 1000;

/**
 * Forme exacte d'une ligne de la table `devices` telle que SQLite la renvoie
 * (noms de colonnes en snake_case, dates en nombres, NULL -> `null`).
 * `string | null` signifie : soit une chaîne, soit null (colonne facultative).
 */
export interface DeviceRow {
  id: string;
  name: string;
  role: Role;
  token_hash: string;
  invited_by: string | null;
  invite_id: string | null;
  created_at: number;
  last_seen: number | null;
  revoked_at: number | null;
  user_agent: string | null;
  /** Espaces, séparés par des virgules (« lfi », « mvt » ou « lfi,mvt »). */
  spaces: string;
  // 0 ou 1 (SQLite n'a pas de booléen) : 1 = cet appareil est le propriétaire.
  owner: number;
}

/** Lecture / écriture de la liste d'espaces stockée en texte. */
// parseSpaces('mvt,lfi') -> ['lfi', 'mvt'].
//   - `(s ?? '')` : si s vaut null ou undefined, on travaille sur une chaîne vide (évite un plantage).
//   - On part de SPACES (la liste officielle) et on garde ceux présents dans le texte : toute valeur
//     inconnue ou mal écrite est donc ignorée, et l'ordre est toujours le même ('lfi' puis 'mvt').
export const parseSpaces = (s: string | null | undefined): Space[] =>
  SPACES.filter((x) => (s ?? '').split(',').includes(x));
// joinSpaces(['mvt', 'lfi']) -> 'lfi,mvt' : l'inverse, avec le même ordre canonique et sans doublon.
export const joinSpaces = (list: Space[]) => SPACES.filter((x) => list.includes(x)).join(',');

/** Espaces auxquels un appareil a accès. */
export const spacesOf = (d: DeviceRow): Space[] => parseSpaces(d.spaces);
// `s as Space` : `s` arrive en `string` (ex. une valeur venant d'une URL) ; on le « convertit » pour
// que `.includes` accepte de comparer. Ce n'est qu'une indication de type : aucune vérification
// n'est faite à l'exécution, mais si s ne vaut ni 'lfi' ni 'mvt', includes renverra simplement false.
export const hasSpace = (d: DeviceRow, s: string) => spacesOf(d).includes(s as Space);
/** Tous les espaces de `list` sont-ils accessibles à cet appareil ? */
// `.every` renvoie true si la condition est vraie pour TOUS les éléments (et true pour une liste vide).
export const coversSpaces = (d: DeviceRow, list: Space[]) => list.every((s) => hasSpace(d, s));

// « Augmentation de module » : on ajoute une propriété `device` au type Request d'Express,
// pour que `req.device` soit connu de TypeScript partout dans le projet.
// `declare global` = on modifie un type global ; `namespace Express` est l'endroit où Express
// déclare ses types. Le `?` rend la propriété facultative : elle n'existe qu'après requireDevice.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: DeviceRow;
    }
  }
}

// Empreinte SHA-256 d'une chaîne, renvoyée en hexadécimal (64 caractères).
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
// Jeton secret : 32 octets aléatoires cryptographiquement sûrs (256 bits, impossible à deviner),
// encodés en « base64url » (lettres, chiffres, - et _ : sans caractère gênant dans une URL).
export const newToken = () => crypto.randomBytes(32).toString('base64url');
// Identifiant de ligne : 12 octets aléatoires (16 caractères). Pas secret, juste unique.
export const newId = () => crypto.randomBytes(12).toString('base64url');

/**
 * Lit la valeur d'un cookie à la main dans l'en-tête HTTP « Cookie »
 * (format : « nom1=valeur1; nom2=valeur2 »). Évite d'ajouter la dépendance cookie-parser.
 * Renvoie la valeur décodée, ou null si le cookie est absent.
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    // Destructuration : `k` reçoit le premier morceau (le nom), `...v` le reste dans un tableau.
    // On recolle `v` avec '=' juste après, au cas où la valeur contiendrait elle-même un '='.
    const [k, ...v] = part.trim().split('=');
    // decodeURIComponent : Express encode la valeur du cookie (ex. %3D) ; on la remet en clair.
    // try/catch : un cookie mal formé (ex. « %E0 ») ferait planter decodeURIComponent → on l'ignore.
    if (k === name) {
      try { return decodeURIComponent(v.join('=')); } catch { return null; }
    }
  }
  return null;
}

/**
 * La requête arrive-t-elle en HTTPS ? `req.secure` est vrai en HTTPS direct, ou derrière un
 * proxy quand `trust proxy` est réglé (TRUST_PROXY=1, le cas en Docker et avec systemd) : Express
 * lit alors lui-même l'en-tête X-Forwarded-Proto du proxy. On ne lit PAS cet en-tête à la main :
 * sans proxy de confiance, n'importe quel client pourrait l'inventer.
 */
export function isHttps(req: Request) {
  return req.secure;
}

/**
 * Pose le cookie de session dans la réponse.
 *   - httpOnly : le JavaScript de la page ne peut pas lire le cookie (protège d'un vol par XSS).
 *   - sameSite 'strict' : le navigateur n'envoie pas le cookie quand la requête vient d'un autre site
 *     (première barrière contre le CSRF).
 *   - secure : cookie envoyé uniquement en HTTPS (activé seulement si on est en HTTPS, sinon le
 *     développement en http://localhost ne fonctionnerait pas).
 *   - path '/' : valable pour tout le site.
 */
export function setSessionCookie(req: Request, res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps(req),
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

// Demande au navigateur d'effacer le cookie (le `path` doit être le même qu'à la création).
export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE, { path: '/' });
}

// Requêtes préparées une seule fois au chargement du module puis réutilisées à chaque requête
// HTTP (plus rapide que de recompiler le SQL à chaque fois). Les `?` sont remplis à l'appel :
// SQLite les traite comme des valeurs, jamais comme du SQL, ce qui empêche l'injection SQL.
// findDevice : l'appareil dont le hash de jeton correspond, seulement s'il n'est pas révoqué.
const findDevice = db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL');
// touchDevice : met à jour la date de dernière activité.
const touchDevice = db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?');

/**
 * L'appareil connecté s'il y en a un, sinon undefined — sans jamais répondre d'erreur.
 * Pour les routes publiques qui se comportent un peu différemment quand on a l'app
 * (archive privée visible, vote déjà fait avec l'app…). Une seule implémentation pour tout le serveur.
 */
export function optionalDevice(req: Request): DeviceRow | undefined {
  const token = readCookie(req, COOKIE);
  return token ? (findDevice.get(sha256(token)) as DeviceRow | undefined) : undefined;
}

/**
 * Enveloppe une route `async` pour Express 4. Express 4 ne rattrape PAS les erreurs d'une fonction
 * async (une promesse rejetée) : la requête restait bloquée sans réponse. `.catch(next)` transmet
 * l'erreur au gestionnaire d'erreurs d'index.ts, qui répond proprement.
 */
export const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res, next).catch(next); };

/** Exige un appareil enregistré et non révoqué. */
// Middleware posé devant toutes les routes privées. En cas de succès, `req.device` contient la
// ligne complète de l'appareil, utilisée ensuite par les routes pour vérifier les droits.
export function requireDevice(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  // Pas de cookie : 401 (non identifié). `return` arrête la fonction : next() n'est pas appelé.
  if (!token) return res.status(401).json({ error: 'Appareil non autorisé' });
  // On cherche par empreinte : le jeton en clair n'est jamais comparé ni stocké.
  // `as DeviceRow | undefined` : .get() renvoie un type vague ; on précise ce qu'on attend
  // (une ligne de devices, ou undefined si rien n'a été trouvé).
  const row = findDevice.get(sha256(token)) as DeviceRow | undefined;
  if (!row) {
    // Jeton inconnu ou appareil révoqué : on efface le cookie devenu inutile.
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Accès révoqué ou expiré' });
  }
  const now = Date.now();
  // On n'écrit last_seen qu'au plus une fois par minute (60_000 ms ; le `_` est un simple séparateur
  // de milliers autorisé en JS) : évite une écriture en base à chaque requête.
  if (!row.last_seen || now - row.last_seen > 60_000) touchDevice.run(now, row.id);
  // On attache l'appareil à la requête pour les middlewares / routes suivants.
  req.device = row;
  next();
}

/**
 * Fabrique un middleware qui n'accepte que certains rôles. Exemple : requireRole('admin', 'relais').
 * `...roles` (paramètre « rest ») regroupe tous les arguments dans un tableau.
 * C'est une fonction qui RENVOIE une fonction (le middleware) : on l'appelle avec les rôles voulus
 * au moment de déclarer la route. À placer APRÈS requireDevice (sinon req.device est vide -> 403).
 */
export const requireRole = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.device || !roles.includes(req.device.role)) return res.status(403).json({ error: 'Droits insuffisants' });
  next();
};

/**
 * Protection CSRF : toute requête qui modifie quelque chose doit porter l'en-tête
 * X-Terrain, qu'un autre site ne peut pas ajouter sans CORS (que l'on n'autorise pas).
 */
// Explication : un site malveillant peut faire envoyer un formulaire vers notre API par le navigateur
// de la victime, mais il ne peut pas y ajouter un en-tête personnalisé sans une autorisation CORS
// que notre serveur ne donne jamais. Le client Terrain, lui, ajoute toujours `X-Terrain: 1`.
export function csrf(req: Request, res: Response, next: NextFunction) {
  // Les méthodes « de lecture » ne modifient rien : pas besoin de vérifier.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // `req.get(nom)` lit un en-tête (sans tenir compte des majuscules).
  if (req.get('x-terrain') !== '1') return res.status(403).json({ error: 'Requête refusée' });
  next();
}

/** Options d'un limiteur de requêtes. */
export interface RateLimitOptions {
  /** Ce qu'on compte : par défaut l'adresse IP. Ex. : un cookie de votant, pour compter par personne. */
  key?: (req: Request) => string;
  /**
   * Ne compter que certaines réponses, d'après leur code HTTP. Ex. : `(s) => s === 404` pour ne
   * compter que les codes de vote FAUX. Les bonnes réponses ne consomment alors rien : toute une
   * salle d'AG derrière le même Wi-Fi peut entrer le bon code sans être bloquée.
   */
  countIf?: (status: number) => boolean;
  /** Message renvoyé avec le 429. */
  message?: string;
}

/**
 * Limiteur de requêtes en mémoire. rateLimit(10, 60_000) = au plus 10 requêtes par minute et par
 * adresse IP, sinon 429. Principe de la « fenêtre glissante » : on garde, pour chaque clé, les dates
 * des requêtes récentes et on oublie celles sorties de la fenêtre.
 * Limites : la mémoire est perdue au redémarrage et n'est pas partagée entre plusieurs serveurs
 * (une seule instance ici : suffisant).
 */
export function rateLimit(max: number, windowMs: number, opts: RateLimitOptions = {}) {
  // `Map<string, number[]>` : clé (IP ou autre) → liste d'horodatages. Créée UNE fois par limiteur
  // et gardée vivante par la « fermeture » (closure) de la fonction renvoyée.
  const hits = new Map<string, number[]>();
  // Ménage toutes les 5 minutes : on retire les clés dont tous les passages sont périmés.
  // Sans ça, la Map grossissait indéfiniment (une entrée par adresse IP jamais revue).
  // unref() : ce minuteur n'empêche pas Node de s'arrêter.
  setInterval(() => {
    const now = Date.now();
    for (const [k, list] of hits) if (!list.some((t) => now - t < windowMs)) hits.delete(k);
  }, 5 * 60_000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    // Derrière un proxy, req.ip n'est la vraie IP du visiteur que si `trust proxy` est réglé (index.ts).
    const key = opts.key ? opts.key(req) : req.ip ?? 'unknown';
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.set(key, list);
    // Déjà au maximum : refus, sans même traiter la requête.
    if (list.length >= max) return res.status(429).json({ error: opts.message ?? 'Trop de tentatives, réessaie dans une minute.' });
    if (opts.countIf) {
      // On ne compte qu'une fois la réponse envoyée, si son code correspond (événement 'finish').
      res.on('finish', () => { if (opts.countIf!(res.statusCode)) list.push(Date.now()); });
    } else {
      list.push(now);
    }
    next();
  };
}

// ---------- Invitations ----------

/** Forme d'une ligne de la table `invites` (voir db.ts pour le sens des colonnes). */
export interface InviteRow {
  id: string;
  token_hash: string;
  role: Role;
  label: string | null;
  max_uses: number;
  uses: number;
  expires_at: number;
  created_by: string | null;
  created_at: number;
  revoked_at: number | null;
  spaces: string;
}

// Requête d'insertion préparée. `uses` est fixé à 0 directement dans le SQL (d'où 9 `?` pour 10 colonnes).
const insertInvite = db.prepare(`
  INSERT INTO invites (id, token_hash, role, label, max_uses, uses, expires_at, created_by, created_at, spaces)
  VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`);

/**
 * Crée une invitation en base et renvoie { token, id }.
 * Entrée : un objet d'options (rôle donné, durée de validité en minutes, nombre d'utilisations max,
 * étiquette libre, id de l'appareil créateur ou null, espaces accordés).
 * Le jeton en clair n'est renvoyé qu'ici, une seule fois, pour fabriquer le lien / QR code :
 * la base ne garde que son hash, donc un lien perdu ne peut pas être « réaffiché ».
 * Attention : AUCUN contrôle de droits ici ; c'est à l'appelant (route /invites) de vérifier.
 */
export function createInvite(opts: { role: Role; ttlMinutes: number; maxUses: number; label: string | null; createdBy: string | null; spaces: Space[] }) {
  const token = newToken();
  const id = newId();
  const now = Date.now();
  // Ordre des valeurs = ordre des `?` dans insertInvite. Date d'expiration = maintenant + durée
  // (minutes × 60 000 ms).
  insertInvite.run(id, sha256(token), opts.role, opts.label, opts.maxUses, now + opts.ttlMinutes * 60_000, opts.createdBy, now, joinSpaces(opts.spaces));
  return { token, id };
}

/**
 * Convertit une ligne SQL d'invitation en objet `Invite` pour le client.
 * `InviteRow & { created_by_name?: … }` : type « intersection » = une InviteRow avec en plus un
 * champ facultatif created_by_name (présent quand la requête a fait une jointure sur devices).
 * Le token_hash n'est volontairement PAS recopié.
 */
export function inviteToDto(r: InviteRow & { created_by_name?: string | null }): Invite {
  return {
    id: r.id,
    role: r.role,
    spaces: parseSpaces(r.spaces),
    label: r.label,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: r.expires_at,
    createdBy: r.created_by,
    // `?? null` : si le champ n'existe pas (undefined), on envoie null (JSON ne connaît pas undefined).
    createdByName: r.created_by_name ?? null,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

/** Même chose pour un appareil : ligne SQL -> objet `Device` (sans token_hash, bien sûr). */
export function deviceToDto(r: DeviceRow & { invited_by_name?: string | null }): Device {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    spaces: parseSpaces(r.spaces),
    // `!!` convertit en vrai booléen : 1 -> true, 0 -> false.
    owner: !!r.owner,
    invitedBy: r.invited_by,
    invitedByName: r.invited_by_name ?? null,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
    revokedAt: r.revoked_at,
    userAgent: r.user_agent,
  };
}

/** Si aucun admin n'existe, crée une invitation admin à usage unique et l'affiche dans la console. */
// Appelée par index.ts au démarrage. Sur une base neuve, c'est le seul moyen de faire entrer le
// premier appareil. `baseUrl` sert à fabriquer un lien cliquable.
export function ensureBootstrapAdmin(baseUrl: string) {
  // COUNT(*) AS n : on nomme la colonne pour pouvoir lire `admins.n`.
  const admins = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE role = 'admin' AND revoked_at IS NULL").get() as { n: number };
  // Au moins un admin actif : rien à faire.
  if (admins.n > 0) return;
  // On annule les anciennes invitations « bootstrap » encore valides : seul le dernier lien affiché
  // dans la console fonctionne (évite qu'un vieux lien traînant dans des logs reste utilisable).
  db.prepare("UPDATE invites SET revoked_at = ? WHERE label = 'bootstrap' AND revoked_at IS NULL").run(Date.now());
  // Le premier appareil devient propriétaire, avec accès aux deux espaces.
  // `[...SPACES]` crée une COPIE du tableau (opérateur « spread ») plutôt que de passer l'original.
  // createdBy: null + label 'bootstrap' : c'est ce couple que /auth/claim reconnaît pour donner owner = 1.
  const { token } = createInvite({ role: 'admin', ttlMinutes: 24 * 60, maxUses: 1, label: 'bootstrap', createdBy: null, spaces: [...SPACES] });
  // Simple ligne de séparation visuelle dans la console.
  const line = '─'.repeat(72);
  // Le jeton est placé après `#` (fragment d'URL) : le navigateur ne l'envoie jamais au serveur
  // dans l'URL, c'est le code client qui le lit puis l'envoie à /auth/claim.
  console.log(`\n${line}\n  Aucun admin pour l'instant. Ouvre ce lien (valable 24 h, usage unique)\n  sur l'appareil qui sera propriétaire (accès aux deux espaces) :\n\n  ${baseUrl}/#/join/${token}\n${line}\n`);
}
