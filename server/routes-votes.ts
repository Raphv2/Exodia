/**
 * ============================================================================
 * routes-votes.ts : les votes en AG (façon Kahoot), côté serveur.
 * ============================================================================
 *
 * À QUOI ÇA SERT
 * - Créer la table des votes et des bulletins (au chargement du fichier).
 * - Routes « app » (routeur `votes`) : lancer, voir, clore un vote, voter depuis l'app.
 * - Routes « publiques » (routeur `publicVotes`) : trouver un vote par son code et voter
 *   SANS compte, ou voter sans code sur un vote « ouvert à tous ».
 *
 * QUI L'APPELLE
 * - server/index.ts :
 *     api.use('/public', publicVotes)   → /api/public/... , accessible sans appareil connecté ;
 *     api.use(requireDevice, votes)     → /api/... , appareil connecté obligatoire (req.device rempli).
 *   Les deux passent avant par express.json et csrf (en-tête X-Terrain obligatoire hors GET).
 * - Côté client : l'écran de l'AG (lancer / clore / voir les résultats), le bandeau de l'agenda,
 *   et la page publique de vote (saisie du code à 5 chiffres).
 *
 * NOTIONS À CONNAÎTRE
 * - « Clé de votant » (voter_key) : ce qui identifie UN votant pour un vote. 'd:<id appareil>' pour
 *   l'app, 'v:<empreinte du cookie>' pour les gens sans l'app. La clé primaire (vote_id, voter_key)
 *   de la table ballots garantit un seul bulletin par votant.
 * - Rayon (radius) : distance max en mètres autour de l'AG pour voter ; 0 = peu importe.
 * - Hachage sha256 : transforme un texte en empreinte impossible à inverser. On stocke l'empreinte
 *   d'un secret (cookie, jeton), jamais le secret lui-même.
 * - Les mêmes conventions que routes-points.ts : codes HTTP, db.prepare/get/all/run, zod, broadcast.
 *   Nouveaux codes ici : 409 Conflict (déjà voté), 410 Gone (vote clos), 428 (position requise).
 */
// crypto (module Node) : tirages aléatoires sûrs (codes, cookies), impossibles à prédire contrairement à Math.random.
import crypto from 'node:crypto';
// `type Request, type Response` : on importe seulement des types, pour annoter les paramètres de fonctions.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from './db';
// rateLimit : limiteur de tentatives par adresse IP ; sha256 : fonction de hachage (voir auth.ts).
import { hasSpace, isHttps, newId, optionalDevice, rateLimit, readCookie, sha256, spacesOf, type DeviceRow } from './auth';
import { broadcast } from './events';
// VOTE_RADII : distances autorisées (25, 50, 100, 200, 500, 0) ; DEFAULT_VOTE_RADIUS : 50 m.
import { VOTE_RADII, DEFAULT_VOTE_RADIUS, type Vote, type VoteResult } from '../shared/model';

/*
 * Votes en AG, façon Kahoot :
 * - l'organisateur·rice d'une AG (ou un admin de l'espace) lance un vote : une question, des choix ;
 * - l'app génère un code à 5 chiffres, unique tant que le vote est ouvert ;
 * - n'importe qui, même sans l'app, tape le code et vote… seulement s'il est à moins de 50 m de l'AG ;
 * - un seul vote par appareil (appareil de l'app, ou cookie « votant » pour les autres).
 * Limite assumée : une position GPS peut être falsifiée et une navigation privée donne un nouveau cookie.
 */

// Création des tables au chargement du fichier (IF NOT EXISTS : sans effet si elles existent déjà).
// Contrairement aux autres tables, celles-ci sont définies ici et non dans db.ts.
// - votes.point_id REFERENCES points(id) ON DELETE CASCADE : supprimer l'AG supprime ses votes.
// - options : la liste des choix, stockée en texte JSON.
// - CHECK (status IN ...) : SQLite refuse toute autre valeur que 'open' ou 'closed'.
// - Index UNIQUE « partiel » (WHERE status = 'open') : deux votes OUVERTS ne peuvent pas avoir le même
//   code, mais un code peut être réutilisé une fois le vote clos.
// - ballots (bulletins) : clé primaire (vote_id, voter_key) = un seul bulletin par votant et par vote.
//   Le choix est l'index (0, 1, 2…) dans la liste des options. On ne stocke pas QUI vote quoi en clair
//   pour les gens sans l'app (seulement une empreinte de cookie).
db.exec(`
  CREATE TABLE IF NOT EXISTS votes (
    id          TEXT PRIMARY KEY,
    point_id    TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    question    TEXT NOT NULL,
    options     TEXT NOT NULL,
    code        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    radius      INTEGER NOT NULL DEFAULT 50,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    closed_at   INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS votes_open_code ON votes(code) WHERE status = 'open';
  CREATE INDEX IF NOT EXISTS votes_point ON votes(point_id);

  CREATE TABLE IF NOT EXISTS ballots (
    vote_id     TEXT NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    voter_key   TEXT NOT NULL,
    choice      INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (vote_id, voter_key)
  );
`);

