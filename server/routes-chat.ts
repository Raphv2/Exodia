import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { db } from './db';
import { hasSpace, newId, parseSpaces } from './auth';
import { broadcast } from './events';
import type { ChatEpochKey, ChatMember, ChatMessage } from '../shared/model';

/*
 * Chat du côté Mouvement, chiffré de bout en bout.
 *
 * Le serveur ne voit JAMAIS le texte des messages ni les clés de lecture :
 * - chaque appareil crée sa paire de clés (ECDH P-256) dans le navigateur ; la clé privée n'en sort pas ;
 *   il publie ici sa clé publique ;
 * - une « époque » = une clé de groupe (AES-GCM 256) tirée au hasard par un appareil, valable pour une liste
 *   précise de membres ; il la chiffre pour chaque membre (ECDH + HKDF) et ne nous envoie que ces enveloppes ;
 * - dès que la liste des membres change (arrivée, départ, retrait), le prochain message ouvre une nouvelle
 *   époque : un nouvel arrivant ne lit pas l'historique, une personne retirée ne lit plus la suite ;
 * - les messages sont stockés chiffrés (avec leur IV) et effacés au bout de 30 jours.
 * Ce que le serveur connaît quand même : qui écrit, quand, et la taille des messages (les « métadonnées »).
 */

