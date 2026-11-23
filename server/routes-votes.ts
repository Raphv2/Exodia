import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from './db';
import { hasSpace, newId, rateLimit, sha256, type DeviceRow } from './auth';
import { broadcast } from './events';
import { VOTE_RADII, DEFAULT_VOTE_RADIUS, type Vote, type VoteResult } from '../shared/model';

/*
 * Votes en AG, façon Kahoot :
 * - l'organisateur·rice d'une AG (ou un admin de l'espace) lance un vote : une question, des choix ;
 * - l'app génère un code à 5 chiffres, unique tant que le vote est ouvert ;
 * - n'importe qui, même sans l'app, tape le code et vote… seulement s'il est à moins de 50 m de l'AG ;
 * - un seul vote par appareil (appareil de l'app, ou cookie « votant » pour les autres).
 * Limite assumée : une position GPS peut être falsifiée et une navigation privée donne un nouveau cookie.
 */

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

interface VoteRow {
  id: string; point_id: string; question: string; options: string; code: string; status: 'open' | 'closed';
  radius: number; created_by: string; created_at: number; closed_at: number | null;
}
interface PointLite { id: string; type: string; space: string; title: string; lat: number; lng: number; created_by: string; starts_at: number | null; public: number }

const VOTER_COOKIE = 'terrain_voter';
const MAX_ACCURACY = 100; // au-delà, la position est trop floue pour décider

const getVote = (id: string) => db.prepare('SELECT * FROM votes WHERE id = ?').get(id) as VoteRow | undefined;
const getOpenByCode = (code: string) => db.prepare("SELECT * FROM votes WHERE code = ? AND status = 'open'").get(code) as VoteRow | undefined;
const getPoint = (id: string) => db.prepare('SELECT id, type, space, title, lat, lng, created_by, starts_at, public FROM points WHERE id = ?').get(id) as PointLite | undefined;

function counts(voteId: string, n: number): number[] {
  const out = Array.from({ length: n }, () => 0);
  for (const r of db.prepare('SELECT choice, COUNT(*) AS c FROM ballots WHERE vote_id = ? GROUP BY choice').all(voteId) as { choice: number; c: number }[]) {
    if (r.choice >= 0 && r.choice < n) out[r.choice] = r.c;
  }
  return out;
}

/** Un vote pour l'app. Les résultats détaillés : à l'organisation pendant le vote, à tout le monde une fois clos. */
function voteDto(v: VoteRow, opts: { full: boolean; voterKey?: string }): Vote {
  const options = JSON.parse(v.options) as string[];
  const c = counts(v.id, options.length);
  const total = c.reduce((a, b) => a + b, 0);
  const showResults = opts.full || v.status === 'closed';
  const mine = opts.voterKey
    ? (db.prepare('SELECT choice FROM ballots WHERE vote_id = ? AND voter_key = ?').get(v.id, opts.voterKey) as { choice: number } | undefined)?.choice ?? null
    : null;
  return {
    id: v.id, pointId: v.point_id, question: v.question, options, status: v.status, radius: v.radius,
    code: opts.full && v.status === 'open' ? v.code : null,
    total, counts: showResults ? c : null, myChoice: mine, createdAt: v.created_at, closedAt: v.closed_at,
  };
}

/** Distance à vol d'oiseau en mètres. */
function distance(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Position (facultative : seulement pour les votes avec une distance). */
const posSchema = z.object({ lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), accuracy: z.number().min(0).max(100000).optional() });

/**
 * Sur place ? (à moins du rayon, avec une petite marge pour l'imprécision du GPS). Ne révèle jamais la distance exacte.
 * Rayon 0 : peu importe la distance, on ne regarde pas la position. Sans position alors qu'il en faut une : NEED_POSITION.
 */
const NEED_POSITION = 'Ce vote demande ta position : il faut être sur place.';
function presenceError(pos: z.infer<typeof posSchema>, ag: PointLite, radius: number): string | null {
  if (!radius) return null;
  if (pos.lat == null || pos.lng == null) return NEED_POSITION;
  const acc = pos.accuracy ?? MAX_ACCURACY;
  if (acc > MAX_ACCURACY) return 'Ta position est trop imprécise. Active le GPS (localisation précise) et réessaie dehors ou près d\'une fenêtre.';
  if (distance({ lat: pos.lat, lng: pos.lng }, ag) > radius + Math.min(acc, 25)) return `Pour voter, il faut être sur place, à moins de ${radius} m du lieu de l'AG.`;
  return null;
}

