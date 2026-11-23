/**
 * server/backup.ts — Script de sauvegarde, lancé à la main, par une tâche planifiée, ou en continu.
 *
 * Ce n'est PAS une partie du serveur web : c'est un petit programme indépendant, lancé par
 * `npm run backup` (= `tsx server/backup.ts`). Chaque sauvegarde :
 *   1. crée un dossier daté dans le dossier de destination ;
 *   2. y copie la base SQLite de façon cohérente (même si l'app tourne et écrit en même temps) ;
 *   3. y copie le dossier des photos / fichiers envoyés ;
 *   4. supprime les sauvegardes trop anciennes (rotation), et SEULEMENT des dossiers de sauvegarde.
 *
 * Deux façons de le lancer :
 *   - `npm run backup -- <destination> [jours]` : une sauvegarde, puis le programme s'arrête ;
 *   - `npm run backup -- <destination> [jours] --daemon` : reste allumé et fait une sauvegarde
 *     chaque nuit à BACKUP_HOUR (4 h par défaut, heure locale = variable TZ). C'est ce que fait le
 *     service « backup » de docker-compose.yml.
 *
 * Notions à connaître :
 *   - `process.argv` : tableau des arguments de la ligne de commande. [0] = node, [1] = le script,
 *     [2] et suivants = ce qu'on a tapé après `npm run backup --`.
 *   - Copier simplement le fichier terrain.db pendant que l'app écrit pourrait donner une copie
 *     corrompue (et en mode WAL, une partie des données est dans terrain.db-wal). VACUUM INTO
 *     demande à SQLite lui-même de produire une copie complète et cohérente.
 *   - Ce fichier n'importe pas db.ts exprès : db.ts créerait des dossiers et lancerait les migrations.
 *     Il importe seulement paths.ts, qui dit où sont les données (une seule source de vérité).
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, UPLOAD_DIR } from './paths';

// Arguments « positionnels » (ceux qui ne commencent pas par --) et options (--daemon).
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const daemon = process.argv.includes('--daemon');
// Dossier de destination : 1er argument, sinon un dossier « terrain-backups » à côté de DATA_DIR.
const dest = path.resolve(args[0] ?? path.join(DATA_DIR, '..', 'terrain-backups'));
// Nombre de jours à conserver : 2e argument, 14 par défaut. Refus net d'une valeur absurde
// (avant, un texte non numérique donnait NaN et la rotation ne supprimait plus rien, sans rien dire).
const keepDays = Number(args[1] ?? 14);
if (!Number.isInteger(keepDays) || keepDays < 1) {
  console.error(`Nombre de jours invalide : « ${args[1]} » (attendu : un entier ≥ 1).`);
  process.exit(1);
}
// Heure de la sauvegarde quotidienne en mode --daemon (0 à 23).
const hour = Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR ?? 4) || 0));

// Nom d'un dossier de sauvegarde : « 2026-11-23-04-00-00 ». La rotation ne touche QUE les dossiers
// qui ont exactement cette forme : un autre dossier rangé là par erreur n'est jamais effacé.
const STAMP = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

/** Fait UNE sauvegarde complète et renvoie son dossier. */
export function backupOnce(): string {
  // Horodatage utilisable comme nom de dossier (les « : » sont interdits sous Windows). Heure UTC.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const target = path.join(dest, stamp);
  fs.mkdirSync(target, { recursive: true });

  // VACUUM INTO : copie propre et cohérente, sans bloquer l'application.
  // Le chemin est inséré dans le SQL entre apostrophes : on double chaque apostrophe (échappement SQL).
  const db = new DatabaseSync(path.join(DATA_DIR, 'terrain.db'));
  try {
    db.exec(`VACUUM INTO '${path.join(target, 'terrain.db').replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  // Copie des fichiers envoyés (photos, archive). Faite juste après la base : un fichier envoyé
  // dans la seconde qui sépare les deux copies peut manquer, ce qui est sans gravité
  // (le ménage efface de toute façon les fichiers que la base ne référence pas).
  if (fs.existsSync(UPLOAD_DIR)) fs.cpSync(UPLOAD_DIR, path.join(target, 'uploads'), { recursive: true });

  rotate(target);
  return target;
}

/** Supprime les sauvegardes plus vieilles que keepDays (seulement les dossiers datés). */
function rotate(keep: string) {
  const limit = Date.now() - keepDays * 86400_000;
  for (const name of fs.readdirSync(dest)) {
    if (!STAMP.test(name)) continue;
    const p = path.join(dest, name);
    if (p === keep) continue;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() && st.mtimeMs < limit) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* dossier disparu entre-temps : rien à faire */ }
  }
}

/** Millisecondes jusqu'à la prochaine occurrence de `hour` h 00 (heure locale). */
function untilNext(h: number): number {
  const next = new Date();
  next.setHours(h, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

/** Lance une sauvegarde en affichant le résultat, sans jamais faire planter le mode --daemon. */
function run() {
  try {
    console.log(`Sauvegarde : ${backupOnce()}`);
  } catch (e) {
    console.error('Échec de la sauvegarde :', e);
    if (!daemon) process.exitCode = 1;
  }
}

if (!daemon) {
  run();
} else {
  // Mode continu : une sauvegarde tout de suite (on sait ainsi dès le démarrage que ça marche),
  // puis chaque jour à `hour` h. setTimeout est recalculé à chaque fois : pas de dérive, et le
  // changement d'heure été/hiver est pris en compte.
  console.log(`Sauvegardes quotidiennes à ${hour} h dans ${dest} (gardées ${keepDays} jours).`);
  run();
  const loop = () => setTimeout(() => { run(); loop(); }, untilNext(hour));
  loop();
}
