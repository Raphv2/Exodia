/*
 * Chiffrement de bout en bout du chat, entièrement dans le navigateur (WebCrypto, aucune bibliothèque externe).
 *
 * - Clé d'appareil : paire ECDH P-256 créée ici. La clé privée est « non extractible » et rangée dans
 *   IndexedDB : même le code de l'app ne peut pas la lire en clair, et elle ne part jamais vers le serveur.
 * - Clé de groupe (par « époque ») : AES-GCM 256 tirée au hasard, chiffrée pour chaque membre avec une clé
 *   dérivée de ECDH(ma clé privée, sa clé publique) via HKDF-SHA-256.
 * - Messages : AES-GCM 256 avec un IV aléatoire de 96 bits par message ; l'en-tête (époque, expéditeur)
 *   est lié au chiffrement (données associées), il ne peut pas être recollé sur un autre message.
 */

/*
 * ===================== GUIDE DE LECTURE (pour non-spécialiste) =====================
 *
 * Qui appelle ce fichier ? Uniquement web/src/chat.ts (l'onglet Chat). Ce fichier ne parle jamais au
 * serveur : il ne fait que des calculs (créer des clés, chiffrer, déchiffrer). C'est chat.ts qui envoie
 * ou reçoit les résultats via api.ts.
 *
 * Notions à connaître :
 *
 * 1) Chiffrement symétrique (AES-GCM) : UNE seule clé sert à chiffrer et à déchiffrer. Très rapide.
 *    Problème : comment donner cette clé aux autres membres sans que le serveur (qui transporte tout) la voie ?
 *
 * 2) Échange de clés asymétrique (ECDH sur la courbe P-256) : chaque appareil a une paire de clés,
 *    une PRIVÉE (secrète, ne quitte jamais l'appareil) et une PUBLIQUE (qu'on peut montrer à tout le monde).
 *    Propriété magique : ECDH(ma privée, ta publique) == ECDH(ta privée, ma publique).
 *    Alice et Bob obtiennent donc le MÊME secret sans jamais l'avoir envoyé sur le réseau ; le serveur,
 *    qui ne connaît que les deux clés publiques, ne peut pas le recalculer.
 *
 * 3) HKDF (fonction de dérivation de clé) : le secret brut sorti d'ECDH n'est pas « uniformément aléatoire »
 *    (c'est une coordonnée d'un point sur une courbe). On le passe dans HKDF-SHA-256 pour en tirer une vraie
 *    clé AES propre. HKDF prend aussi un « sel » et une étiquette « info » : changer l'un ou l'autre donne
 *    une clé totalement différente, ce qui évite qu'une même clé serve à deux usages.
 *
 * 4) Enveloppe (« wrap ») : la clé de groupe chiffrée avec la clé Alice↔Bob. Une enveloppe par membre.
 *    Le serveur stocke les enveloppes mais ne peut en ouvrir aucune.
 *
 * 5) IV (« vecteur d'initialisation », aussi appelé nonce) : 12 octets aléatoires fournis à AES-GCM à
 *    chaque chiffrement. Il n'est PAS secret (on l'envoie à côté du message), mais il ne doit JAMAIS être
 *    réutilisé avec la même clé : sinon un attaquant peut combiner deux messages et retrouver des
 *    informations, voire forger des messages. Tirés au hasard sur 96 bits, la probabilité de collision est
 *    négligeable pour le volume d'un chat.
 *
 * 6) AAD (« additional authenticated data », données associées) : des données qui ne sont PAS chiffrées
 *    mais qui sont « scellées » avec le message. Si on les change, le déchiffrement échoue. Ici l'AAD
 *    contient le numéro d'époque et l'identifiant de l'expéditeur : le serveur ne peut pas prendre le
 *    message de Bob et le présenter comme venant d'Alice.
 *
 * 7) AES-GCM est un chiffrement « authentifié » : en plus de cacher le contenu, il ajoute une étiquette
 *    (16 octets) qui détecte toute modification. Un seul bit changé => decrypt() lève une erreur.
 *
 * 8) Époque : une clé de groupe valable pour une liste précise de membres. Quand la liste change, on en
 *    crée une nouvelle (voir chat.ts et server/routes-chat.ts). Un nouveau membre ne reçoit pas les
 *    anciennes clés, donc ne lit pas l'historique ; un membre retiré ne reçoit pas la nouvelle.
 *
 * Ce que le serveur voit : les clés publiques, les enveloppes (illisibles), les messages chiffrés
 * (illisibles), leurs IV, qui envoie, quand, et la taille approximative.
 * Ce qu'il ne voit pas : les clés privées, les clés de groupe, le texte, les positions partagées.
 * ===================================================================================
 */
