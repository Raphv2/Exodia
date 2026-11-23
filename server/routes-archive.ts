/*
 * routes-archive.ts — API HTTP de l'« Archive » du côté Mouvement.
 *
 * Qui l'appelle ? server/index.ts monte deux routeurs exportés ici :
 * - `archive` sous /api, derrière requireDevice : réservé aux appareils connectés (puis requireMvt ici) ;
 * - `publicArchive` sous /api/public : accessible SANS compte (archive publique, AG annoncées, fichiers).
 * index.ts appelle aussi cleanupArchive() au démarrage puis toutes les heures.
 * Côté navigateur, les appels viennent de web/src/api.ts (archive, uploadArchiveFile, publicArchive…).
 *
 * Notions à connaître :
 * - Envoi de fichier en deux temps : 1) POST /archive/files envoie les octets bruts et reçoit un nom de
 *   fichier généré ; 2) POST /archive crée l'élément d'archive qui référence ce nom. Les fichiers envoyés
 *   mais jamais rattachés sont effacés après 24 h par cleanupArchive().
 * - « Sniffing » : on détermine le type d'un fichier en lisant ses premiers octets (les « nombres
 *   magiques »), jamais en croyant son nom ou le type annoncé par le navigateur, qui sont falsifiables.
 * - DTO (« objet de transfert ») : la forme JSON envoyée au client, distincte de la ligne SQL brute.
 * - Requêtes préparées (db.prepare + ?) : les valeurs sont passées à part, ce qui empêche l'injection SQL.
 */
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, UPLOAD_DIR } from './db';
import { hasSpace, newId, optionalDevice, type DeviceRow } from './auth';
// Registre des fichiers envoyés : un fichier n'est rattachable que par qui l'a envoyé, et une seule fois.
import { registerUpload, uploaderOf, forgetUpload, claimError, uniqueFileIndex } from './uploads';
// Retire les métadonnées des images (EXIF) et, au mieux, des PDF (auteur, logiciel…).
import { sanitize } from './sanitize';
import { broadcast } from './events';
import type { ArchiveItem, PublicAg, RegistryEntry } from '../shared/model';

/*
 * Archive (côté Mouvement) :
 * - des documents ajoutés à la main (photo, PDF, copie de mail, note), datés, privés ou publics ;
 * - un registre automatique : les événements passés et les votes clos (jamais les blocages ni les alertes).
 * Sans compte, on ne voit que les documents publics et les AG annoncées publiquement.
 */

// L'archive n'existe que dans l'espace « Mouvement ».
const SPACE = 'mvt';
// Dossier des fichiers d'archive : un sous-dossier du dossier d'envois, séparé des photos des points.
const ARCHIVE_DIR = path.join(UPLOAD_DIR, 'archive');
// Création du dossier au démarrage s'il n'existe pas (recursive : pas d'erreur s'il existe déjà).
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

/*
 * Table des éléments d'archive (créée si absente).
 * - kind : nature affichée (document, image, copie de mail, note) — les CHECK refusent toute autre valeur ;
 * - date : date du document lui-même (choisie par l'utilisateur), en millisecondes ;
 * - body : texte libre (note, copie de mail) ; file : nom du fichier stocké sur disque ;
 *   file_name : nom d'origine (pour le téléchargement) ; file_type : extension détectée ;
 * - visibility : 'private' (membres Mouvement) ou 'public' (tout le monde, sans compte) ;
 * - created_by : identifiant de l'appareil qui a déposé l'élément.
 * Index sur date : la liste est toujours triée par date.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS archive_items (
    id          TEXT PRIMARY KEY,
    space       TEXT NOT NULL DEFAULT 'mvt',
    kind        TEXT NOT NULL CHECK (kind IN ('document', 'image', 'mail', 'note')),
    title       TEXT NOT NULL,
    date        INTEGER NOT NULL,
    body        TEXT,
    file        TEXT,
    file_name   TEXT,
    file_type   TEXT,
    visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS archive_date ON archive_items(date);
`);
// Un même fichier ne peut appartenir qu'à un seul document (garanti par la base elle-même).
uniqueFileIndex('archive_file_unique', 'archive_items', 'file');

/*
 * Forme exacte d'un nom de fichier stocké : 8 à 40 caractères sûrs + une extension autorisée.
 * Sécurité essentielle : un nom qui passe ce test ne peut contenir ni « / » ni « .. », donc on ne peut
 * pas s'en servir pour lire ou effacer un fichier en dehors de ARCHIVE_DIR (attaque « path traversal »).
 */
