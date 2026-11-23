/*
 * routes-chat.ts — API HTTP du chat chiffré (côté Mouvement).
 *
 * Qui l'appelle ? server/index.ts monte le routeur `chat` sous /api, derrière requireDevice (il faut être un
 * appareil enregistré) ; le client correspondant est web/src/chat.ts (via web/src/api.ts). index.ts appelle
 * aussi cleanupChat() au démarrage puis toutes les heures.
 *
 * Notions : ce serveur est un simple « facteur aveugle ». Il stocke et redistribue des clés publiques,
 * des enveloppes et des messages chiffrés qu'il ne sait pas ouvrir (toute la crypto est dans
 * web/src/chat-crypto.ts). Son seul vrai rôle de sécurité ici : contrôler QUI a le droit de poster et
 * s'assurer que la clé de groupe utilisée correspond bien aux membres actuels (sinon réponse 409, et le
 * client ouvre une nouvelle époque).
 *
 * Rappel des codes HTTP utilisés : 400 = données invalides, 403 = interdit, 404 = introuvable,
 * 409 = « conflit » (ta vision du groupe n'est plus à jour, recommence), 201 = créé.
 */
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { db, tx } from './db';
import { hasSpace, newId, parseSpaces, rateLimit } from './auth';
import { broadcast } from './events';
import type { ChatEpochKey, ChatMember, ChatMessage } from '../shared/model';

/*
 * Chat du côté Mouvement, chiffré de bout en bout.
 *
 * Le serveur ne voit JAMAIS le texte des messages ni les clés de lecture :
 * - chaque appareil crée sa paire de clés (ECDH P-256) dans le navigateur ; la clé privée n'en sort pas ;
 *   il publie ici sa clé publique ;
 * - une « époque » = une clé de groupe (AES-GCM 256) tirée au hasard par un appareil, valable pour une liste
 *   précise de membres ; il la chiffre pour chaque membre (ECDH + HKDF) et ne nous envoie que ces enveloppes ;
 * - dès que la liste des membres change (arrivée, départ, retrait), le prochain message ouvre une nouvelle
 *   époque : un nouvel arrivant ne lit pas l'historique, une personne retirée ne lit plus la suite ;
 * - les messages sont stockés chiffrés (avec leur IV) et effacés au bout de 30 jours.
 * Ce que le serveur connaît quand même : qui écrit, quand, et la taille des messages (les « métadonnées »).
 */

// Le chat n'existe que dans l'espace « Mouvement » (code 'mvt').
const SPACE = 'mvt';
// Durée de conservation des messages (règle métier : on ne garde pas d'historique long, par prudence).
const RETENTION_DAYS = 30;

/*
 * Création des tables au chargement du module (IF NOT EXISTS : sans effet si elles existent déjà).
 * - chat_keys : la clé publique (JWK texte) de chaque appareil qui a ouvert le chat ;
 * - chat_epochs : une ligne par époque (id croissant ; la plus grande = la plus récente) ;
 * - chat_wraps : les enveloppes. Une par (époque, destinataire). On garde aussi qui l'a faite (sender_id),
 *   avec quelle clé publique (sender_key, nécessaire au destinataire pour refaire l'ECDH), et pour quelle
 *   clé du destinataire (recipient_key, pour détecter qu'un membre a changé de clé) ;
 * - chat_messages : les messages chiffrés (iv + ciphertext en base64url), rattachés à une époque.
 * ON DELETE CASCADE : supprimer une époque supprime ses enveloppes et messages (db.ts active
 * PRAGMA foreign_keys = ON, sans quoi SQLite ignorerait cette règle).
 * L'index sur created_at accélère la pagination et le nettoyage des vieux messages.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_keys (
    device_id   TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_epochs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    members     TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_wraps (
    epoch_id    INTEGER NOT NULL REFERENCES chat_epochs(id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    sender_key  TEXT NOT NULL,
    recipient_key TEXT NOT NULL,
    wrapped     TEXT NOT NULL,
    iv          TEXT NOT NULL,
    PRIMARY KEY (epoch_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id          TEXT PRIMARY KEY,
    epoch_id    INTEGER NOT NULL REFERENCES chat_epochs(id) ON DELETE CASCADE,
    sender_id   TEXT NOT NULL,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_messages_time ON chat_messages(created_at);
`);
// La colonne chat_epochs.members n'était jamais relue (les membres d'une époque sont ceux de ses
// enveloppes, table chat_wraps) : on la supprime des anciennes bases. DROP COLUMN existe depuis
// SQLite 3.35 (inclus dans Node 22). try/catch : sans effet si elle n'existe pas.
if ((db.prepare('PRAGMA table_info(chat_epochs)').all() as { name: string }[]).some((c) => c.name === 'members')) {
  try { db.exec('ALTER TABLE chat_epochs DROP COLUMN members'); } catch { /* ancienne version de SQLite : on la laisse */ }
}
// Index pour la pagination (date, puis id pour départager deux messages de la même milliseconde).
db.exec('CREATE INDEX IF NOT EXISTS chat_messages_cursor ON chat_messages(created_at, id)');

