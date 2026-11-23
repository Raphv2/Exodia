/**
 * server/routes-access.ts — Routes HTTP de gestion des accès : rejoindre, mon appareil,
 * invitations, gestion des appareils.
 *
 * À quoi sert ce fichier ?
 *   Il exporte le routeur `access`, monté par index.ts sous /api. Routes :
 *     POST   /api/auth/claim      utiliser une invitation -> devenir un appareil autorisé (public)
 *     GET    /api/me              infos sur mon appareil
 *     PATCH  /api/me              changer mon nom affiché
 *     POST   /api/auth/logout     me déconnecter (révoque mon propre appareil)
 *     POST   /api/invites         créer une invitation (admin, ou relais avec restrictions)
 *     GET    /api/invites         lister les invitations encore utilisables (admin)
 *     DELETE /api/invites/:id     annuler une invitation
 *     GET    /api/devices         lister les appareils (admin)
 *     PATCH  /api/devices/:id     changer rôle / nom / espaces d'un appareil (admin)
 *     DELETE /api/devices/:id     retirer un appareil, éventuellement « en cascade » (admin)
 *
 * Modèle de droits (le cœur de la sécurité du projet) :
 *   - propriétaire (owner = 1) : un seul, accès aux deux espaces, gère tout le monde, seul à
 *     pouvoir nommer des admins ; personne ne peut le modifier ni le retirer.
 *   - admin : gère les relais et membres dont TOUS les espaces sont aussi les siens.
 *   - relais : peut seulement faire entrer UN membre à la fois, en face à face (QR code, 1 h max).
 *   - membre : aucun droit de gestion.
 *   - Règle d'espaces : on ne peut jamais donner un espace qu'on n'a pas soi-même.
 *
 * Notions à connaître :
 *   - zod (`z`) : bibliothèque de validation. On décrit la forme attendue des données
 *     (`z.object({...})`), puis `.safeParse(valeur)` renvoie { success: true, data } ou
 *     { success: false, error } sans lever d'exception. `data` est alors correctement typé.
 *     Ne JAMAIS faire confiance à `req.body` : il vient du navigateur et peut contenir n'importe quoi.
 *   - `req.device!` : le `!` affirme à TypeScript que device existe (garanti par requireDevice).
 *   - `as unknown as X` : double conversion de type. `.get()` renvoie un type que TypeScript refuse
 *     de convertir directement en X ; passer par `unknown` force la conversion. Aucune vérification
 *     n'a lieu à l'exécution : c'est une promesse faite au compilateur.
 *   - Codes HTTP : 400 données invalides, 401 non identifié, 403 interdit, 404 introuvable,
 *     410 « Gone » (n'existe plus : invitation expirée / utilisée), 429 trop de tentatives.
 */
// `type Request` : import d'un type uniquement, à côté de la valeur Router.
import { Router, type Request } from 'express';
// Bibliothèque qui génère des QR codes (ici en image SVG, c'est-à-dire du texte).
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, tx } from './db';
import {
  asyncRoute, createInvite, deviceToDto, inviteToDto, newId, newToken, rateLimit, requireDevice, requireRole,
  setSessionCookie, clearSessionCookie, sha256, parseSpaces, joinSpaces, spacesOf, coversSpaces,
  type DeviceRow, type InviteRow,
} from './auth';
import { disconnect } from './events';
import { SPACES, type CreatedInvite, type Role, type Space } from '../shared/model';

// Le routeur exporté ; index.ts fait `api.use(access)`.
export const access = Router();

// Règle de validation d'un nom d'appareil : texte, espaces de début/fin retirés (`trim`),
// 1 à 40 caractères. Le message en français est celui renvoyé au client si c'est vide.
const nameSchema = z.string().trim().min(1, 'Indique un prénom ou un pseudo').max(40);

/**
 * Adresse publique du site, pour fabriquer les liens d'invitation.
 * Ordre de préférence :
 *   1. PUBLIC_URL (configurée par l'administrateur : la plus fiable), sans « / » final ;
 *   2. l'en-tête Origin envoyé par le navigateur (présent sur les POST) ;
 *   3. protocole + en-tête Host de la requête.
 * Les options 2 et 3 viennent de la requête : sans PUBLIC_URL, un client pourrait influencer
 * l'adresse du lien généré (sans grand risque ici, puisque c'est lui-même qui reçoit le lien).
 */
function publicBase(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const origin = req.get('origin');
  if (origin) return origin;
  return `${req.protocol}://${req.get('host')}`;
}