const FILE_RE = /^[A-Za-z0-9_-]{8,40}\.(jpg|png|webp|pdf|txt)$/;
// Type MIME (en-tête Content-Type) à renvoyer pour chaque extension autorisée.
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8' };

// Une ligne de la table telle que SQLite la renvoie (+ creator_name, ajouté par la jointure de SELECT plus bas).
interface ItemRow {
  id: string; space: string; kind: ArchiveItem['kind']; title: string; date: number; body: string | null;
  file: string | null; file_name: string | null; file_type: string | null; visibility: 'private' | 'public';
  created_by: string; created_at: number; updated_at: number; creator_name?: string | null;
}

/*
 * Ligne SQL -> objet JSON pour le client.
 * withAuthor = false pour le public : on n'expose JAMAIS qui a déposé un document (protection des militant·es).
 */
const itemDto = (r: ItemRow, withAuthor: boolean): ArchiveItem => ({
  id: r.id, kind: r.kind, title: r.title, date: r.date, body: r.body, file: r.file, fileName: r.file_name,
  fileType: r.file_type, visibility: r.visibility, createdBy: withAuthor ? r.created_by : null,
  creatorName: withAuthor ? r.creator_name ?? null : null, createdAt: r.created_at,
});

/** Type réel du fichier, d'après son contenu (jamais d'après le nom ou ce que dit le navigateur). */
/*
 * Entrée : le contenu du fichier. Sortie : l'extension à utiliser, ou null si le type est refusé.
 * Chaque format commence par une signature fixe (« nombre magique ») qu'on compare octet par octet.
 */
function sniff(buf: Buffer): 'jpg' | 'png' | 'webp' | 'pdf' | 'txt' | null {
  // Trop court pour être un fichier utile.
  if (buf.length < 5) return null;
  // JPEG : commence par FF D8 FF.
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // PNG : signature de 8 octets « \x89PNG\r\n\x1a\n ».
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  // WebP : « RIFF » (octets 0-3), taille (4-7), puis « WEBP » (8-11).
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // PDF : commence par « %PDF- ».
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  // Texte (copie de mail .eml, .txt) : de l'UTF-8 valide, sans octet nul.
  if (!buf.includes(0)) {
    // Si des octets ne sont pas de l'UTF-8 valide, Node les remplace par le caractère « � » (U+FFFD) :
    // sa présence signale donc un fichier binaire (ou dans un autre encodage), qu'on refuse.
    const text = buf.toString('utf8');
    if (!text.includes('�')) return 'txt';
  }
  return null;
}

/*
 * Efface un fichier d'archive du disque, sans attendre ni signaler d'erreur (force : pas d'erreur s'il n'existe pas).
 * Le test FILE_RE empêche d'effacer autre chose qu'un fichier d'archive, même si le nom venait d'ailleurs.
 */
const removeFile = (name: string | null) => {
  if (!name || !FILE_RE.test(name) || fileUsed(name)) return;
  forgetUpload(name);
  fs.rm(path.join(ARCHIVE_DIR, name), { force: true }, () => {});
};

/** Ce fichier est-il déjà rattaché à un document ? */
const fileUsed = (name: string) => !!db.prepare('SELECT 1 FROM archive_items WHERE file = ?').get(name);

/** Appareil connecté (facultatif) : pour les routes accessibles aussi sans compte. */
/*
 * Les routes publiques ne passent pas par requireDevice. Pour savoir si le visiteur est quand même un
 * appareil connecté (et peut voir un fichier privé), on relit ici le cookie de session « terrain_sid »,
 * on le hache en SHA-256 (le serveur ne stocke que l'empreinte du jeton, jamais le jeton) et on cherche
 * l'appareil non révoqué correspondant. Sortie : l'appareil, ou undefined si visiteur anonyme.
 */
// (optionalDevice vient désormais d'auth.ts : une seule lecture de cookie pour tout le serveur.)

// Début de requête commun : chaque élément + le nom de l'appareil auteur (LEFT JOIN : null s'il a disparu).
const SELECT = 'SELECT a.*, d.name AS creator_name FROM archive_items a LEFT JOIN devices d ON d.id = a.created_by';

