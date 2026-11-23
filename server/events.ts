/**
 * server/events.ts — Notifications en temps réel du serveur vers les navigateurs (SSE).
 *
 * À quoi sert ce fichier ?
 *   Quand quelqu'un crée ou modifie un point, les autres téléphones doivent le voir sans recharger.
 *   On utilise les « Server-Sent Events » (SSE) : le navigateur ouvre UNE requête HTTP GET qui ne
 *   se termine jamais (/api/stream) ; le serveur y écrit des messages au fil de l'eau.
 *   Côté navigateur, c'est l'objet `EventSource` qui reçoit ces messages.
 *
 * Qui l'appelle ?
 *   - index.ts branche `stream` sur la route GET /api/stream (après requireDevice).
 *   - Les routes (routes-points.ts, routes-votes.ts, routes-chat.ts…) appellent `broadcast(...)`
 *     après une modification.
 *   - routes-access.ts appelle `disconnect(...)` quand des appareils sont révoqués.
 *
 * Notions à connaître :
 *   - Format SSE : du texte, chaque message est fait de lignes « event: nom » et « data: … »,
 *     terminé par une ligne vide (d'où les `\n\n`). Une ligne qui commence par « : » est un
 *     commentaire ignoré par le navigateur (utilisé ici comme « ping »).
 *   - Tout est en mémoire : si le serveur redémarre, les navigateurs se reconnectent seuls.
 *   - SSE est à sens unique (serveur -> client). Pour envoyer, le client fait des requêtes normales.
 */
import type { Request, Response } from 'express';
import { db } from './db';
import { parseSpaces } from './auth';

/** Diffusion temps réel (Server-Sent Events) : prévient les appareils qu'un point a changé. */
// Liste des connexions ouvertes. Clé = l'objet réponse (le « tuyau » vers un navigateur),
// valeur = l'id de l'appareil connecté. Un même appareil peut avoir plusieurs onglets, donc
// plusieurs entrées.
const clients = new Map<Response, string>();

/**
 * Route GET /api/stream : ouvre le flux pour l'appareil connecté.
 * Ne renvoie rien et n'appelle jamais `res.end()` : la réponse reste ouverte volontairement.
 */
export function stream(req: Request, res: Response) {
  res.set({
    // Type MIME qui indique au navigateur qu'il s'agit d'un flux SSE.
    'Content-Type': 'text/event-stream',
    // Interdit toute mise en cache ou transformation (compression…) par un intermédiaire.
    'Cache-Control': 'no-cache, no-transform',
    // Garde la connexion TCP ouverte.
    Connection: 'keep-alive',
    // Spécifique à Nginx : désactive la mise en tampon, sinon les messages arriveraient en retard.
    'X-Accel-Buffering': 'no',
  });
  // Envoie tout de suite les en-têtes (sans attendre un premier contenu) : le navigateur sait
  // ainsi que la connexion est établie.
  res.flushHeaders();
  // Instruction SSE : en cas de coupure, le navigateur réessaiera de se connecter après 5 s.
  res.write('retry: 5000\n\n');
  // On enregistre cette connexion. `req.device!` : le `!` (« non-null assertion ») dit à TypeScript
  // « je sais que device existe » — vrai car requireDevice est placé avant cette route.
  // Au plus 5 connexions par appareil (plusieurs onglets) : au-delà, on ferme la plus ancienne.
  const mine = [...clients].filter(([, id]) => id === req.device!.id).map(([r]) => r);
  if (mine.length >= 5) { mine[0].end(); clients.delete(mine[0]); }
  clients.set(res, req.device!.id);
  // Quand le navigateur ferme la connexion (onglet fermé, réseau perdu), on l'oublie.
  req.on('close', () => clients.delete(res));
}

// Relit en base les espaces de l'appareil (et vérifie qu'il n'est pas révoqué) au moment de diffuser :
// ainsi un changement d'espaces ou une révocation est pris en compte immédiatement.
const spacesOfDevice = db.prepare('SELECT spaces FROM devices WHERE id = ? AND revoked_at IS NULL');

/**
 * Diffuse un événement. Avec `space`, seuls les appareils qui ont accès à cet espace le reçoivent :
 * rien ne fuit d'un espace à l'autre, pas même un titre dans une notification.
 */
// Entrées : `event` = nom de l'événement (ex. 'point'), `data` = contenu (objet transformé en JSON,
// `{}` par défaut), `space` = facultatif ('lfi' ou 'mvt'). Sans `space`, tout le monde reçoit.
// `Record<string, unknown>` = « un objet dont les clés sont des textes et les valeurs de n'importe
// quel type » ; `unknown` est plus sûr que `any` car il oblige à vérifier avant d'utiliser.
// `space` est désormais OBLIGATOIRE : l'oublier aurait envoyé l'information aux deux espaces.
export function broadcast(event: string, data: Record<string, unknown>, space: string) {
  // Le message est fabriqué une seule fois, avec l'espace (le client sait d'où il vient).
  const payload = `event: ${event}\ndata: ${JSON.stringify({ ...data, space })}\n\n`;
  // Une seule lecture en base par APPAREIL et par diffusion (et non une par connexion ouverte).
  const allowed = new Map<string, boolean>();
  for (const [res, deviceId] of clients) {
    if (!allowed.has(deviceId)) {
      const row = spacesOfDevice.get(deviceId) as { spaces: string } | undefined;
      // Appareil révoqué (row absent) ou sans accès à cet espace : pas de message.
      allowed.set(deviceId, !!row && parseSpaces(row.spaces).includes(space as never));
    }
    if (allowed.get(deviceId)) res.write(payload);
  }
}

/** Coupe le flux des appareils révoqués. */
// Entrée : liste d'ids d'appareils. Chaque connexion concernée reçoit un dernier événement
// 'revoked' (le client peut alors afficher « accès retiré ») puis est fermée.
export function disconnect(deviceIds: string[]) {
  for (const [res, id] of clients) {
    if (deviceIds.includes(id)) {
      res.write('event: revoked\ndata: {}\n\n');
      res.end();
      // Supprimer une entrée pendant qu'on parcourt une Map est autorisé en JavaScript.
      clients.delete(res);
    }
  }
}

// Toutes les 25 s, on envoie un commentaire SSE (« : ping ») à chaque client : beaucoup de proxys
// et d'hébergeurs coupent une connexion silencieuse au bout de 30 à 60 s.
// `.unref()` : ce minuteur ne doit pas empêcher Node de s'arrêter s'il ne reste que lui.
setInterval(() => {
  for (const res of clients.keys()) res.write(': ping\n\n');
}, 25_000).unref();
