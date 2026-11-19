import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, UPLOAD_DIR } from './db';
import { newId, type DeviceRow } from './auth';
import { broadcast } from './events';
import { TYPES, TYPE_KEYS, STATUSES, type Point, type PointInput, type PointStatus, type Problem } from '../shared/model';
import { occurrences } from '../shared/time';

export const points = Router();

const PHOTO_RE = /^[A-Za-z0-9_-]{8,40}\.(jpg|png|webp)$/;

interface PointRow {
  id: string; mode: Point['mode']; type: Point['type']; title: string; description: string | null;
  lat: number; lng: number; color: string | null; photo: string | null;
  starts_at: number | null; ends_at: number | null; recurrence: Point['recurrence']; recurrence_until: number | null;
  expires_at: number | null; status: Point['status']; status_at: number | null; parent_id: string | null; created_by: string; created_at: number; updated_at: number;
  creator_name?: string | null;
}

const toDto = (r: PointRow, problems: Problem[] = []): Point => ({
  id: r.id, mode: r.mode, type: r.type, title: r.title, description: r.description,
  lat: r.lat, lng: r.lng, color: r.color, photo: r.photo,
  startsAt: r.starts_at, endsAt: r.ends_at, recurrence: r.recurrence, recurrenceUntil: r.recurrence_until,
  expiresAt: r.expires_at, status: r.status, createdBy: r.created_by, creatorName: r.creator_name ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
  statusAt: r.status_at ?? null, parentId: r.parent_id ?? null,
  problems,
});

const SELECT = 'SELECT p.*, d.name AS creator_name FROM points p LEFT JOIN devices d ON d.id = p.created_by';
const getPoint = (id: string) => db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as PointRow | undefined;

// ---------- Problèmes signalés sur un point ----------

interface ProblemRow {
  id: string; point_id: string; message: string; created_by: string; created_at: number; expires_at: number;
  creator_name: string | null;
}
const problemDto = (r: ProblemRow): Problem => ({
  id: r.id, pointId: r.point_id, message: r.message, createdBy: r.created_by, creatorName: r.creator_name,
  createdAt: r.created_at, expiresAt: r.expires_at,
});
const PROBLEM_SELECT = `SELECT pr.*, d.name AS creator_name FROM problems pr LEFT JOIN devices d ON d.id = pr.created_by
  WHERE pr.resolved_at IS NULL AND pr.expires_at > ?`;