/** Registre automatique : événements passés (sans blocages ni alertes) et votes clos. */
/*
 * Construit, à chaque demande, la liste « ce qui s'est passé » à partir des autres tables :
 * - les événements terminés (points en mode 'event' dont la fin est passée), en excluant les types
 *   sensibles (alertes, police, blocages) : règle métier, on ne garde pas de trace de ces actions ;
 * - les votes clos des AG, avec le nombre de voix par option.
 * 500 éléments maximum de chaque sorte. Sortie : tableau de RegistryEntry (voir shared/model.ts).
 */
function registry(): RegistryEntry[] {
  const now = Date.now();
  const events = db.prepare(`SELECT id, type, title, starts_at, ends_at FROM points
    WHERE space = ? AND mode = 'event' AND type NOT IN ('warning', 'danger', 'police', 'blocage') AND ends_at IS NOT NULL AND ends_at < ?
    ORDER BY starts_at DESC LIMIT 500`).all(SPACE, now) as { id: string; type: string; title: string; starts_at: number; ends_at: number }[];
  // Votes clos, avec le titre de l'AG (le point) à laquelle ils sont rattachés.
  const votes = db.prepare(`SELECT v.id, v.question, v.options, v.closed_at, p.title AS ag FROM votes v JOIN points p ON p.id = v.point_id
    WHERE p.space = ? AND v.status = 'closed' ORDER BY v.closed_at DESC LIMIT 500`).all(SPACE) as { id: string; question: string; options: string; closed_at: number; ag: string }[];
  /*
   * Résultats d'un vote : un tableau de n compteurs (un par option), rempli à partir des bulletins
   * regroupés par choix. Le test « r.choice < n » ignore un éventuel numéro de choix hors limites.
   */
  // Tous les décomptes en UNE requête (avant : une requête par vote). Clé : id du vote.
  const tally = new Map<string, { choice: number; c: number }[]>();
  for (const r of db.prepare(`SELECT b.vote_id, b.choice, COUNT(*) AS c FROM ballots b JOIN votes v ON v.id = b.vote_id
    JOIN points p ON p.id = v.point_id WHERE p.space = ? AND v.status = 'closed' GROUP BY b.vote_id, b.choice`).all(SPACE) as { vote_id: string; choice: number; c: number }[]) {
    tally.set(r.vote_id, [...(tally.get(r.vote_id) ?? []), r]);
  }
  const countsOf = (id: string, n: number) => {
    const out = Array.from({ length: n }, () => 0);
    for (const r of tally.get(id) ?? []) if (r.choice >= 0 && r.choice < n) out[r.choice] = r.c;
    return out;
  };
  // Options stockées en JSON : une valeur corrompue ne doit pas faire planter tout le registre.
  const parseOptions = (s: string): string[] => {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  };
  // Les deux listes mises bout à bout (« ... » = décomposition), chacune convertie au format partagé.
  return [
    ...events.map((e): RegistryEntry => ({ kind: 'event', id: e.id, date: e.starts_at, end: e.ends_at, title: e.title, type: e.type })),
    ...votes.map((v): RegistryEntry => {
      // Les options sont stockées en texte JSON (ex. '["Pour","Contre"]').
      const options = parseOptions(v.options);
      return { kind: 'vote', id: v.id, date: v.closed_at, title: v.question, ag: v.ag, options, counts: countsOf(v.id, options.length) };
    }),
  ];
}

// ====================================================================================
// App (appareil connecté, avec accès au côté Mouvement)
// ====================================================================================

export const archive = Router();

// Garde : l'appareil connecté doit avoir accès à l'espace Mouvement (sinon 403).
const requireMvt: express.RequestHandler = (req, res, next) => {
  if (!hasSpace(req.device!, SPACE)) return res.status(403).json({ error: 'L\'archive est réservée au côté Mouvement.' });
  next();
};
// Règle métier : on ne modifie / supprime que ce qu'on a déposé soi-même, sauf si on est admin.
const canEdit = (me: DeviceRow, r: ItemRow) => r.created_by === me.id || me.role === 'admin';

/*
 * GET /api/archive — tous les éléments (privés et publics) avec leur auteur, plus le registre automatique.
 * Le « as unknown as ItemRow[] » force le type : node:sqlite renvoie des objets génériques.
 */
archive.get('/archive', requireMvt, (_req, res) => {
  const rows = db.prepare(`${SELECT} WHERE a.space = ? ORDER BY a.date DESC`).all(SPACE) as unknown as ItemRow[];
  res.json({ items: rows.map((r) => itemDto(r, true)), registry: registry() });
});