// Une ligne de la table `votes`. status : un « type union littéral », seulement ces deux textes.
interface VoteRow {
  id: string; point_id: string; question: string; options: string; code: string; status: 'open' | 'closed';
  radius: number; created_by: string; created_at: number; closed_at: number | null;
}
// Version allégée d'un point : seulement les colonnes utiles aux votes (on n'a pas besoin du reste).
interface PointLite { id: string; type: string; space: string; title: string; lat: number; lng: number; created_by: string; starts_at: number | null; public: number }

// Nom du cookie qui identifie un votant sans compte.
const VOTER_COOKIE = 'terrain_voter';
// Précision GPS maximale acceptée, en mètres (le navigateur donne un rayon d'incertitude).
const MAX_ACCURACY = 100; // au-delà, la position est trop floue pour décider

// Petits raccourcis de lecture en base. Aucune vérification de droits ici : c'est aux routes de le faire.
const getVote = (id: string) => db.prepare('SELECT * FROM votes WHERE id = ?').get(id) as VoteRow | undefined;
// Un vote OUVERT par son code (les codes des votes clos ne marchent plus).
const getOpenByCode = (code: string) => db.prepare("SELECT * FROM votes WHERE code = ? AND status = 'open'").get(code) as VoteRow | undefined;
const getPoint = (id: string) => db.prepare('SELECT id, type, space, title, lat, lng, created_by, starts_at, public FROM points WHERE id = ?').get(id) as PointLite | undefined;

// Compte les bulletins par choix. Entrées : id du vote, nombre d'options. Sortie : ex. [12, 5, 0].
function counts(voteId: string, n: number): number[] {
  // Un tableau de n zéros (un compteur par option).
  const out = Array.from({ length: n }, () => 0);
  // GROUP BY choice : SQLite renvoie une ligne par choix avec son nombre de bulletins (COUNT(*)).
  for (const r of db.prepare('SELECT choice, COUNT(*) AS c FROM ballots WHERE vote_id = ? GROUP BY choice').all(voteId) as { choice: number; c: number }[]) {
    // On ignore un choix hors limites (donnée incohérente) au lieu de créer une case en trop.
    if (r.choice >= 0 && r.choice < n) out[r.choice] = r.c;
  }
  return out;
}

// Construit l'objet `Vote` envoyé au client. Entrées :
//  - full : true pour l'organisation (code + résultats en direct), false pour les votant·es ;
//  - voterKey : pour retrouver « mon choix » si j'ai déjà voté.
// RÈGLE : pendant le vote, les autres ne voient que le total (pas de vote « suiveur »).
/** Un vote pour l'app. Les résultats détaillés : à l'organisation pendant le vote, à tout le monde une fois clos. */
function voteDto(v: VoteRow, opts: { full: boolean; voterKey?: string }): Vote {
  // Les options sont stockées en JSON : on les redécode en tableau.
  const options = JSON.parse(v.options) as string[];
  const c = counts(v.id, options.length);
  // reduce additionne tous les compteurs : le nombre total de bulletins.
  const total = c.reduce((a, b) => a + b, 0);
  // Résultats détaillés si on organise, ou pour tout le monde une fois le vote clos.
  const showResults = opts.full || v.status === 'closed';
  // Mon bulletin, s'il existe. `(... as {...} | undefined)?.choice` lit le choix seulement si une ligne a été trouvée ;
  // `?? null` : pas de ligne → null (« je n'ai pas encore voté »).
  const mine = opts.voterKey
    ? (db.prepare('SELECT choice FROM ballots WHERE vote_id = ? AND voter_key = ?').get(v.id, opts.voterKey) as { choice: number } | undefined)?.choice ?? null
    : null;
  return {
    id: v.id, pointId: v.point_id, question: v.question, options, status: v.status, radius: v.radius,
    // Le code n'est donné qu'à l'organisation, et seulement tant que le vote est ouvert.
    code: opts.full && v.status === 'open' ? v.code : null,
    total, counts: showResults ? c : null, myChoice: mine, createdAt: v.created_at, closedAt: v.closed_at,
    // isOpenToAll est déclarée plus bas : ça marche car une `function` est « remontée » (hoisting) en JavaScript.
    openToAll: isOpenToAll(v, getPoint(v.point_id)),
  };
}

