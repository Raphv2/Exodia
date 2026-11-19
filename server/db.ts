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
`);
