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

const DB = 'terrain-chat';
const STORE = 'keys';
const HKDF_INFO = new TextEncoder().encode('terrain/chat/epoch-key/v1');

// ---------- base64url ----------
export const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64 = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
};

// ---------- stockage local de la clé d'appareil ----------
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

export interface DeviceKeys { privateKey: CryptoKey; publicJwk: string }

/** Clé de cet appareil : créée la première fois, puis relue depuis IndexedDB. */
export async function deviceKeys(): Promise<DeviceKeys> {
  if (!window.isSecureContext || !crypto.subtle) throw new Error('Le chat chiffré demande une connexion sécurisée (https).');
  const saved = await idb<{ privateKey: CryptoKey; publicJwk: string } | undefined>('readonly', (s) => s.get('device'));
  if (saved?.privateKey && saved.publicJwk) return saved;
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
  const keys = { privateKey: pair.privateKey, publicJwk };
  await idb('readwrite', (s) => s.put(keys, 'device'));
  return keys;
}

const importPublic = (jwk: string) =>
  crypto.subtle.importKey('jwk', { ...JSON.parse(jwk), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);

/** Clé d'enveloppe partagée entre moi et un autre appareil (ECDH → HKDF → AES-GCM). */
async function pairKey(myPrivate: CryptoKey, theirPublicJwk: string, salt: BufferSource): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(theirPublicJwk) }, myPrivate, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Sel de l'enveloppe : lié aux deux clés publiques (dans un ordre fixe). */
const saltFor = async (a: string, b: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|'))));

/** Nouvelle clé de groupe, chiffrée pour chaque membre. */
export async function newEpoch(me: DeviceKeys, members: { id: string; publicKey: string }[]) {
  const groupKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await crypto.subtle.exportKey('raw', groupKey);
  const wraps = await Promise.all(members.map(async (m) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await pairKey(me.privateKey, m.publicKey, await saltFor(me.publicJwk, m.publicKey));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, raw);
    return { deviceId: m.id, wrapped: b64(wrapped), iv: b64(iv), recipientKey: m.publicKey };
  }));
  // On ne garde pas la clé brute : on la ré-importe en non extractible.
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key, wraps };
}

/** Ouvrir l'enveloppe qui m'est destinée. */
export async function openEpoch(me: DeviceKeys, w: { senderKey: string; recipientKey: string; wrapped: string; iv: string }): Promise<CryptoKey> {
  if (w.recipientKey !== me.publicJwk) throw new Error('Enveloppe faite pour une ancienne clé de cet appareil');
  const k = await pairKey(me.privateKey, w.senderKey, await saltFor(w.senderKey, me.publicJwk));
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, k, unb64(w.wrapped));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Contenu d'un message (une fois déchiffré). */
export type Plain = { t: 'text'; body: string } | { t: 'loc'; lat: number; lng: number; acc?: number };

const aad = (epochId: number, senderId: string) => new TextEncoder().encode(`terrain/chat/v1|${epochId}|${senderId}`);

export async function encryptMessage(key: CryptoKey, epochId: number, senderId: string, msg: Plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(msg));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(epochId, senderId) }, key, data);
  return { iv: b64(iv), ciphertext: b64(ct) };
}

export async function decryptMessage(key: CryptoKey, epochId: number, senderId: string, iv: string, ciphertext: string): Promise<Plain> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(epochId, senderId) }, key, unb64(ciphertext));
  const msg = JSON.parse(new TextDecoder().decode(pt)) as Plain;
  if (msg.t === 'text' && typeof msg.body === 'string') return { t: 'text', body: msg.body };
  if (msg.t === 'loc' && Number.isFinite(msg.lat) && Number.isFinite(msg.lng)) return { t: 'loc', lat: msg.lat, lng: msg.lng, acc: msg.acc };
  throw new Error('Message illisible');
}

/** Code de sécurité d'un appareil : à comparer de vive voix pour être sûr que personne ne s'est glissé au milieu. */
export async function safetyCode(publicJwk: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicJwk)));
  let n = '';
  for (let i = 0; i < 10; i++) n += String(((h[2 * i] << 8) | h[2 * i + 1]) % 100).padStart(2, '0');
  return n.match(/.{1,5}/g)!.join(' ');
}