// Nom de la base IndexedDB (stockage du navigateur, propre à ce site) où l'on range la clé d'appareil.
const DB = 'terrain-chat';
// Nom du « magasin » (équivalent d'une table) dans cette base.
const STORE = 'keys';
// Étiquette « info » de HKDF : sépare cet usage (envelopper une clé d'époque, version 1) de tout autre
// usage futur. Si un jour on change le format, passer en v2 donnera des clés différentes, sans mélange.
const HKDF_INFO = new TextEncoder().encode('terrain/chat/epoch-key/v1');

// ---------- base64url ----------
/*
 * Les clés et messages chiffrés sont des octets bruts ; pour les mettre dans du JSON on les convertit
 * en texte « base64url » (variante de base64 sans +, / ni =, sans danger dans une URL).
 * Entrée : des octets. Sortie : une chaîne de caractères.
 */
export const b64 = (buf: ArrayBuffer | Uint8Array) => {
  // On accepte un ArrayBuffer (sortie de WebCrypto) ou un Uint8Array : on se ramène toujours au second.
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  // btoa() ne prend qu'une « chaîne binaire » (un caractère par octet) : on la construit octet par octet.
  for (const b of bytes) s += String.fromCharCode(b);
  // base64 classique, puis passage en base64url : + devient -, / devient _, et on retire le remplissage =.
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
/** Inverse de b64 : texte base64url -> octets. */
export const unb64 = (s: string) => {
  // On revient à l'alphabet base64 classique que comprend atob().
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  // atob() exige une longueur multiple de 4 : on rajoute juste ce qu'il faut de « = » de remplissage.
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  // Chaîne binaire -> tableau d'octets. Le « as » précise à TypeScript le type exact attendu par WebCrypto.
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
};

// ---------- stockage local de la clé d'appareil ----------
/*
 * Petit utilitaire pour IndexedDB, dont l'API d'origine fonctionne par événements (onsuccess, onerror…).
 * On l'emballe dans une Promise pour pouvoir écrire « await idb(...) ».
 * - mode : 'readonly' pour lire, 'readwrite' pour écrire ;
 * - fn : reçoit le magasin et lance UNE requête (get, put…), dont le résultat est renvoyé.
 * Pourquoi IndexedDB et pas localStorage ? localStorage ne stocke que du texte : il faudrait exporter la clé
 * privée en clair. IndexedDB, lui, sait stocker un objet CryptoKey tel quel, y compris non extractible.
 */
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    // Ouvre (ou crée) la base, en version 1.
    const open = indexedDB.open(DB, 1);
    // Appelé seulement à la toute première ouverture (ou changement de version) : on crée le magasin.
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      // Toute lecture/écriture IndexedDB se fait dans une transaction.
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      // Une fois la transaction terminée, on referme la base pour ne pas garder de connexion ouverte.
      tx.oncomplete = () => open.result.close();
    };
  });
}

/*
 * Les clés de cet appareil telles que le reste du code les manipule :
 * - privateKey : objet CryptoKey opaque (on peut s'en servir, pas le lire) ;
 * - publicJwk : la clé publique en texte JSON (format « JWK »), prête à être envoyée au serveur.
 */
export interface DeviceKeys { privateKey: CryptoKey; publicJwk: string }