// Formule de haversine : distance sur une sphère (la Terre, rayon R ≈ 6 371 km) entre deux points GPS.
// Assez précise pour comparer à quelques dizaines de mètres. Entrées : deux { lat, lng } en degrés.
/** Distance à vol d'oiseau en mètres. */
function distance(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  // rad convertit des degrés en radians (les fonctions Math.sin/cos travaillent en radians).
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  // Écarts de latitude et de longitude.
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  // Le cœur de la formule ; `** 2` = « au carré ».
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  // Distance finale en mètres.
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Position envoyée par le client : tout est facultatif, car un vote à rayon 0 n'en demande pas.
// accuracy = incertitude en mètres donnée par le navigateur.
/** Position (facultative : seulement pour les votes avec une distance). */
const posSchema = z.object({ lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), accuracy: z.number().min(0).max(100000).optional() });

/**
 * Sur place ? (à moins du rayon, avec une petite marge pour l'imprécision du GPS). Ne révèle jamais la distance exacte.
 * Rayon 0 : peu importe la distance, on ne regarde pas la position. Sans position alors qu'il en faut une : NEED_POSITION.
 */
// Message d'erreur réutilisé : les routes le comparent pour répondre 428 au lieu de 403
// (le client sait alors qu'il doit demander la position).
const NEED_POSITION = 'Ce vote demande ta position : il faut être sur place.';
// Entrées : la position, l'AG, le rayon du vote. Sortie : null si on peut voter, sinon le message d'erreur.
// z.infer<typeof posSchema> : le type TypeScript déduit automatiquement du schéma zod.
function presenceError(pos: z.infer<typeof posSchema>, ag: PointLite, radius: number): string | null {
  // Rayon 0 : on ne regarde pas la position du tout.
  if (!radius) return null;
  if (pos.lat == null || pos.lng == null) return NEED_POSITION;
  // Précision absente → on suppose la pire acceptée (100 m).
  const acc = pos.accuracy ?? MAX_ACCURACY;
  // Position trop floue : on refuse plutôt que de décider au hasard.
  if (acc > MAX_ACCURACY) return 'Ta position est trop imprécise. Active le GPS (localisation précise) et réessaie dehors ou près d\'une fenêtre.';
  // Marge de tolérance : la précision GPS, plafonnée à 25 m. Le message donne le rayon, jamais la distance
  // réelle (sinon on pourrait trianguler l'emplacement de l'AG en essayant plusieurs positions).
  if (distance({ lat: pos.lat, lng: pos.lng }, ag) > radius + Math.min(acc, 25)) return `Pour voter, il faut être sur place, à moins de ${radius} m du lieu de l'AG.`;
  return null;
}

// Identifie le votant pour garantir « un bulletin par personne ». Trois cas, dans l'ordre :
// 1) appareil fourni par la route (routes de l'app) ; 2) cookie de session de l'app présent
// (quelqu'un qui a l'app vote sur la page publique) ; 3) sinon un cookie « votant » anonyme.
// Ainsi une même personne ne peut pas voter une fois dans l'app et une fois sur la page publique.
/** Clé du votant : l'appareil de l'app s'il est connecté, sinon un cookie « votant » (créé au besoin). */
function voterKey(req: Request, res: Response, device?: DeviceRow): string {
  // Préfixe 'd:' = appareil de l'app (fourni par la route, ou cookie de session de l'app présent).
  const d = device ?? optionalDevice(req);
  if (d) return `d:${d.id}`;
  // `let` car on peut la remplacer juste en dessous.
  let v = readCookie(req, VOTER_COOKIE) ?? undefined;
  // Pas de cookie, ou un cookie à la forme suspecte : on en crée un nouveau.
  if (!v || !/^[A-Za-z0-9_-]{20,80}$/.test(v)) {
    // 24 octets aléatoires encodés en base64url (lettres, chiffres, - et _) : impossible à deviner.
    v = crypto.randomBytes(24).toString('base64url');
    // httpOnly : illisible par le JavaScript de la page ; sameSite strict : jamais envoyé depuis un autre site ;
    // maxAge : environ 400 jours (en millisecondes).
    res.cookie(VOTER_COOKIE, v, {
      httpOnly: true, sameSite: 'strict', path: '/', maxAge: 400 * 86400 * 1000,
      // secure (cookie uniquement en HTTPS) si la connexion est en HTTPS, directement ou derrière un proxy.
      secure: isHttps(req),
    });
  }
  // On stocke l'empreinte du cookie, pas le cookie : quelqu'un qui lirait la base ne pourrait pas se faire passer pour ce votant.
  return `v:${sha256(v)}`;
}