/** Clé du votant : l'appareil de l'app s'il est connecté, sinon un cookie « votant » (créé au besoin). */
function voterKey(req: Request, res: Response, device?: DeviceRow): string {
  if (device) return `d:${device.id}`;
  const header = req.headers.cookie ?? '';
  const sid = /(?:^|;\s*)terrain_sid=([^;]+)/.exec(header)?.[1];
  if (sid) {
    const d = db.prepare('SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(decodeURIComponent(sid))) as { id: string } | undefined;
    if (d) return `d:${d.id}`;
  }
  let v = /(?:^|;\s*)terrain_voter=([^;]+)/.exec(header)?.[1];
  if (!v || !/^[A-Za-z0-9_-]{20,80}$/.test(v)) {
    v = crypto.randomBytes(24).toString('base64url');
    res.cookie(VOTER_COOKIE, v, {
      httpOnly: true, sameSite: 'strict', path: '/', maxAge: 400 * 86400 * 1000,
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    });
  }
  return `v:${sha256(v)}`;
}

function newCode(): string {
  for (let i = 0; i < 50; i++) {
    const code = String(crypto.randomInt(0, 100000)).padStart(5, '0');
    if (!getOpenByCode(code)) return code;
  }
  throw new Error('Plus de code disponible');
}

/** Enregistre un bulletin (un seul par votant et par vote). */
function cast(v: VoteRow, ag: PointLite, key: string, choice: number, by?: string): { ok: true } | { error: string; status: number } {
  const options = JSON.parse(v.options) as string[];
  if (v.status !== 'open') return { error: 'Ce vote est clos.', status: 410 };
  if (!Number.isInteger(choice) || choice < 0 || choice >= options.length) return { error: 'Choix invalide.', status: 400 };
  const r = db.prepare('INSERT OR IGNORE INTO ballots (vote_id, voter_key, choice, created_at) VALUES (?, ?, ?, ?)').run(v.id, key, choice, Date.now());
  if (!r.changes) return { error: 'Tu as déjà voté avec cet appareil.', status: 409 };
  broadcast('votes', { id: v.id, pointId: v.point_id, by }, ag.space);
  return { ok: true };
}

// ====================================================================================
// Routes de l'app (appareil connecté)
// ====================================================================================

export const votes = Router();

const canRun = (me: DeviceRow, ag: PointLite) => hasSpace(me, ag.space) && (ag.created_by === me.id || me.role === 'admin');

/** Les votes d'une AG. */
votes.get('/points/:id/votes', (req, res) => {
  const ag = getPoint(req.params.id);
  if (!ag || !hasSpace(req.device!, ag.space)) return res.status(404).json({ error: 'AG introuvable' });
  const full = canRun(req.device!, ag);
  const rows = db.prepare('SELECT * FROM votes WHERE point_id = ? ORDER BY created_at DESC').all(ag.id) as unknown as VoteRow[];
  res.json({ votes: rows.map((v) => voteDto(v, { full, voterKey: `d:${req.device!.id}` })), canRun: full });
});

/** Lancer un vote sur une AG (organisateur·rice ou admin de l'espace). */
votes.post('/points/:id/votes', (req, res) => {
  const body = z.object({
    question: z.string().trim().min(1, 'Écris la question').max(200),
    options: z.array(z.string().trim().min(1).max(60)).min(2, 'Il faut au moins 2 choix').max(8),
    // Distance autour de l'AG pour pouvoir voter : seulement les valeurs proposées.
    radius: z.number().int().refine((r) => (VOTE_RADII as readonly number[]).includes(r), 'Distance invalide').optional(),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });
  const ag = getPoint(req.params.id);
  if (!ag || !hasSpace(req.device!, ag.space) || ag.type !== 'ag') return res.status(404).json({ error: 'AG introuvable' });
  // Les votes n'existent que côté Mouvement.
  if (ag.space !== 'mvt') return res.status(400).json({ error: 'Les votes ne sont disponibles que côté Mouvement.' });
  if (!canRun(req.device!, ag)) return res.status(403).json({ error: 'Seul·e l\'organisateur·rice de l\'AG ou un admin peut lancer un vote.' });
  const id = newId();
  db.prepare('INSERT INTO votes (id, point_id, question, options, code, radius, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, ag.id, body.data.question, JSON.stringify(body.data.options), newCode(), body.data.radius ?? DEFAULT_VOTE_RADIUS, req.device!.id, Date.now());
  broadcast('votes', { id, pointId: ag.id, by: req.device!.id }, ag.space);
  res.status(201).json({ vote: voteDto(getVote(id)!, { full: true }) });
});

/** Un vote (avec résultats en direct pour l'organisation). */
votes.get('/votes/:id', (req, res) => {
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag || !hasSpace(req.device!, ag.space)) return res.status(404).json({ error: 'Vote introuvable' });
  res.json({ vote: voteDto(v, { full: canRun(req.device!, ag), voterKey: `d:${req.device!.id}` }) });
});

/** Clore un vote : le code ne marche plus, les résultats deviennent visibles par tous. */
votes.post('/votes/:id/close', (req, res) => {
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag || !hasSpace(req.device!, ag.space)) return res.status(404).json({ error: 'Vote introuvable' });
  if (!canRun(req.device!, ag)) return res.status(403).json({ error: 'Seul·e l\'organisateur·rice ou un admin peut clore le vote.' });
  db.prepare("UPDATE votes SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(Date.now(), v.id);
  broadcast('votes', { id: v.id, pointId: v.point_id, by: req.device!.id }, ag.space);
  res.json({ vote: voteDto(getVote(v.id)!, { full: true }) });
});

/** Voter depuis l'app : même règle des 50 m, un vote par appareil. */
votes.post('/votes/:id/ballot', (req, res) => {
  const body = posSchema.extend({ choice: z.number().int() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Données invalides' });
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag || !hasSpace(req.device!, ag.space)) return res.status(404).json({ error: 'Vote introuvable' });
  const far = presenceError(body.data, ag, v.radius);
  if (far) return res.status(far === NEED_POSITION ? 428 : 403).json({ error: far, radius: v.radius });
  const r = cast(v, ag, `d:${req.device!.id}`, body.data.choice, req.device!.id);
  if ('error' in r) return res.status(r.status).json({ error: r.error });
  res.json({ vote: voteDto(getVote(v.id)!, { full: canRun(req.device!, ag), voterKey: `d:${req.device!.id}` }) });
});

// ====================================================================================
// Routes publiques (sans l'app) : uniquement avec le code, et sur place
// ====================================================================================

export const publicVotes = Router();
// 5 chiffres = 100 000 codes : on limite fortement les essais pour empêcher de les deviner.
const tryLimit = rateLimit(15, 60_000);

/** Trouver un vote par son code, si l'on est sur place. Rien n'est révélé de l'AG sauf son titre. */
publicVotes.post('/votes/lookup', tryLimit, (req, res) => {
  const body = posSchema.extend({ code: z.string().regex(/^\d{5}$/, 'Le code fait 5 chiffres') }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });
  const v = getOpenByCode(body.data.code);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag) return res.status(404).json({ error: 'Aucun vote ouvert avec ce code.' });
  const far = presenceError(body.data, ag, v.radius);
  if (far) return res.status(far === NEED_POSITION ? 428 : 403).json({ error: far, radius: v.radius });
  const key = voterKey(req, res);
  const dto = voteDto(v, { full: false, voterKey: key });
  res.json({ vote: { ...dto, code: null }, agTitle: ag.title });
});