// ---------- Rejoindre avec une invitation ----------

/**
 * POST /api/auth/claim — Utiliser une invitation.
 * Entrée (JSON) : { token: le jeton lu dans le lien /#/join/…, name: prénom ou pseudo }.
 * Effets : crée l'appareil en base, pose le cookie de session.
 * Sortie : { device } (le nouvel appareil, au format DTO).
 * Route publique (pas de requireDevice : on n'a pas encore de cookie), donc protégée par un
 * limiteur : 10 essais par minute et par IP, pour empêcher de tester des jetons en masse.
 */
access.post('/auth/claim', rateLimit(10, 60_000), (req, res) => {
  // Validation : jeton de 20 à 100 caractères (un vrai jeton base64url de 32 octets en fait 43).
  const body = z.object({ token: z.string().min(20).max(100), name: nameSchema }).safeParse(req.body);
  // `issues[0]?.message` : `?.` (« optional chaining ») renvoie undefined au lieu de planter si
  // issues[0] n'existe pas ; `??` fournit alors un message par défaut.
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });

  const now = Date.now();
  // Nouveau jeton de session (secret, mis dans le cookie) et nouvel id d'appareil.
  const token = newToken();
  const id = newId();
  // Transaction (tx, voir db.ts) : vérifications ET écritures se font d'un bloc. Ainsi, même si un
  // jour le serveur devenait asynchrone ou multi-processus, une invitation à usage unique ne
  // pourrait pas être utilisée deux fois « en même temps ».
  const refused = tx(() => {
    // On cherche l'invitation par l'empreinte du jeton (la base ne contient que des empreintes).
    const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(body.data.token)) as InviteRow | undefined;
    // Trois raisons de refuser, toutes en 410 « n'existe plus » avec un message explicite :
    if (!invite || invite.revoked_at) return 'Cette invitation n\'existe pas ou a été annulée.';
    if (invite.expires_at < now) return 'Cette invitation a expiré. Demande un nouveau QR code.';
    if (invite.uses >= invite.max_uses) return 'Cette invitation a déjà été utilisée.';
    // `uses = uses + 1` est calculé par SQLite lui-même (pas de lecture puis écriture côté JS).
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(invite.id);
    // L'invitation fixe les espaces ; celle du tout premier lancement fait de l'appareil le propriétaire.
    // Condition « propriétaire » : étiquette 'bootstrap' ET aucun créateur (invitation produite par
    // le serveur lui-même : ensureBootstrapAdmin ou cli-invite.ts). Un utilisateur ne peut pas en
    // fabriquer une : ses invitations ont toujours un créateur (created_by).
    const owner = invite.label === 'bootstrap' && !invite.created_by ? 1 : 0;
    // Il n'y a qu'UN propriétaire. Une invitation de secours (npm run invite-admin, typiquement après
    // la perte du téléphone) TRANSFÈRE la propriété : l'ancien propriétaire devient simple admin
    // (le nouveau peut ensuite le retirer s'il a été perdu ou volé).
    if (owner) db.prepare('UPDATE devices SET owner = 0 WHERE owner = 1').run();
    // Insertion du nouvel appareil : 11 colonnes, 11 `?`, valeurs passées dans le même ordre.
    db.prepare(`INSERT INTO devices (id, name, role, token_hash, invited_by, invite_id, created_at, last_seen, user_agent, spaces, owner)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      // invited_by = le créateur de l'invitation (sert à la révocation en cascade).
      // user_agent : description du navigateur, tronquée à 200 caractères (`?? ''` si absent).
      // Espaces : les deux pour le propriétaire, sinon ceux prévus par l'invitation (déjà en texte).
      .run(id, body.data.name, invite.role, sha256(token), invite.created_by, invite.id, now, now, (req.get('user-agent') ?? '').slice(0, 200),
        owner ? joinSpaces([...SPACES]) : invite.spaces, owner);
    return null;
  });
  if (refused) return res.status(410).json({ error: refused });
  // Le navigateur garde désormais le jeton dans un cookie httpOnly.
  setSessionCookie(req, res, token);
  // On relit la ligne insérée pour renvoyer exactement ce qui est en base.
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow;
  res.json({ device: deviceToDto(row) });
});

// ---------- Mon appareil ----------

// GET /api/me — Renvoie l'appareil connecté. Sert au client à savoir s'il est connecté, son rôle,
// ses espaces. (Si le cookie est invalide, requireDevice répond 401 avant d'arriver ici.)
access.get('/me', requireDevice, (req, res) => {
  res.json({ device: deviceToDto(req.device!) });
});

// PATCH /api/me — Change mon propre nom. Entrée : { name }.
access.patch('/me', requireDevice, (req, res) => {
  // `req.body?.name` : si le corps est absent (undefined), `?.` évite le plantage et donne undefined,
  // que zod refusera proprement.
  const name = nameSchema.safeParse(req.body?.name);
  if (!name.success) return res.status(400).json({ error: name.error.issues[0]?.message });
  // On ne modifie QUE l'appareil connecté (id pris dans req.device, jamais dans la requête).
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name.data, req.device!.id);
  res.json({ ok: true });
});

// POST /api/auth/logout — Déconnexion. Ce n'est pas un simple oubli du cookie : l'appareil est
// RÉVOQUÉ en base. Pour revenir, il faudra une nouvelle invitation.
// Garde-fous : le propriétaire ne peut pas se déconnecter (l'app n'aurait plus de propriétaire),
// ni le dernier admin. Les invitations encore ouvertes créées par cet appareil sont annulées et son
// flux temps réel est coupé, exactement comme pour un retrait par un admin.
access.post('/auth/logout', requireDevice, (req, res) => {
  const me = req.device!;
  if (me.owner) return res.status(400).json({ error: 'Le propriétaire ne peut pas se déconnecter. Pour changer de téléphone, utilise une invitation de secours (npm run invite-admin) depuis le serveur.' });
  if (me.role === 'admin' && activeAdminCount() <= 1) return res.status(400).json({ error: 'Tu es le dernier admin : nomme d\'abord un autre admin.' });
  const now = Date.now();
  tx(() => {
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now, me.id);
    db.prepare('UPDATE invites SET revoked_at = ? WHERE revoked_at IS NULL AND created_by = ?').run(now, me.id);
  });
  disconnect([me.id]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- Invitations (admin, ou relais pour le « main en main ») ----------

// Liste d'espaces valide : un tableau de 'lfi' / 'mvt', 1 ou 2 éléments.
// (Un doublon ['lfi', 'lfi'] passerait la validation, mais joinSpaces le supprime ensuite.)
const spacesSchema = z.array(z.enum(['lfi', 'mvt'])).min(1, 'Choisis au moins un espace').max(2);

// Forme attendue pour créer une invitation.
const inviteSchema = z.object({
  role: z.enum(['admin', 'relais', 'membre']),
  // Durée de validité : entier, de 5 minutes à 7 jours (7 × 24 × 60 minutes).
  ttlMinutes: z.number().int().min(5).max(7 * 24 * 60),
  // Nombre d'utilisations : de 1 à 100 (un même lien peut servir à toute une réunion).
  maxUses: z.number().int().min(1).max(100),
  // `.nullish()` = la valeur peut être absente (undefined) ou null.
  label: z.string().trim().max(60).nullish(),
  spaces: spacesSchema,
});

/**
 * Peut-on gérer cet appareil ? Le propriétaire gère tout le monde (sauf lui-même pour le retrait).
 * Un admin gère seulement les relais et membres dont tous les espaces sont aussi les siens.
 */
// Entrées : `me` = l'appareil qui agit, `target` = l'appareil visé. Renvoie true / false.
// L'ordre des tests compte :
//   1. personne ne gère le propriétaire (pas même lui-même) ;
//   2. le propriétaire gère tous les autres ;
//   3. sinon (admin) : la cible ne doit pas être admin ET tous ses espaces doivent être dans les miens
//      (un admin « lfi » ne peut pas toucher un membre « lfi,mvt », car il agirait sur l'espace mvt).
function canManage(me: DeviceRow, target: DeviceRow): boolean {
  if (target.owner) return false;
  if (me.owner) return true;
  return target.role !== 'admin' && coversSpaces(me, spacesOf(target));
}

/**
 * POST /api/invites — Créer une invitation.
 * Entrée : { role, ttlMinutes, maxUses, label?, spaces } (voir inviteSchema).
 * Sortie : { invite, url, qrSvg } — le lien complet et son QR code en SVG, prêts à afficher.
 * Réservée aux admins et relais. `async` car la génération du QR code est asynchrone (`await`).
 */
access.post('/invites', requireDevice, requireRole('admin', 'relais'), asyncRoute(async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Paramètres d\'invitation invalides' });
  // Destructuration avec `let` (et non `const`) : ces trois valeurs pourront être modifiées plus bas
  // pour un relais.
  let { role, ttlMinutes, maxUses } = parsed.data;
  const me = req.device!;
  // zod a typé `spaces` comme ('lfi' | 'mvt')[] ; on l'annonce comme Space[] (même chose, autre nom).
  const spaces = parsed.data.spaces as Space[];
  // On ne fait entrer quelqu'un que dans ses propres espaces ; seul le propriétaire nomme des admins.
  if (!coversSpaces(me, spaces)) return res.status(403).json({ error: 'Tu ne peux inviter que dans tes propres espaces.' });
  if (role === 'admin' && !me.owner) return res.status(403).json({ error: 'Seul le propriétaire peut faire entrer un admin.' });
  if (me.role === 'relais') {
    // Un relais ne peut inviter qu'une personne à la fois, en face à face.
    // Quoi que le client ait demandé, on IMPOSE : rôle membre, 1 h maximum, 1 seule utilisation.
    // (Le serveur corrige en silence plutôt que de refuser.)
    role = 'membre' as Role;
    ttlMinutes = Math.min(ttlMinutes, 60);
    maxUses = 1;
  }
  // `parsed.data.label || null` : une étiquette vide ('') ou absente devient null en base.
  const { token, id } = createInvite({ role, ttlMinutes, maxUses, label: parsed.data.label || null, createdBy: me.id, spaces });
  // Le jeton est dans le fragment (#) : il n'est jamais envoyé au serveur ni dans les en-têtes Referer.
  const url = `${publicBase(req)}/#/join/${token}`;
  // QR code en SVG : marge minimale, correction d'erreur moyenne (« M » : reste lisible même un peu
  // abîmé), couleurs de la charte (bleu très foncé sur blanc).
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#00232C', light: '#ffffff' } });
  const row = db.prepare('SELECT * FROM invites WHERE id = ?').get(id) as unknown as InviteRow;
  // Typage explicite de la réponse avec l'interface partagée CreatedInvite (shared/model.ts) : si
  // la forme diverge de ce que le client attend, TypeScript le signale à la compilation.
  const out: CreatedInvite = { invite: inviteToDto(row), url, qrSvg };
  res.json(out);
}));

