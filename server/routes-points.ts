/**
 * ============================================================================
 * routes-points.ts : tout ce qui touche aux POINTS de la carte, côté serveur.
 * ============================================================================
 *
 * À QUOI ÇA SERT
 * - Lire, créer, modifier, supprimer les points (panneaux, AG, blocus, blocages, alertes…).
 * - Les actions « de terrain » ouvertes à tous : changer l'état d'un panneau/blocage,
 *   rattacher un blocage à un blocus, « Toujours là » sur une alerte, signaler un problème,
 *   « je participe », « je fournis ».
 * - L'envoi et la lecture des photos.
 * - Deux tâches de fond : releaseBlocages (fin de blocus) et cleanup (ménage).
 *
 * QUI L'APPELLE
 * - server/index.ts importe `points`, `cleanup` et `releaseBlocages`.
 *   `points` est monté par `api.use(requireDevice, points)` : TOUTES ces routes passent
 *   d'abord par requireDevice (auth.ts), qui remplit `req.device` avec l'appareil connecté
 *   ou répond 401. Les URL réelles sont donc préfixées par /api (ex. GET /api/points).
 * - Avant, index.ts a aussi appliqué express.json (corps JSON → req.body) et csrf
 *   (toute requête non-GET doit avoir l'en-tête X-Terrain: 1).
 * - Côté client, ce sont les appels fetch de l'interface (carte, agenda, fiches de point).
 *
 * NOTIONS À CONNAÎTRE
 * - Route Express : `points.get('/chemin', (req, res) => { ... })`. `req` = la requête
 *   (req.params = morceaux variables de l'URL comme :id, req.body = corps JSON),
 *   `res` = la réponse qu'on renvoie avec res.json(...) / res.status(code).
 * - `return res.status(400).json(...)` : le `return` sert seulement à SORTIR de la fonction
 *   pour ne pas envoyer une deuxième réponse plus bas.
 * - Codes HTTP utilisés : 200 OK (par défaut), 201 créé, 400 données invalides,
 *   403 interdit (pas le droit), 404 introuvable, 429 trop tôt / trop souvent.
 * - Espaces : chaque point appartient à « lfi » (Campagne) ou « mvt » (Mouvement) ;
 *   un appareil ne voit et ne touche QUE les points de ses espaces (hasSpace).
 * - Base SQLite (node:sqlite) : `db.prepare(sql)` prépare une requête, `.get()` renvoie
 *   une ligne (ou undefined), `.all()` toutes les lignes, `.run()` exécute un INSERT/UPDATE/DELETE.
 *   Les `?` sont remplacés par les valeurs passées : c'est ce qui protège des injections SQL.
 * - Les colonnes SQL sont en snake_case (starts_at), l'objet envoyé au client en camelCase
 *   (startsAt) : les fonctions « Dto » (Data Transfer Object) font la traduction.
 * - Dates : partout des nombres = millisecondes depuis 1970 (Date.now()).
 *   60_000 = 1 minute, 3600_000 = 1 heure, 86400_000 = 1 jour (le _ est juste un séparateur lisible).
 * - broadcast (events.ts) : prévient en temps réel (Server-Sent Events) les appareils
 *   connectés d'un espace qu'un point a changé, pour qu'ils rechargent.
 */
// express : le framework HTTP. Router : un « sous-ensemble de routes » qu'on branche ensuite dans index.ts.
import express, { Router } from 'express';
// fs (système de fichiers) et path (construction de chemins) : modules intégrés à Node, pour les photos.
import fs from 'node:fs';
import path from 'node:path';
// zod : bibliothèque de validation. On décrit la forme attendue des données, zod vérifie ce que le client envoie.
import { z } from 'zod';
// db = la connexion SQLite partagée ; UPLOAD_DIR = le dossier où sont rangées les photos (data/uploads).
import { db, UPLOAD_DIR } from './db';
// newId : identifiant aléatoire ; hasSpace : l'appareil a-t-il accès à tel espace ?
// `type DeviceRow` : on n'importe qu'un TYPE (il disparaît à la compilation, aucun code n'est chargé).
import { newId, hasSpace, type DeviceRow } from './auth';
// broadcast : envoie un événement temps réel aux appareils connectés (voir events.ts).
import { broadcast } from './events';
// Le modèle partagé client/serveur (shared/model.ts) : types de points, états possibles, couleurs, règles…
import { TYPES, TYPE_KEYS, STATUSES, BLOCUS_COLORS, CONFIRM_LOCK_MIN, canReportProblem, typeInSpace, SPACE_LABEL, type Participant, type Person, type Point, type PointInput, type PointStatus, type Problem } from '../shared/model';
// occurrences : calcule les dates réelles d'un événement répété (chaque semaine, etc.).
import { occurrences } from '../shared/time';

// Le routeur exporté : index.ts le monte derrière requireDevice (appareil connecté obligatoire).
export const points = Router();

// Forme autorisée d'un nom de photo : 8 à 40 caractères sûrs + extension d'image.
// Sert de garde-fou de sécurité : un nom comme « ../../etc/passwd » ne passe jamais,
// donc impossible de lire ou supprimer un fichier en dehors du dossier des photos.
const PHOTO_RE = /^[A-Za-z0-9_-]{8,40}\.(jpg|png|webp)$/;

// Une ligne de la table `points` telle que SQLite la renvoie (noms de colonnes en snake_case).
// `Point['mode']` : « le type du champ mode de l'interface Point » (évite de recopier 'fixe' | 'event').
// `string | null` : la colonne peut être vide (NULL en SQL).
interface PointRow {
  id: string; mode: Point['mode']; type: Point['type']; title: string; description: string | null;
  lat: number; lng: number; color: string | null; photo: string | null;
  starts_at: number | null; ends_at: number | null; recurrence: Point['recurrence']; recurrence_until: number | null;
  // SQLite n'a pas de vrai booléen : flash et public valent 0 ou 1 (d'où `number`).
  expires_at: number | null; status: Point['status']; status_at: number | null; parent_id: string | null; material: string | null; flash: number; confirmed_at: number | null; space: string; public: number; created_by: string; created_at: number; updated_at: number;
  // Le `?` rend le champ facultatif : il n'existe que si la requête a fait la jointure avec `devices`.
  creator_name?: string | null;
}

// Les engagements d'un événement : qui vient (participants) et, pour chaque élément de matériel,
// qui l'apporte (providers). `Record<string, Person[]>` = un objet { "Banderole": [personnes], ... }.
interface Pledges { participants: Participant[]; providers: Record<string, Person[]> }
// Valeur « aucun engagement » réutilisée partout (elle n'est jamais modifiée, donc on peut la partager).
const NO_PLEDGES: Pledges = { participants: [], providers: {} };

