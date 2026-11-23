import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'terrain.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('admin','relais','membre')),
    token_hash  TEXT NOT NULL UNIQUE,
    invited_by  TEXT,
    invite_id   TEXT,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER,
    revoked_at  INTEGER,
    user_agent  TEXT
  );

  CREATE TABLE IF NOT EXISTS invites (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL CHECK (role IN ('admin','relais','membre')),
    label       TEXT,
    max_uses    INTEGER NOT NULL,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    revoked_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS points (
    id                TEXT PRIMARY KEY,
    mode              TEXT NOT NULL,
    type              TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    lat               REAL NOT NULL,
    lng               REAL NOT NULL,
    color             TEXT,
    photo             TEXT,
    starts_at         INTEGER,
    ends_at           INTEGER,
    recurrence        TEXT NOT NULL DEFAULT 'none',
    recurrence_until  INTEGER,
    expires_at        INTEGER,
    status            TEXT,
    created_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS points_expires ON points(expires_at);

  CREATE TABLE IF NOT EXISTS problems (
    id           TEXT PRIMARY KEY,
    point_id     TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    message      TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    resolved_at  INTEGER,
    resolved_by  TEXT
  );

  CREATE INDEX IF NOT EXISTS problems_point ON problems(point_id);
`);

// Engagements sur un événement : « je participe » et « je fournis tel matériel » (indépendants).
db.exec(`
  CREATE TABLE IF NOT EXISTS pledges (
    point_id    TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('participe','fournit')),
    item        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (point_id, device_id, kind, item)
  );
`);

// Migrations légères (ajout de colonnes sur une base existante).
const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
if (!cols('points').includes('parent_id')) db.exec('ALTER TABLE points ADD COLUMN parent_id TEXT');
if (!cols('pledges').includes('arrive_at')) db.exec('ALTER TABLE pledges ADD COLUMN arrive_at INTEGER');
// Espaces LFI / Mouvement : chaque point appartient à un espace, chaque appareil a accès à un ou deux espaces.
if (!cols('points').includes('space')) {
  db.exec("ALTER TABLE points ADD COLUMN space TEXT NOT NULL DEFAULT 'lfi'");
  db.exec("UPDATE points SET space = 'mvt' WHERE type IN ('blocus', 'blocage', 'police')");
}
if (!cols('devices').includes('spaces')) db.exec("ALTER TABLE devices ADD COLUMN spaces TEXT NOT NULL DEFAULT 'lfi,mvt'");
if (!cols('devices').includes('owner')) db.exec('ALTER TABLE devices ADD COLUMN owner INTEGER NOT NULL DEFAULT 0');
if (!cols('invites').includes('spaces')) db.exec("ALTER TABLE invites ADD COLUMN spaces TEXT NOT NULL DEFAULT 'lfi,mvt'");
// Un seul propriétaire : s'il n'y en a pas encore, c'est le plus ancien admin.
db.exec(`UPDATE devices SET owner = 1, spaces = 'lfi,mvt' WHERE id = (
  SELECT id FROM devices WHERE role = 'admin' AND revoked_at IS NULL ORDER BY created_at LIMIT 1
) AND NOT EXISTS (SELECT 1 FROM devices WHERE owner = 1 AND revoked_at IS NULL)`);
db.exec('CREATE INDEX IF NOT EXISTS points_space ON points(space)');
if (!cols('points').includes('public')) db.exec('ALTER TABLE points ADD COLUMN public INTEGER NOT NULL DEFAULT 0');
if (!cols('points').includes('confirmed_at')) db.exec('ALTER TABLE points ADD COLUMN confirmed_at INTEGER');
if (!cols('problems').includes('confirmed_at')) db.exec('ALTER TABLE problems ADD COLUMN confirmed_at INTEGER');
if (!cols('points').includes('flash')) db.exec('ALTER TABLE points ADD COLUMN flash INTEGER NOT NULL DEFAULT 0');
if (!cols('points').includes('material')) db.exec('ALTER TABLE points ADD COLUMN material TEXT');
if (!cols('points').includes('status_at')) db.exec('ALTER TABLE points ADD COLUMN status_at INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS points_parent ON points(parent_id)');
// Les blocages étaient des événements : ce sont désormais des points fixes (la barricade reste en place).
db.exec(`UPDATE points SET mode = 'fixe', starts_at = NULL, ends_at = NULL, recurrence = 'none', recurrence_until = NULL,
         expires_at = NULL, status = COALESCE(status, 'vide') WHERE type = 'blocage' AND mode = 'event'`);
