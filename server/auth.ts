import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db';
import type { Device, Invite, Role } from '../shared/model';

export const COOKIE = 'terrain_sid';
const COOKIE_MAX_AGE = 400 * 86400 * 1000;

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
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: DeviceRow;
    }
  }
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const newId = () => crypto.randomBytes(12).toString('base64url');

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isHttps(req: Request) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

export function setSessionCookie(req: Request, res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps(req),
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE, { path: '/' });
}

const findDevice = db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL');
const touchDevice = db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?');

/** Exige un appareil enregistré et non révoqué. */
export function requireDevice(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  if (!token) return res.status(401).json({ error: 'Appareil non autorisé' });
  const row = findDevice.get(sha256(token)) as DeviceRow | undefined;
  if (!row) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Accès révoqué ou expiré' });
  }
  const now = Date.now();
  if (!row.last_seen || now - row.last_seen > 60_000) touchDevice.run(now, row.id);
  req.device = row;
  next();
}

export const requireRole = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.device || !roles.includes(req.device.role)) return res.status(403).json({ error: 'Droits insuffisants' });
  next();
};

/**
 * Protection CSRF : toute requête qui modifie quelque chose doit porter l'en-tête
 * X-Terrain, qu'un autre site ne peut pas ajouter sans CORS (que l'on n'autorise pas).
 */
export function csrf(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-terrain') !== '1') return res.status(403).json({ error: 'Requête refusée' });
  next();
}

/** Limiteur très simple, en mémoire, par IP. */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (list.length > max) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans une minute' });
    next();
  };
}

// ---------- Invitations ----------

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
}

const insertInvite = db.prepare(`
  INSERT INTO invites (id, token_hash, role, label, max_uses, uses, expires_at, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`);

export function createInvite(opts: { role: Role; ttlMinutes: number; maxUses: number; label: string | null; createdBy: string | null }) {
  const token = newToken();
  const id = newId();
  const now = Date.now();
  insertInvite.run(id, sha256(token), opts.role, opts.label, opts.maxUses, now + opts.ttlMinutes * 60_000, opts.createdBy, now);
  return { token, id };
}

export function inviteToDto(r: InviteRow & { created_by_name?: string | null }): Invite {
  return {
    id: r.id,
    role: r.role,
    label: r.label,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: r.expires_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? null,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

export function deviceToDto(r: DeviceRow & { invited_by_name?: string | null }): Device {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    invitedBy: r.invited_by,
    invitedByName: r.invited_by_name ?? null,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
    revokedAt: r.revoked_at,
    userAgent: r.user_agent,
  };
}

/** Si aucun admin n'existe, crée une invitation admin à usage unique et l'affiche dans la console. */
export function ensureBootstrapAdmin(baseUrl: string) {
  const admins = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE role = 'admin' AND revoked_at IS NULL").get() as { n: number };
  if (admins.n > 0) return;
  db.prepare("UPDATE invites SET revoked_at = ? WHERE label = 'bootstrap' AND revoked_at IS NULL").run(Date.now());
  const { token } = createInvite({ role: 'admin', ttlMinutes: 24 * 60, maxUses: 1, label: 'bootstrap', createdBy: null });
  const line = '─'.repeat(72);
  console.log(`\n${line}\n  Aucun admin pour l'instant. Ouvre ce lien (valable 24 h, usage unique)\n  sur l'appareil qui sera admin :\n\n  ${baseUrl}/#/join/${token}\n${line}\n`);
}
