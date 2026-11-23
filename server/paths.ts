/**
 * server/paths.ts — Où sont rangées les données. Une seule source de vérité, importée par db.ts
 * (le serveur) et par backup.ts (le script de sauvegarde), qui ne doivent jamais diverger.
 *
 * DATA_DIR : variable d'environnement, sinon le dossier « data » à côté de là où on lance le serveur.
 * `path.resolve` transforme un chemin relatif en chemin absolu.
 */
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
// Sous-dossier des fichiers envoyés (photos des points, documents de l'archive).
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
