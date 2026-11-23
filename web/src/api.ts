/*
 * web/src/api.ts — toutes les communications entre le navigateur et le serveur.
 *
 * À quoi il sert : chaque action de l'appli qui touche aux données (lire les points, créer un vote,
 * envoyer une photo…) passe par une fonction de l'objet `api` ci-dessous. Aucun autre fichier
 * n'appelle `fetch` directement pour l'API : si une adresse change, on ne la corrige qu'ici.
 *
 * Qui l'utilise : presque tous les écrans (store.ts, main.ts, detail.ts, forms.ts, votes.ts…).
 *
 * Notions :
 * - `async` / `await` / `Promise` : une requête réseau prend du temps ; une fonction `async` renvoie
 *   une « promesse » de résultat, et `await` attend ce résultat sans bloquer la page.
 * - Générique `<T>` : `req<{ point: Point }>(...)` veut dire « cette requête renvoie un objet de cette
 *   forme ». Le générique ne vérifie rien à l'exécution : c'est une promesse faite à TypeScript.
 * - L'authentification se fait par cookie (envoyé automatiquement par le navigateur), pas par mot de passe.
 */
// Import de types seulement : la liste de toutes les formes de données échangées (voir shared/model.ts).
import type { CreatedInvite, Device, Invite, Point, PointInput, Role, Space, Vote, VoteResult, ArchiveItem, RegistryEntry, PublicAg, ChatMember, ChatEpochKey, ChatMessage } from '../../shared/model';

/**
 * Erreur renvoyée par toutes les fonctions de l'API. Elle hérite de `Error` (donc a un `message`)
 * et ajoute `status` : le code HTTP (404, 403…), ou 0 quand le réseau est coupé.
 */
export class ApiError extends Error {
  // `public status` dans les paramètres du constructeur : raccourci TypeScript qui déclare ET remplit
  // le champ `this.status` en une fois.
  constructor(public status: number, message: string) {
    // `super(...)` appelle le constructeur de la classe parente (Error) avec le message.
    super(message);
  }
}

// Que faire quand le serveur répond « non connecté » (401) ? Par défaut rien ; main.ts remplace ce
// comportement au démarrage (rechargement de la page) via `setUnauthorizedHandler`.
// Ce détour évite que api.ts dépende de main.ts (sinon les deux fichiers s'importeraient mutuellement).
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

/**
 * Fonction centrale : envoie UNE requête à `/api{url}` et renvoie la réponse JSON.
 * - `method` : 'GET' (lire), 'POST' (créer/agir), 'PUT' (remplacer), 'PATCH' (modifier en partie), 'DELETE'.
 * - `body` : objet envoyé en JSON (facultatif). `unknown` = « n'importe quoi, sans garantie de forme ».
 * - `raw` : fichier binaire (photo, document) envoyé tel quel à la place du JSON.
 * Lève une `ApiError` si le réseau est coupé ou si le serveur répond par une erreur.
 */
async function req<T>(method: string, url: string, body?: unknown, raw?: Blob): Promise<T> {
  // En-tête maison `X-Terrain` : un site tiers ne peut pas ajouter cet en-tête à une requête vers nous
  // sans autorisation du serveur ; le serveur s'en sert donc pour refuser les requêtes forgées
  // ailleurs (protection dite « CSRF »).
  const headers: Record<string, string> = { 'X-Terrain': '1' };
  // `BodyInit` : tout ce que fetch accepte comme corps (texte, Blob…).
  let payload: BodyInit | undefined;
  if (raw) {
    // Fichier : on annonce son vrai type (image/jpeg, application/pdf…) et on l'envoie tel quel.
    headers['Content-Type'] = raw.type;
    payload = raw;
  } else if (body !== undefined) {
    // Objet : transformé en texte JSON.
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    // `credentials: 'same-origin'` : envoyer le cookie de session (même site uniquement).
    res = await fetch(`/api${url}`, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    // fetch ne lève une erreur QUE si le réseau a échoué (pas pour une réponse 404/500).
    throw new ApiError(0, 'Pas de connexion. Vérifie ton réseau.');
  }
  // On ne lit la réponse en JSON que si le serveur dit que c'en est ; sinon objet vide.
  // .catch : un corps annoncé JSON mais invalide (proxy en panne qui renvoie du HTML…) donne un objet
  // vide au lieu d'une exception brute ; le code HTTP suffit alors à produire le bon message.
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => ({})) : {};
  // `res.ok` = code HTTP entre 200 et 299.
  if (!res.ok) {
    // Session expirée ou appareil révoqué : on le signale (sauf pour /me, qui sert justement à tester
    // si on est connecté : l'écran d'accès gère ce cas lui-même).
    if (res.status === 401 && url !== '/me') onUnauthorized();
    // Le serveur renvoie ses erreurs sous la forme { error: "message lisible" }.
    throw new ApiError(res.status, data.error ?? `Erreur ${res.status}`);
  }
  // `as T` : on fait confiance au serveur pour la forme de la réponse.
  return data as T;
}