/**
 * GET /api/invites — Invitations encore utilisables (admins seulement).
 * SQL : jointure GAUCHE (LEFT JOIN) sur devices pour récupérer le nom du créateur ; « gauche » =
 * on garde aussi les invitations sans créateur (bootstrap). Filtres : non annulée, non expirée,
 * pas encore épuisée. Les plus récentes d'abord. `i` et `d` sont des alias courts des tables.
 * Puis filtre en JS : un admin ne voit que les invitations dont tous les espaces sont les siens.
 */
access.get('/invites', requireDevice, requireRole('admin'), (req, res) => {
  const me = req.device!;
  const rows = (db.prepare(`
    SELECT i.*, d.name AS created_by_name FROM invites i LEFT JOIN devices d ON d.id = i.created_by
    WHERE i.revoked_at IS NULL AND i.expires_at > ? AND i.uses < i.max_uses
    ORDER BY i.created_at DESC`).all(Date.now()) as unknown as InviteRow[])
    .filter((i) => me.owner || coversSpaces(me, parseSpaces(i.spaces)));
  // `rows.map(inviteToDto)` : on passe directement la fonction de conversion à map.
  res.json({ invites: rows.map(inviteToDto) });
});

/**
 * DELETE /api/invites/:id — Annuler une invitation. `:id` est un paramètre d'URL, lu dans req.params.id.
 * Autorisé si : je suis propriétaire, OU je l'ai créée moi-même (cas du relais), OU je suis admin
 * et tous ses espaces sont les miens.
 */
