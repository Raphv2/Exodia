import { Router, type Request } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db } from './db';
import {
  createInvite, deviceToDto, inviteToDto, newId, newToken, rateLimit, requireDevice, requireRole,
  setSessionCookie, clearSessionCookie, sha256, parseSpaces, joinSpaces, spacesOf, coversSpaces,
  type DeviceRow, type InviteRow,
} from './auth';
import { disconnect } from './events';
import { SPACES, type CreatedInvite, type Role, type Space } from '../shared/model';

export const access = Router();

const nameSchema = z.string().trim().min(1, 'Indique un prénom ou un pseudo').max(40);

function publicBase(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const origin = req.get('origin');
  if (origin) return origin;
  return `${req.protocol}://${req.get('host')}`;
}

// ---------- Rejoindre avec une invitation ----------

access.post('/auth/claim', rateLimit(10, 60_000), (req, res) => {
  const body = z.object({ token: z.string().min(20).max(100), name: nameSchema }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });

  const now = Date.now();
  const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(body.data.token)) as InviteRow | undefined;
  if (!invite || invite.revoked_at) return res.status(410).json({ error: 'Cette invitation n\'existe pas ou a été annulée.' });
  if (invite.expires_at < now) return res.status(410).json({ error: 'Cette invitation a expiré. Demande un nouveau QR code.' });
  if (invite.uses >= invite.max_uses) return res.status(410).json({ error: 'Cette invitation a déjà été utilisée.' });

  const token = newToken();
  const id = newId();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(invite.id);
    // L'invitation fixe les espaces ; celle du tout premier lancement fait de l'appareil le propriétaire.
    const owner = invite.label === 'bootstrap' && !invite.created_by ? 1 : 0;
    db.prepare(`INSERT INTO devices (id, name, role, token_hash, invited_by, invite_id, created_at, last_seen, user_agent, spaces, owner)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, body.data.name, invite.role, sha256(token), invite.created_by, invite.id, now, now, (req.get('user-agent') ?? '').slice(0, 200),
        owner ? joinSpaces([...SPACES]) : invite.spaces, owner);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setSessionCookie(req, res, token);
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow;
  res.json({ device: deviceToDto(row) });
});

// ---------- Mon appareil ----------

access.get('/me', requireDevice, (req, res) => {
  res.json({ device: deviceToDto(req.device!) });
});

access.patch('/me', requireDevice, (req, res) => {
  const name = nameSchema.safeParse(req.body?.name);
  if (!name.success) return res.status(400).json({ error: name.error.issues[0]?.message });
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name.data, req.device!.id);
  res.json({ ok: true });
});

access.post('/auth/logout', requireDevice, (req, res) => {
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), req.device!.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- Invitations (admin, ou relais pour le « main en main ») ----------

const spacesSchema = z.array(z.enum(['lfi', 'mvt'])).min(1, 'Choisis au moins un espace').max(2);

const inviteSchema = z.object({
  role: z.enum(['admin', 'relais', 'membre']),
  ttlMinutes: z.number().int().min(5).max(7 * 24 * 60),
  maxUses: z.number().int().min(1).max(100),
  label: z.string().trim().max(60).nullish(),
  spaces: spacesSchema,
});

/**
 * Peut-on gérer cet appareil ? Le propriétaire gère tout le monde (sauf lui-même pour le retrait).
 * Un admin gère seulement les relais et membres dont tous les espaces sont aussi les siens.
 */
function canManage(me: DeviceRow, target: DeviceRow): boolean {
  if (target.owner) return false;
  if (me.owner) return true;
  return target.role !== 'admin' && coversSpaces(me, spacesOf(target));
}

access.post('/invites', requireDevice, requireRole('admin', 'relais'), async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Paramètres d\'invitation invalides' });
  let { role, ttlMinutes, maxUses } = parsed.data;
  const me = req.device!;
  const spaces = parsed.data.spaces as Space[];
  // On ne fait entrer quelqu'un que dans ses propres espaces ; seul le propriétaire nomme des admins.
  if (!coversSpaces(me, spaces)) return res.status(403).json({ error: 'Tu ne peux inviter que dans tes propres espaces.' });
  if (role === 'admin' && !me.owner) return res.status(403).json({ error: 'Seul le propriétaire peut faire entrer un admin.' });
  if (me.role === 'relais') {
    // Un relais ne peut inviter qu'une personne à la fois, en face à face.
    role = 'membre' as Role;
    ttlMinutes = Math.min(ttlMinutes, 60);
    maxUses = 1;
  }
  const { token, id } = createInvite({ role, ttlMinutes, maxUses, label: parsed.data.label || null, createdBy: me.id, spaces });
  // Le jeton est dans le fragment (#) : il n'est jamais envoyé au serveur ni dans les en-têtes Referer.
  const url = `${publicBase(req)}/#/join/${token}`;
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#00232C', light: '#ffffff' } });
  const row = db.prepare('SELECT * FROM invites WHERE id = ?').get(id) as unknown as InviteRow;
  const out: CreatedInvite = { invite: inviteToDto(row), url, qrSvg };
  res.json(out);
});