/*
 * Toutes les routes de l'API, regroupées dans un seul objet. Chaque entrée est une petite fonction
 * fléchée qui appelle `req` avec la bonne méthode, la bonne adresse et le type de réponse attendu.
 * Les adresses entre accents graves (`…${id}…`) sont des « gabarits » : `${id}` est remplacé par la valeur.
 * Utilisation : `const { point } = await api.createPoint(input);`
 */
export const api = {
  // Qui suis-je ? (appareil connecté) — renommer mon appareil — rejoindre avec un jeton d'invitation — se déconnecter.
  me: () => req<{ device: Device }>('GET', '/me'),
  rename: (name: string) => req('PATCH', '/me', { name }),
  claim: (token: string, name: string) => req<{ device: Device }>('POST', '/auth/claim', { token, name }),
  logout: () => req('POST', '/auth/logout', {}),

  // Chat chiffré de bout en bout (le serveur ne voit que des clés publiques et des messages chiffrés)
  // Publier ma clé publique ; lire l'état (membres, dernière époque, clés emballées pour moi).
  chatKey: (publicKey: unknown) => req('PUT', '/chat/key', { publicKey }),
  chatState: () => req<{ members: ChatMember[]; lastEpoch: { id: number; createdAt: number; members: { id: string; key: string }[] } | null; keys: ChatEpochKey[] }>('GET', '/chat/state'),
  // Créer une nouvelle époque : la clé de conversation emballée (chiffrée) pour chaque appareil membre.
  chatEpoch: (o: { wraps: { deviceId: string; wrapped: string; iv: string; recipientKey: string }[]; senderKey: string }) => req<{ epochId: number }>('POST', '/chat/epochs', o),
  // Messages, éventuellement plus anciens qu'une date `before` (pour charger l'historique par pages).
  // Gabarit imbriqué : on n'ajoute `?before=…` à l'adresse que si `before` est fourni.
  // Curseurs « date:id » : before = remonter l'historique, after = rattraper ce qui est arrivé depuis.
  chatMessages: (q: { before?: string; after?: string } = {}) =>
    req<{ messages: ChatMessage[]; page: number }>('GET', `/chat/messages${q.before ? `?before=${q.before}` : q.after ? `?after=${q.after}` : ''}`),
  chatSend: (o: { epochId: number; iv: string; ciphertext: string }) => req<{ id: string; createdAt: number }>('POST', '/chat/messages', o),
  chatDelete: (id: string) => req('DELETE', `/chat/messages/${id}`),

  // Archive (côté Mouvement)
  archive: () => req<{ items: ArchiveItem[]; registry: RegistryEntry[] }>('GET', '/archive'),
  // Envoi du fichier d'abord (corps binaire, d'où `undefined` à la place du JSON), puis création de la fiche.
  uploadArchiveFile: (blob: Blob) => req<{ file: string; fileType: string }>('POST', '/archive/files', undefined, blob),
  createArchive: (o: { kind: ArchiveItem['kind']; title: string; date: number; body?: string | null; file?: string | null; fileName?: string | null; visibility: ArchiveItem['visibility'] }) =>
    req<{ item: ArchiveItem }>('POST', '/archive', o),
  updateArchive: (id: string, o: { visibility?: ArchiveItem['visibility']; title?: string }) => req<{ item: ArchiveItem }>('PATCH', `/archive/${id}`, o),
  deleteArchive: (id: string) => req('DELETE', `/archive/${id}`),
  // Sans compte : archive publique et AG annoncées
  publicArchive: () => req<{ items: ArchiveItem[] }>('GET', '/public/archive'),
  publicAgs: () => req<{ ags: PublicAg[] }>('GET', '/public/ags'),

  // Votes en AG
  votes: (pointId: string) => req<{ votes: Vote[]; canRun: boolean }>('GET', `/points/${pointId}/votes`),
  createVote: (pointId: string, question: string, options: string[], radius: number) => req<{ vote: Vote }>('POST', `/points/${pointId}/votes`, { question, options, radius }),
  vote: (id: string) => req<{ vote: Vote }>('GET', `/votes/${id}`),
  openAppVotes: () => req<{ votes: { vote: Vote; agTitle: string; canRun: boolean }[] }>('GET', '/votes/open'),
  closeVote: (id: string) => req<{ vote: Vote }>('POST', `/votes/${id}/close`, {}),
  // Voter : `...(pos ?? {})` « étale » lat/lng/accuracy dans l'objet envoyé si on a une position,
  // sinon n'ajoute rien (étaler un objet vide ne fait rien). Le serveur vérifie la distance à l'AG.
  ballot: (id: string, choice: number, pos: { lat: number; lng: number; accuracy?: number } | null) => req<{ vote: Vote }>('POST', `/votes/${id}/ballot`, { choice, ...(pos ?? {}) }),
  // Vote public (sans l'app)
  // Retrouver un vote à partir de son code à 5 chiffres, puis voter avec ce code.
  lookupVote: (code: string, pos: { lat: number; lng: number; accuracy?: number } | null) => req<{ vote: Vote; agTitle: string }>('POST', '/public/votes/lookup', { code, ...(pos ?? {}) }),
  publicBallot: (code: string, choice: number, pos: { lat: number; lng: number; accuracy?: number } | null) => req<{ vote: Vote }>('POST', '/public/votes/ballot', { code, choice, ...(pos ?? {}) }),
  voteResult: (id: string) => req<{ result: VoteResult }>('GET', `/public/votes/${id}/result`),
  // Votes « ouverts à tous » de la page d'accueil publique, et vote sans code sur l'un d'eux.
  openVotes: () => req<{ votes: { vote: Vote; agTitle: string }[] }>('GET', '/public/votes/open'),
  openBallot: (id: string, choice: number) => req<{ vote: Vote }>('POST', `/public/votes/${id}/open-ballot`, { choice }),

  // Points de la carte : lire, créer, modifier, changer l'état, rattacher un blocage à un blocus.
  // `space` : ne demander que les points de cet espace (moins de données à télécharger).
  points: (space?: Space) => req<{ points: Point[] }>('GET', space ? `/points?space=${space}` : '/points'),
  createPoint: (p: PointInput) => req<{ point: Point }>('POST', '/points', p),
  updatePoint: (id: string, p: PointInput) => req<{ point: Point }>('PUT', `/points/${id}`, p),
  // `Point['status']` : réutilise exactement le type du champ status (un état ou null).
  setStatus: (id: string, status: Point['status']) => req<{ point: Point }>('PATCH', `/points/${id}/status`, { status }),
  setParent: (id: string, parentId: string | null) => req<{ point: Point }>('PATCH', `/points/${id}/parent`, { parentId }),
  // Dire « je viens » (on = true) ou « je ne viens plus » ; `arriveAt = null` : valeur par défaut du paramètre.
  participate: (id: string, on: boolean, arriveAt: number | null = null) => req<{ point: Point }>('POST', `/points/${id}/participate`, { on, arriveAt }),
  // Dire « j'apporte tel matériel » (ou plus).
  provide: (id: string, item: string, on: boolean) => req<{ point: Point }>('POST', `/points/${id}/provide`, { item, on }),
  // Prolonger une alerte / un flash de quelques minutes.
  extend: (id: string, minutes: number) => req<{ point: Point }>('POST', `/points/${id}/extend`, { minutes }),
  extendFlash: (id: string, minutes: number) => req<{ point: Point }>('POST', `/points/${id}/extend-flash`, { minutes }),
  deletePoint: (id: string) => req('DELETE', `/points/${id}`),
  // Terminer un événement maintenant.
  finish: (id: string) => req<{ point: Point }>('POST', `/points/${id}/finish`, {}),
  // Problèmes sur un blocage : signaler, déclarer réglé, prolonger.
  reportProblem: (id: string, message: string, durationMinutes: number) =>
    req<{ point: Point }>('POST', `/points/${id}/problems`, { message, durationMinutes }),
  resolveProblem: (problemId: string) => req<{ point: Point }>('POST', `/problems/${problemId}/resolve`, {}),
  extendProblem: (problemId: string, minutes: number) => req<{ point: Point }>('POST', `/problems/${problemId}/extend`, { minutes }),
  // Envoi d'une photo (binaire) ; le serveur renvoie le nom sous lequel il l'a rangée.
  uploadPhoto: (blob: Blob) => req<{ photo: string }>('POST', '/photos', undefined, blob),

  // Gestion de l'équipe : invitations et appareils.
  createInvite: (o: { role: Role; ttlMinutes: number; maxUses: number; label?: string | null; spaces: Space[] }) => req<CreatedInvite>('POST', '/invites', o),
  invites: () => req<{ invites: Invite[] }>('GET', '/invites'),
  revokeInvite: (id: string) => req('DELETE', `/invites/${id}`),
  // `Device & { manageable: boolean }` : un appareil, plus un champ disant si JE peux le gérer.
  devices: () => req<{ devices: (Device & { manageable: boolean })[] }>('GET', '/devices'),
  updateDevice: (id: string, o: { role?: Role; name?: string; spaces?: Space[] }) => req('PATCH', `/devices/${id}`, o),
  // Révoquer un appareil ; `cascade` = révoquer aussi tous ceux qu'il a invités (`?cascade=1` dans l'adresse).
  revokeDevice: (id: string, cascade: boolean) => req<{ revoked: number }>('DELETE', `/devices/${id}${cascade ? '?cascade=1' : ''}`),
};