access.delete('/invites/:id', requireDevice, requireRole('admin', 'relais'), (req, res) => {
  const me = req.device!;
  const inv = db.prepare('SELECT * FROM invites WHERE id = ?').get(req.params.id) as InviteRow | undefined;
  // Invitation introuvable : on répond « ok » quand même (le résultat voulu — qu'elle n'existe
  // plus — est atteint). C'est un choix « idempotent ».
  if (!inv) return res.json({ ok: true });
  const allowed = me.owner || inv.created_by === me.id || (me.role === 'admin' && coversSpaces(me, parseSpaces(inv.spaces)));
  if (!allowed) return res.status(403).json({ error: 'Tu ne peux pas annuler cette invitation.' });
  // Annulation « douce » : on marque revoked_at, on ne supprime pas la ligne (cleanup() la supprimera
  // une semaine après son expiration).
  db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(Date.now(), inv.id);
  res.json({ ok: true });
});

// ---------- Appareils (admin) ----------

/**
 * GET /api/devices — Liste des appareils actifs (admins seulement).
 * SQL : jointure de la table devices AVEC ELLE-MÊME (alias d = l'appareil, p = son parrain) pour
 * obtenir le nom de la personne qui l'a invité.
 * Chaque appareil renvoyé reçoit en plus `manageable` : le client s'en sert pour afficher ou non
 * les boutons d'action (le serveur revérifie de toute façon à chaque action).
 */