/** Clé du votant SI elle existe déjà (sans créer de cookie) : pour savoir si quelqu'un a voté. */
function existingVoterKey(req: Request): string | null {
  const d = optionalDevice(req);
  if (d) return `d:${d.id}`;
  const v = readCookie(req, VOTER_COOKIE);
  return v && /^[A-Za-z0-9_-]{20,80}$/.test(v) ? `v:${sha256(v)}` : null;
}

/** Ce votant a-t-il un bulletin dans ce vote ? */
const hasBallot = (voteId: string, key: string | null) =>
  !!key && !!db.prepare('SELECT 1 FROM ballots WHERE vote_id = ? AND voter_key = ?').get(voteId, key);

// Tire un code à 5 chiffres pas déjà utilisé par un vote ouvert (jusqu'à 50 essais).
function newCode(): string | null {
  for (let i = 0; i < 50; i++) {
    // crypto.randomInt(0, 100000) : nombre de 0 à 99999 ; padStart(5, '0') : 42 → "00042".
    const code = String(crypto.randomInt(0, 100000)).padStart(5, '0');
    if (!getOpenByCode(code)) return code;
  }
  // Après 50 échecs (presque impossible sauf s'il y a des dizaines de milliers de votes ouverts).
  return null;
}

// Logique commune aux trois façons de voter. Entrées : le vote, l'AG, la clé du votant, l'index choisi,
// et l'id de l'appareil (facultatif, seulement pour le broadcast).
// Le type de retour est une union : soit { ok: true }, soit { error, status } ; la route teste `'error' in r`.
/** Enregistre un bulletin (un seul par votant et par vote). */
function cast(v: VoteRow, ag: PointLite, key: string, choice: number, by?: string): { ok: true } | { error: string; status: number } {
  // Note : options est décodé avant la vérification du statut (sans conséquence).
  const options = JSON.parse(v.options) as string[];
  // 410 Gone : la ressource « n'existe plus » sous cette forme (vote fini).
  if (v.status !== 'open') return { error: 'Ce vote est clos.', status: 410 };
  // Le choix doit être un entier et un index valide dans la liste des options.
  if (!Number.isInteger(choice) || choice < 0 || choice >= options.length) return { error: 'Choix invalide.', status: 400 };
  // INSERT OR IGNORE : si ce votant a déjà un bulletin (clé primaire), rien n'est inséré, sans erreur.
  // C'est la base de données elle-même qui garantit « un seul vote », même si deux requêtes arrivent en même temps.
  const r = db.prepare('INSERT OR IGNORE INTO ballots (vote_id, voter_key, choice, created_at) VALUES (?, ?, ?, ?)').run(v.id, key, choice, Date.now());
  // r.changes = nombre de lignes insérées ; 0 → déjà voté → 409 Conflict.
  if (!r.changes) return { error: 'Tu as déjà voté avec cet appareil.', status: 409 };
  // Prévient les appareils de l'espace : l'écran de l'organisation met à jour le compteur en direct.
  broadcast('votes', { id: v.id, pointId: v.point_id, by }, ag.space);
  return { ok: true };
}

// ====================================================================================
// Routes de l'app (appareil connecté)
// ====================================================================================

// Routeur des routes de l'app : index.ts le monte derrière requireDevice, donc req.device existe toujours.
export const votes = Router();

// Peut lancer / clore un vote et voir ses résultats en direct : il faut avoir accès à l'espace,
// ET être l'auteur·rice de l'AG ou admin.
const canRun = (me: DeviceRow, ag: PointLite) => hasSpace(me, ag.space) && (ag.created_by === me.id || me.role === 'admin');

