import express, { Router, type Request } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, UPLOAD_DIR } from './db';
import { hasSpace, newId, sha256, type DeviceRow } from './auth';
import { broadcast } from './events';
import type { ArchiveItem, PublicAg, RegistryEntry } from '../shared/model';

/*
 * Archive (côté Mouvement) :
 * - des documents ajoutés à la main (photo, PDF, copie de mail, note), datés, privés ou publics ;
 * - un registre automatique : les événements passés et les votes clos (jamais les blocages ni les alertes).
 * Sans compte, on ne voit que les documents publics et les AG annoncées publiquement.
 */

const SPACE = 'mvt';
const ARCHIVE_DIR = path.join(UPLOAD_DIR, 'archive');
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

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

const FILE_RE = /^[A-Za-z0-9_-]{8,40}\.(jpg|png|webp|pdf|txt)$/;
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8' };

interface ItemRow {
  id: string; space: string; kind: ArchiveItem['kind']; title: string; date: number; body: string | null;
  file: string | null; file_name: string | null; file_type: string | null; visibility: 'private' | 'public';
  created_by: string; created_at: number; updated_at: number; creator_name?: string | null;
}

const itemDto = (r: ItemRow, withAuthor: boolean): ArchiveItem => ({
  id: r.id, kind: r.kind, title: r.title, date: r.date, body: r.body, file: r.file, fileName: r.file_name,
  fileType: r.file_type, visibility: r.visibility, createdBy: withAuthor ? r.created_by : null,
  creatorName: withAuthor ? r.creator_name ?? null : null, createdAt: r.created_at,
});

/** Type réel du fichier, d'après son contenu (jamais d'après le nom ou ce que dit le navigateur). */
function sniff(buf: Buffer): 'jpg' | 'png' | 'webp' | 'pdf' | 'txt' | null {
  if (buf.length < 5) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  // Texte (copie de mail .eml, .txt) : de l'UTF-8 valide, sans octet nul.
  if (!buf.includes(0)) {
    const text = buf.toString('utf8');
    if (!text.includes('�')) return 'txt';
  }
  return null;
}

const removeFile = (name: string | null) => {
  if (name && FILE_RE.test(name)) fs.rm(path.join(ARCHIVE_DIR, name), { force: true }, () => {});
};

/** Appareil connecté (facultatif) : pour les routes accessibles aussi sans compte. */
function optionalDevice(req: Request): DeviceRow | undefined {
  const sid = /(?:^|;\s*)terrain_sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (!sid) return undefined;
  return db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(decodeURIComponent(sid))) as DeviceRow | undefined;
}

const SELECT = 'SELECT a.*, d.name AS creator_name FROM archive_items a LEFT JOIN devices d ON d.id = a.created_by';

/** Registre automatique : événements passés (sans blocages ni alertes) et votes clos. */
function registry(): RegistryEntry[] {
  const now = Date.now();
  const events = db.prepare(`SELECT id, type, title, starts_at, ends_at FROM points
    WHERE space = ? AND mode = 'event' AND type NOT IN ('warning', 'danger', 'police', 'blocage') AND ends_at IS NOT NULL AND ends_at < ?
    ORDER BY starts_at DESC LIMIT 500`).all(SPACE, now) as { id: string; type: string; title: string; starts_at: number; ends_at: number }[];
  const votes = db.prepare(`SELECT v.id, v.question, v.options, v.closed_at, p.title AS ag FROM votes v JOIN points p ON p.id = v.point_id
    WHERE p.space = ? AND v.status = 'closed' ORDER BY v.closed_at DESC LIMIT 500`).all(SPACE) as { id: string; question: string; options: string; closed_at: number; ag: string }[];
  const countsOf = (id: string, n: number) => {
    const out = Array.from({ length: n }, () => 0);
    for (const r of db.prepare('SELECT choice, COUNT(*) AS c FROM ballots WHERE vote_id = ? GROUP BY choice').all(id) as { choice: number; c: number }[]) if (r.choice < n) out[r.choice] = r.c;
    return out;
  };
  return [
    ...events.map((e): RegistryEntry => ({ kind: 'event', id: e.id, date: e.starts_at, end: e.ends_at, title: e.title, type: e.type })),
    ...votes.map((v): RegistryEntry => {
      const options = JSON.parse(v.options) as string[];
      return { kind: 'vote', id: v.id, date: v.closed_at, title: v.question, ag: v.ag, options, counts: countsOf(v.id, options.length) };
    }),
  ];
}

// ====================================================================================
// App (appareil connecté, avec accès au côté Mouvement)
// ====================================================================================

export const archive = Router();

const requireMvt: express.RequestHandler = (req, res, next) => {
  if (!hasSpace(req.device!, SPACE)) return res.status(403).json({ error: 'L\'archive est réservée au côté Mouvement.' });
  next();
};
const canEdit = (me: DeviceRow, r: ItemRow) => r.created_by === me.id || me.role === 'admin';

archive.get('/archive', requireMvt, (_req, res) => {
  const rows = db.prepare(`${SELECT} WHERE a.space = ? ORDER BY a.date DESC`).all(SPACE) as unknown as ItemRow[];
  res.json({ items: rows.map((r) => itemDto(r, true)), registry: registry() });
});