access.get('/devices', requireDevice, requireRole('admin'), (req, res) => {
  const me = req.device!;
  // Un admin ne voit que les appareils qui partagent au moins un de ses espaces.
  // `.some(...)` = au moins un élément vérifie la condition (≠ `.every` = tous).
  const rows = (db.prepare(`
    SELECT d.*, p.name AS invited_by_name FROM devices d LEFT JOIN devices p ON p.id = d.invited_by
    WHERE d.revoked_at IS NULL ORDER BY d.created_at DESC`).all() as unknown as DeviceRow[])
    .filter((d) => me.owner || spacesOf(d).some((s) => spacesOf(me).includes(s)));
  // `{ ...deviceToDto(d), manageable: … }` : copie de l'objet DTO + un champ supplémentaire.
  res.json({ devices: rows.map((d) => ({ ...deviceToDto(d), manageable: canManage(me, d) })) });
});

// Nombre d'admins actifs. Sert à empêcher de se retrouver sans aucun admin.
function activeAdminCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM devices WHERE role = 'admin' AND revoked_at IS NULL").get() as { n: number }).n;
}

/**
 * PATCH /api/devices/:id — Modifier un appareil (admins seulement).
 * Entrée : { role?, name?, spaces? } — chaque champ est facultatif (`.optional()`), seuls ceux
 * fournis sont modifiés.
 */
access.patch('/devices/:id', requireDevice, requireRole('admin'), (req, res) => {
  const body = z.object({ role: z.enum(['admin', 'relais', 'membre']).optional(), name: nameSchema.optional(), spaces: spacesSchema.optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Données invalides' });
  // L'appareil visé doit exister et être actif.
  const target = db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').get(req.params.id) as DeviceRow | undefined;
  if (!target) return res.status(404).json({ error: 'Appareil introuvable' });
  const me = req.device!;
  // Série de contrôles de droits, du plus spécifique au plus général :
  // le propriétaire est intouchable (message dédié, même si canManage le refuserait aussi)…
  if (target.owner) return res.status(403).json({ error: 'Le propriétaire ne peut pas être modifié.' });
  // … il faut avoir autorité sur la cible…
  if (!canManage(me, target)) return res.status(403).json({ error: 'Tu ne peux pas gérer cet appareil.' });
  // … seul le propriétaire peut promouvoir quelqu'un admin…
  if (body.data.role === 'admin' && !me.owner) return res.status(403).json({ error: 'Seul le propriétaire peut nommer un admin.' });
  // … et on ne peut accorder que des espaces qu'on possède soi-même.
  if (body.data.spaces && !coversSpaces(me, body.data.spaces as Space[])) return res.status(403).json({ error: 'Tu ne peux donner que tes propres espaces.' });
  // Mises à jour, une par champ fourni (sans transaction : voir la remarque sur l'ordre ci-dessous).
  // (Avant, les espaces étaient enregistrés ICI, avant le contrôle « dernier admin » ci-dessous :
  // une réponse 400 laissait la modification à moitié faite. Désormais : tous les contrôles, puis
  // toutes les écritures ensemble.)
  // Garde-fou : on refuse de rétrograder le dernier admin actif. (Les espaces, eux, ont déjà été
  // enregistrés à la ligne précédente même si on refuse ici.)
  if (body.data.role && target.role === 'admin' && body.data.role !== 'admin' && activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'Il doit rester au moins un admin.' });
  }
  tx(() => {
    if (body.data.spaces) db.prepare('UPDATE devices SET spaces = ? WHERE id = ?').run(joinSpaces(body.data.spaces as Space[]), target.id);
    if (body.data.role) db.prepare('UPDATE devices SET role = ? WHERE id = ?').run(body.data.role, target.id);
    if (body.data.name) db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(body.data.name, target.id);
  });
  res.json({ ok: true });
});