// Caractères autorisés pour du base64 / base64url : on refuse tout le reste (pas d'injection de texte arbitraire).
const B64 = /^[A-Za-z0-9+/=_-]+$/;
/** Clé publique : JWK EC P-256 (x, y en base64url), rien d'autre. */
// .strict() rejette tout champ en plus (ex. un champ « d », qui serait une clé PRIVÉE envoyée par erreur).
const jwkSchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().regex(B64).max(64), y: z.string().regex(B64).max(64) }).strict();
// Une clé publique telle que stockée : le JSON exact {"kty":"EC","crv":"P-256","x":"…","y":"…"}.
const KEY_TEXT = /^\{"kty":"EC","crv":"P-256","x":"[A-Za-z0-9_-]{20,64}","y":"[A-Za-z0-9_-]{20,64}"\}$/;

// Limites de débit par appareil (pas par IP) : de quoi discuter normalement, pas de quoi remplir le disque.
const byDevice = { key: (req: import('express').Request) => `dev:${req.device?.id ?? req.ip}` };
const messageLimit = rateLimit(60, 60_000, { ...byDevice, message: 'Trop de messages d\'un coup, ralentis un peu.' });
const epochLimit = rateLimit(10, 60_000, byDevice);

// Le routeur exporté, monté par server/index.ts.
export const chat = Router();

/*
 * Garde (« middleware ») commune à toutes les routes : l'appareil doit avoir accès à l'espace Mouvement.
 * req.device est forcément rempli ici car requireDevice passe avant (d'où le « ! »).
 */
const requireMvt: RequestHandler = (req, res, next) => {
  if (!hasSpace(req.device!, SPACE)) return res.status(403).json({ error: 'Le chat est réservé au côté Mouvement.' });
  next();
};

/** Membres actuels : appareils actifs du côté Mouvement qui ont publié leur clé. */
/*
 * C'est LA définition du groupe : appareil non révoqué + accès à 'mvt' + clé publiée.
 * Le filtre sur l'espace se fait en JavaScript (parseSpaces) car `spaces` est une liste texte « lfi,mvt ».
 * Sortie triée par nom, avec { id, name, publicKey }.
 * Conséquence : révoquer un appareil ou lui retirer 'mvt' le sort immédiatement du groupe.
 */
function members(): ChatMember[] {
  const rows = db.prepare(`SELECT d.id, d.name, d.spaces, k.public_key FROM devices d JOIN chat_keys k ON k.device_id = d.id
    WHERE d.revoked_at IS NULL ORDER BY d.name`).all() as { id: string; name: string; spaces: string; public_key: string }[];
  return rows.filter((r) => parseSpaces(r.spaces).includes(SPACE)).map((r) => ({ id: r.id, name: r.name, publicKey: r.public_key }));
}

/** Publier (ou remplacer) la clé publique de mon appareil. */
/*
 * PUT /api/chat/key  — corps : { publicKey: { kty, crv, x, y } }. Réponse : { ok: true }.
 * Appelé par le client à chaque synchronisation ; ne fait quelque chose que si la clé a changé.
 */
chat.put('/chat/key', requireMvt, (req, res) => {
  // Validation stricte du JWK reçu (voir jwkSchema).
  const jwk = jwkSchema.safeParse(req.body?.publicKey);
  if (!jwk.success) return res.status(400).json({ error: 'Clé publique invalide' });
  // On reconstruit le texte dans un ordre de champs FIXE : c'est la forme « canonique » que le client
  // produit aussi, ce qui permet ensuite de comparer des clés par simple égalité de chaînes.
  const value = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.data.x, y: jwk.data.y });
  const prev = db.prepare('SELECT public_key FROM chat_keys WHERE device_id = ?').get(req.device!.id) as { public_key: string } | undefined;
  // Rien à faire si la même clé est déjà enregistrée (évite des notifications inutiles à chaque sync).
  if (prev?.public_key !== value) {
    // « Upsert » : insère, ou met à jour si l'appareil a déjà une ligne (ON CONFLICT).
    db.prepare(`INSERT INTO chat_keys (device_id, public_key, created_at) VALUES (?, ?, ?)
                ON CONFLICT (device_id) DO UPDATE SET public_key = excluded.public_key, created_at = excluded.created_at`)
      .run(req.device!.id, value, Date.now());
    // Nouveau membre (ou nouvelle clé) : les autres ouvriront une nouvelle époque au prochain message.
    broadcast('chat', { kind: 'members' }, SPACE);
  }
  res.json({ ok: true });
});