/** Voter sans l'app. */
publicVotes.post('/votes/ballot', tryLimit, (req, res) => {
  const body = posSchema.extend({ code: z.string().regex(/^\d{5}$/), choice: z.number().int() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Données invalides' });
  const v = getOpenByCode(body.data.code);
  const ag = v && getPoint(v.point_id);
  if (!v || !ag) return res.status(404).json({ error: 'Ce vote est clos ou le code est faux.' });
  const far = presenceError(body.data, ag, v.radius);
  if (far) return res.status(far === NEED_POSITION ? 428 : 403).json({ error: far, radius: v.radius });
  const key = voterKey(req, res);
  const r = cast(v, ag, key, body.data.choice);
  if ('error' in r) return res.status(r.status).json({ error: r.error });
  res.json({ vote: { ...voteDto(getVote(v.id)!, { full: false, voterKey: key }), code: null } });
});

/**
 * Votes ouverts à tous, SANS code : uniquement les votes « peu importe la distance »
 * d'une AG annoncée publiquement (sur une AG interne, la question ne doit pas fuiter : le code reste nécessaire).
 */
const isOpenToAll = (v: VoteRow, ag: PointLite | undefined) => !!ag && v.status === 'open' && v.radius === 0 && ag.type === 'ag' && ag.space === 'mvt' && !!ag.public;

publicVotes.get('/votes/open', (req, res) => {
  const rows = db.prepare("SELECT * FROM votes WHERE status = 'open' AND radius = 0 ORDER BY created_at DESC LIMIT 50").all() as unknown as VoteRow[];
  const key = voterKey(req, res);
  const out = rows.flatMap((v) => {
    const ag = getPoint(v.point_id);
    if (!isOpenToAll(v, ag)) return [];
    return [{ vote: { ...voteDto(v, { full: false, voterKey: key }), code: null }, agTitle: ag!.title }];
  });
  res.json({ votes: out });
});

/** Voter sans code, sur un vote ouvert à tous. */
publicVotes.post('/votes/:id/open-ballot', tryLimit, (req, res) => {
  const body = z.object({ choice: z.number().int() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Données invalides' });
  const v = getVote(req.params.id);
  const ag = v && getPoint(v.point_id);
  if (!v || !isOpenToAll(v, ag)) return res.status(404).json({ error: 'Ce vote n\'est pas ouvert à tous (ou il est clos).' });
  const key = voterKey(req, res);
  const r = cast(v, ag!, key, body.data.choice);
  if ('error' in r) return res.status(r.status).json({ error: r.error });
  res.json({ vote: { ...voteDto(getVote(v.id)!, { full: false, voterKey: key }), code: null } });
});

/** Résultat d'un vote (seulement une fois clos), pour la personne qui a voté sans l'app. */
publicVotes.get('/votes/:id/result', (req, res) => {
  const v = getVote(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vote introuvable' });
  const out: VoteResult = { id: v.id, status: v.status, question: v.question, options: JSON.parse(v.options), counts: v.status === 'closed' ? counts(v.id, JSON.parse(v.options).length) : null };
  res.json({ result: out });
});
