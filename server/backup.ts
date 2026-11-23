/**
 * server/backup.ts — Script de sauvegarde, lancé à la main ou par une tâche planifiée (cron).
 *
 * Ce n'est PAS une partie du serveur web : c'est un petit programme indépendant, lancé par
 * `npm run backup` (= `tsx server/backup.ts`). Il :
 *   1. crée un dossier daté dans le dossier de destination ;
 *   2. y copie la base SQLite de façon cohérente (même si l'app tourne et écrit en même temps) ;
 *   3. y copie le dossier des photos / fichiers envoyés ;
 *   4. supprime les sauvegardes trop anciennes (rotation).
 *
 * Notions à connaître :
 *   - `process.argv` : tableau des arguments de la ligne de commande. [0] = node, [1] = le script,
 *     [2] et suivants = ce qu'on a tapé après `npm run backup --`.
 *   - Copier simplement le fichier terrain.db pendant que l'app écrit pourrait donner une copie
 *     corrompue (et en mode WAL, une partie des données est dans terrain.db-wal). VACUUM INTO
 *     demande à SQLite lui-même de produire une copie complète et cohérente.
 *   - Ce fichier n'importe pas db.ts exprès : db.ts créerait des dossiers et lancerait les migrations.
 */
// Sauvegarde cohérente de la base (même app en marche) + copie des photos.
// Usage : npm run backup -- <dossier de destination> [jours à garder]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Même règle que db.ts pour trouver les données (à garder synchronisée à la main).
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
// Dossier de destination : 1er argument, sinon un dossier « terrain-backups » à côté de DATA_DIR
// (`..` = dossier parent).
const dest = path.resolve(process.argv[2] ?? path.join(DATA_DIR, '..', 'terrain-backups'));
// Nombre de jours de sauvegardes à conserver : 2e argument, 14 par défaut.
// Attention : un texte non numérique donnerait NaN (aucune suppression, car toute comparaison avec NaN est fausse).
const keepDays = Number(process.argv[3] ?? 14);

// Horodatage utilisable comme nom de dossier. toISOString() donne « 2026-11-23T14:05:09.123Z » ;
// .slice(0, 19) garde « 2026-11-23T14:05:09 » ; la regex /[:T]/g remplace chaque ':' et 'T'
// (le `g` = « global », toutes les occurrences) par '-' -> « 2026-11-23-14-05-09 ».
// Les ':' sont interdits dans les noms de fichiers sous Windows. Heure en UTC (le « Z » d'ISO).
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = path.join(dest, stamp);
// Crée le dossier de cette sauvegarde (et `dest` au passage).
fs.mkdirSync(target, { recursive: true });

// VACUUM INTO produit une copie propre et compacte, sans bloquer l'application.
// On ouvre une seconde connexion à la même base (autorisé avec SQLite, surtout en mode WAL).
const db = new DatabaseSync(path.join(DATA_DIR, 'terrain.db'));
// Le chemin de destination est inséré dans le SQL entre apostrophes. Le `.replace(/'/g, "''")`
// double chaque apostrophe du chemin (règle d'échappement SQL : '' = une apostrophe littérale),
// pour qu'un dossier comme « l'équipe » ne casse pas la requête.
db.exec(`VACUUM INTO '${path.join(target, 'terrain.db').replace(/'/g, "''")}'`);
db.close();

// Copie récursive du dossier des fichiers envoyés (photos, archive), s'il existe.
const uploads = path.join(DATA_DIR, 'uploads');
if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(target, 'uploads'), { recursive: true });

// Rotation : on supprime les sauvegardes plus vieilles que `keepDays`.
// Date limite = maintenant − keepDays jours (86400_000 ms = 1 jour).
const limit = Date.now() - keepDays * 86400_000;
// On parcourt TOUT le contenu du dossier de destination.
for (const name of fs.readdirSync(dest)) {
  const p = path.join(dest, name);
  // On supprime un élément seulement si : ce n'est pas la sauvegarde qu'on vient de faire, c'est un
  // dossier, et sa date de dernière modification (mtimeMs) est antérieure à la limite.
  // `force: true` : pas d'erreur si l'élément a déjà disparu.
  // Attention : tout dossier ancien présent dans `dest` est concerné, même s'il n'a rien à voir
  // avec les sauvegardes — il faut donc un dossier de destination dédié.
  if (p !== target && fs.statSync(p).isDirectory() && fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { recursive: true, force: true });
}

console.log(`Sauvegarde : ${target}`);