/** Envoi d'un fichier (avant de créer l'élément d'archive). */
/*
 * POST /api/archive/files — corps : les octets bruts du fichier (pas de JSON, pas de formulaire).
 * express.raw lit tout le corps dans un Buffer, quel que soit le Content-Type annoncé (type: () => true),
 * dans la limite de 15 Mo (au-delà, Express répond 413). Réponse : 201 { file, fileType }.
 */
archive.post('/archive/files', requireMvt, express.raw({ type: () => true, limit: '15mb' }), (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Fichier vide.' });
  // Le type est déduit du contenu ; tout ce qui n'est pas reconnu est refusé.
  const ext = sniff(buf);
  if (!ext) return res.status(400).json({ error: 'Type de fichier non accepté : image (JPEG, PNG, WebP), PDF ou texte (.txt, .eml).' });
  // Nom généré par le serveur (aléatoire, imprévisible) : le nom d'origine n'est jamais utilisé sur le disque.
  const name = `${newId()}.${ext}`;
  // Écriture synchrone : simple, mais bloque le serveur le temps d'écrire (jusqu'à 15 Mo).
  fs.writeFileSync(path.join(ARCHIVE_DIR, name), sanitize(buf, ext));
  // On retient que CET appareil a envoyé ce fichier : lui seul pourra le rattacher à un document.
  registerUpload(name, 'archive', req.device!.id);
  res.status(201).json({ file: name, fileType: ext });
});

/*
 * Schéma de validation (zod) d'un nouvel élément : types, longueurs max, valeurs permises.
 * trim() retire les espaces autour ; nullish() = champ facultatif (absent, null ou undefined).
 * file doit avoir exactement la forme d'un nom généré (FILE_RE).
 */
const itemSchema = z.object({
  kind: z.enum(['document', 'image', 'mail', 'note']),
  title: z.string().trim().min(1, 'Donne un titre').max(120),
  // Date du document : pas avant 1900, pas plus d'un an dans le futur (fautes de frappe).
  date: z.number().int().min(-2_208_988_800_000).max(Date.now() + 365 * 86400_000),
  body: z.string().trim().max(50_000).nullish(),
  file: z.string().regex(FILE_RE).nullish(),
  fileName: z.string().trim().max(160).nullish(),
  visibility: z.enum(['private', 'public']),
});

/*
 * POST /api/archive — crée un élément (2e temps de l'envoi). Corps : voir itemSchema.
 * Réponse : 201 { item }. Prévient les autres appareils Mouvement en temps réel.
 */