/**
 * DELETE /api/devices/:id — Retirer (révoquer) un appareil. Admins seulement.
 * Option `?cascade=1` : retire aussi tous les appareils qu'il a fait entrer, et ceux que ces derniers
 * ont fait entrer, etc. Utile si un téléphone tombe en de mauvaises mains et a déjà invité d'autres
 * personnes. Les invitations encore ouvertes créées par ces appareils sont aussi annulées, et leurs
 * flux temps réel coupés. Sortie : { ok, revoked: nombre d'appareils retirés }.
 */
access.delete('/devices/:id', requireDevice, requireRole('admin'), (req, res) => {
  // `req.query` = paramètres après le `?` dans l'URL (toujours du texte).
  const cascade = req.query.cascade === '1';
  const target = db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').get(req.params.id) as DeviceRow | undefined;
  if (!target) return res.status(404).json({ error: 'Appareil introuvable' });
  const me = req.device!;
  if (target.owner) return res.status(403).json({ error: 'Le propriétaire ne peut pas être retiré.' });
  if (!canManage(me, target)) return res.status(403).json({ error: 'Tu ne peux pas retirer cet appareil.' });

  // Révocation en cascade : l'appareil et tous ceux qu'il a fait entrer (et ainsi de suite),
  // limitée à ceux que je peux gérer (jamais le propriétaire, jamais un autre espace que les miens).
  // Requête récursive (CTE « WITH RECURSIVE ») : on construit une table temporaire `tree(id)` :
  //   - point de départ : l'id de la cible (`SELECT ?`) ;
  //   - étape répétée : ajouter les appareils actifs dont invited_by est déjà dans tree ;
  //   - SQLite répète jusqu'à ce qu'il n'y ait plus rien de nouveau. `UNION` (et non UNION ALL)
  //     élimine les doublons, ce qui évite aussi de tourner en rond.
  // Enfin on récupère les lignes complètes de ces appareils. Sans cascade, la liste = la cible seule.
  const tree = cascade
    ? (db.prepare(`
        WITH RECURSIVE tree(id) AS (
          SELECT ? UNION SELECT d.id FROM devices d JOIN tree t ON d.invited_by = t.id
        ) SELECT d.* FROM devices d JOIN tree t ON t.id = d.id`).all(target.id) as unknown as DeviceRow[])
    : [target];
  // Parcours de l'arbre depuis la cible, en descendant d'invité en invité :
  //  - un intermédiaire DÉJÀ révoqué ne bloque plus la descente (avant, ses invités étaient oubliés) ;
  //  - un appareil que je n'ai PAS le droit de gérer est épargné, et toute sa descendance avec lui
  //    (avant, ses propres invités pouvaient être retirés alors que lui restait).
  const byParent = new Map<string, DeviceRow[]>();
  for (const d of tree) if (d.invited_by) byParent.set(d.invited_by, [...(byParent.get(d.invited_by) ?? []), d]);
  const ids: string[] = [];
  const walk = (d: DeviceRow) => {
    if (d.id !== target.id && !canManage(me, d)) return;
    if (!d.revoked_at) ids.push(d.id);
    for (const child of byParent.get(d.id) ?? []) walk(child);
  };
  walk(target);

  // Combien d'admins actifs vont disparaître ? `IN (?,?,?)` : on fabrique autant de `?` que d'ids
  // (`ids.map(() => '?').join(',')`), puis on passe les ids un par un avec `...ids` (« spread »).
  // On ne met JAMAIS les ids directement dans le texte SQL : les `?` protègent de l'injection.
  const adminsLost = (db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE role = 'admin' AND revoked_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number }).n;
  // Garde-fou : il doit toujours rester au moins un admin actif.
  if (adminsLost > 0 && activeAdminCount() - adminsLost < 1) {
    return res.status(400).json({ error: 'Impossible : il ne resterait plus aucun admin.' });
  }
  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  tx(() => {
    db.prepare(`UPDATE devices SET revoked_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
    db.prepare(`UPDATE invites SET revoked_at = ? WHERE revoked_at IS NULL AND created_by IN (${placeholders})`).run(now, ...ids);
  });
  // Coupe tout de suite leurs connexions temps réel (events.ts).
  disconnect(ids);
  res.json({ ok: true, revoked: ids.length });
});
