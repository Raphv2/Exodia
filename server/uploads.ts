/**
 * server/uploads.ts — Registre des fichiers envoyés (photos des points, documents de l'archive).
 *
 * Pourquoi ce registre ?
 *   L'envoi d'un fichier se fait en deux temps : 1) on envoie les octets, le serveur répond avec un
 *   nom aléatoire ; 2) on crée le point ou le document qui « contient » ce nom. Sans registre, rien
 *   n'empêchait l'étape 2 d'utiliser le nom d'un fichier envoyé par quelqu'un d'autre, ou déjà
 *   rattaché à un autre élément. Conséquences possibles : supprimer un élément effaçait le fichier
 *   de l'autre, et un document privé pouvait devenir public en étant « réutilisé » par un document public.
 *
 * La règle, désormais : un fichier ne peut être rattaché que
 *   - par l'appareil qui l'a envoyé ;
 *   - à un seul élément (vérifié ici, et garanti par un index UNIQUE en base).
 * Tant qu'il n'est rattaché à rien, seul l'appareil qui l'a envoyé peut le voir.
 */
import { db } from './db';

export type UploadKind = 'photo' | 'archive';

db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    name        TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('photo', 'archive')),
    device_id   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
`);

/**
 * Crée un index UNIQUE « partiel » (seulement les lignes où le fichier n'est pas NULL) : la base
 * refuse alors elle-même qu'un même fichier soit rattaché à deux éléments. Appelé par chaque module
 * juste après la création de sa table. try/catch : une ancienne base qui contiendrait déjà un
 * doublon démarre quand même (le contrôle applicatif de claimError reste actif).
 */
export function uniqueFileIndex(name: string, table: string, column: string) {
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table}(${column}) WHERE ${column} IS NOT NULL`);
  } catch (e) {
    console.warn(`Index ${name} non créé (doublon existant) :`, (e as Error).message);
  }
}
uniqueFileIndex('points_photo_unique', 'points', 'photo');

/** Note qu'un appareil vient d'envoyer ce fichier. */
export function registerUpload(name: string, kind: UploadKind, deviceId: string) {
  db.prepare('INSERT OR REPLACE INTO uploads (name, kind, device_id, created_at) VALUES (?, ?, ?, ?)').run(name, kind, deviceId, Date.now());
}

/** Qui a envoyé ce fichier (undefined si inconnu, par ex. un fichier d'avant ce registre). */
export function uploaderOf(name: string, kind: UploadKind): string | undefined {
  return (db.prepare('SELECT device_id FROM uploads WHERE name = ? AND kind = ?').get(name, kind) as { device_id: string } | undefined)?.device_id;
}

/** Oublie un fichier (supprimé du disque). */
export function forgetUpload(name: string) {
  db.prepare('DELETE FROM uploads WHERE name = ?').run(name);
}

/**
 * Peut-on rattacher ce fichier à un nouvel élément ? Renvoie un message d'erreur, ou null si oui.
 * `usedElsewhere` : vrai si le fichier est déjà rattaché à un autre élément.
 */
export function claimError(name: string, kind: UploadKind, deviceId: string, usedElsewhere: boolean): string | null {
  if (usedElsewhere) return 'Ce fichier est déjà utilisé ailleurs : envoie-le à nouveau.';
  if (uploaderOf(name, kind) !== deviceId) return 'Le fichier n\'a pas été reçu, réessaie.';
  return null;
}