function activeProblems(pointId?: string): Map<string, Problem[]> {
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

/** Un point complet (avec ses problèmes en cours), prêt à renvoyer. */
function pointDto(id: string): Point | null {
  const row = getPoint(id);
  return row ? toDto(row, activeProblems(id).get(id) ?? []) : null;
}

const inputSchema = z.object({
  mode: z.enum(['fixe', 'event']),
  type: z.enum(TYPE_KEYS),
  title: z.string().trim().min(1, 'Donne un titre au point').max(80),
  description: z.string().trim().max(2000).nullish(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  photo: z.string().regex(PHOTO_RE).nullish(),
  startsAt: z.number().int().nullish(),
  endsAt: z.number().int().nullish(),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
  recurrenceUntil: z.number().int().nullish(),
  durationMinutes: z.number().int().min(5).max(24 * 60).optional(),
  status: z.enum(['a_coller', 'colle', 'abime', 'tenu', 'vide', 'leve']).nullish(),
  parentId: z.string().max(40).nullish(),
});

/** L'état demandé est-il valable pour ce type de point ? */
const validStatus = (type: Point['type'], status: unknown): status is PointStatus =>
  !!STATUSES[type]?.includes(status as PointStatus);

/** Le blocus auquel rattacher un blocage, ou un message d'erreur. */
function blocusFor(parentId: string | null | undefined): { id: string | null } | string {
  if (!parentId) return { id: null };
  const parent = getPoint(parentId);
  if (!parent || parent.type !== 'blocus') return 'Ce blocus n\'existe plus.';
  return { id: parent.id };
}

type Normalized = Omit<PointRow, 'id' | 'created_by' | 'created_at' | 'updated_at' | 'creator_name' | 'status_at'>;

/** Valide et normalise les règles métier (horaires, expiration, alertes). */
function normalize(input: PointInput, existing?: PointRow): Normalized | string {
  const meta = TYPES[input.type];
  const now = Date.now();
  const mode = meta.alert ? 'event' : input.mode;
  if (!meta.modes.includes(mode)) return `Le type « ${meta.label} » n'est pas disponible en ${mode === 'fixe' ? 'point fixe' : 'événement'}.`;

  const base = {
    mode, type: input.type, title: input.title, description: input.description || null,
    lat: input.lat, lng: input.lng, color: input.color || null, photo: input.photo || null,
    parent_id: null as string | null,
  };

  if (meta.alert) {
    // Warning / danger : durée de vie courte à partir de maintenant (ou on garde l'existante).
    const keep = existing && existing.type === input.type && input.durationMinutes == null;
    const startsAt = keep ? existing.starts_at! : now;
    const expiresAt = keep ? existing.expires_at! : now + (input.durationMinutes ?? 30) * 60_000;
    return { ...base, starts_at: startsAt, ends_at: expiresAt, recurrence: 'none', recurrence_until: null, expires_at: expiresAt, status: null };
  }

  if (mode === 'fixe') {
    const statuses = STATUSES[input.type];
    let parentId: string | null = null;
    if (input.type === 'blocage') {
      const b = blocusFor(input.parentId);
      if (typeof b === 'string') return b;
      parentId = b.id;
    }
    return {
      ...base, parent_id: parentId, starts_at: null, ends_at: null, recurrence: 'none', recurrence_until: null, expires_at: null,
      status: statuses ? (validStatus(input.type, input.status) ? input.status : statuses[0]) : null,
    };
  }

  if (input.startsAt == null || input.endsAt == null) return 'Indique la date et la plage horaire de l\'événement.';
  if (input.endsAt <= input.startsAt) return 'L\'heure de fin doit être après l\'heure de début.';
  if (input.endsAt - input.startsAt > 7 * 86400000) return 'Un événement ne peut pas durer plus de 7 jours.';
  const recurrence = input.recurrence ?? 'none';
  const until = recurrence === 'none' ? null : input.recurrenceUntil ?? null;
  if (until != null && until < input.startsAt) return 'La date de fin de répétition est avant le premier événement.';
  return {
    ...base, starts_at: input.startsAt, ends_at: input.endsAt, recurrence, recurrence_until: until,
    expires_at: recurrence === 'none' ? input.endsAt : until,
    status: null,
  };
}

const canEdit = (me: DeviceRow, row: PointRow) => me.role === 'admin' || row.created_by === me.id;

points.get('/points', (_req, res) => {
  const rows = db.prepare(`${SELECT} ORDER BY p.created_at`).all() as unknown as PointRow[];
  const problems = activeProblems();
  res.json({ points: rows.map((r) => toDto(r, problems.get(r.id) ?? [])) });
});

points.post('/points', (req, res) => {
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Données invalides' });
  const n = normalize(parsed.data);
  if (typeof n === 'string') return res.status(400).json({ error: n });
  const id = newId();
  const now = Date.now();
  db.prepare(`INSERT INTO points (id, mode, type, title, description, lat, lng, color, photo, starts_at, ends_at,
              recurrence, recurrence_until, expires_at, status, status_at, parent_id, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, n.mode, n.type, n.title, n.description, n.lat, n.lng, n.color, n.photo, n.starts_at, n.ends_at,
      n.recurrence, n.recurrence_until, n.expires_at, n.status, n.status ? now : null, n.parent_id, req.device!.id, now, now);
  broadcast('points', { id, by: req.device!.id, action: 'create', type: n.type });
  res.status(201).json({ point: pointDto(id)! });
});

points.put('/points/:id', (req, res) => {
  const row = getPoint(req.params.id);
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut modifier ce point.' });
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Données invalides' });
  const n = normalize(parsed.data, row);
  if (typeof n === 'string') return res.status(400).json({ error: n });
  const now = Date.now();
  const statusAt = n.status === row.status ? row.status_at : n.status ? now : null;
  db.prepare(`UPDATE points SET mode=?, type=?, title=?, description=?, lat=?, lng=?, color=?, photo=?, starts_at=?, ends_at=?,
              recurrence=?, recurrence_until=?, expires_at=?, status=?, status_at=?, parent_id=?, updated_at=? WHERE id=?`)
    .run(n.mode, n.type, n.title, n.description, n.lat, n.lng, n.color, n.photo, n.starts_at, n.ends_at,
      n.recurrence, n.recurrence_until, n.expires_at, n.status, statusAt, n.parent_id, now, row.id);
  if (row.type === 'blocus' && n.type !== 'blocus') db.prepare('UPDATE points SET parent_id = NULL WHERE parent_id = ?').run(row.id);
  if (row.type === 'blocus') releaseBlocages();
  if (row.photo && row.photo !== n.photo) removePhoto(row.photo);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' });
  res.json({ point: pointDto(row.id)! });
});

/** État d'un panneau ou d'un blocage : tout le monde peut le mettre à jour sur le terrain. */
points.patch('/points/:id/status', (req, res) => {
  const row = getPoint(req.params.id);
  if (!row || !STATUSES[row.type]) return res.status(404).json({ error: 'Point introuvable' });
  if (!validStatus(row.type, req.body?.status)) return res.status(400).json({ error: 'État invalide' });
  const now = Date.now();
  db.prepare('UPDATE points SET status = ?, status_at = ?, updated_at = ? WHERE id = ?').run(req.body.status, now, now, row.id);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' });
  res.json({ point: pointDto(row.id)! });
});

/** Rattacher un blocage à un blocus (ou le détacher) : tout le monde peut le faire sur le terrain. */
points.patch('/points/:id/parent', (req, res) => {
  const row = getPoint(req.params.id);
  if (!row || row.type !== 'blocage') return res.status(404).json({ error: 'Blocage introuvable' });
  const b = blocusFor(req.body?.parentId ?? null);
  if (typeof b === 'string') return res.status(400).json({ error: b });
  db.prepare('UPDATE points SET parent_id = ?, updated_at = ? WHERE id = ?').run(b.id, Date.now(), row.id);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' });
  res.json({ point: pointDto(row.id)! });
});

/** Prolonger une alerte : tout le monde peut confirmer qu'elle est toujours d'actualité. */
points.post('/points/:id/extend', (req, res) => {
  const minutes = z.number().int().min(5).max(240).safeParse(req.body?.minutes);
  if (!minutes.success) return res.status(400).json({ error: 'Durée invalide' });
  const row = getPoint(req.params.id);
  if (!row || !TYPES[row.type].alert) return res.status(404).json({ error: 'Alerte introuvable' });
  const exp = Math.max(row.expires_at ?? 0, Date.now()) + minutes.data * 60_000;
  db.prepare('UPDATE points SET expires_at = ?, ends_at = ?, updated_at = ? WHERE id = ?').run(exp, exp, Date.now(), row.id);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' });
  res.json({ point: pointDto(row.id)! });
});

/** Terminer un événement maintenant (auteur·rice ou admin) : il quitte la carte mais reste dans l'agenda. */
points.post('/points/:id/finish', (req, res) => {
  const row = getPoint(req.params.id);
  if (!row || row.mode !== 'event' || TYPES[row.type].alert) return res.status(404).json({ error: 'Événement introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut terminer cet événement.' });
  const now = Date.now();
  if (row.recurrence !== 'none') {
    // Événement répété : on arrête la répétition après l'occurrence en cours.
    db.prepare('UPDATE points SET recurrence_until = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(now, now, now, row.id);
  } else {
    const start = Math.min(row.starts_at ?? now, now - 60_000);
    db.prepare('UPDATE points SET starts_at = ?, ends_at = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(start, now, now, now, row.id);
  }
  db.prepare('UPDATE problems SET resolved_at = ?, resolved_by = ? WHERE point_id = ? AND resolved_at IS NULL').run(now, req.device!.id, row.id);
  if (row.type === 'blocus') releaseBlocages();
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' });
  res.json({ point: pointDto(row.id)! });
});

/** Signaler un problème sur un point : tout le monde peut le faire. */
points.post('/points/:id/problems', (req, res) => {
  const body = z.object({
    message: z.string().trim().min(1, 'Décris le problème').max(200),
    durationMinutes: z.number().int().min(5).max(24 * 60),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });
  const row = getPoint(req.params.id);
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  if (TYPES[row.type].alert) return res.status(400).json({ error: 'C\'est déjà une alerte : prolonge-la plutôt.' });
  const now = Date.now();
  db.prepare('INSERT INTO problems (id, point_id, message, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId(), row.id, body.data.message, req.device!.id, now, now + body.data.durationMinutes * 60_000);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'problem', title: row.title });
  res.status(201).json({ point: pointDto(row.id)! });
});

/** Problème réglé : tout le monde peut le lever. */
points.post('/problems/:id/resolve', (req, res) => {
  const pr = db.prepare('SELECT point_id FROM problems WHERE id = ? AND resolved_at IS NULL').get(req.params.id) as { point_id: string } | undefined;
  if (!pr) return res.status(404).json({ error: 'Problème introuvable ou déjà réglé' });
  db.prepare('UPDATE problems SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(Date.now(), req.device!.id, req.params.id);
  broadcast('points', { id: pr.point_id, by: req.device!.id, action: 'update' });
  res.json({ point: pointDto(pr.point_id)! });
});

/** Problème toujours d'actualité : on prolonge. */
points.post('/problems/:id/extend', (req, res) => {
  const minutes = z.number().int().min(5).max(240).safeParse(req.body?.minutes);
  if (!minutes.success) return res.status(400).json({ error: 'Durée invalide' });
  const pr = db.prepare('SELECT point_id, expires_at FROM problems WHERE id = ? AND resolved_at IS NULL').get(req.params.id) as { point_id: string; expires_at: number } | undefined;
  if (!pr) return res.status(404).json({ error: 'Problème introuvable ou déjà réglé' });
  const exp = Math.max(pr.expires_at, Date.now()) + minutes.data * 60_000;
  db.prepare('UPDATE problems SET expires_at = ? WHERE id = ?').run(exp, req.params.id);
  broadcast('points', { id: pr.point_id, by: req.device!.id, action: 'update' });
  res.json({ point: pointDto(pr.point_id)! });
});

points.delete('/points/:id', (req, res) => {
  const row = getPoint(req.params.id);
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut supprimer ce point.' });
  db.prepare('DELETE FROM points WHERE id = ?').run(row.id);
  db.prepare('UPDATE points SET parent_id = NULL WHERE parent_id = ?').run(row.id);
  if (row.photo) removePhoto(row.photo);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'delete' });
  res.json({ ok: true });
});

// ---------- Photos ----------

function sniff(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function removePhoto(name: string) {
  if (!PHOTO_RE.test(name)) return;
  fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
}

points.post('/photos', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }), (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf)) return res.status(400).json({ error: 'Envoie une image JPEG, PNG ou WebP.' });
  const ext = sniff(buf);
  if (!ext) return res.status(400).json({ error: 'Ce fichier n\'est pas une image valide.' });
  const name = `${newId()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.status(201).json({ photo: name });
});

points.get('/photos/:name', (req, res) => {
  if (!PHOTO_RE.test(req.params.name)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=604800, immutable');
  res.sendFile(path.join(UPLOAD_DIR, req.params.name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------- Fin des blocus ----------

/**
 * Quand un blocus se termine (fin prévue ou « Terminer maintenant »), ses blocages encore « tenus »
 * passent à « sans personne » : la barricade reste sur la carte, mais plus personne ne la tient.
 * Un blocage marqué « tenu » après la fin du blocus n'est pas touché.
 */
export function releaseBlocages() {
  const now = Date.now();
  const rows = db.prepare(`SELECT id, status_at, parent_id FROM points
    WHERE type = 'blocage' AND status = 'tenu' AND parent_id IS NOT NULL`).all() as unknown as { id: string; status_at: number | null; parent_id: string }[];
  const parents = new Map<string, Point | null>();
  const released: string[] = [];
  for (const r of rows) {
    if (!parents.has(r.parent_id)) {
      const p = getPoint(r.parent_id);
      parents.set(r.parent_id, p ? toDto(p) : null);
    }
    const parent = parents.get(r.parent_id);
    if (!parent) continue;
    const since = r.status_at ?? 0;
    const ended = (t: number | null) => t != null && t > since && t <= now;
    // Fin d'une occurrence, ou blocus arrêté plus tôt (« Terminer maintenant » sur un blocus répété).
    if (ended(parent.expiresAt) || occurrences(parent, since, now).some((o) => ended(o.end))) released.push(r.id);
  }
  if (!released.length) return;
  const upd = db.prepare("UPDATE points SET status = 'vide', status_at = ?, updated_at = ? WHERE id = ?");
  for (const id of released) upd.run(now, now, id);
  broadcast('points', { id: released[0], action: 'update' });
}

// ---------- Ménage périodique ----------

export function cleanup() {
  const now = Date.now();
  // Alertes expirées depuis plus de 6 h.
  const old = db.prepare("SELECT photo FROM points WHERE type IN ('warning','danger') AND expires_at < ?").all(now - 6 * 3600_000) as { photo: string | null }[];
  db.prepare("DELETE FROM points WHERE type IN ('warning','danger') AND expires_at < ?").run(now - 6 * 3600_000);
  old.forEach((r) => r.photo && removePhoto(r.photo));
  // Photos envoyées mais jamais rattachées à un point.
  const used = new Set((db.prepare('SELECT photo FROM points WHERE photo IS NOT NULL').all() as { photo: string }[]).map((r) => r.photo));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (used.has(f)) continue;
    const st = fs.statSync(path.join(UPLOAD_DIR, f));
    if (now - st.mtimeMs > 24 * 3600_000) removePhoto(f);
  }
  // Problèmes réglés ou expirés depuis plus d'un jour.
  db.prepare('DELETE FROM problems WHERE COALESCE(resolved_at, expires_at) < ?').run(now - 86400_000);
  // Invitations mortes depuis une semaine.
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(now - 7 * 86400_000);
}