// Adresse d'une photo. `encodeURIComponent` protège les caractères spéciaux (espaces, `/`, `?`…) du nom.
export const photoUrl = (name: string) => `/api/photos/${encodeURIComponent(name)}`;
/** Fichier d'archive (public pour tous, privé seulement pour le côté Mouvement : le serveur vérifie). */
export const archiveFileUrl = (name: string) => `/api/public/archive/files/${encodeURIComponent(name)}`;

/** Redimensionne et ré-encode en JPEG (retire aussi les données EXIF, dont la position GPS). */
// Entrées : le fichier choisi, la taille max du plus grand côté (px) et la qualité JPEG (0 à 1).
// Sortie : un Blob JPEG prêt à envoyer avec `api.uploadPhoto`.
// Pourquoi : une photo de téléphone pèse plusieurs Mo, et ses métadonnées peuvent révéler où elle a été prise.
export async function compressImage(file: File, max = 1600, quality = 0.82): Promise<Blob> {
  // Méthode moderne et rapide : createImageBitmap, en respectant l'orientation de l'appareil photo
  // ('from-image'). `as ImageBitmapOptions` car certaines définitions TypeScript ne connaissent pas
  // encore cette option. En cas d'échec (vieux navigateur), `.catch(() => null)` renvoie null.
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions).catch(() => null);
  // Repli sur une balise <img> classique. Le type `A & { width; height }` garantit qu'on peut lire la taille.
  const src: CanvasImageSource & { width: number; height: number } = bmp ?? (await loadImg(file));
  // Facteur de réduction : jamais plus que 1 (on n'agrandit pas une petite image).
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  // On redessine l'image dans un <canvas> invisible à la nouvelle taille…
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
  // … puis on exporte ce canvas en JPEG. Le canvas ne contient que des pixels : aucune métadonnée EXIF
  // ne survit. `toBlob` fonctionne avec une fonction de rappel ; on l'enveloppe dans une Promise
  // pour pouvoir l'utiliser avec `await`.
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image illisible'))), 'image/jpeg', quality));
}

/** Charge un fichier image dans une balise <img> (méthode de secours de compressImage). */
function loadImg(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image illisible'));
    // Crée une adresse temporaire `blob:…` qui pointe vers le fichier en mémoire.
    img.src = URL.createObjectURL(file);
  });
}