// Lit la table `pledges` (engagements) et les regroupe par point.
// Entrée : un id de point (facultatif). Sans id, on charge les engagements de TOUS les points
// en une seule requête (plus rapide que 1 requête par point quand on renvoie toute la carte).
// Renvoie une Map : id du point → { participants, providers }.
/** Qui participe et qui fournit quoi, par point (appareils retirés exclus). */
function pledgesFor(pointId?: string): Map<string, Pledges> {
  // Jointure avec `devices` pour avoir le nom de la personne. `d.revoked_at IS NULL` : un appareil
  // retiré par un admin disparaît des listes. Le WHERE n'est ajouté que si on a demandé un seul point.
  // ORDER BY pl.created_at : les gens apparaissent dans l'ordre où ils se sont engagés.
  const sql = `SELECT pl.point_id, pl.kind, pl.item, pl.arrive_at, d.id AS device_id, d.name FROM pledges pl
    JOIN devices d ON d.id = pl.device_id AND d.revoked_at IS NULL ${pointId ? 'WHERE pl.point_id = ?' : ''} ORDER BY pl.created_at`;
  // Avec ou sans paramètre selon le cas. `as unknown as {...}[]` : on dit à TypeScript « fais-moi
  // confiance, les lignes ont cette forme » (node:sqlite renvoie un type générique qu'on ne peut pas convertir directement).
  const rows = (pointId ? db.prepare(sql).all(pointId) : db.prepare(sql).all()) as unknown as
    { point_id: string; kind: string; item: string; arrive_at: number | null; device_id: string; name: string }[];
  // Map = dictionnaire clé → valeur, ici id du point → ses engagements.
  const map = new Map<string, Pledges>();
  for (const r of rows) {
    // Premier engagement rencontré pour ce point : on crée son entrée vide.
    if (!map.has(r.point_id)) map.set(r.point_id, { participants: [], providers: {} });
    // Le `!` final dit à TypeScript « ce n'est pas undefined » (on vient juste de le créer).
    const pl = map.get(r.point_id)!;
    const who = { id: r.device_id, name: r.name };
    // kind = 'participe' → on ajoute la personne aux participants, avec son heure d'arrivée (?? null si absente).
    // Sinon kind = 'fournit' : `??=` crée la liste de cet élément de matériel si elle n'existe pas, puis on y ajoute la personne.
    if (r.kind === 'participe') pl.participants.push({ ...who, arriveAt: r.arrive_at ?? null });
    else (pl.providers[r.item] ??= []).push(who);
  }
  return map;
}

// Convertit une ligne SQL en objet `Point` pour le client (snake_case → camelCase).
// Entrées : la ligne, ses problèmes en cours et ses engagements (valeurs par défaut s'ils ne sont pas fournis).
// La syntaxe `=> ({ ... })` : fonction fléchée qui renvoie directement un objet (les parenthèses évitent
// que les accolades soient prises pour le corps de la fonction).
const toDto = (r: PointRow, problems: Problem[] = [], pledges: Pledges = NO_PLEDGES): Point => ({
  // `r.space as Point['space']` : en base c'est un texte quelconque, on affirme que c'est 'lfi' ou 'mvt'.
  id: r.id, space: r.space as Point['space'], mode: r.mode, type: r.type, title: r.title, description: r.description,
  lat: r.lat, lng: r.lng, color: r.color, photo: r.photo,
  startsAt: r.starts_at, endsAt: r.ends_at, recurrence: r.recurrence, recurrenceUntil: r.recurrence_until,
  // `?? null` : si la valeur est undefined (pas de jointure), on met null.
  expiresAt: r.expires_at, status: r.status, createdBy: r.created_by, creatorName: r.creator_name ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
  // `!!x` transforme 0/1 en false/true. parseMaterial décode la liste de matériel stockée en JSON.
  statusAt: r.status_at ?? null, parentId: r.parent_id ?? null, material: parseMaterial(r.material), flash: !!r.flash, isPublic: !!r.public, confirmedAt: r.confirmed_at ?? null,
  problems,
  participants: pledges.participants,
  providers: pledges.providers,
});

