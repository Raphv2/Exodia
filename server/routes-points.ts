import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, UPLOAD_DIR } from './db';
import { newId, type DeviceRow } from './auth';
import { broadcast } from './events';
import { TYPES, TYPE_KEYS, type Point, type PointInput } from '../shared/model';

export const points = Router();

const PHOTO_RE = /^[A-Za-z0-9_-]{8,40}\.(jpg|png|webp)$/;

interface PointRow {
  id: string; mode: Point['mode']; type: Point['type']; title: string; description: string | null;
  lat: number; lng: number; color: string | null; photo: string | null;
  starts_at: number | null; ends_at: number | null; recurrence: Point['recurrence']; recurrence_until: number | null;
  expires_at: number | null; status: Point['status']; created_by: string; created_at: number; updated_at: number;
  creator_name?: string | null;
}

const toDto = (r: PointRow): Point => ({
  id: r.id, mode: r.mode, type: r.type, title: r.title, description: r.description,
  lat: r.lat, lng: r.lng, color: r.color, photo: r.photo,
  startsAt: r.starts_at, endsAt: r.ends_at, recurrence: r.recurrence, recurrenceUntil: r.recurrence_until,
  expiresAt: r.expires_at, status: r.status, createdBy: r.created_by, creatorName: r.creator_name ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const SELECT = 'SELECT p.*, d.name AS creator_name FROM points p LEFT JOIN devices d ON d.id = p.created_by';
const getPoint = (id: string) => db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as PointRow | undefined;

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
  status: z.enum(['a_coller', 'colle', 'abime']).nullish(),
});

type Normalized = Omit<PointRow, 'id' | 'created_by' | 'created_at' | 'updated_at' | 'creator_name'>;

/** Valide et normalise les règles métier (horaires, expiration, alertes). */
function normalize(input: PointInput, existing?: PointRow): Normalized | string {
  const meta = TYPES[input.type];
  const now = Date.now();
  const mode = meta.alert ? 'event' : input.mode;
  if (!meta.modes.includes(mode)) return `Le type « ${meta.label} » n'est pas disponible en ${mode === 'fixe' ? 'point fixe' : 'événement'}.`;

  const base = {
    mode, type: input.type, title: input.title, description: input.description || null,
    lat: input.lat, lng: input.lng, color: input.color || null, photo: input.photo || null,
  };

  if (meta.alert) {
    // Warning / danger : durée de vie courte à partir de maintenant (ou on garde l'existante).
    const keep = existing && existing.type === input.type && input.durationMinutes == null;
    const startsAt = keep ? existing.starts_at! : now;
    const expiresAt = keep ? existing.expires_at! : now + (input.durationMinutes ?? 30) * 60_000;
    return { ...base, starts_at: startsAt, ends_at: expiresAt, recurrence: 'none', recurrence_until: null, expires_at: expiresAt, status: null };
  }

  if (mode === 'fixe') {
    return {
      ...base, starts_at: null, ends_at: null, recurrence: 'none', recurrence_until: null, expires_at: null,
      status: input.type === 'panneau' ? input.status ?? 'a_coller' : null,
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
  res.json({ points: rows.map(toDto) });
});

points.post('/points', (req, res) => {
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Données invalides' });
  const n = normalize(parsed.data);
  if (typeof n === 'string') return res.status(400).json({ error: n });
  const id = newId();
  const now = Date.now();
  db.prepare(`INSERT INTO points (id, mode, type, title, description, lat, lng, color, photo, starts_at, ends_at,
              recurrence, recurrence_until, expires_at, status, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, n.mode, n.type, n.title, n.description, n.lat, n.lng, n.color, n.photo, n.starts_at, n.ends_at,
      n.recurrence, n.recurrence_until, n.expires_at, n.status, req.device!.id, now, now);
  broadcast('points', { id, by: req.device!.id, action: 'create', type: n.type });
  res.status(201).json({ point: toDto(getPoint(id)!) });
});

points.put('/points/:id', (req, res) => {
  const row = getPoint(req.params.id);
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut modifier ce point.' });
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Données invalides' });
  const n = normalize(parsed.data, row);
  if (typeof n === 'string') return res.status(400).json({ error: n });
  db.prepare(`UPDATE points SET mode=?, type=?, title=?, description=?, lat=?, lng=?, color=?, photo=?, starts_at=?, ends_at=?,
              recurrence=?, recurrence_until=?, expires_at=?, status=?, updated_at=? WHERE id=?`)
    .run(n.mode, n.type, n.title, n.description, n.lat, n.lng, n.color, n.photo, n.starts_at, n.ends_at,
      n.recurrence, n.recurrence_until, n.expires_at, n.status, Date.now(), row.id);
  if (row.photo && row.photo !== n.photo) removePhoto(row.photo);
  broadcast('points', { id: row.id, by: req.device!.id, action: 'update' });
  res.json({ point: toDto(getPoint(row.id)!) });
});

/** Statut d'un panneau : tout le monde peut le mettre à jour sur le terrain. */
points.patch('/points/:id/status', (req, res) => {
  const status = z.enum(['a_coller', 'colle', 'abime']).safeParse(req.body?.status);
  if (!status.success) return res.status(400).json({ error: 'Statut invalide' });
  const r = db.prepare("UPDATE points SET status = ?, updated_at = ? WHERE id = ? AND type = 'panneau'").run(status.data, Date.now(), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Panneau introuvable' });
  broadcast('points', { id: req.params.id, by: req.device!.id, action: 'update' });
  res.json({ point: toDto(getPoint(req.params.id)!) });
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
  res.json({ point: toDto(getPoint(row.id)!) });
});

points.delete('/points/:id', (req, res) => {
  const row = getPoint(req.params.id);
  if (!row) return res.status(404).json({ error: 'Point introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut supprimer ce point.' });
  db.prepare('DELETE FROM points WHERE id = ?').run(row.id);
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
  // Invitations mortes depuis une semaine.
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(now - 7 * 86400_000);
}