// GET /votes/open : tous les votes ouverts des espaces de l'appareil.
/** Tous les votes ouverts de mes espaces (accès rapide : bandeau de l'Agenda, badge sur la carte). */
votes.get('/votes/open', (req, res) => {
  const me = req.device!;
  // Filtre par espace DANS la requête (avant le LIMIT) : avant, le LIMIT 100 s'appliquait à tous
  // les espaces et des votes de mon espace pouvaient manquer. Les `?` sont générés selon le nombre
  // d'espaces de l'appareil (1 ou 2), et remplis par spacesOf(me).
  const spaces = spacesOf(me);
  const rows = (spaces.length ? db.prepare(`SELECT v.* FROM votes v JOIN points p ON p.id = v.point_id
    WHERE v.status = 'open' AND p.space IN (${spaces.map(() => '?').join(',')}) ORDER BY v.created_at DESC LIMIT 100`).all(...spaces) : []) as unknown as VoteRow[];
  // flatMap : chaque vote donne [] (on l'écarte) ou [un élément] (on le garde). C'est un « filter + map » en un.
  const out = rows.flatMap((v) => {
    const ag = getPoint(v.point_id);
    // AG supprimée ou d'un autre espace : le vote n'apparaît pas.
    if (!ag || !hasSpace(me, ag.space)) return [];
    const full = canRun(me, ag);
    // voterKey 'd:<id>' : pour afficher « tu as voté X ».
    return [{ vote: voteDto(v, { full, voterKey: `d:${me.id}` }), agTitle: ag.title, canRun: full }];
  });
  res.json({ votes: out });
});

// GET /points/:id/votes : la liste des votes d'une AG (du plus récent au plus ancien).
/** Les votes d'une AG. */
votes.get('/points/:id/votes', (req, res) => {
  const ag = getPoint(req.params.id);
  if (!ag || !hasSpace(req.device!, ag.space)) return res.status(404).json({ error: 'AG introuvable' });
  const full = canRun(req.device!, ag);
  const rows = db.prepare('SELECT * FROM votes WHERE point_id = ? ORDER BY created_at DESC').all(ag.id) as unknown as VoteRow[];
  res.json({ votes: rows.map((v) => voteDto(v, { full, voterKey: `d:${req.device!.id}` })), canRun: full });
});

// POST /points/:id/votes : corps { question, options[], radius? }. Réponse 201 + le vote créé (avec son code).
/** Lancer un vote sur une AG (organisateur·rice ou admin de l'espace). */
votes.post('/points/:id/votes', (req, res) => {
  const body = z.object({
    question: z.string().trim().min(1, 'Écris la question').max(200),
    // Entre 2 et 8 choix, chacun de 1 à 60 caractères.
    options: z.array(z.string().trim().min(1).max(60)).min(2, 'Il faut au moins 2 choix').max(8),
    // Distance autour de l'AG pour pouvoir voter : seulement les valeurs proposées.
    // refine : règle de validation sur mesure. `as readonly number[]` : VOTE_RADII a un type très précis
    // (tuple de valeurs exactes) ; on l'élargit pour pouvoir appeler includes avec un nombre quelconque.
    radius: z.number().int().refine((r) => (VOTE_RADII as readonly number[]).includes(r), 'Distance invalide').optional(),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });
  const ag = getPoint(req.params.id);
  // Le point doit exister, être dans nos espaces, et être une AG.
  if (!ag || !hasSpace(req.device!, ag.space) || ag.type !== 'ag') return res.status(404).json({ error: 'AG introuvable' });
  // Les votes n'existent que côté Mouvement.
  if (ag.space !== 'mvt') return res.status(400).json({ error: 'Les votes ne sont disponibles que côté Mouvement.' });
  // 403 : seul·e l'organisateur·rice ou un admin.
  if (!canRun(req.device!, ag)) return res.status(403).json({ error: 'Seul·e l\'organisateur·rice de l\'AG ou un admin peut lancer un vote.' });
  const id = newId();
  // Un code libre à cet instant ; null si (cas extrême) aucun n'a été trouvé → 503, réessayer plus tard.
  const code = newCode();
  if (!code) return res.status(503).json({ error: 'Trop de votes ouverts en même temps : clos-en un et réessaie.' });
  db.prepare('INSERT INTO votes (id, point_id, question, options, code, radius, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, ag.id, body.data.question, JSON.stringify(body.data.options), code, body.data.radius ?? DEFAULT_VOTE_RADIUS, req.device!.id, Date.now());
  broadcast('votes', { id, pointId: ag.id, by: req.device!.id }, ag.space);
  // full: true : la personne qui vient de lancer le vote reçoit le code à afficher dans la salle.
  res.status(201).json({ vote: voteDto(getVote(id)!, { full: true }) });
});

// GET /votes/:id : un vote ; résultats détaillés si on peut l'organiser.
/** Un vote (avec résultats en direct pour l'organisation). */
votes.get('/votes/:id', (req, res) => {
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag || !hasSpace(req.device!, ag.space)) return res.status(404).json({ error: 'Vote introuvable' });
  res.json({ vote: voteDto(v, { full: canRun(req.device!, ag), voterKey: `d:${req.device!.id}` }) });
});