/** Clé de cet appareil : créée la première fois, puis relue depuis IndexedDB. */
export async function deviceKeys(): Promise<DeviceKeys> {
  // WebCrypto (crypto.subtle) n'existe que sur une page sécurisée (https, ou localhost en développement).
  if (!window.isSecureContext || !crypto.subtle) throw new Error('Le chat chiffré demande une connexion sécurisée (https).');
  // On regarde d'abord si une clé a déjà été créée sur cet appareil (clé « device » dans le magasin).
  const saved = await idb<{ privateKey: CryptoKey; publicJwk: string } | undefined>('readonly', (s) => s.get('device'));
  if (saved?.privateKey && saved.publicJwk) return saved;
  /*
   * Première fois : on crée une paire ECDH sur la courbe P-256.
   * Le « false » = NON EXTRACTIBLE : le navigateur refusera à jamais d'exporter la clé privée, même à notre
   * propre code. Intérêt : si un jour une faille (XSS) injecte du script dans la page, ce script pourra
   * UTILISER la clé tant qu'il tourne, mais pas la COPIER pour l'emporter ailleurs.
   * ['deriveBits'] = le seul usage autorisé : calculer un secret partagé ECDH.
   * Remarque : la clé publique, elle, reste toujours exportable (c'est le principe d'une clé publique).
   */
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  // Export de la clé publique au format JWK (JSON) : { kty, crv, x, y, ext, key_ops… }.
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  // On ne garde que les 4 champs utiles, dans un ordre fixe : ainsi la même clé donne toujours exactement
  // la même chaîne, ce qui permet de comparer des clés par simple égalité de texte (serveur et client).
  const publicJwk = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
  const keys = { privateKey: pair.privateKey, publicJwk };
  // Rangement dans IndexedDB (l'objet CryptoKey est stocké tel quel, toujours non extractible).
  await idb('readwrite', (s) => s.put(keys, 'device'));
  return keys;
}

/*
 * Transforme le texte JWK d'une clé publique (reçu du serveur) en objet CryptoKey utilisable par ECDH.
 * « ext: true » est ajouté car notre JWK compact ne contient pas ce champ et une clé publique est extractible.
 * Le tableau d'usages est vide : une clé publique ECDH ne « fait » rien seule, elle sert d'argument à deriveBits.
 */
const importPublic = (jwk: string) =>
  crypto.subtle.importKey('jwk', { ...JSON.parse(jwk), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);

/** Clé d'enveloppe partagée entre moi et un autre appareil (ECDH → HKDF → AES-GCM). */
/*
 * Entrées : ma clé privée, la clé publique de l'autre (JWK texte), un sel.
 * Sortie : une clé AES-GCM 256 que l'autre appareil peut recalculer de son côté à l'identique
 * (avec SA privée et MA publique), sans que rien de secret n'ait circulé.
 */
async function pairKey(myPrivate: CryptoKey, theirPublicJwk: string, salt: BufferSource): Promise<CryptoKey> {
  // Étape 1 — ECDH : 256 bits de secret partagé, identiques des deux côtés.
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(theirPublicJwk) }, myPrivate, 256);
  // Étape 2 — on présente ces bits à WebCrypto comme « matière première » pour HKDF (non extractible).
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  // Étape 3 — HKDF-SHA-256 (sel + info) produit une vraie clé AES-GCM 256, non extractible, pour chiffrer
  // / déchiffrer l'enveloppe. Pourquoi ne pas utiliser les bits ECDH directement comme clé AES ? Parce qu'ils
  // ne sont pas parfaitement uniformes et qu'on veut pouvoir séparer les usages (info) : c'est la pratique standard.
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Sel de l'enveloppe : lié aux deux clés publiques (dans un ordre fixe). */
/*
 * Le sel = SHA-256 des deux clés publiques triées puis jointes par « | ».
 * Le tri garantit que l'expéditeur et le destinataire calculent le MÊME sel quel que soit le côté.
 * Lier le sel aux deux clés attache la clé d'enveloppe à cette paire précise d'appareils.
 */
