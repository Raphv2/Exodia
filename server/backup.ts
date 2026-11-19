// Sauvegarde cohérente de la base (même app en marche) + copie des photos.
// Usage : npm run backup -- <dossier de destination> [jours à garder]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const dest = path.resolve(process.argv[2] ?? path.join(DATA_DIR, '..', 'terrain-backups'));
const keepDays = Number(process.argv[3] ?? 14);

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = path.join(dest, stamp);
fs.mkdirSync(target, { recursive: true });

// VACUUM INTO produit une copie propre et compacte, sans bloquer l'application.
const db = new DatabaseSync(path.join(DATA_DIR, 'terrain.db'));
db.exec(`VACUUM INTO '${path.join(target, 'terrain.db').replace(/'/g, "''")}'`);
db.close();

const uploads = path.join(DATA_DIR, 'uploads');
if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(target, 'uploads'), { recursive: true });

// Rotation : on supprime les sauvegardes plus vieilles que `keepDays`.
const limit = Date.now() - keepDays * 86400_000;
for (const name of fs.readdirSync(dest)) {
  const p = path.join(dest, name);
  if (p !== target && fs.statSync(p).isDirectory() && fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { recursive: true, force: true });
}

console.log(`Sauvegarde : ${target}`);