// POST /votes/:id/close : clore un vote.
/** Clore un vote : le code ne marche plus, les résultats deviennent visibles par tous. */
votes.post('/votes/:id/close', (req, res) => {
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag || !hasSpace(req.device!, ag.space)) return res.status(404).json({ error: 'Vote introuvable' });
  if (!canRun(req.device!, ag)) return res.status(403).json({ error: 'Seul·e l\'organisateur·rice ou un admin peut clore le vote.' });
  // `AND status = 'open'` : clore un vote déjà clos ne change rien (closed_at n'est pas réécrit).
  db.prepare("UPDATE votes SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(Date.now(), v.id);
  broadcast('votes', { id: v.id, pointId: v.point_id, by: req.device!.id }, ag.space);
  res.json({ vote: voteDto(getVote(v.id)!, { full: true }) });
});

// POST /votes/:id/ballot : corps { choice, lat?, lng?, accuracy? }. Voter depuis l'app.
/** Voter depuis l'app : même règle des 50 m, un vote par appareil. */
votes.post('/votes/:id/ballot', (req, res) => {
  // extend : on reprend le schéma de position et on y ajoute le champ choice.
  const body = posSchema.extend({ choice: z.number().int() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Données invalides' });
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag || !hasSpace(req.device!, ag.space)) return res.status(404).json({ error: 'Vote introuvable' });
  // Vérifie la présence sur place selon le rayon du vote.
  const far = presenceError(body.data, ag, v.radius);
  // 428 « Precondition Required » : il manque la position ; 403 : trop loin ou position imprécise.
  // On renvoie aussi le rayon pour que le client puisse l'afficher.
  if (far) return res.status(far === NEED_POSITION ? 428 : 403).json({ error: far, radius: v.radius });
  // La clé de votant est l'appareil ; on passe son id pour le broadcast.
  const r = cast(v, ag, `d:${req.device!.id}`, body.data.choice, req.device!.id);
  // `'error' in r` : teste si l'objet a une propriété error (et TypeScript comprend alors quel cas de l'union on a).
  if ('error' in r) return res.status(r.status).json({ error: r.error });
  res.json({ vote: voteDto(getVote(v.id)!, { full: canRun(req.device!, ag), voterKey: `d:${req.device!.id}` }) });
});

// ====================================================================================
// Routes publiques (sans l'app) : uniquement avec le code, et sur place
// ====================================================================================

// Routeur public : monté sur /api/public SANS requireDevice. req.device n'existe pas ici,
// donc chaque route doit se protéger elle-même (code, position, limite de tentatives).
export const publicVotes = Router();
// 5 chiffres = 100 000 codes : on limite les essais pour empêcher de les deviner. Mais pendant une AG,
// toute la salle partage souvent la MÊME adresse IP (Wi-Fi du lieu, 4G de l'opérateur) : un simple
// « 15 requêtes par minute et par IP » bloquait des gens qui tapaient le bon code. D'où trois compteurs :
//  - codeGuessLimit : ne compte que les codes FAUX (réponse 404), par IP : 20 erreurs / 10 min.
//    Les bons codes ne consomment rien ; deviner 100 000 codes à ce rythme prendrait des mois.
//  - voterLimit : par votant (cookie), 20 requêtes / minute : un même navigateur ne peut pas marteler.
//  - ipLimit : filet de sécurité très large par IP (une salle entière tient dedans).
const codeGuessLimit = rateLimit(20, 10 * 60_000, { countIf: (s) => s === 404, message: 'Trop de codes faux. Attends quelques minutes et vérifie le code affiché.' });
const voterLimit = rateLimit(20, 60_000, { key: (req) => `voter:${readCookie(req, VOTER_COOKIE) ?? req.ip ?? 'unknown'}` });
const ipLimit = rateLimit(600, 60_000);

// POST /public/votes/lookup : corps { code, lat?, lng?, accuracy? }.
// tryLimit est placé avant le gestionnaire : c'est un middleware, il s'exécute d'abord et peut répondre 429.
/** Trouver un vote par son code, si l'on est sur place. Rien n'est révélé de l'AG sauf son titre. */
publicVotes.post('/votes/lookup', ipLimit, codeGuessLimit, voterLimit, (req, res) => {
  // Le code doit faire exactement 5 chiffres (^ début, \d{5} cinq chiffres, $ fin).
  const body = posSchema.extend({ code: z.string().regex(/^\d{5}$/, 'Le code fait 5 chiffres') }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });
  const v = getOpenByCode(body.data.code);
  const ag = v && getPoint(v.point_id);
  // Même message que le code soit faux ou l'AG supprimée : on ne donne aucun indice.
  if (!v || !ag) return res.status(404).json({ error: 'Aucun vote ouvert avec ce code.' });
  // On vérifie la position AVANT de révéler la question : sans être sur place, on n'apprend rien du vote.
  const far = presenceError(body.data, ag, v.radius);
  if (far) return res.status(far === NEED_POSITION ? 428 : 403).json({ error: far, radius: v.radius });
  // Pas d'appareil ici : la clé vient du cookie de session ou du cookie votant (créé si besoin).
  const key = voterKey(req, res);
  const dto = voteDto(v, { full: false, voterKey: key });
  // `{ ...dto, code: null }` : copie de l'objet avec code écrasé à null (par sécurité, même si full: false le fait déjà).
  res.json({ vote: { ...dto, code: null }, agTitle: ag.title });
});