archive.post('/archive', requireMvt, (req, res) => {
  const b = itemSchema.safeParse(req.body);
  // On renvoie le premier message d'erreur de zod (ex. « Donne un titre »).
  if (!b.success) return res.status(400).json({ error: b.error.issues[0]?.message ?? 'Données invalides' });
  // Un élément vide n'a pas de sens : il faut au moins un texte ou un fichier.
  if (!b.data.body && !b.data.file) return res.status(400).json({ error: 'Ajoute un fichier ou un texte.' });
  // Le fichier annoncé doit avoir réellement été reçu (1er temps) et ne pas avoir été nettoyé depuis.
  if (b.data.file) {
    // Le fichier doit exister, avoir été envoyé par CET appareil, et n'appartenir à aucun autre document.
    // Avant, on pouvait reprendre le fichier d'un autre (et rendre public un document privé).
    if (!fs.existsSync(path.join(ARCHIVE_DIR, b.data.file))) return res.status(400).json({ error: 'Le fichier n\'a pas été reçu, réessaie.' });
    const err = claimError(b.data.file, 'archive', req.device!.id, fileUsed(b.data.file));
    if (err) return res.status(400).json({ error: err });
    // « Image » seulement pour une vraie image : le type annoncé doit correspondre au contenu.
    const isImage = /\.(jpg|png|webp)$/.test(b.data.file);
    if (b.data.kind === 'image' && !isImage) return res.status(400).json({ error: 'Ce fichier n\'est pas une image : choisis « Document ».' });
  }
  const id = newId();
  const now = Date.now();
  // Type de fichier = extension du nom généré (fiable, puisque fixée par sniff()).
  const ext = b.data.file?.split('.').pop() ?? null;
  // « || null » transforme les chaînes vides en NULL dans la base.
  db.prepare(`INSERT INTO archive_items (id, space, kind, title, date, body, file, file_name, file_type, visibility, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, SPACE, b.data.kind, b.data.title, b.data.date, b.data.body || null, b.data.file || null, b.data.fileName || null, ext, b.data.visibility, req.device!.id, now, now);
  broadcast('archive', { id, by: req.device!.id }, SPACE);
  // On relit la ligne insérée (avec le nom de l'auteur) pour renvoyer exactement ce qui est en base.
  res.status(201).json({ item: itemDto(db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as unknown as ItemRow, true) });
});

/** Changer la visibilité ou le titre (auteur·rice ou admin). */
/*
 * PATCH /api/archive/:id — corps : { visibility?, title? } (les deux facultatifs).
 * COALESCE(?, colonne) : si la valeur envoyée est NULL (champ absent), on garde l'ancienne.
 */
archive.patch('/archive/:id', requireMvt, (req, res) => {
  const b = z.object({ visibility: z.enum(['private', 'public']).optional(), title: z.string().trim().min(1).max(120).optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: 'Données invalides' });
  // Le filtre sur l'espace évite d'agir sur un élément d'un autre espace.
  const row = db.prepare(`${SELECT} WHERE a.id = ? AND a.space = ?`).get(req.params.id, SPACE) as ItemRow | undefined;
  if (!row) return res.status(404).json({ error: 'Document introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut le modifier.' });
  db.prepare('UPDATE archive_items SET visibility = COALESCE(?, visibility), title = COALESCE(?, title), updated_at = ? WHERE id = ?')
    .run(b.data.visibility ?? null, b.data.title ?? null, Date.now(), row.id);
  broadcast('archive', { id: row.id, by: req.device!.id }, SPACE);
  res.json({ item: itemDto(db.prepare(`${SELECT} WHERE a.id = ?`).get(row.id) as unknown as ItemRow, true) });
});

/*
 * DELETE /api/archive/:id — supprime l'élément (auteur·rice ou admin), puis son fichier sur le disque.
 * Suppression définitive : pas de corbeille.
 */
archive.delete('/archive/:id', requireMvt, (req, res) => {
  const row = db.prepare(`${SELECT} WHERE a.id = ? AND a.space = ?`).get(req.params.id, SPACE) as ItemRow | undefined;
  if (!row) return res.status(404).json({ error: 'Document introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut le supprimer.' });
  db.prepare('DELETE FROM archive_items WHERE id = ?').run(row.id);
  removeFile(row.file);
  broadcast('archive', { id: row.id, by: req.device!.id }, SPACE);
  res.json({ ok: true });
});

// ====================================================================================
// Public (sans compte) : archive publique et AG annoncées
// ====================================================================================

export const publicArchive = Router();

/** Documents publics uniquement, sans le nom de qui les a déposés. */
// GET /api/public/archive — itemDto(r, false) masque l'auteur ; le registre n'est pas exposé au public.
publicArchive.get('/archive', (_req, res) => {
  const rows = db.prepare(`${SELECT} WHERE a.space = ? AND a.visibility = 'public' ORDER BY a.date DESC`).all(SPACE) as unknown as ItemRow[];
  res.json({ items: rows.map((r) => itemDto(r, false)) });
});

/** AG annoncées publiquement et pas encore terminées. */
/*
 * GET /api/public/ags — uniquement les points de type 'ag' marqués public = 1, dont la fin est à venir.
 * On choisit explicitement les colonnes renvoyées (pas de SELECT *) pour ne rien divulguer d'autre
 * (auteur, notes internes…).
 */
publicArchive.get('/ags', (_req, res) => {
  const rows = db.prepare(`SELECT id, title, description, lat, lng, starts_at, ends_at FROM points
    WHERE space = ? AND type = 'ag' AND public = 1 AND ends_at IS NOT NULL AND ends_at > ? ORDER BY starts_at`)
    .all(SPACE, Date.now()) as { id: string; title: string; description: string | null; lat: number; lng: number; starts_at: number; ends_at: number }[];
  const ags: PublicAg[] = rows.map((r) => ({ id: r.id, title: r.title, description: r.description, lat: r.lat, lng: r.lng, startsAt: r.starts_at, endsAt: r.ends_at }));
  res.json({ ags });
});

/**
 * Fichier d'archive : public pour tous, privé seulement pour les appareils du côté Mouvement.
 * Les fichiers non-images sont téléchargés (jamais affichés comme une page) pour éviter tout contenu piégé.
 */
/*
 * GET /api/public/archive/files/:name
 * Pour un fichier privé demandé par quelqu'un sans droit, on répond 404 (et non 403) : on ne confirme
 * même pas que le fichier existe.
 */
publicArchive.get('/archive/files/:name', (req, res) => {
  const name = req.params.name;
  // Premier rempart : le nom doit avoir la forme exacte d'un nom généré (pas de « ../ »).
  if (!FILE_RE.test(name)) return res.status(404).end();
  // Le fichier doit être rattaché à un élément d'archive (un fichier orphelin n'est jamais servi).
  const row = db.prepare('SELECT visibility, file_name FROM archive_items WHERE file = ?').get(name) as { visibility: string; file_name: string | null } | undefined;
  // Fichier pas encore rattaché à un document : seul l'appareil qui l'a envoyé peut le voir (aperçu).
  if (!row) {
    const d = optionalDevice(req);
    if (!d || uploaderOf(name, 'archive') !== d.id) return res.status(404).end();
    return res.set('Cache-Control', 'private, no-store').sendFile(path.join(ARCHIVE_DIR, name), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  }
  if (row.visibility !== 'public') {
    const d = optionalDevice(req);
    if (!d || !hasSpace(d, SPACE)) return res.status(404).end();
  }
  // Extension du nom (validée par FILE_RE, donc forcément une clé de MIME).
  const ext = name.split('.').pop()!;
  const image = ['jpg', 'png', 'webp'].includes(ext);
  // Nom proposé au téléchargement : on remplace tout caractère inhabituel par « _ » (notamment les
  // guillemets et retours à la ligne, qui casseraient l'en-tête HTTP), et on limite à 120 caractères.
  // Nom de téléchargement : version ASCII de secours (accents retirés) pour les vieux navigateurs,
  // et version complète encodée (filename*, norme RFC 5987) qui garde les accents.
  const original = (row.file_name || `document.${ext}`).slice(0, 120);
  const asciiName = original.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w .()-]/g, '_');
  /*
   * En-têtes de réponse :
   * - Content-Type : fixé par NOUS d'après l'extension sniffée (et nosniff, posé dans index.ts,
   *   interdit au navigateur d'en deviner un autre) ;
   * - Cache-Control : « public » autorise les caches intermédiaires, « private » seulement le navigateur ;
   * - Content-Disposition : images affichées (inline), le reste forcé en téléchargement (attachment) ;
   * - Content-Security-Policy avec « sandbox » : même ouvert directement, le fichier ne peut exécuter
   *   aucun script ni charger quoi que ce soit (défense en profondeur contre un PDF/texte piégé).
   */
  res.set({
    'Content-Type': MIME[ext],
    // no-cache : le navigateur (et tout cache intermédiaire) doit revérifier à chaque fois. Ainsi un
    // document repassé en privé n'est plus servi depuis un cache. Pour un public, un cache partagé
    // peut le garder mais doit lui aussi revérifier.
    'Cache-Control': row.visibility === 'public' ? 'public, no-cache' : 'private, no-cache',
    'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(original)}`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  // Envoi du fichier ; s'il a disparu du disque entre-temps, on répond 404 (si rien n'est encore parti).
  res.sendFile(path.join(ARCHIVE_DIR, name), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

/** Fichiers envoyés mais jamais rattachés à un document (abandon en cours de route), après 24 h. */
/*
 * Appelée par index.ts au démarrage et toutes les heures. Parcourt le dossier et efface les fichiers
 * qui ne sont référencés par aucun élément ET dont la dernière modification date de plus de 24 h.
 * Le délai laisse le temps à quelqu'un de finir de remplir le formulaire après l'envoi du fichier.
 */
export function cleanupArchive() {
  // Ensemble (Set) des noms de fichiers utilisés : recherche instantanée avec .has().
  const used = new Set((db.prepare('SELECT file FROM archive_items WHERE file IS NOT NULL').all() as { file: string }[]).map((r) => r.file));
  const now = Date.now();
  for (const f of fs.readdirSync(ARCHIVE_DIR)) {
    // On ne touche ni aux fichiers utilisés, ni à ce qui n'a pas la forme d'un fichier d'archive.
    if (used.has(f) || !FILE_RE.test(f)) continue;
    try {
      if (now - fs.statSync(path.join(ARCHIVE_DIR, f)).mtimeMs > 24 * 3600_000) removeFile(f);
    } catch { /* fichier disparu entre-temps */ }
  }
}