const saltFor = async (a: string, b: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|'))));

/** Nouvelle clé de groupe, chiffrée pour chaque membre. */
/*
 * Appelée par chat.ts quand il faut ouvrir une nouvelle époque (le groupe a changé).
 * Entrées : mes clés, la liste des membres actuels (moi compris) avec leur clé publique.
 * Sortie : { key, wraps }
 *   - key : la clé de groupe, gardée en mémoire par chat.ts pour chiffrer ;
 *   - wraps : une enveloppe par membre, à envoyer au serveur (POST /chat/epochs).
 */
export async function newEpoch(me: DeviceKeys, members: { id: string; publicKey: string }[]) {
  // Clé de groupe tirée au hasard. Exceptionnellement EXTRACTIBLE (true) : on a besoin de ses octets bruts
  // pour pouvoir les chiffrer dans chaque enveloppe.
  const groupKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  // Ses 32 octets bruts (c'est cela qu'on met dans les enveloppes).
  const raw = await crypto.subtle.exportKey('raw', groupKey);
  // Une enveloppe par membre, calculées en parallèle (Promise.all).
  const wraps = await Promise.all(members.map(async (m) => {
    // IV neuf et aléatoire pour CHAQUE enveloppe (12 octets = 96 bits, la taille recommandée pour GCM).
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // Clé d'enveloppe propre au couple (moi, ce membre). Pour moi-même, c'est ECDH avec ma propre publique :
    // ça marche aussi, et me permet de retrouver la clé de groupe plus tard depuis le serveur.
    const k = await pairKey(me.privateKey, m.publicKey, await saltFor(me.publicJwk, m.publicKey));
    // On chiffre les octets de la clé de groupe : c'est l'enveloppe.
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, raw);
    // recipientKey : on note pour quelle clé publique l'enveloppe a été faite (le serveur vérifie qu'elle est à jour).
    return { deviceId: m.id, wrapped: b64(wrapped), iv: b64(iv), recipientKey: m.publicKey };
  }));
  // On ne garde pas la clé brute : on la ré-importe en non extractible.
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key, wraps };
}

/** Ouvrir l'enveloppe qui m'est destinée. */
/*
 * Appelée par chat.ts (sync) pour chaque enveloppe reçue du serveur.
 * Entrées : mes clés et l'enveloppe (qui l'a faite = senderKey, pour quelle clé = recipientKey, contenu, IV).
 * Sortie : la clé de groupe de cette époque, non extractible. Lève une erreur si l'enveloppe ne s'ouvre pas.
 */
export async function openEpoch(me: DeviceKeys, w: { senderKey: string; recipientKey: string; wrapped: string; iv: string }): Promise<CryptoKey> {
  // Si l'appareil a changé de clé (données du site effacées), les vieilles enveloppes visaient l'ancienne
  // clé : inutile d'essayer, elles sont perdues pour lui.
  if (w.recipientKey !== me.publicJwk) throw new Error('Enveloppe faite pour une ancienne clé de cet appareil');
  // Je recalcule la même clé d'enveloppe que l'expéditeur : ECDH(ma privée, sa publique) + même sel.
  const k = await pairKey(me.privateKey, w.senderKey, await saltFor(w.senderKey, me.publicJwk));
  // Déchiffrement : AES-GCM vérifie au passage que l'enveloppe n'a pas été modifiée (sinon : erreur).
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, k, unb64(w.wrapped));
  // La clé de groupe est importée NON extractible : on peut chiffrer/déchiffrer avec, pas la ressortir.
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Contenu d'un message (une fois déchiffré). */
/*
 * Deux formes possibles (union discriminée par le champ « t ») :
 * - texte : { t: 'text', body } ;
 * - position : { t: 'loc', lat, lng, acc? } (acc = précision en mètres).
 * Le type est DANS la partie chiffrée : le serveur ne sait même pas si c'est un texte ou une position.
 */
export type Plain = { t: 'text'; body: string } | { t: 'loc'; lat: number; lng: number; acc?: number };