/** Membres et dernière époque (pour savoir s'il faut en ouvrir une nouvelle). */
/*
 * GET /api/chat/state — réponse :
 * - members : le groupe actuel (voir members()) ;
 * - lastEpoch : { id, members: [{ id, key }] } = pour qui la dernière époque a été faite, ou null ;
 * - keys : TOUTES les enveloppes destinées à mon appareil (une par époque à laquelle j'ai appartenu).
 * Le client compare members et lastEpoch.members : s'ils diffèrent, il devra ouvrir une nouvelle époque.
 */
chat.get('/chat/state', requireMvt, (req, res) => {
  // L'époque la plus récente = le plus grand id (AUTOINCREMENT garantit des id croissants).
  const last = db.prepare('SELECT id, created_at FROM chat_epochs ORDER BY id DESC LIMIT 1').get() as { id: number; created_at: number } | undefined;
  // Membres de la dernière époque, avec la clé pour laquelle chacun a reçu son enveloppe.
  const lastMembers = last
    ? (db.prepare('SELECT device_id AS id, recipient_key AS key FROM chat_wraps WHERE epoch_id = ?').all(last.id) as { id: string; key: string }[])
    : [];
  // Seulement MES enveloppes (device_id = moi) : je ne reçois jamais celles des autres.
  const mine = db.prepare(`SELECT epoch_id, sender_id, sender_key, recipient_key, wrapped, iv FROM chat_wraps WHERE device_id = ? ORDER BY epoch_id`)
    .all(req.device!.id) as { epoch_id: number; sender_id: string; sender_key: string; recipient_key: string; wrapped: string; iv: string }[];
  // Passage des noms de colonnes SQL (snake_case) aux noms JSON du modèle partagé (camelCase).
  const keys: ChatEpochKey[] = mine.map((w) => ({ epochId: w.epoch_id, senderId: w.sender_id, senderKey: w.sender_key, recipientKey: w.recipient_key, wrapped: w.wrapped, iv: w.iv }));
  res.json({
    members: members(),
    lastEpoch: last ? { id: last.id, createdAt: last.created_at, members: lastMembers } : null,
    keys,
  });
});

/** Ouvrir une époque : une enveloppe (clé de groupe chiffrée) pour chaque membre actuel, et pour personne d'autre. */
/*
 * POST /api/chat/epochs — corps : { wraps: [{ deviceId, wrapped, iv, recipientKey }], senderKey }.
 * Réponse : 201 { epochId }, ou 409 si la vision du groupe du client n'est plus à jour.
 * Le serveur ne peut pas vérifier le CONTENU des enveloppes (chiffré), mais il vérifie qu'il y en a une
 * pour chaque membre actuel, faite pour sa clé actuelle, et que l'auteur se présente avec SA vraie clé.
 */