// Le matériel est stocké en base comme du texte JSON : '["Banderole","Eau"]'.
// Cette fonction le relit de façon tolérante : texte vide, JSON cassé ou mauvais contenu → liste vide,
// jamais d'erreur (une donnée abîmée ne doit pas faire planter toute la carte).
function parseMaterial(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // filter garde seulement les chaînes de caractères, au cas où le JSON contiendrait autre chose.
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

// Requête de base : tous les champs du point (p.*) + le nom de son auteur·rice.
// LEFT JOIN (et pas JOIN) : on garde le point même si l'appareil auteur n'existe plus (creator_name sera NULL).
const SELECT = 'SELECT p.*, d.name AS creator_name FROM points p LEFT JOIN devices d ON d.id = p.created_by';
// Un point par son id, SANS vérification de droits (usage interne uniquement).
const getPoint = (id: string) => db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as PointRow | undefined;

// SÉCURITÉ, à utiliser dans toutes les routes : renvoie le point seulement si l'appareil a accès à son espace.
// Si ce n'est pas le cas, on fait « comme s'il n'existait pas » (404) plutôt que de répondre 403 :
// ainsi un appareil de l'autre espace ne peut même pas savoir qu'un point avec cet id existe.
/** Le point, seulement s'il appartient à un espace de l'appareil (sinon : comme s'il n'existait pas). */
function pointFor(req: express.Request, id: string): PointRow | undefined {
  const row = getPoint(id);
  // `req.device!` : rempli par requireDevice avant d'arriver ici, d'où le `!` (jamais undefined).
  return row && hasSpace(req.device!, row.space) ? row : undefined;
}

// ---------- Problèmes signalés sur un point ----------

// Une ligne de la table `problems` (un problème signalé sur un blocage : « Barricade enlevée »…).
interface ProblemRow {
  id: string; point_id: string; message: string; created_by: string; created_at: number; expires_at: number;
  confirmed_at: number | null; creator_name: string | null;
}
// Même principe que toDto : ligne SQL → objet `Problem` pour le client.
const problemDto = (r: ProblemRow): Problem => ({
  id: r.id, pointId: r.point_id, message: r.message, createdBy: r.created_by, creatorName: r.creator_name,
  createdAt: r.created_at, expiresAt: r.expires_at, confirmedAt: r.confirmed_at ?? null,
});

// RÈGLE MÉTIER « Toujours là » : après un signalement ou une confirmation, on attend 15 min
// (CONFIRM_LOCK_MIN, dans shared/model.ts) avant de pouvoir prolonger à nouveau. Sinon dix personnes
// qui appuient en même temps prolongeraient une alerte de dix fois 30 min.
// Entrées : date de création et date de la dernière confirmation (ou null).
// Sortie : null si on peut prolonger, sinon le message expliquant pourquoi on ne peut pas.
/** Message d'attente si « Toujours là » a déjà été utilisé il y a moins de 15 min (sinon null). */
function confirmLocked(createdAt: number, confirmedAt: number | null): string | null {
  // Point de départ = la plus récente des deux dates ; on y ajoute 15 min ; on retire maintenant.
  // Si le résultat est positif, il reste encore du temps à attendre.
  const wait = Math.max(createdAt, confirmedAt ?? 0) + CONFIRM_LOCK_MIN * 60_000 - Date.now();
  if (wait <= 0) return null;
  // Message différent selon que quelqu'un a déjà confirmé ou que c'est juste un signalement tout neuf.
  return confirmedAt
    ? 'Doucement : quelqu\'un vient déjà de confirmer que c\'est toujours là. Rien n\'a été rajouté.'
    : 'Doucement : ça vient d\'être signalé, pas besoin de prolonger tout de suite. Rien n\'a été rajouté.';
}
// Problèmes « en cours » = pas réglés (resolved_at IS NULL) ET pas expirés (expires_at > maintenant).
// Le `?` sera remplacé par Date.now() au moment de l'exécution. Jointure pour le nom de l'auteur·rice.
const PROBLEM_SELECT = `SELECT pr.*, d.name AS creator_name FROM problems pr LEFT JOIN devices d ON d.id = pr.created_by
  WHERE pr.resolved_at IS NULL AND pr.expires_at > ?`;

// Problèmes en cours, regroupés par point (même logique que pledgesFor : un seul point ou tous d'un coup).
function activeProblems(pointId?: string): Map<string, Problem[]> {
  // On complète la requête de base : filtre sur un point si demandé, puis tri du plus ancien au plus récent.
  const rows = (pointId
    ? db.prepare(`${PROBLEM_SELECT} AND pr.point_id = ? ORDER BY pr.created_at`).all(Date.now(), pointId)
    : db.prepare(`${PROBLEM_SELECT} ORDER BY pr.created_at`).all(Date.now())) as unknown as ProblemRow[];
  const map = new Map<string, Problem[]>();
  for (const r of rows) {
    if (!map.has(r.point_id)) map.set(r.point_id, []);
    map.get(r.point_id)!.push(problemDto(r));
  }
  return map;
}

// Utilisé à la fin de presque chaque route : on relit le point à jour en base et on le renvoie au client,
// qui remplace ainsi sa copie locale. Renvoie null si le point n'existe plus.
/** Un point complet (avec ses problèmes en cours), prêt à renvoyer. */
function pointDto(id: string): Point | null {
  const row = getPoint(id);
  // `.get(id)` sur les Map peut renvoyer undefined : on remplace par [] pour les problèmes ;
  // pour les engagements, toDto utilisera sa valeur par défaut NO_PLEDGES.
  return row ? toDto(row, activeProblems(id).get(id) ?? [], pledgesFor(id).get(id)) : null;
}

// Schéma zod de ce que le client envoie pour créer ou modifier un point.
// Tout ce qui ne respecte pas ce schéma est refusé avec une erreur 400, AVANT de toucher à la base.
// Ne jamais faire confiance au client : n'importe qui peut envoyer une requête à la main.
const inputSchema = z.object({
  mode: z.enum(['fixe', 'event']),
  // z.enum(TYPE_KEYS) : seulement un des types connus ('panneau', 'ag', ...).
  type: z.enum(TYPE_KEYS),
  // trim() enlève les espaces autour ; min(1, message) : le message est celui affiché à l'utilisateur.
  title: z.string().trim().min(1, 'Donne un titre au point').max(80),
  // nullish() = la valeur peut être absente (undefined) ou null.
  description: z.string().trim().max(2000).nullish(),
  // Latitude entre -90 et 90, longitude entre -180 et 180 : des coordonnées GPS valides.
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  // Couleur au format #RRGGBB uniquement (empêche d'injecter du texte bizarre dans le style de la carte).
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  // Nom d'une photo déjà envoyée via POST /photos (même règle de sécurité que PHOTO_RE).
  photo: z.string().regex(PHOTO_RE).nullish(),
  // Dates en millisecondes : nombres entiers.
  startsAt: z.number().int().nullish(),
  endsAt: z.number().int().nullish(),
  // .default('none') : si le client n'envoie rien, zod met 'none' (pas de répétition).
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
  recurrenceUntil: z.number().int().nullish(),
  // Durée de vie d'une alerte, entre 5 min et 24 h.
  durationMinutes: z.number().int().min(5).max(24 * 60).optional(),
  // Tous les états existants ; on vérifie plus loin (validStatus) que l'état convient AU TYPE du point.
  status: z.enum(['a_coller', 'colle', 'abime', 'tenu', 'vide', 'leve']).nullish(),
  // Pour un blocage : l'id du blocus auquel il appartient. max(40) : un id raisonnable, pas un roman.
  parentId: z.string().max(40).nullish(),
  // Liste de matériel : 20 éléments maximum, chacun de 1 à 40 caractères.
  material: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  // Flash : événement improvisé qui commence bientôt (notification à tout le monde).
  flash: z.boolean().optional(),
  // Espace demandé à la création ('lfi' par défaut). Ignoré en modification : un point ne change pas d'espace.
  space: z.enum(['lfi', 'mvt']).optional(),
  // Demande d'annonce publique (n'a d'effet que pour une AG côté Mouvement, voir normalize).
  isPublic: z.boolean().optional(),
});

// `status is PointStatus` est un « prédicat de type » : si la fonction renvoie true, TypeScript
// sait ensuite que `status` est bien un PointStatus (et plus un `unknown`).
// STATUSES[type] n'existe que pour panneau et blocage ; `?.` évite une erreur pour les autres types,
// et `!!` transforme le résultat (true/false/undefined) en vrai booléen.
/** L'état demandé est-il valable pour ce type de point ? */
const validStatus = (type: Point['type'], status: unknown): status is PointStatus =>
  !!STATUSES[type]?.includes(status as PointStatus);

// RÈGLE MÉTIER blocus / blocages : un blocus est un événement (une journée de blocage d'une fac…),
// un blocage est une barricade fixe qui peut lui être rattachée ; elle prend alors sa couleur,
// et passe à « sans personne » à la fin du blocus (voir releaseBlocages).
// Renvoie { id } (l'id du blocus, ou null si pas de rattachement) ou bien un TEXTE d'erreur.
// Ce motif « objet si OK, string si erreur » est utilisé dans tout le fichier : on teste avec typeof x === 'string'.
/** Le blocus auquel rattacher un blocage, ou un message d'erreur. */
function blocusFor(parentId: string | null | undefined, space = 'mvt'): { id: string | null } | string {
  if (!parentId) return { id: null };
  const parent = getPoint(parentId);
  // Le parent doit exister, être un blocus ET être dans le même espace : sinon on pourrait rattacher
  // un blocage à un point d'un espace auquel on n'a pas accès.
  if (!parent || parent.type !== 'blocus' || parent.space !== space) return 'Ce blocus n\'existe plus.';
  return { id: parent.id };
}

// Le type des données « prêtes à écrire en base » : une PointRow SANS les champs que le serveur gère
// lui-même (id, auteur, dates de création…). `Omit<T, 'a' | 'b'>` = le type T moins ces champs.
type Normalized = Omit<PointRow, 'id' | 'created_by' | 'created_at' | 'updated_at' | 'creator_name' | 'status_at' | 'confirmed_at' | 'space'>;

// Le cœur des règles métier. Entrées :
//  - input : les données déjà validées par zod ;
//  - existing : le point actuel en cas de modification (undefined en création) ;
//  - space : l'espace du point ; par défaut celui du point existant, sinon 'lfi'.
//    (Une valeur par défaut peut utiliser un paramètre précédent : `existing?.space`.)
// Sortie : les colonnes à écrire, ou un message d'erreur (string).
/** Valide et normalise les règles métier (horaires, expiration, alertes). */
function normalize(input: PointInput, existing?: PointRow, space: string = existing?.space ?? 'lfi'): Normalized | string {
  // Les caractéristiques du type (libellé, modes autorisés, est-ce une alerte ?) depuis shared/model.ts.
  const meta = TYPES[input.type];
  const now = Date.now();
  // Une alerte (warning, danger, police) est toujours un « événement » limité dans le temps, quoi que dise le client.
  const mode = meta.alert ? 'event' : input.mode;
  // Chaque type n'accepte que certains modes (ex. un panneau est forcément fixe, une AG forcément un événement).
  if (!meta.modes.includes(mode)) return `Le type « ${meta.label} » n'est pas disponible en ${mode === 'fixe' ? 'point fixe' : 'événement'}.`;

  // Les champs communs à tous les cas. `x || null` : une chaîne vide '' devient null (champ vide en base).
  const base = {
    mode, type: input.type, title: input.title, description: input.description || null,
    lat: input.lat, lng: input.lng, color: input.color || null, photo: input.photo || null,
    // `null as string | null` : sans ça TypeScript croirait que ce champ vaut TOUJOURS null.
    parent_id: null as string | null,
    material: null as string | null,
    flash: 0,
    // (public = 1 seulement si : type AG, espace Mouvement, et case cochée. Dans tous les autres cas 0.)
    // Seule une AG côté Mouvement peut être annoncée publiquement.
    public: input.type === 'ag' && space === 'mvt' && input.isPublic ? 1 : 0,
  };

  // --- Cas 1 : alerte. ---
  if (meta.alert) {
    // Alertes (warning, danger, police) : durée de vie courte à partir de maintenant (ou on garde l'existante).
    // On garde les dates d'origine si on modifie une alerte sans changer son type ni demander de nouvelle durée
    // (corriger une faute de frappe ne doit pas relancer le compte à rebours).
    const keep = existing && existing.type === input.type && input.durationMinutes == null;
    // Le `!` affirme que ces dates existent (une alerte en a toujours).
    const startsAt = keep ? existing.starts_at! : now;
    // Sinon : expire dans `durationMinutes` minutes (30 par défaut). * 60_000 convertit minutes → millisecondes.
    const expiresAt = keep ? existing.expires_at! : now + (input.durationMinutes ?? 30) * 60_000;
    // `...base` recopie tous les champs communs, puis on ajoute ceux propres aux alertes (jamais répétées, sans état).
    return { ...base, starts_at: startsAt, ends_at: expiresAt, recurrence: 'none', recurrence_until: null, expires_at: expiresAt, status: null };
  }

  // --- Cas 2 : point fixe (panneau, blocage, local…). Pas de dates, n'expire jamais. ---
  if (mode === 'fixe') {
    // La liste des états possibles pour ce type (undefined si le type n'a pas d'état).
    const statuses = STATUSES[input.type];
    let parentId: string | null = null;
    // Seul un blocage peut avoir un parent (son blocus).
    if (input.type === 'blocage') {
      const b = blocusFor(input.parentId, space);
      // Si blocusFor a renvoyé un texte, c'est une erreur : on la remonte telle quelle.
      if (typeof b === 'string') return b;
      parentId = b.id;
    }
    return {
      ...base, parent_id: parentId, starts_at: null, ends_at: null, recurrence: 'none', recurrence_until: null, expires_at: null,
      // État : celui demandé s'il est valable pour ce type, sinon le premier de la liste (ex. 'a_coller', 'tenu') ;
      // null pour les types sans état.
      status: statuses ? (validStatus(input.type, input.status) ? input.status : statuses[0]) : null,
    };
  }

  // --- Cas 3 : événement (AG, tractage, blocus…). Il lui faut un début et une fin. ---
  if (input.startsAt == null || input.endsAt == null) return 'Indique la date et la plage horaire de l\'événement.';
  if (input.endsAt <= input.startsAt) return 'L\'heure de fin doit être après l\'heure de début.';
  // 7 * 86400000 = 7 jours en millisecondes.
  if (input.endsAt - input.startsAt > 7 * 86400000) return 'Un événement ne peut pas durer plus de 7 jours.';
  const flash = input.flash ? 1 : 0;
  // Un flash est improvisé : il ne se répète jamais.
  const recurrence = flash ? 'none' : input.recurrence ?? 'none';
  // La date de fin de répétition n'a de sens que s'il y a une répétition.
  const until = recurrence === 'none' ? null : input.recurrenceUntil ?? null;
  if (until != null && until < input.startsAt) return 'La date de fin de répétition est avant le premier événement.';
  // new Set(...) supprime les doublons, puis [...] le reconvertit en tableau.
  const material = [...new Set(input.material ?? [])];
  return {
    // Matériel stocké en JSON (ou NULL si la liste est vide).
    ...base, flash, material: material.length ? JSON.stringify(material) : null,
    starts_at: input.startsAt, ends_at: input.endsAt, recurrence, recurrence_until: until,
    // expires_at = quand le point quitte la carte : à la fin pour un événement unique, à la fin de la
    // répétition sinon. Une répétition sans date de fin donne null = n'expire jamais.
    expires_at: recurrence === 'none' ? input.endsAt : until,
    status: null,
  };
}

// DROITS de modification : un admin, mais seulement dans un espace auquel il a accès,
// OU l'auteur·rice du point. (Les autres actions « de terrain » plus bas sont ouvertes à tous.)
const canEdit = (me: DeviceRow, row: PointRow) => (me.role === 'admin' && hasSpace(me, row.space)) || row.created_by === me.id;

// GET /points : la carte entière. Renvoie tous les points des espaces de l'appareil.
// Les points de l'autre espace sont retirés par le filter, ils ne quittent jamais le serveur.
points.get('/points', (req, res) => {
  const rows = (db.prepare(`${SELECT} ORDER BY p.created_at`).all() as unknown as PointRow[])
    .filter((r) => hasSpace(req.device!, r.space));
  // Problèmes et engagements de tous les points chargés en 2 requêtes au total (pas une par point).
  const problems = activeProblems();
  const pledges = pledgesFor();
  // Pour chaque ligne : ses problèmes (ou []) et ses engagements (ou la valeur par défaut).
  res.json({ points: rows.map((r) => toDto(r, problems.get(r.id) ?? [], pledges.get(r.id))) });
});

// POST /points : créer un point. Corps = PointInput (JSON). Réponse 201 + le point créé.
points.post('/points', (req, res) => {
  // safeParse ne lance pas d'exception : il renvoie { success: true, data } ou { success: false, error }.
  const parsed = inputSchema.safeParse(req.body);
  // 400 avec le premier message d'erreur trouvé par zod (ex. « Donne un titre au point »).
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Données invalides' });
  const space = parsed.data.space ?? 'lfi';
  // 403 : on n'a pas le droit de créer dans un espace dont on n'est pas membre.
  if (!hasSpace(req.device!, space)) return res.status(403).json({ error: 'Tu n\'as pas accès à cet espace.' });
  // Certains types n'existent que d'un côté (ex. panneau seulement en Campagne, blocus seulement en Mouvement).
  if (!typeInSpace(parsed.data.type, space)) return res.status(400).json({ error: `Ce type de point n'existe pas côté ${SPACE_LABEL[space]}.` });
  // On applique les règles métier ; un texte renvoyé = une erreur à afficher.
  const n = normalize(parsed.data, undefined, space);
  if (typeof n === 'string') return res.status(400).json({ error: n });
  const id = newId();
  const now = Date.now();
  // Nouveau blocus sans couleur choisie : on lui en attribue une automatiquement.
  if (n.type === 'blocus' && !n.color) {
    // Une couleur différente pour chaque blocus en cours : ses blocages la reprennent sur la carte.
    // Couleurs déjà prises par les blocus en cours de cet espace. COALESCE(color, ?) : un blocus sans couleur
    // a en fait la couleur par défaut du type. « En cours » = pas d'expiration ou expiration dans le futur.
    const used = new Set((db.prepare(`SELECT COALESCE(color, ?) AS c FROM points
      WHERE type = 'blocus' AND space = ? AND (expires_at IS NULL OR expires_at > ?)`).all(TYPES.blocus.color, space, now) as { c: string }[]).map((r) => r.c));
    // La première couleur libre de la palette ; si toutes sont prises, on reboucle (modulo %) sur la palette.
    const free = BLOCUS_COLORS.find((c) => !used.has(c)) ?? BLOCUS_COLORS[used.size % BLOCUS_COLORS.length];
    // On stocke null plutôt que la couleur par défaut (le client l'appliquera tout seul).
    n.color = free === TYPES.blocus.color ? null : free;
  }
  // Insertion : 24 colonnes, 24 `?`, 24 valeurs dans le même ordre. Les valeurs ne sont jamais collées
  // dans le texte SQL : SQLite les reçoit à part (aucune injection possible).
  db.prepare(`INSERT INTO points (id, mode, type, title, description, lat, lng, color, photo, starts_at, ends_at,
              recurrence, recurrence_until, expires_at, status, status_at, parent_id, material, flash, space, public, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    // status_at (date du dernier changement d'état) = maintenant si le point a un état, sinon null.
    // created_by = l'appareil connecté ; created_at et updated_at = maintenant.
    .run(id, n.mode, n.type, n.title, n.description, n.lat, n.lng, n.color, n.photo, n.starts_at, n.ends_at,
      n.recurrence, n.recurrence_until, n.expires_at, n.status, n.status ? now : null, n.parent_id, n.material, n.flash, space, n.public, req.device!.id, now, now);
  // Prévenir en direct les appareils de cet espace (le client affiche une notification pour un flash, par ex.).
  broadcast('points', { id, by: req.device!.id, action: 'create', type: n.type, title: n.title, flash: !!n.flash, startsAt: n.starts_at }, space);
  // 201 Created + le point complet relu en base. Le `!` : on vient de l'insérer, il existe forcément.
  res.status(201).json({ point: pointDto(id)! });
});

// PUT /points/:id : modifier un point existant (remplace tous ses champs).
points.put('/points/:id', (req, res) => {
  const row = pointFor(req, req.params.id);
  // 404 si le point n'existe pas OU s'il est dans un espace qui n'est pas le nôtre (voir pointFor).
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  // 403 : le point existe et on le voit, mais on n'a pas le droit de le modifier.
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut modifier ce point.' });
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Données invalides' });
  // Le nouveau type doit exister dans l'espace du point. `as never` : contournement de typage
  // (row.space est un string, typeInSpace attend un Space) — c'est une affirmation, pas une vérification.
  if (!typeInSpace(parsed.data.type, row.space as never)) return res.status(400).json({ error: 'Ce type de point n\'existe pas dans cet espace.' });
  // Pas de 3e argument : l'espace est celui du point existant ; `space` envoyé par le client est ignoré.
  const n = normalize(parsed.data, row);
  if (typeof n === 'string') return res.status(400).json({ error: n });
  const now = Date.now();
  // Date du dernier changement d'état : inchangée si l'état n'a pas bougé, maintenant s'il a changé,
  // null si le point n'a plus d'état. (Ternaire imbriqué : a ? b : c ? d : e.)
  const statusAt = n.status === row.status ? row.status_at : n.status ? now : null;
  // On réécrit tous les champs modifiables. space, created_by et created_at ne bougent jamais.
  db.prepare(`UPDATE points SET mode=?, type=?, title=?, description=?, lat=?, lng=?, color=?, photo=?, starts_at=?, ends_at=?,
              recurrence=?, recurrence_until=?, expires_at=?, status=?, status_at=?, parent_id=?, material=?, flash=?, public=?, updated_at=? WHERE id=?`)
    .run(n.mode, n.type, n.title, n.description, n.lat, n.lng, n.color, n.photo, n.starts_at, n.ends_at,
      n.recurrence, n.recurrence_until, n.expires_at, n.status, statusAt, n.parent_id, n.material, n.flash, n.public, now, row.id);
  // Matériel retiré de la liste : les « je fournis » correspondants n'ont plus lieu d'être.
  const kept = new Set(parseMaterial(n.material));
  // Pour chaque élément actuellement « fourni » par quelqu'un, on supprime les engagements
  // si l'élément n'est plus dans la nouvelle liste de matériel.
  for (const r of db.prepare("SELECT DISTINCT item FROM pledges WHERE point_id = ? AND kind = 'fournit'").all(row.id) as { item: string }[]) {
    if (!kept.has(r.item)) db.prepare("DELETE FROM pledges WHERE point_id = ? AND kind = 'fournit' AND item = ?").run(row.id, r.item);
  }
  // Plus un événement (devenu fixe) ou devenu une alerte : participations et fournitures n'ont plus de sens.
  if (n.mode !== 'event' || TYPES[n.type].alert) db.prepare('DELETE FROM pledges WHERE point_id = ?').run(row.id);
  // Un blocus transformé en autre chose : ses blocages ne lui sont plus rattachés.
  if (row.type === 'blocus' && n.type !== 'blocus') db.prepare('UPDATE points SET parent_id = NULL WHERE parent_id = ?').run(row.id);
  // Les dates du blocus ont pu changer (fin avancée…) : on vérifie tout de suite s'il faut libérer ses blocages.
  if (row.type === 'blocus') releaseBlocages();
  // Photo remplacée ou retirée : on supprime l'ancien fichier du disque.
  if (row.photo && row.photo !== n.photo) removePhoto(row.photo);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' }, row.space);
  res.json({ point: pointDto(row.id)! });
});

// PATCH /points/:id/status : changer seulement l'état. PATCH = modification partielle (contrairement à PUT).
// Pas de canEdit ici : c'est voulu, n'importe quel membre de l'espace peut le faire depuis le terrain.
/** État d'un panneau ou d'un blocage : tout le monde peut le mettre à jour sur le terrain. */
points.patch('/points/:id/status', (req, res) => {
  const row = pointFor(req, req.params.id);
  // Le point doit avoir des états possibles (panneau ou blocage), sinon 404.
  if (!row || !STATUSES[row.type]) return res.status(404).json({ error: 'Point introuvable' });
  // `req.body?.status` : `?.` évite une erreur si le corps est vide.
  if (!validStatus(row.type, req.body?.status)) return res.status(400).json({ error: 'État invalide' });
  const now = Date.now();
  // On met à jour l'état et sa date (status_at sert à releaseBlocages pour savoir QUAND il a été marqué « tenu »).
  db.prepare('UPDATE points SET status = ?, status_at = ?, updated_at = ? WHERE id = ?').run(req.body.status, now, now, row.id);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' }, row.space);
  res.json({ point: pointDto(row.id)! });
});

// PATCH /points/:id/parent : corps { parentId } (ou null pour détacher).
/** Rattacher un blocage à un blocus (ou le détacher) : tout le monde peut le faire sur le terrain. */
points.patch('/points/:id/parent', (req, res) => {
  const row = pointFor(req, req.params.id);
  // Seuls les blocages ont un parent.
  if (!row || row.type !== 'blocage') return res.status(404).json({ error: 'Blocage introuvable' });
  // Le blocus doit exister et être dans le même espace que le blocage.
  const b = blocusFor(req.body?.parentId ?? null, row.space);
  if (typeof b === 'string') return res.status(400).json({ error: b });
  db.prepare('UPDATE points SET parent_id = ?, updated_at = ? WHERE id = ?').run(b.id, Date.now(), row.id);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' }, row.space);
  res.json({ point: pointDto(row.id)! });
});

// POST /points/:id/extend-flash : corps { minutes } (5 à 240). Ajoute du temps à la fin d'un flash.
/** Prolonger un flash : son auteur·rice (ou un admin) ajoute du temps, tant qu'il n'est pas terminé. */
points.post('/points/:id/extend-flash', (req, res) => {
  // Un schéma zod peut valider une seule valeur, pas forcément un objet.
  const minutes = z.number().int().min(5).max(240).safeParse(req.body?.minutes);
  if (!minutes.success) return res.status(400).json({ error: 'Durée invalide' });
  const row = pointFor(req, req.params.id);
  // Doit être un flash, avec une heure de fin.
  if (!row || !row.flash || row.ends_at == null) return res.status(404).json({ error: 'Flash introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice du flash ou un admin peut le prolonger.' });
  const now = Date.now();
  // On ne ressuscite pas un flash déjà fini.
  if (row.ends_at <= now) return res.status(400).json({ error: 'Ce flash est déjà terminé.' });
  // Nouvelle fin = ancienne fin + minutes demandées.
  const end = row.ends_at + minutes.data * 60_000;
  // Garde-fou : un flash ne dure jamais plus de 24 h depuis son début.
  if (end - (row.starts_at ?? now) > 24 * 3600_000) return res.status(400).json({ error: 'Un flash ne peut pas durer plus de 24 h.' });
  // ends_at ET expires_at : l'événement dure plus longtemps et reste plus longtemps sur la carte.
  db.prepare('UPDATE points SET ends_at = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(end, end, now, row.id);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' }, row.space);
  res.json({ point: pointDto(row.id)! });
});

// POST /points/:id/extend : le bouton « Toujours là » sur une alerte (warning, danger, police).
// Ouvert à tous, mais limité à une fois par tranche de 15 min (confirmLocked).
/** Prolonger une alerte : tout le monde peut confirmer qu'elle est toujours d'actualité. */
points.post('/points/:id/extend', (req, res) => {
  const minutes = z.number().int().min(5).max(240).safeParse(req.body?.minutes);
  if (!minutes.success) return res.status(400).json({ error: 'Durée invalide' });
  const row = pointFor(req, req.params.id);
  // Seules les alertes se prolongent ainsi.
  if (!row || !TYPES[row.type].alert) return res.status(404).json({ error: 'Alerte introuvable' });
  const locked = confirmLocked(row.created_at, row.confirmed_at);
  // 429 « Too Many Requests » : la requête est correcte mais arrive trop tôt.
  if (locked) return res.status(429).json({ error: locked });
  const now = Date.now();
  // Si l'alerte a déjà expiré, on repart de maintenant ; sinon on ajoute à la fin prévue.
  const exp = Math.max(row.expires_at ?? 0, now) + minutes.data * 60_000;
  // confirmed_at = maintenant : relance le délai de 15 min avant la prochaine confirmation.
  db.prepare('UPDATE points SET expires_at = ?, ends_at = ?, confirmed_at = ?, updated_at = ? WHERE id = ?').run(exp, exp, now, now, row.id);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' }, row.space);
  res.json({ point: pointDto(row.id)! });
});

// POST /points/:id/finish : « Terminer maintenant » un événement (pas une alerte).
/** Terminer un événement maintenant (auteur·rice ou admin) : il quitte la carte mais reste dans l'agenda. */
points.post('/points/:id/finish', (req, res) => {
  const row = pointFor(req, req.params.id);
  if (!row || row.mode !== 'event' || TYPES[row.type].alert) return res.status(404).json({ error: 'Événement introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut terminer cet événement.' });
  const now = Date.now();
  // Pour un événement répété, on coupe la répétition à partir de maintenant et on le retire de la carte (expires_at).
  if (row.recurrence !== 'none') {
    // Événement répété : on arrête la répétition après l'occurrence en cours.
    db.prepare('UPDATE points SET recurrence_until = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(now, now, now, row.id);
  } else {
    // Événement unique : la fin devient maintenant. Le début est ramené au plus tard 1 min avant,
    // pour que la fin soit toujours après le début (sinon l'événement serait incohérent dans l'agenda).
    const start = Math.min(row.starts_at ?? now, now - 60_000);
    db.prepare('UPDATE points SET starts_at = ?, ends_at = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(start, now, now, now, row.id);
  }
  // Les problèmes encore ouverts sur ce point sont marqués réglés par la personne qui termine.
  db.prepare('UPDATE problems SET resolved_at = ?, resolved_by = ? WHERE point_id = ? AND resolved_at IS NULL').run(now, req.device!.id, row.id);
  // Un blocus terminé : ses blocages « tenus » passent à « sans personne ».
  if (row.type === 'blocus') releaseBlocages();
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' }, row.space);
  res.json({ point: pointDto(row.id)! });
});

// POST /points/:id/participate : corps { on: true/false, arriveAt? }. Chacun ne gère que sa propre participation
// (on utilise toujours req.device.id, jamais un id envoyé par le client).
/**
 * « Je participe » / « je ne participe plus » : chacun pour soi.
 * `arriveAt` (blocus) : heure d'arrivée prévue si on ne vient pas dès le RDV ; null = au RDV.
 */
points.post('/points/:id/participate', (req, res) => {
  // z.object(...) défini sur place : la forme attendue pour cette seule route.
  const body = z.object({ on: z.boolean(), arriveAt: z.number().int().nullish() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Requête invalide' });
  const row = pointFor(req, req.params.id);
  // Seuls les vrais événements (pas les points fixes ni les alertes) acceptent des participants.
  if (!row || row.mode !== 'event' || TYPES[row.type].alert) return res.status(404).json({ error: 'Événement introuvable' });
  const arriveAt = body.data.arriveAt ?? null;
  // Heure d'arrivée plausible : pas plus d'un jour dans le passé, pas plus de 400 jours dans le futur.
  if (arriveAt != null && (arriveAt < Date.now() - 86400_000 || arriveAt > Date.now() + 400 * 86400_000)) {
    return res.status(400).json({ error: 'Heure d\'arrivée invalide' });
  }
  // « UPSERT » : on insère l'engagement ; s'il existe déjà (même clé primaire point/appareil/kind/item),
  // ON CONFLICT ... DO UPDATE met simplement à jour l'heure d'arrivée. `excluded` = la ligne qu'on tentait d'insérer.
  if (body.data.on) {
    db.prepare(`INSERT INTO pledges (point_id, device_id, kind, item, arrive_at, created_at) VALUES (?, ?, 'participe', '', ?, ?)
                ON CONFLICT (point_id, device_id, kind, item) DO UPDATE SET arrive_at = excluded.arrive_at`)
      .run(row.id, req.device!.id, arriveAt, Date.now());
  // on = false : on retire sa participation.
  } else db.prepare("DELETE FROM pledges WHERE point_id = ? AND device_id = ? AND kind = 'participe'").run(row.id, req.device!.id);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' }, row.space);
  res.json({ point: pointDto(row.id)! });
});

// POST /points/:id/provide : corps { item, on }. Je fournis (ou plus) un élément du matériel.
/** « Je fournis » un élément du matériel (sans forcément venir). */
points.post('/points/:id/provide', (req, res) => {
  const body = z.object({ item: z.string().trim().min(1).max(40), on: z.boolean() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Requête invalide' });
  const row = pointFor(req, req.params.id);
  if (!row || row.mode !== 'event' || TYPES[row.type].alert) return res.status(404).json({ error: 'Événement introuvable' });
  // On ne peut s'engager que sur un élément de la liste définie par l'organisateur·rice.
  if (!parseMaterial(row.material).includes(body.data.item)) return res.status(400).json({ error: 'Ce matériel n\'est pas dans la liste.' });
  // INSERT OR IGNORE : si l'engagement existe déjà (clé primaire), on ne fait rien au lieu d'échouer.
  if (body.data.on) db.prepare("INSERT OR IGNORE INTO pledges (point_id, device_id, kind, item, created_at) VALUES (?, ?, 'fournit', ?, ?)").run(row.id, req.device!.id, body.data.item, Date.now());
  else db.prepare("DELETE FROM pledges WHERE point_id = ? AND device_id = ? AND kind = 'fournit' AND item = ?").run(row.id, req.device!.id, body.data.item);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' }, row.space);
  res.json({ point: pointDto(row.id)! });
});

// POST /points/:id/problems : corps { message, durationMinutes }. Signaler un problème sur un blocage
// (« Barricade enlevée », « Manque de monde »…) sans créer d'alerte séparée sur la carte.
/** Signaler un problème sur un point : tout le monde peut le faire. */
points.post('/points/:id/problems', (req, res) => {
  const body = z.object({
    message: z.string().trim().min(1, 'Décris le problème').max(200),
    durationMinutes: z.number().int().min(5).max(24 * 60),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });
  const row = pointFor(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  // Sur une alerte, on ne signale pas un problème : on la prolonge.
  if (TYPES[row.type].alert) return res.status(400).json({ error: 'C\'est déjà une alerte : prolonge-la plutôt.' });
  // Règle métier (shared/model.ts) : seul un blocage, lieu « tenu » par des gens, peut avoir des problèmes.
  if (!canReportProblem(row.type)) return res.status(400).json({ error: 'On ne signale un problème que sur un blocage.' });
  const now = Date.now();
  // Le problème expire tout seul après la durée choisie (il disparaît de activeProblems).
  db.prepare('INSERT INTO problems (id, point_id, message, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId(), row.id, body.data.message, req.device!.id, now, now + body.data.durationMinutes * 60_000);
  // action 'problem' : le client peut afficher une notification spécifique avec le titre du point.
  broadcast('points', { id: row.id, by: req.device!.id, action: 'problem', title: row.title }, row.space);
  res.status(201).json({ point: pointDto(row.id)! });
});

// POST /problems/:id/resolve : marquer un problème comme réglé.
/** Problème réglé : tout le monde peut le lever. */
points.post('/problems/:id/resolve', (req, res) => {
  // On cherche le problème encore ouvert.
  const pr = db.prepare('SELECT point_id FROM problems WHERE id = ? AND resolved_at IS NULL').get(req.params.id) as { point_id: string } | undefined;
  // `pr && ...` : si pr est undefined, owner vaut undefined sans appeler pointFor.
  // pointFor vérifie que le point du problème est dans un de nos espaces (sécurité).
  const owner = pr && pointFor(req, pr.point_id);
  if (!pr || !owner) return res.status(404).json({ error: 'Problème introuvable ou déjà réglé' });
  db.prepare('UPDATE problems SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(Date.now(), req.device!.id, req.params.id);
  broadcast('points', { id: pr.point_id, by: req.device!.id, action: 'update' }, owner.space);
  res.json({ point: pointDto(pr.point_id)! });
});

// POST /problems/:id/extend : « Toujours là » sur un problème (même règle des 15 min que les alertes).
/** Problème toujours d'actualité : on prolonge. */
points.post('/problems/:id/extend', (req, res) => {
  const minutes = z.number().int().min(5).max(240).safeParse(req.body?.minutes);
  if (!minutes.success) return res.status(400).json({ error: 'Durée invalide' });
  const pr = db.prepare('SELECT point_id, expires_at, created_at, confirmed_at FROM problems WHERE id = ? AND resolved_at IS NULL').get(req.params.id) as
    { point_id: string; expires_at: number; created_at: number; confirmed_at: number | null } | undefined;
  const owner = pr && pointFor(req, pr.point_id);
  if (!pr || !owner) return res.status(404).json({ error: 'Problème introuvable ou déjà réglé' });
  const locked = confirmLocked(pr.created_at, pr.confirmed_at);
  if (locked) return res.status(429).json({ error: locked });
  const now = Date.now();
  // Si le problème a déjà expiré, on repart de maintenant ; sinon on ajoute à la fin prévue.
  const exp = Math.max(pr.expires_at, now) + minutes.data * 60_000;
  db.prepare('UPDATE problems SET expires_at = ?, confirmed_at = ? WHERE id = ?').run(exp, now, req.params.id);
  broadcast('points', { id: pr.point_id, by: req.device!.id, action: 'update' }, owner.space);
  res.json({ point: pointDto(pr.point_id)! });
});

// DELETE /points/:id : supprimer un point (auteur·rice ou admin).
points.delete('/points/:id', (req, res) => {
  const row = pointFor(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut supprimer ce point.' });
  // Grâce à PRAGMA foreign_keys = ON (db.ts) et aux « ON DELETE CASCADE », les problèmes, engagements
  // et votes liés à ce point sont supprimés automatiquement par SQLite.
  db.prepare('DELETE FROM points WHERE id = ?').run(row.id);
  // Si c'était un blocus, ses blocages restent sur la carte mais ne lui sont plus rattachés.
  db.prepare('UPDATE points SET parent_id = NULL WHERE parent_id = ?').run(row.id);
  if (row.photo) removePhoto(row.photo);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'delete' }, row.space);
  res.json({ ok: true });
});

// ---------- Photos ----------

// Reconnaît le format d'une image en lisant ses premiers octets (« nombres magiques »), au lieu de
// croire l'extension ou l'en-tête Content-Type envoyés par le client (qui peuvent mentir).
function sniff(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  // Moins de 12 octets : trop court pour être une vraie image.
  if (buf.length < 12) return null;
  // JPEG commence toujours par FF D8 FF (notation hexadécimale).
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // PNG commence par la signature fixe 89 50 4E 47 0D 0A 1A 0A (« .PNG » + caractères de contrôle).
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  // WebP : « RIFF » aux octets 0-3, puis « WEBP » aux octets 8-11.
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Supprime une photo du disque. On revérifie le nom avec PHOTO_RE : impossible de supprimer
// autre chose qu'une photo, même si un nom piégé arrivait jusqu'ici.
function removePhoto(name: string) {
  if (!PHOTO_RE.test(name)) return;
  // fs.rm asynchrone ; force: true = pas d'erreur si le fichier n'existe déjà plus ; le callback vide ignore les erreurs.
  fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
}

// POST /photos : envoi d'une photo (étape 1 ; l'étape 2 est de mettre son nom dans un point).
// express.raw(...) : middleware propre à cette route, qui lit le corps BRUT (les octets de l'image)
// au lieu de JSON, uniquement pour ces types d'image, et refuse au-delà de 8 Mo.
points.post('/photos', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }), (req, res) => {
  // `as Buffer` : affirmation de type ; on vérifie juste après que c'est vrai.
  const buf = req.body as Buffer;
  // Si le Content-Type n'était pas une image, express.raw n'a rien lu et req.body n'est pas un Buffer.
  if (!Buffer.isBuffer(buf)) return res.status(400).json({ error: 'Envoie une image JPEG, PNG ou WebP.' });
  // On vérifie le contenu réel du fichier.
  const ext = sniff(buf);
  if (!ext) return res.status(400).json({ error: 'Ce fichier n\'est pas une image valide.' });
  // Nom aléatoire généré par le serveur : on n'utilise jamais le nom choisi par le client.
  const name = `${newId()}.${ext}`;
  // Écriture synchrone sur le disque (bloque le serveur le temps de l'écriture, acceptable pour quelques Mo).
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  // Le client reçoit le nom, qu'il renverra dans le champ `photo` du point.
  res.status(201).json({ photo: name });
});

// GET /photos/:name : afficher une photo.
points.get('/photos/:name', (req, res) => {
  // Nom invalide → 404 sans rien lire sur le disque.
  if (!PHOTO_RE.test(req.params.name)) return res.status(404).end();
  // À quel point (et donc quel espace) appartient cette photo ?
  const of = db.prepare('SELECT space FROM points WHERE photo = ?').get(req.params.name) as { space: string } | undefined;
  // Photo d'un point de l'autre espace : 404, comme si elle n'existait pas.
  // (Une photo pas encore rattachée à un point n'a pas d'espace : elle reste visible par tout appareil connecté.)
  if (of && !hasSpace(req.device!, of.space)) return res.status(404).end();
  // Le navigateur peut la garder en cache 7 jours (604800 s) : un nom de photo ne change jamais de contenu (immutable).
  // private : seulement le cache du navigateur, pas les caches partagés (proxies).
  res.set('Cache-Control', 'private, max-age=604800, immutable');
  // sendFile envoie le fichier ; en cas d'erreur (fichier absent), on répond 404 si rien n'est encore parti.
  res.sendFile(path.join(UPLOAD_DIR, req.params.name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------- Fin des blocus ----------

// Appelée par index.ts toutes les 60 secondes (setInterval), et aussi juste après la modification
// ou la fin d'un blocus pour que l'effet soit immédiat.
/**
 * Quand un blocus se termine (fin prévue ou « Terminer maintenant »), ses blocages encore « tenus »
 * passent à « sans personne » : la barricade reste sur la carte, mais plus personne ne la tient.
 * Un blocage marqué « tenu » après la fin du blocus n'est pas touché.
 */
export function releaseBlocages() {
  const now = Date.now();
  // Tous les blocages « tenus » rattachés à un blocus : les seuls candidats à la libération.
  const rows = db.prepare(`SELECT id, status_at, parent_id FROM points
    WHERE type = 'blocage' AND status = 'tenu' AND parent_id IS NOT NULL`).all() as unknown as { id: string; status_at: number | null; parent_id: string }[];
  // Petit cache : plusieurs blocages ont souvent le même blocus, on ne le relit qu'une fois.
  const parents = new Map<string, Point | null>();
  // Les ids des blocages à passer à « sans personne ».
  const released: string[] = [];
  for (const r of rows) {
    if (!parents.has(r.parent_id)) {
      const p = getPoint(r.parent_id);
      // toDto(p) : on a besoin d'un objet Point (camelCase) pour la fonction occurrences.
      parents.set(r.parent_id, p ? toDto(p) : null);
    }
    const parent = parents.get(r.parent_id);
    // Blocus supprimé entre-temps : rien à faire.
    if (!parent) continue;
    // Depuis quand le blocage est « tenu » (0 si on ne sait pas).
    const since = r.status_at ?? 0;
    // Une fin compte seulement si elle a eu lieu APRÈS que le blocage a été marqué « tenu » et avant maintenant.
    // C'est ce qui permet de remarquer « tenu » un blocage après la fin du blocus sans qu'il soit relâché aussitôt.
    const ended = (t: number | null) => t != null && t > since && t <= now;
    // Fin d'une occurrence, ou blocus arrêté plus tôt (« Terminer maintenant » sur un blocus répété).
    // .some(...) : vrai si au moins une occurrence s'est terminée dans cet intervalle.
    if (ended(parent.expiresAt) || occurrences(parent, since, now).some((o) => ended(o.end))) released.push(r.id);
  }
  // Rien à libérer : on s'arrête (et on ne prévient personne).
  if (!released.length) return;
  // Requête préparée une seule fois puis exécutée pour chaque blocage.
  const upd = db.prepare("UPDATE points SET status = 'vide', status_at = ?, updated_at = ? WHERE id = ?");
  for (const id of released) upd.run(now, now, id);
  // Un seul événement suffit à faire recharger la carte côté client ; les blocages sont toujours côté Mouvement.
  broadcast('points', { id: released[0], action: 'update' }, 'mvt');
}

// ---------- Ménage périodique ----------

// Ménage, appelé par index.ts au démarrage puis toutes les heures.
export function cleanup() {
  const now = Date.now();
  // Alertes expirées depuis plus de 6 h.
  // Construit la liste SQL des types d'alerte : "'warning','danger','police'". On colle ici du texte dans le SQL,
  // ce qui est sans danger seulement parce que ces valeurs viennent de nos constantes, jamais du client.
  const alertTypes = TYPE_KEYS.filter((t) => TYPES[t].alert).map((t) => `'${t}'`).join(',');
  // On lit d'abord les photos des alertes à supprimer, pour pouvoir effacer leurs fichiers ensuite.
  const old = db.prepare(`SELECT photo FROM points WHERE type IN (${alertTypes}) AND expires_at < ?`).all(now - 6 * 3600_000) as { photo: string | null }[];
  db.prepare(`DELETE FROM points WHERE type IN (${alertTypes}) AND expires_at < ?`).run(now - 6 * 3600_000);
  // `r.photo && removePhoto(...)` : n'appelle removePhoto que si la photo existe.
  old.forEach((r) => r.photo && removePhoto(r.photo));
  // Photos envoyées mais jamais rattachées à un point.
  // Toutes les photos encore utilisées par un point.
  const used = new Set((db.prepare('SELECT photo FROM points WHERE photo IS NOT NULL').all() as { photo: string }[]).map((r) => r.photo));
  // readdirSync : liste les fichiers du dossier des photos.
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (used.has(f)) continue;
    // statSync : infos du fichier ; mtimeMs = date de dernière modification. Plus de 24 h et inutilisée → supprimée
    // (le délai laisse le temps de créer le point après avoir envoyé la photo).
    const st = fs.statSync(path.join(UPLOAD_DIR, f));
    if (now - st.mtimeMs > 24 * 3600_000) removePhoto(f);
  }
  // Problèmes réglés ou expirés depuis plus d'un jour.
  // COALESCE prend la première valeur non NULL : la date de résolution si réglé, sinon la date d'expiration.
  db.prepare('DELETE FROM problems WHERE COALESCE(resolved_at, expires_at) < ?').run(now - 86400_000);
  // Invitations mortes depuis une semaine.
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(now - 7 * 86400_000);
}