/** Voter sans l'app. */
// POST /public/votes/ballot : corps { code, choice, lat?, lng?, accuracy? }. Voter sans l'app.
// Le code et la position sont revérifiés : on ne fait pas confiance au fait que lookup a été appelé avant.
publicVotes.post('/votes/ballot', ipLimit, codeGuessLimit, voterLimit, (req, res) => {
  const body = posSchema.extend({ code: z.string().regex(/^\d{5}$/), choice: z.number().int() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Données invalides' });
  const v = getOpenByCode(body.data.code);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag) return res.status(404).json({ error: 'Ce vote est clos ou le code est faux.' });
  const far = presenceError(body.data, ag, v.radius);
  if (far) return res.status(far === NEED_POSITION ? 428 : 403).json({ error: far, radius: v.radius });
  const key = voterKey(req, res);
  // Pas de 5e argument : le broadcast ne contiendra pas d'auteur (personne connue).
  const r = cast(v, ag, key, body.data.choice);
  if ('error' in r) return res.status(r.status).json({ error: r.error });
  res.json({ vote: { ...voteDto(getVote(v.id)!, { full: false, voterKey: key }), code: null } });
});

// RÈGLE MÉTIER « votes indicatifs ouverts à tous » (détails dans le bloc ci-dessous).
/**
 * Votes ouverts à tous, SANS code : uniquement les votes « peu importe la distance »
 * d'une AG annoncée publiquement (sur une AG interne, la question ne doit pas fuiter : le code reste nécessaire).
 */
function isOpenToAll(v: VoteRow, ag: PointLite | undefined): boolean {
  // Les cinq conditions : AG trouvée, vote ouvert, rayon 0, c'est une AG côté Mouvement, et l'AG est publique.
  // `!!ag.public` : 0/1 → false/true.
  return !!ag && v.status === 'open' && v.radius === 0 && ag.type === 'ag' && ag.space === 'mvt' && !!ag.public;
}

// GET /public/votes/open : la liste des votes ouverts à tous (affichée sur la page d'accueil publique).
// Pas de tryLimit ici (lecture seule). Peut créer le cookie votant pour afficher « mon choix ».
publicVotes.get('/votes/open', (req, res) => {
  // Pré-filtre SQL sur radius = 0 ; les autres conditions (AG publique…) sont vérifiées par isOpenToAll.
  const rows = db.prepare("SELECT * FROM votes WHERE status = 'open' AND radius = 0 ORDER BY created_at DESC LIMIT 50").all() as unknown as VoteRow[];
  const key = voterKey(req, res);
  const out = rows.flatMap((v) => {
    const ag = getPoint(v.point_id);
    if (!isOpenToAll(v, ag)) return [];
    // `ag!` : isOpenToAll a vérifié que ag existe, mais TypeScript ne le sait pas, d'où le `!`.
    return [{ vote: { ...voteDto(v, { full: false, voterKey: key }), code: null }, agTitle: ag!.title }];
  });
  res.json({ votes: out });
});

/** Voter sans code, sur un vote ouvert à tous. */
// POST /public/votes/:id/open-ballot : corps { choice }. Pas de code ni de position : seulement si isOpenToAll.
publicVotes.post('/votes/:id/open-ballot', ipLimit, voterLimit, (req, res) => {
  const body = z.object({ choice: z.number().int() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Données invalides' });
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  // Même 404 que le vote n'existe pas ou ne soit pas ouvert à tous : on ne révèle pas l'existence des votes internes.
  if (!v || !isOpenToAll(v, ag)) return res.status(404).json({ error: 'Ce vote n\'est pas ouvert à tous (ou il est clos).' });
  const key = voterKey(req, res);
  const r = cast(v, ag!, key, body.data.choice);
  if ('error' in r) return res.status(r.status).json({ error: r.error });
  res.json({ vote: { ...voteDto(getVote(v.id)!, { full: false, voterKey: key }), code: null } });
});

// GET /public/votes/:id/result : le résultat, seulement pour qui a le droit de le voir.
/**
 * Résultat d'un vote (compteurs seulement une fois clos), pour la personne qui a voté sans l'app.
 * Avant, l'id suffisait : n'importe qui le connaissant voyait la question d'une AG interne.
 * Maintenant il faut : avoir voté dans ce vote (cookie votant ou appareil), OU que l'AG soit
 * publique côté Mouvement. Sinon 404, comme si le vote n'existait pas.
 */
publicVotes.get('/votes/:id/result', (req, res) => {
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  const isPublic = !!ag && ag.type === 'ag' && ag.space === 'mvt' && !!ag.public;
  if (!v || !(isPublic || hasBallot(v.id, existingVoterKey(req)))) return res.status(404).json({ error: 'Vote introuvable' });
  // Les compteurs seulement si le vote est clos ; sinon null (pas de résultat partiel).
  const out: VoteResult = { id: v.id, status: v.status, question: v.question, options: JSON.parse(v.options), counts: v.status === 'closed' ? counts(v.id, JSON.parse(v.options).length) : null };
  res.json({ result: out });
});

// ====================================================================================
// Clôture automatique
// ====================================================================================

/** Délai après la fin de l'AG avant de clore ses votes encore ouverts (le temps de finir de compter). */
const AUTO_CLOSE_AFTER_END = 2 * 3600_000;
/** Pour une AG sans heure de fin connue : un vote ouvert depuis plus de 24 h est clos. */
const AUTO_CLOSE_MAX_AGE = 24 * 3600_000;

/**
 * Ferme les votes qui ne devraient plus être ouverts. Appelée chaque minute par index.ts.
 * Avant, un vote restait ouvert pour toujours si personne ne le fermait, même des jours après l'AG,
 * ou si son AG avait changé de type entre-temps. Cas fermés :
 *  - le point n'est plus une AG (type modifié) ;
 *  - l'AG est terminée depuis plus de 2 h ;
 *  - l'AG n'a pas d'heure de fin et le vote est ouvert depuis plus de 24 h.
 */
export function closeStaleVotes() {
  const now = Date.now();
  const rows = db.prepare(`SELECT v.id, v.point_id, p.space FROM votes v JOIN points p ON p.id = v.point_id
    WHERE v.status = 'open' AND (
      p.type != 'ag'
      OR (p.ends_at IS NOT NULL AND p.ends_at < ?)
      OR (p.ends_at IS NULL AND v.created_at < ?)
    )`).all(now - AUTO_CLOSE_AFTER_END, now - AUTO_CLOSE_MAX_AGE) as { id: string; point_id: string; space: string }[];
  const close = db.prepare("UPDATE votes SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'");
  for (const r of rows) {
    close.run(now, r.id);
    broadcast('votes', { id: r.id, pointId: r.point_id }, r.space);
  }
}