/*
 * Données associées (AAD) d'un message : préfixe de version + numéro d'époque + identifiant de l'expéditeur.
 * Non chiffrées mais scellées : chiffrer et déchiffrer doivent fournir exactement la même AAD.
 * Effet : un message ne peut pas être déplacé vers une autre époque ni attribué à un autre expéditeur.
 */
const aad = (epochId: number, senderId: string) => new TextEncoder().encode(`terrain/chat/v1|${epochId}|${senderId}`);

/*
 * Chiffrer un message. Entrées : clé de groupe, époque, mon identifiant, contenu.
 * Sortie : { iv, ciphertext } en base64url, à envoyer au serveur avec l'epochId.
 */
export async function encryptMessage(key: CryptoKey, epochId: number, senderId: string, msg: Plain) {
  // IV neuf et aléatoire pour chaque message : la même clé de groupe sert à beaucoup de messages,
  // donc réutiliser un IV serait une faute grave (voir le guide en haut du fichier).
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Le message devient du JSON, puis des octets UTF-8.
  const data = new TextEncoder().encode(JSON.stringify(msg));
  // Chiffrement authentifié : le résultat contient le texte chiffré + l'étiquette d'intégrité de 16 octets.
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(epochId, senderId) }, key, data);
  return { iv: b64(iv), ciphertext: b64(ct) };
}

/*
 * Déchiffrer un message reçu. Lève une erreur si : mauvaise clé, message modifié, mauvaise époque ou mauvais
 * expéditeur (AAD différente), ou contenu inattendu. chat.ts attrape l'erreur et affiche « illisible ».
 */
export async function decryptMessage(key: CryptoKey, epochId: number, senderId: string, iv: string, ciphertext: string): Promise<Plain> {
  // L'AAD est recalculée à partir de ce que dit le serveur (époque, expéditeur) : s'il ment, l'étiquette ne colle plus.
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(epochId, senderId) }, key, unb64(ciphertext));
  const msg = JSON.parse(new TextDecoder().decode(pt)) as Plain;
  // Le « as Plain » ne vérifie rien à l'exécution : on contrôle donc la forme à la main, et on reconstruit
  // un objet propre (sans champ en trop) pour ne jamais faire confiance aveuglément à un autre membre.
  if (msg.t === 'text' && typeof msg.body === 'string') return { t: 'text', body: msg.body };
  if (msg.t === 'loc' && Number.isFinite(msg.lat) && Number.isFinite(msg.lng)) return { t: 'loc', lat: msg.lat, lng: msg.lng, acc: msg.acc };
  throw new Error('Message illisible');
}

/** Code de sécurité d'un appareil : à comparer de vive voix pour être sûr que personne ne s'est glissé au milieu. */
/*
 * Pourquoi ? Le serveur distribue les clés publiques. Un serveur malveillant pourrait remplacer la clé de
 * Bob par la sienne (attaque de « l'homme du milieu ») ou ajouter un faux membre. En comparant de vive voix
 * le code affiché pour Bob sur mon téléphone avec celui affiché sur le téléphone de Bob, on le détecte.
 * Calcul : SHA-256 de la clé publique, puis 10 nombres de 00 à 99 tirés de 2 octets chacun,
 * soit 20 chiffres groupés par 5 (ex. « 12345 67890 12345 67890 »).
 */
export async function safetyCode(publicJwk: string): Promise<string> {
  // Empreinte de 32 octets de la clé publique (son texte JWK canonique).
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicJwk)));
  let n = '';
  // Pour i = 0..9 : on assemble 2 octets en un nombre de 0 à 65535, on garde le reste modulo 100,
  // et on l'écrit sur 2 chiffres (padStart ajoute un 0 devant si besoin).
  for (let i = 0; i < 10; i++) n += String(((h[2 * i] << 8) | h[2 * i + 1]) % 100).padStart(2, '0');
  // Découpe en blocs de 5 chiffres séparés par un espace, plus faciles à lire à voix haute.
  return n.match(/.{1,5}/g)!.join(' ');
}