chat.post('/chat/epochs', requireMvt, epochLimit, (req, res) => {
  // Validation de forme et de taille (bornes « max » = protection contre des envois énormes).
  const body = z.object({
    wraps: z.array(z.object({
      deviceId: z.string().min(8).max(40),
      wrapped: z.string().regex(B64).max(200),
      iv: z.string().regex(B64).max(40),
      recipientKey: z.string().regex(KEY_TEXT),
    })).min(1).max(500),
    senderKey: z.string().regex(KEY_TEXT),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Données invalides' });
  // Le groupe tel que le serveur le voit maintenant.
  const current = members();
  // Listes d'identifiants triées : on pourra comparer « même ensemble » sans dépendre de l'ordre.
  const ids = current.map((m) => m.id).sort();
  const given = body.data.wraps.map((w) => w.deviceId).sort();
  // L'auteur doit lui-même faire partie du groupe (donc avoir publié sa clé).
  if (!current.some((m) => m.id === req.device!.id)) return res.status(409).json({ error: 'Publie d\'abord ta clé.' });
  // Exactement les membres actuels, chacun avec SA clé actuelle : sinon la liste a changé entre-temps, on recommence.
  // Dictionnaire id -> clé publique actuelle, pour les vérifications ci-dessous.
  const byId = new Map(current.map((m) => [m.id, m.publicKey]));
  // Ma clé publique officielle (celle enregistrée ici), qui sera stockée comme sender_key.
  const me = byId.get(req.device!.id);
  // Trois conditions de refus (409) :
  // 1) l'ensemble des destinataires n'est pas exactement le groupe actuel (ni un de plus, ni un de moins) ;
  // 2) une enveloppe a été faite pour une ancienne clé d'un membre ;
  // 3) l'auteur annonce une autre clé que la sienne (le destinataire referait alors un mauvais ECDH).
  if (JSON.stringify(ids) !== JSON.stringify(given) || body.data.wraps.some((w) => byId.get(w.deviceId) !== w.recipientKey) || body.data.senderKey !== me) {
    return res.status(409).json({ error: 'La liste des membres a changé, réessaie.' });
  }
  const now = Date.now();
  // L'époque et toutes ses enveloppes : ensemble ou pas du tout (transaction).
  const epochId = tx(() => {
    const r = db.prepare('INSERT INTO chat_epochs (created_by, created_at) VALUES (?, ?)').run(req.device!.id, now);
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO chat_wraps (epoch_id, device_id, sender_id, sender_key, recipient_key, wrapped, iv) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const w of body.data.wraps) ins.run(id, w.deviceId, req.device!.id, me, w.recipientKey, w.wrapped, w.iv);
    return id;
  });
  res.status(201).json({ epochId });
});

/** Messages chiffrés (les plus récents d'abord, par pages). */
/*
 * GET /api/chat/messages?before=<horodatage ms> — 60 messages au plus, plus anciens que `before`.
 * Sans `before` : les 60 plus récents (« maintenant + 1 ms » pour inclure ceux de cette milliseconde).
 * Tous les membres reçoivent tous les messages, même d'époques qu'ils ne peuvent pas déchiffrer :
 * c'est le client qui affichera « illisible ». Le nom de l'expéditeur vient de la table devices
 * (LEFT JOIN : null si l'appareil a été supprimé).
 */
// Pagination par CURSEUR « date:id » plutôt que par date seule : deux messages envoyés dans la même
// milliseconde ne peuvent plus être perdus à la frontière entre deux pages.
//  - ?before=<date>:<id> : les PAGE messages juste avant ce curseur (remonter l'historique) ;
//  - ?after=<date>:<id>  : les messages juste après (rattraper une rafale, du plus ancien au plus récent) ;
//  - sans paramètre : les PAGE plus récents.
const PAGE = 100;
const parseCursor = (v: unknown): [number, string] | null => {
  const m = typeof v === 'string' ? /^(\d{1,15}):([A-Za-z0-9_-]{0,40})$/.exec(v) : null;
  return m ? [Number(m[1]), m[2]] : null;
};
chat.get('/chat/messages', requireMvt, (req, res) => {
  const before = parseCursor(req.query.before);
  const after = parseCursor(req.query.after);
  const base = `SELECT m.id, m.epoch_id, m.sender_id, m.iv, m.ciphertext, m.created_at, d.name AS sender_name
    FROM chat_messages m LEFT JOIN devices d ON d.id = m.sender_id`;
  // (a, b) < (?, ?) : comparaison de « tuples » de SQLite : d'abord la date, puis l'id en cas d'égalité.
  const rows = (after
    ? db.prepare(`${base} WHERE (m.created_at, m.id) > (?, ?) ORDER BY m.created_at, m.id LIMIT ${PAGE}`).all(after[0], after[1])
    : before
      ? db.prepare(`${base} WHERE (m.created_at, m.id) < (?, ?) ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE}`).all(before[0], before[1])
      : db.prepare(`${base} ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE}`).all()) as {
      id: string; epoch_id: number; sender_id: string; iv: string; ciphertext: string; created_at: number; sender_name: string | null }[];
  // Conversion vers le format JSON partagé avec le client (shared/model.ts).
  const out: ChatMessage[] = rows.map((r) => ({ id: r.id, epochId: r.epoch_id, senderId: r.sender_id, senderName: r.sender_name, iv: r.iv, ciphertext: r.ciphertext, createdAt: r.created_at }));
  res.json({ messages: out, page: PAGE });
});

/** Envoyer un message chiffré : seulement dans une époque dont je fais partie. */
/*
 * POST /api/chat/messages — corps : { epochId, iv, ciphertext }. Réponse : 201 { id, createdAt }.
 * 403 si je n'ai pas d'enveloppe pour cette époque ; 409 si l'époque ne correspond plus au groupe actuel.
 * La taille max (16 000 caractères base64 ≈ 12 Ko) borne la longueur d'un message.
 */
chat.post('/chat/messages', requireMvt, messageLimit, (req, res) => {
  const body = z.object({ epochId: z.number().int().positive(), iv: z.string().regex(B64).max(40), ciphertext: z.string().regex(B64).max(16_000) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Message trop long ou invalide' });
  // Ai-je une enveloppe pour cette époque ? Sinon je n'en fais pas partie et n'ai rien à y écrire.
  const wrap = db.prepare('SELECT 1 FROM chat_wraps WHERE epoch_id = ? AND device_id = ?').get(body.data.epochId, req.device!.id);
  if (!wrap) return res.status(403).json({ error: 'Clé de groupe inconnue pour cet appareil.' });
  // La clé de groupe doit correspondre EXACTEMENT aux membres actuels (mêmes appareils, mêmes clés) :
  // après un retrait ou une arrivée, on refuse l'ancienne clé, l'app en ouvre une nouvelle et renvoie.
  // On résume chaque ensemble en une chaîne « id:clé,id:clé,… » triée, puis on compare les deux chaînes.
  const epochSet = (db.prepare('SELECT device_id, recipient_key FROM chat_wraps WHERE epoch_id = ?').all(body.data.epochId) as { device_id: string; recipient_key: string }[])
    .map((w) => `${w.device_id}:${w.recipient_key}`).sort().join(',');
  const currentSet = members().map((m) => `${m.id}:${m.publicKey}`).sort().join(',');
  // Sécurité : sans ce contrôle, un membre pourrait continuer à écrire avec une clé que connaît encore
  // une personne retirée du groupe, qui pourrait alors lire la suite.
  if (epochSet !== currentSet) return res.status(409).json({ error: 'Le groupe a changé : nouvelle clé nécessaire.' });
  const id = newId();
  const now = Date.now();
  // L'expéditeur enregistré est l'appareil authentifié (jamais une valeur fournie par le client).
  db.prepare('INSERT INTO chat_messages (id, epoch_id, sender_id, iv, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, body.data.epochId, req.device!.id, body.data.iv, body.data.ciphertext, now);
  // Notification temps réel aux appareils Mouvement : juste « il y a un message », sans contenu.
  broadcast('chat', { kind: 'message', id, by: req.device!.id }, SPACE);
  res.status(201).json({ id, createdAt: now });
});

/** Effacer ses propres messages (ou tout message, pour un admin du côté Mouvement). */
/*
 * DELETE /api/chat/messages/:id — le serveur ne peut pas lire le message mais sait qui l'a envoyé,
 * ce qui suffit pour appliquer la règle « auteur ou admin ». Suppression définitive (pas de corbeille).
 */
chat.delete('/chat/messages/:id', requireMvt, (req, res) => {
  const m = db.prepare('SELECT sender_id FROM chat_messages WHERE id = ?').get(req.params.id) as { sender_id: string } | undefined;
  if (!m) return res.status(404).json({ error: 'Message introuvable' });
  if (m.sender_id !== req.device!.id && req.device!.role !== 'admin') return res.status(403).json({ error: 'Tu ne peux effacer que tes messages.' });
  db.prepare('DELETE FROM chat_messages WHERE id = ?').run(req.params.id);
  // Prévenir les autres appareils pour qu'ils rafraîchissent.
  broadcast('chat', { kind: 'delete', id: req.params.id }, SPACE);
  res.json({ ok: true });
});

/** Messages de plus de 30 jours, et époques devenues vides. */
/*
 * Appelée par server/index.ts au démarrage puis toutes les heures.
 * 1) supprime les messages plus vieux que RETENTION_DAYS ;
 * 2) supprime les époques qui n'ont plus aucun message, SAUF la dernière (encore utilisée pour écrire).
 *    Grâce à ON DELETE CASCADE, leurs enveloppes disparaissent avec elles.
 */
export function cleanupChat() {
  db.prepare('DELETE FROM chat_messages WHERE created_at < ?').run(Date.now() - RETENTION_DAYS * 86400_000);
  db.exec(`DELETE FROM chat_epochs WHERE id < (SELECT COALESCE(MAX(id), 0) FROM chat_epochs)
           AND id NOT IN (SELECT DISTINCT epoch_id FROM chat_messages)`);
}