/** Envoi d'un fichier (avant de créer l'élément d'archive). */
archive.post('/archive/files', requireMvt, express.raw({ type: () => true, limit: '15mb' }), (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Fichier vide.' });
  const ext = sniff(buf);
  if (!ext) return res.status(400).json({ error: 'Type de fichier non accepté : image (JPEG, PNG, WebP), PDF ou texte (.txt, .eml).' });
  const name = `${newId()}.${ext}`;
  fs.writeFileSync(path.join(ARCHIVE_DIR, name), buf);
  res.status(201).json({ file: name, fileType: ext });
});

const itemSchema = z.object({
  kind: z.enum(['document', 'image', 'mail', 'note']),
  title: z.string().trim().min(1, 'Donne un titre').max(120),
  date: z.number().int().min(0),
  body: z.string().trim().max(50_000).nullish(),
  file: z.string().regex(FILE_RE).nullish(),
  fileName: z.string().trim().max(160).nullish(),
  visibility: z.enum(['private', 'public']),
});

archive.post('/archive', requireMvt, (req, res) => {
  const b = itemSchema.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: b.error.issues[0]?.message ?? 'Données invalides' });
  if (!b.data.body && !b.data.file) return res.status(400).json({ error: 'Ajoute un fichier ou un texte.' });
  if (b.data.file && !fs.existsSync(path.join(ARCHIVE_DIR, b.data.file))) return res.status(400).json({ error: 'Le fichier n\'a pas été reçu, réessaie.' });
  const id = newId();
  const now = Date.now();
  const ext = b.data.file?.split('.').pop() ?? null;
  db.prepare(`INSERT INTO archive_items (id, space, kind, title, date, body, file, file_name, file_type, visibility, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, SPACE, b.data.kind, b.data.title, b.data.date, b.data.body || null, b.data.file || null, b.data.fileName || null, ext, b.data.visibility, req.device!.id, now, now);
  broadcast('archive', { id, by: req.device!.id }, SPACE);
  res.status(201).json({ item: itemDto(db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as unknown as ItemRow, true) });
});

/** Changer la visibilité ou le titre (auteur·rice ou admin). */
archive.patch('/archive/:id', requireMvt, (req, res) => {
  const b = z.object({ visibility: z.enum(['private', 'public']).optional(), title: z.string().trim().min(1).max(120).optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: 'Données invalides' });
  const row = db.prepare(`${SELECT} WHERE a.id = ? AND a.space = ?`).get(req.params.id, SPACE) as ItemRow | undefined;
  if (!row) return res.status(404).json({ error: 'Document introuvable' });
  if (!canEdit(req.device!, row)) return res.status(403).json({ error: 'Seul·e l\'auteur·rice ou un admin peut le modifier.' });
  db.prepare('UPDATE archive_items SET visibility = COALESCE(?, visibility), title = COALESCE(?, title), updated_at = ? WHERE id = ?')
    .run(b.data.visibility ?? null, b.data.title ?? null, Date.now(), row.id);
  broadcast('archive', { id: row.id, by: req.device!.id }, SPACE);
  res.json({ item: itemDto(db.prepare(`${SELECT} WHERE a.id = ?`).get(row.id) as unknown as ItemRow, true) });
});

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
publicArchive.get('/archive', (_req, res) => {
  const rows = db.prepare(`${SELECT} WHERE a.space = ? AND a.visibility = 'public' ORDER BY a.date DESC`).all(SPACE) as unknown as ItemRow[];
  res.json({ items: rows.map((r) => itemDto(r, false)) });
});

/** AG annoncées publiquement et pas encore terminées. */
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
publicArchive.get('/archive/files/:name', (req, res) => {
  const name = req.params.name;
  if (!FILE_RE.test(name)) return res.status(404).end();
  const row = db.prepare('SELECT visibility, file_name FROM archive_items WHERE file = ?').get(name) as { visibility: string; file_name: string | null } | undefined;
  if (!row) return res.status(404).end();
  if (row.visibility !== 'public') {
    const d = optionalDevice(req);
    if (!d || !hasSpace(d, SPACE)) return res.status(404).end();
  }
  const ext = name.split('.').pop()!;
  const image = ['jpg', 'png', 'webp'].includes(ext);
  const safeName = (row.file_name || `document.${ext}`).replace(/[^\w .()-]/g, '_').slice(0, 120);
  res.set({
    'Content-Type': MIME[ext],
    'Cache-Control': row.visibility === 'public' ? 'public, max-age=3600' : 'private, max-age=3600',
    'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename="${safeName}"`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.sendFile(path.join(ARCHIVE_DIR, name), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

/** Fichiers envoyés mais jamais rattachés à un document (abandon en cours de route), après 24 h. */
export function cleanupArchive() {
  const used = new Set((db.prepare('SELECT file FROM archive_items WHERE file IS NOT NULL').all() as { file: string }[]).map((r) => r.file));
  const now = Date.now();
  for (const f of fs.readdirSync(ARCHIVE_DIR)) {
    if (used.has(f) || !FILE_RE.test(f)) continue;
    if (now - fs.statSync(path.join(ARCHIVE_DIR, f)).mtimeMs > 24 * 3600_000) removeFile(f);
  }
}