const SPACE = 'mvt';
const RETENTION_DAYS = 30;

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_keys (
    device_id   TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_epochs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    members     TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_wraps (
    epoch_id    INTEGER NOT NULL REFERENCES chat_epochs(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    sender_key  TEXT NOT NULL,
    recipient_key TEXT NOT NULL,
    wrapped     TEXT NOT NULL,
    iv          TEXT NOT NULL,
    PRIMARY KEY (epoch_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id          TEXT PRIMARY KEY,
    epoch_id    INTEGER NOT NULL REFERENCES chat_epochs(id) ON DELETE CASCADE,
    sender_id   TEXT NOT NULL,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_messages_time ON chat_messages(created_at);
`);

const B64 = /^[A-Za-z0-9+/=_-]+$/;
/** Clé publique : JWK EC P-256 (x, y en base64url), rien d'autre. */
const jwkSchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().regex(B64).max(64), y: z.string().regex(B64).max(64) }).strict();

export const chat = Router();

const requireMvt: RequestHandler = (req, res, next) => {
  if (!hasSpace(req.device!, SPACE)) return res.status(403).json({ error: 'Le chat est réservé au côté Mouvement.' });
  next();
};

/** Membres actuels : appareils actifs du côté Mouvement qui ont publié leur clé. */
function members(): ChatMember[] {
  const rows = db.prepare(`SELECT d.id, d.name, d.spaces, k.public_key FROM devices d JOIN chat_keys k ON k.device_id = d.id
    WHERE d.revoked_at IS NULL ORDER BY d.name`).all() as { id: string; name: string; spaces: string; public_key: string }[];
  return rows.filter((r) => parseSpaces(r.spaces).includes(SPACE)).map((r) => ({ id: r.id, name: r.name, publicKey: r.public_key }));
}

/** Publier (ou remplacer) la clé publique de mon appareil. */
chat.put('/chat/key', requireMvt, (req, res) => {
  const jwk = jwkSchema.safeParse(req.body?.publicKey);
  if (!jwk.success) return res.status(400).json({ error: 'Clé publique invalide' });
  const value = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.data.x, y: jwk.data.y });
  const prev = db.prepare('SELECT public_key FROM chat_keys WHERE device_id = ?').get(req.device!.id) as { public_key: string } | undefined;
  if (prev?.public_key !== value) {
    db.prepare(`INSERT INTO chat_keys (device_id, public_key, created_at) VALUES (?, ?, ?)
                ON CONFLICT (device_id) DO UPDATE SET public_key = excluded.public_key, created_at = excluded.created_at`)
      .run(req.device!.id, value, Date.now());
    // Nouveau membre (ou nouvelle clé) : les autres ouvriront une nouvelle époque au prochain message.
    broadcast('chat', { kind: 'members' }, SPACE);
  }
  res.json({ ok: true });
});

/** Membres et dernière époque (pour savoir s'il faut en ouvrir une nouvelle). */
chat.get('/chat/state', requireMvt, (req, res) => {
  const last = db.prepare('SELECT id FROM chat_epochs ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
  // Membres de la dernière époque, avec la clé pour laquelle chacun a reçu son enveloppe.
  const lastMembers = last
    ? (db.prepare('SELECT device_id AS id, recipient_key AS key FROM chat_wraps WHERE epoch_id = ?').all(last.id) as { id: string; key: string }[])
    : [];
  const mine = db.prepare(`SELECT epoch_id, sender_id, sender_key, recipient_key, wrapped, iv FROM chat_wraps WHERE device_id = ? ORDER BY epoch_id`)
    .all(req.device!.id) as { epoch_id: number; sender_id: string; sender_key: string; recipient_key: string; wrapped: string; iv: string }[];
  const keys: ChatEpochKey[] = mine.map((w) => ({ epochId: w.epoch_id, senderId: w.sender_id, senderKey: w.sender_key, recipientKey: w.recipient_key, wrapped: w.wrapped, iv: w.iv }));
  res.json({
    members: members(),
    lastEpoch: last ? { id: last.id, members: lastMembers } : null,
    keys,
  });
});

/** Ouvrir une époque : une enveloppe (clé de groupe chiffrée) pour chaque membre actuel, et pour personne d'autre. */
chat.post('/chat/epochs', requireMvt, (req, res) => {
  const body = z.object({
    wraps: z.array(z.object({
      deviceId: z.string().min(8).max(40),
      wrapped: z.string().regex(B64).max(200),
      iv: z.string().regex(B64).max(40),
      recipientKey: z.string().max(400),
    })).min(1).max(500),
    senderKey: z.string().max(400),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Données invalides' });
  const current = members();
  const ids = current.map((m) => m.id).sort();
  const given = body.data.wraps.map((w) => w.deviceId).sort();
  if (!current.some((m) => m.id === req.device!.id)) return res.status(409).json({ error: 'Publie d\'abord ta clé.' });
  // Exactement les membres actuels, chacun avec SA clé actuelle : sinon la liste a changé entre-temps, on recommence.
  const byId = new Map(current.map((m) => [m.id, m.publicKey]));
  const me = byId.get(req.device!.id);
  if (JSON.stringify(ids) !== JSON.stringify(given) || body.data.wraps.some((w) => byId.get(w.deviceId) !== w.recipientKey) || body.data.senderKey !== me) {
    return res.status(409).json({ error: 'La liste des membres a changé, réessaie.' });
  }
  const now = Date.now();
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO chat_epochs (members, created_by, created_at) VALUES (?, ?, ?)').run(JSON.stringify(ids), req.device!.id, now);
    const epochId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO chat_wraps (epoch_id, device_id, sender_id, sender_key, recipient_key, wrapped, iv) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const w of body.data.wraps) ins.run(epochId, w.deviceId, req.device!.id, me, w.recipientKey, w.wrapped, w.iv);
    db.exec('COMMIT');
    res.status(201).json({ epochId });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

/** Messages chiffrés (les plus récents d'abord, par pages). */
chat.get('/chat/messages', requireMvt, (req, res) => {
  const before = Number(req.query.before) || Date.now() + 1;
  const rows = db.prepare(`SELECT m.id, m.epoch_id, m.sender_id, m.iv, m.ciphertext, m.created_at, d.name AS sender_name
    FROM chat_messages m LEFT JOIN devices d ON d.id = m.sender_id
    WHERE m.created_at < ? ORDER BY m.created_at DESC LIMIT 60`).all(before) as {
      id: string; epoch_id: number; sender_id: string; iv: string; ciphertext: string; created_at: number; sender_name: string | null }[];
  const out: ChatMessage[] = rows.map((r) => ({ id: r.id, epochId: r.epoch_id, senderId: r.sender_id, senderName: r.sender_name, iv: r.iv, ciphertext: r.ciphertext, createdAt: r.created_at }));
  res.json({ messages: out });
});

/** Envoyer un message chiffré : seulement dans une époque dont je fais partie. */
chat.post('/chat/messages', requireMvt, (req, res) => {
  const body = z.object({ epochId: z.number().int().positive(), iv: z.string().regex(B64).max(40), ciphertext: z.string().regex(B64).max(16_000) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Message trop long ou invalide' });
  const wrap = db.prepare('SELECT 1 FROM chat_wraps WHERE epoch_id = ? AND device_id = ?').get(body.data.epochId, req.device!.id);
  if (!wrap) return res.status(403).json({ error: 'Clé de groupe inconnue pour cet appareil.' });
  // La clé de groupe doit correspondre EXACTEMENT aux membres actuels (mêmes appareils, mêmes clés) :
  // après un retrait ou une arrivée, on refuse l'ancienne clé, l'app en ouvre une nouvelle et renvoie.
  const epochSet = (db.prepare('SELECT device_id, recipient_key FROM chat_wraps WHERE epoch_id = ?').all(body.data.epochId) as { device_id: string; recipient_key: string }[])
    .map((w) => `${w.device_id}:${w.recipient_key}`).sort().join(',');
  const currentSet = members().map((m) => `${m.id}:${m.publicKey}`).sort().join(',');
  if (epochSet !== currentSet) return res.status(409).json({ error: 'Le groupe a changé : nouvelle clé nécessaire.' });
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO chat_messages (id, epoch_id, sender_id, iv, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, body.data.epochId, req.device!.id, body.data.iv, body.data.ciphertext, now);
  broadcast('chat', { kind: 'message', id, by: req.device!.id }, SPACE);
  res.status(201).json({ id, createdAt: now });
});

/** Effacer ses propres messages (ou tout message, pour un admin du côté Mouvement). */
chat.delete('/chat/messages/:id', requireMvt, (req, res) => {
  const m = db.prepare('SELECT sender_id FROM chat_messages WHERE id = ?').get(req.params.id) as { sender_id: string } | undefined;
  if (!m) return res.status(404).json({ error: 'Message introuvable' });
  if (m.sender_id !== req.device!.id && req.device!.role !== 'admin') return res.status(403).json({ error: 'Tu ne peux effacer que tes messages.' });
  db.prepare('DELETE FROM chat_messages WHERE id = ?').run(req.params.id);
  broadcast('chat', { kind: 'delete', id: req.params.id }, SPACE);
  res.json({ ok: true });
});

/** Messages de plus de 30 jours, et époques devenues vides. */
export function cleanupChat() {
  db.prepare('DELETE FROM chat_messages WHERE created_at < ?').run(Date.now() - RETENTION_DAYS * 86400_000);
  db.exec(`DELETE FROM chat_epochs WHERE id < (SELECT COALESCE(MAX(id), 0) FROM chat_epochs)
           AND id NOT IN (SELECT DISTINCT epoch_id FROM chat_messages)`);
}