access.get('/invites', requireDevice, requireRole('admin'), (req, res) => {
  const me = req.device!;
  const rows = (db.prepare(`
    SELECT i.*, d.name AS created_by_name FROM invites i LEFT JOIN devices d ON d.id = i.created_by
    WHERE i.revoked_at IS NULL AND i.expires_at > ? AND i.uses < i.max_uses
    ORDER BY i.created_at DESC`).all(Date.now()) as unknown as InviteRow[])
    .filter((i) => me.owner || coversSpaces(me, parseSpaces(i.spaces)));
  res.json({ invites: rows.map(inviteToDto) });
});

access.delete('/invites/:id', requireDevice, requireRole('admin', 'relais'), (req, res) => {
  const me = req.device!;
  const inv = db.prepare('SELECT * FROM invites WHERE id = ?').get(req.params.id) as InviteRow | undefined;
  if (!inv) return res.json({ ok: true });
  const allowed = me.owner || inv.created_by === me.id || (me.role === 'admin' && coversSpaces(me, parseSpaces(inv.spaces)));
  if (!allowed) return res.status(403).json({ error: 'Tu ne peux pas annuler cette invitation.' });
  db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(Date.now(), inv.id);
  res.json({ ok: true });
});

// ---------- Appareils (admin) ----------

access.get('/devices', requireDevice, requireRole('admin'), (req, res) => {
  const me = req.device!;
  // Un admin ne voit que les appareils qui partagent au moins un de ses espaces.
  const rows = (db.prepare(`
    SELECT d.*, p.name AS invited_by_name FROM devices d LEFT JOIN devices p ON p.id = d.invited_by
    WHERE d.revoked_at IS NULL ORDER BY d.created_at DESC`).all() as unknown as DeviceRow[])
    .filter((d) => me.owner || spacesOf(d).some((s) => spacesOf(me).includes(s)));
  res.json({ devices: rows.map((d) => ({ ...deviceToDto(d), manageable: canManage(me, d) })) });
});

function activeAdminCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM devices WHERE role = 'admin' AND revoked_at IS NULL").get() as { n: number }).n;
}

access.patch('/devices/:id', requireDevice, requireRole('admin'), (req, res) => {
  const body = z.object({ role: z.enum(['admin', 'relais', 'membre']).optional(), name: nameSchema.optional(), spaces: spacesSchema.optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });
  const target = db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').get(req.params.id) as DeviceRow | undefined;
  if (!target) return res.status(404).json({ error: 'Appareil introuvable' });
  const me = req.device!;
  if (target.owner) return res.status(403).json({ error: 'Le propriétaire ne peut pas être modifié.' });
  if (!canManage(me, target)) return res.status(403).json({ error: 'Tu ne peux pas gérer cet appareil.' });
  if (body.data.role === 'admin' && !me.owner) return res.status(403).json({ error: 'Seul le propriétaire peut nommer un admin.' });
  if (body.data.spaces && !coversSpaces(me, body.data.spaces as Space[])) return res.status(403).json({ error: 'Tu ne peux donner que tes propres espaces.' });
  if (body.data.spaces) db.prepare('UPDATE devices SET spaces = ? WHERE id = ?').run(joinSpaces(body.data.spaces as Space[]), target.id);
  if (body.data.role && target.role === 'admin' && body.data.role !== 'admin' && activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'Il doit rester au moins un admin.' });
  }
  if (body.data.role) db.prepare('UPDATE devices SET role = ? WHERE id = ?').run(body.data.role, target.id);
  if (body.data.name) db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(body.data.name, target.id);
  res.json({ ok: true });
});

access.delete('/devices/:id', requireDevice, requireRole('admin'), (req, res) => {
  const cascade = req.query.cascade === '1';
  const target = db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').get(req.params.id) as DeviceRow | undefined;
  if (!target) return res.status(404).json({ error: 'Appareil introuvable' });
  const me = req.device!;
  if (target.owner) return res.status(403).json({ error: 'Le propriétaire ne peut pas être retiré.' });
  if (!canManage(me, target)) return res.status(403).json({ error: 'Tu ne peux pas retirer cet appareil.' });

  // Révocation en cascade : l'appareil et tous ceux qu'il a fait entrer (et ainsi de suite),
  // limitée à ceux que je peux gérer (jamais le propriétaire, jamais un autre espace que les miens).
  const tree = cascade
    ? (db.prepare(`
        WITH RECURSIVE tree(id) AS (
          SELECT ? UNION SELECT d.id FROM devices d JOIN tree t ON d.invited_by = t.id WHERE d.revoked_at IS NULL
        ) SELECT d.* FROM devices d JOIN tree t ON t.id = d.id`).all(target.id) as unknown as DeviceRow[])
    : [target];
  const ids = tree.filter((d) => d.id === target.id || canManage(me, d)).map((d) => d.id);

  const adminsLost = (db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE role = 'admin' AND revoked_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number }).n;
  if (adminsLost > 0 && activeAdminCount() - adminsLost < 1) {
    return res.status(400).json({ error: 'Impossible : il ne resterait plus aucun admin.' });
  }
  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE devices SET revoked_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
  db.prepare(`UPDATE invites SET revoked_at = ? WHERE revoked_at IS NULL AND created_by IN (${placeholders})`).run(now, ...ids);
  disconnect(ids);
  res.json({ ok: true, revoked: ids.length });
});
