/*
 * chat.ts — l'onglet « Chat » de l'interface (navigateur).
 *
 * Qui l'appelle ? web/src/main.ts appelle mountChat(panneau) une seule fois au démarrage, seulement si
 * l'appareil a accès au côté Mouvement. main.ts relaie aussi les événements temps réel « chat » du
 * serveur (Server-Sent Events) via store.emit('chat'), que ce fichier écoute.
 *
 * Répartition des rôles :
 * - chat-crypto.ts : les calculs cryptographiques (clés, chiffrement) ;
 * - api.ts : les appels HTTP vers server/routes-chat.ts ;
 * - ici : l'orchestration (publier ma clé, ouvrir les enveloppes, décider s'il faut une nouvelle
 *   époque, réessayer en cas de 409), la vérification des membres, et l'affichage.
 *
 * Ce que le chat protège, et ce qu'il ne protège pas (à lire !) :
 * - Le serveur ne peut pas LIRE les messages : il ne voit que du texte chiffré.
 * - Le serveur fournit la liste des membres et leurs clés publiques. S'il était piraté, il pourrait
 *   glisser un faux membre. Parade : chaque appareil retient les clés qu'il a déjà vues (« carnet
 *   de confiance », dans le stockage local) et AVERTIT quand un membre apparaît ou change de clé.
 *   Il faut alors comparer de vive voix les codes de sécurité, puis marquer le membre « vérifié ».
 * - Une époque n'est acceptée que si elle vient de la clé d'un membre connu.
 * - Chaque message contient, chiffrés, un identifiant et l'heure d'envoi : un message rejoué en
 *   double est ignoré, et l'heure affichée ne peut pas être falsifiée par le serveur.
 * - La clé de groupe change à chaque arrivée/départ ET au moins une fois par semaine : une clé de
 *   groupe volée ne permet pas de lire indéfiniment. Ce n'est pas une confidentialité persistante
 *   complète (comme Signal) : la clé d'APPAREIL est fixe, et un appareil compromis peut relire ce qui
 *   est encore conservé (30 jours).
 *
 * Notions : « état de module ». Les variables `let` ci-dessous vivent tant que la page est ouverte.
 * Rappel : `h(...)` (ui.ts) fabrique un élément HTML ; `clear(el, ...enfants)` remplace son contenu.
 * h() insère le texte comme du texte (pas comme du HTML) : un message ne peut pas injecter de balises.
 */
import { api, ApiError } from './api';
import { store } from './store';
import { openSheet, confirmSheet } from './sheet';
import { flyTo, markSpot } from './map';
import { getPosition } from './geo';
import { h, icon, clear, toast, time, dayLong, sameDay } from './ui';
import {
  deviceKeys, newEpoch, openEpoch, encryptMessage, decryptMessage, safetyCode,
  type DeviceKeys, type Plain,
} from './chat-crypto';
import type { ChatMember, ChatMessage } from '../../shared/model';

// Un message tel qu'on l'affiche. `at` = heure d'envoi (chiffrée si disponible, sinon celle du serveur),
// `mid` = identifiant chiffré (pour repérer un doublon), `cursor` = position côté serveur (pagination).
interface Shown { id: string; mid: string | null; senderId: string; senderName: string | null; at: number; cursor: string; plain: Plain | null }

/** Durée maximale d'une époque : au-delà, on en ouvre une nouvelle même si le groupe n'a pas changé. */
const EPOCH_MAX_AGE = 7 * 86400_000;

// Mes clés d'appareil (chargées au premier sync).
let me: DeviceKeys | null = null;
// Le groupe actuel, tel que renvoyé par le serveur.
let members: ChatMember[] = [];
// La dernière époque connue, sa date, et pour quels (appareil, clé) elle a été faite.
let lastEpoch: { id: number; createdAt: number; members: { id: string; key: string }[] } | null = null;
// Clés de groupe déjà ouvertes, par numéro d'époque.
const epochKeys = new Map<number, CryptoKey>();
// Messages affichés, du plus ancien au plus récent.
let messages: Shown[] = [];
// Taille d'une page de messages côté serveur (renvoyée par l'API).
let page = 100;
let root: HTMLElement;
let list: HTMLElement;
let banner: HTMLElement;
let ready = false;

// ---------- Carnet de confiance (clés déjà vues) ----------

/** Ce que l'appareil sait d'un membre : sa clé, et si on a vérifié son code de vive voix. */
interface Known { key: string; verified: boolean }
const TRUST_KEY = 'terrain:chat:trust';

function loadTrust(): Record<string, Known> {
  try { return JSON.parse(localStorage.getItem(TRUST_KEY) ?? '{}') as Record<string, Known>; } catch { return {}; }
}
function saveTrust(t: Record<string, Known>) {
  try { localStorage.setItem(TRUST_KEY, JSON.stringify(t)); } catch { /* stockage indisponible */ }
}

/**
 * Changements depuis la dernière visite : membres nouveaux (`added`) et membres dont la clé a
 * changé (`changed`, plus inquiétant : nouveau téléphone… ou intrus). Le tout premier passage sur
 * cet appareil sert de référence : personne n'est signalé, tout le monde est « non vérifié ».
 */
let alerts: { added: ChatMember[]; changed: ChatMember[] } = { added: [], changed: [] };

function updateTrust() {
  const trust = loadTrust();
  const first = Object.keys(trust).length === 0;
  const added: ChatMember[] = [];
  const changed: ChatMember[] = [];
  for (const m of members) {
    if (m.id === store.me.id) { trust[m.id] = { key: m.publicKey, verified: true }; continue; }
    const k = trust[m.id];
    if (!k) { if (!first) added.push(m); trust[m.id] = { key: m.publicKey, verified: false }; }
    else if (k.key !== m.publicKey) { changed.push(m); trust[m.id] = { key: m.publicKey, verified: false }; }
  }
  saveTrust(trust);
  // On cumule avec les alertes pas encore vues (jusqu'à ce que la personne ouvre la liste des membres).
  const merge = (a: ChatMember[], b: ChatMember[]) => [...a.filter((x) => !b.some((y) => y.id === x.id)), ...b];
  alerts = { added: merge(alerts.added, added), changed: merge(alerts.changed, changed) };
}

/** Clés acceptées comme expéditrices d'une époque : celles des membres connus (actuels ou passés). */
function trustedKeys(): Set<string> {
  const t = loadTrust();
  return new Set([...Object.values(t).map((k) => k.key), ...members.map((m) => m.publicKey)]);
}

// ---------- Synchronisation des clés ----------

/**
 * Met à jour l'état local : publie ma clé, récupère membres + enveloppes, ouvre celles qu'on peut.
 */
async function sync() {
  me ??= await deviceKeys();
  // Publier ma clé publique (le serveur ne fait rien si elle n'a pas changé).
  await api.chatKey(JSON.parse(me.publicJwk));
  const st = await api.chatState();
  members = st.members;
  lastEpoch = st.lastEpoch;
  updateTrust();
  const trusted = trustedKeys();
  for (const k of st.keys) {
    if (epochKeys.has(k.epochId)) continue;
    // Enveloppe d'une ancienne clé de cet appareil, ou d'un expéditeur inconnu : ignorée.
    try { epochKeys.set(k.epochId, await openEpoch(me, k, trusted)); } catch { /* illisible ici */ }
  }
  renderBanner();
}

/** La dernière époque convient-elle pour écrire ? (même groupe, clé connue, pas trop vieille) */
function epochUpToDate(): boolean {
  if (!lastEpoch || !epochKeys.has(lastEpoch.id)) return false;
  // Rotation hebdomadaire : limite ce qu'une clé de groupe volée permettrait de lire.
  if (Date.now() - lastEpoch.createdAt > EPOCH_MAX_AGE) return false;
  const a = lastEpoch.members.map((m) => `${m.id}:${m.key}`).sort().join(',');
  const b = members.map((m) => `${m.id}:${m.publicKey}`).sort().join(',');
  return a === b;
}

/** L'époque avec laquelle chiffrer : la dernière si elle convient, sinon une nouvelle (2 essais). */
async function writingEpoch(): Promise<{ id: number; key: CryptoKey }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (epochUpToDate()) return { id: lastEpoch!.id, key: epochKeys.get(lastEpoch!.id)! };
    const { key, wraps } = await newEpoch(me!, members.map((m) => ({ id: m.id, publicKey: m.publicKey })));
    try {
      const { epochId } = await api.chatEpoch({ wraps, senderKey: me!.publicJwk });
      epochKeys.set(epochId, key);
      lastEpoch = { id: epochId, createdAt: Date.now(), members: members.map((m) => ({ id: m.id, key: m.publicKey })) };
      return { id: epochId, key };
    } catch (e) {
      // 409 : la liste a changé entre-temps : on se resynchronise et on recommence.
      if ((e as ApiError).status !== 409) throw e;
      await sync();
    }
  }
  throw new Error('Le groupe change trop vite, réessaie dans un instant.');
}

// ---------- Messages ----------

/** Déchiffre un message reçu du serveur (contenu null s'il est illisible sur cet appareil). */
async function decrypt(m: ChatMessage): Promise<Shown> {
  const key = epochKeys.get(m.epochId);
  let plain: Plain | null = null;
  let mid: string | null = null;
  let at = m.createdAt;
  if (key) {
    try {
      const s = await decryptMessage(key, m.epochId, m.senderId, m.iv, m.ciphertext);
      mid = s.mid ?? null;
      // Heure chiffrée par l'expéditeur, si elle est plausible (pas plus d'une heure d'écart avec le
      // serveur : un téléphone à l'heure fausse ne doit pas reclasser tout le fil).
      if (s.at && Math.abs(s.at - m.createdAt) < 3600_000) at = s.at;
      plain = s.t === 'text' ? { t: 'text', body: s.body } : { t: 'loc', lat: s.lat, lng: s.lng, acc: s.acc };
    } catch { plain = null; }
  }
  return { id: m.id, mid, senderId: m.senderId, senderName: m.senderName, at, cursor: `${m.createdAt}:${m.id}`, plain };
}

/** Range la liste : tri par heure, et doublons (même identifiant chiffré) retirés. */
function normalize(list: Shown[]): Shown[] {
  const seen = new Set<string>();
  return list
    .sort((a, b) => a.at - b.at || a.cursor.localeCompare(b.cursor))
    .filter((m) => {
      if (!m.mid) return true;
      // Même expéditeur + même identifiant chiffré = rejeu du même message : on n'en garde qu'un.
      const k = `${m.senderId}|${m.mid}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/**
 * Met à jour la liste avec le serveur :
 *  1) rattrape TOUT ce qui est arrivé depuis le dernier message connu (page après page : une rafale
 *     de plus de 100 messages ne laisse plus de trou) ;
 *  2) recharge la page la plus récente et retire de l'écran les messages qui n'y sont plus
 *     (effacés par leur auteur ou un admin) : avant, ils restaient affichés jusqu'au rechargement.
 */
async function loadLatest() {
  const known = new Map(messages.map((m) => [m.id, m]));
  let after = messages.length ? messages[messages.length - 1].cursor : undefined;
  if (after) {
    for (let i = 0; i < 20; i++) {
      const r = await api.chatMessages({ after });
      page = r.page;
      for (const m of await Promise.all(r.messages.map(decrypt))) known.set(m.id, m);
      if (r.messages.length < r.page) break;
      after = `${r.messages[r.messages.length - 1].createdAt}:${r.messages[r.messages.length - 1].id}`;
    }
  }
  const latest = await api.chatMessages();
  page = latest.page;
  const fresh = await Promise.all(latest.messages.map(decrypt));
  for (const m of fresh) known.set(m.id, m);
  // Fenêtre couverte par la page récente : du plus ancien message renvoyé jusqu'à maintenant.
  // Tout message local dans cette fenêtre mais absent de la réponse a été effacé.
  const ids = new Set(fresh.map((m) => m.id));
  const oldest = latest.messages.length === latest.page ? latest.messages[latest.messages.length - 1] : null;
  const floor = oldest ? `${oldest.createdAt}:${oldest.id}` : '';
  for (const [id, m] of known) {
    if (!ids.has(id) && cursorGte(m.cursor, floor)) known.delete(id);
  }
  messages = normalize([...known.values()]);
}

/** Compare deux curseurs « date:id » (la date d'abord, numériquement). */
function cursorGte(a: string, b: string): boolean {
  if (!b) return true;
  const [ta, ia] = [Number(a.split(':')[0]), a.split(':')[1]];
  const [tb, ib] = [Number(b.split(':')[0]), b.split(':')[1]];
  return ta > tb || (ta === tb && ia >= ib);
}

/** Charge la page de messages plus anciens (bouton en haut de la liste). */
async function loadOlder() {
  const oldest = messages.reduce<Shown | null>((o, m) => (!o || !cursorGte(m.cursor, o.cursor) ? m : o), null);
  if (!oldest) return;
  const { messages: raw } = await api.chatMessages({ before: oldest.cursor });
  if (!raw.length) return toast('Pas de message plus ancien.', 'info');
  messages = normalize([...(await Promise.all(raw.map(decrypt))), ...messages]);
  renderList(false);
}

/** Envoie un message : synchroniser, choisir l'époque, chiffrer, envoyer (avec reprise sur 409). */
async function send(msg: Plain) {
  await sync();
  for (let attempt = 0; ; attempt++) {
    const { id, key } = await writingEpoch();
    const enc = await encryptMessage(key, id, store.me.id, msg);
    try {
      await api.chatSend({ epochId: id, ...enc });
      break;
    } catch (e) {
      if ((e as ApiError).status !== 409 || attempt >= 2) throw e;
      await sync();
    }
  }
  await loadLatest();
  renderList(true);
}

// ---------- Affichage ----------

/** Une bulle de message. */
function bubble(m: Shown) {
  const mine = m.senderId === store.me.id;
  let content: Node;
  if (!m.plain) {
    content = h('span', { class: 'chat-locked' }, icon('lock', 14), 'Message illisible sur cet appareil (envoyé avant ton arrivée, ou avec une ancienne clé).');
  } else if (m.plain.t === 'loc') {
    const pos = { lat: m.plain.lat, lng: m.plain.lng };
    content = h('span', { class: 'chat-loc' }, icon('map-pin', 16), h('span', null, 'Position partagée', m.plain.acc ? h('small', null, ` · ± ${Math.round(m.plain.acc)} m`) : null),
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { store.setView('map'); setTimeout(() => { markSpot(pos, m.senderName ?? 'Position partagée'); flyTo(pos, 18); }, 250); } }, 'Voir'));
  } else {
    content = h('span', { class: 'chat-text' }, m.plain.body);
  }
  // L'auteur n'est plus membre (appareil retiré ou parti du côté Mouvement) : on le signale.
  const gone = !mine && !members.some((x) => x.id === m.senderId);
  const unverified = !mine && !gone && loadTrust()[m.senderId]?.verified === false;
  return h('li', { class: `chat-msg${mine ? ' mine' : ''}` },
    mine ? null : h('span', { class: 'chat-from' }, m.senderName ?? 'Appareil retiré', gone && m.senderName ? h('em', null, ' (n\'est plus membre)') : null,
      unverified ? h('span', { class: 'chat-unverified', title: 'Code de sécurité pas encore vérifié' }, icon('shield-alert', 12)) : null),
    h('div', { class: 'chat-bubble' }, content),
    h('span', { class: 'chat-meta' }, time(m.at),
      mine || store.me.role === 'admin' ? h('button', { class: 'chat-del', type: 'button', 'aria-label': 'Effacer ce message', onclick: async () => {
        if (!(await confirmSheet('Effacer ce message ?', 'Il disparaîtra pour tout le monde.', 'Effacer'))) return;
        try { await api.chatDelete(m.id); messages = messages.filter((x) => x.id !== m.id); renderList(false); } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, icon('trash-2', 12)) : null));
}

/** Redessine la liste ; `scrollToEnd` : descendre tout en bas (nouveau message). */
function renderList(scrollToEnd: boolean) {
  if (!list) return;
  const items: Node[] = [];
  // Bouton « plus anciens » seulement si on a au moins une page pleine (il y en a peut-être d'autres).
  if (messages.length >= page) items.push(h('li', { class: 'chat-older' }, h('button', { class: 'link-btn', type: 'button', onclick: () => void loadOlder() }, 'Messages plus anciens')));
  let day = 0;
  for (const m of messages) {
    if (!day || !sameDay(day, m.at)) { day = m.at; items.push(h('li', { class: 'chat-day' }, dayLong(m.at))); }
    items.push(bubble(m));
  }
  if (!messages.length) items.push(h('li', { class: 'chat-empty' }, icon('message-circle', 32, 1.6), h('strong', null, 'Aucun message'), h('span', null, 'Écris le premier : il sera chiffré sur ton téléphone avant de partir.')));
  clear(list, ...items);
  if (scrollToEnd) requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
}

/** Bandeau d'alerte : nouveaux membres / clés changées, à vérifier. */
function renderBanner() {
  if (!banner) return;
  const { added, changed } = alerts;
  if (!added.length && !changed.length) return void clear(banner);
  const names = (l: ChatMember[]) => l.map((m) => m.name).join(', ');
  clear(banner, h('div', { class: `chat-alert${changed.length ? ' is-danger' : ''}` },
    icon(changed.length ? 'shield-alert' : 'user-plus', 18),
    h('span', null,
      changed.length ? h('strong', null, `Clé changée : ${names(changed)}. `) : null,
      added.length ? `Nouveau dans le chat : ${names(added)}. ` : null,
      changed.length ? 'Nouveau téléphone… ou quelqu\'un qui se fait passer pour lui. Compare son code de sécurité de vive voix.' : 'Vérifie son code de sécurité quand tu le croises.'),
    h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => void openMembers() }, 'Vérifier')));
}

/** Liste des membres avec leurs codes de sécurité, et un bouton « vérifié » pour chacun. */
async function openMembers() {
  const rows = await Promise.all(members.map(async (m) => ({ m, code: await safetyCode(m.publicKey) })));
  // Ouvrir la liste vaut « j'ai vu l'alerte » : le bandeau disparaît.
  alerts = { added: [], changed: [] };
  renderBanner();
  const render = () => {
    const trust = loadTrust();
    return h('ul', { class: 'chat-members' }, rows.map(({ m, code }) => {
      const self = m.id === store.me.id;
      const ok = self || trust[m.id]?.verified;
      return h('li', null,
        h('strong', null, m.name, self ? h('em', null, ' (moi)') : null),
        h('code', { class: 'chat-code' }, code),
        self ? null : ok
          ? h('span', { class: 'chat-verified' }, icon('shield-check', 14), 'Vérifié')
          : h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: (e: Event) => {
              const t = loadTrust();
              t[m.id] = { key: m.publicKey, verified: true };
              saveTrust(t);
              (e.currentTarget as HTMLElement).closest('ul')!.replaceWith(render());
              renderList(false);
            } }, 'C\'est le même code'));
    }));
  };
  openSheet({
    title: 'Membres du chat',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'Pour être sûr·e que personne ne s\'est glissé au milieu, comparez de vive voix le code de sécurité de chaque appareil : celui affiché ici doit être le même que celui affiché sur le téléphone de la personne. Si c\'est le cas, marque-le comme vérifié.'),
      render(),
      h('p', { class: 'field-hint' }, 'Un membre qui efface les données du site ou change de téléphone obtient une nouvelle clé (et un nouveau code) : il faudra le vérifier à nouveau, et il ne pourra plus relire les anciens messages.'),
    ),
  });
}

/** Monte l'onglet Chat dans `el`. Appelée une fois par main.ts. */
export function mountChat(el: HTMLElement) {
  root = el;
  list = h('ul', { class: 'chat-list', 'aria-live': 'polite' });
  banner = h('div', { class: 'chat-banner' });
  const input = h('textarea', { class: 'input chat-input', rows: '1', maxlength: '4000', placeholder: 'Message chiffré…', 'aria-label': 'Message' }) as HTMLTextAreaElement;
  const sendBtn = h('button', { class: 'btn btn-primary chat-send', type: 'button', 'aria-label': 'Envoyer' }, icon('send', 18)) as HTMLButtonElement;
  const locBtn = h('button', { class: 'btn btn-light chat-send', type: 'button', 'aria-label': 'Envoyer ma position', title: 'Envoyer ma position' }, icon('map-pin', 18)) as HTMLButtonElement;
  const status = h('p', { class: 'field-hint chat-status' });

  // Envoi d'un texte (bouton ou Entrée ; Maj+Entrée = retour à la ligne).
  const doSend = async () => {
    const text = input.value.trim();
    if (!text || !ready) return;
    sendBtn.disabled = true;
    try { await send({ t: 'text', body: text }); input.value = ''; input.style.height = ''; }
    catch (e) { toast((e as Error).message, 'err', 5000); }
    sendBtn.disabled = false;
    input.focus();
  };
  sendBtn.onclick = () => void doSend();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend(); } });
  // La zone de saisie grandit avec le texte (jusqu'à 140 px).
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(140, input.scrollHeight)}px`; });
  // Envoi de ma position (après confirmation), arrondie à ~1 m.
  locBtn.onclick = async () => {
    if (!ready) return;
    if (!(await confirmSheet('Envoyer ta position ?', 'Ta position actuelle sera envoyée, chiffrée, à tous les membres du chat.', 'Envoyer', false))) return;
    locBtn.disabled = true;
    try {
      const p = await getPosition(15000);
      await send({ t: 'loc', lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5, acc: p.accuracy });
    } catch (e) { toast((e as Error).message, 'err', 5000); }
    locBtn.disabled = false;
  };

  clear(root,
    h('div', { class: 'panel-head' },
      h('h2', { class: 'panel-title' }, 'Chat'),
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => void openMembers() }, icon('shield-check', 16), 'Membres')),
    h('p', { class: 'chat-e2e' }, icon('lock', 14), 'Chiffré de bout en bout : le serveur ne voit que du charabia. Messages effacés au bout de 30 jours.'),
    banner,
    status,
    list,
    h('div', { class: 'chat-compose' }, locBtn, input, sendBtn),
  );

  // Démarrage : clés, puis messages. Une erreur ici (pas de https, stockage bloqué) est affichée.
  const start = async () => {
    status.textContent = 'Préparation des clés de chiffrement…';
    try {
      await sync();
      await loadLatest();
      ready = true;
      status.textContent = '';
      renderList(true);
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };

  // Signal temps réel « chat » (nouveau message, effacement, changement de membres) : on resynchronise.
  store.on('chat', async () => {
    if (!ready) return;
    try { await sync(); await loadLatest(); renderList(store.view === 'chat'); } catch { /* prochaine fois */ }
  });
  store.on('view', () => { if (store.view === 'chat' && ready) requestAnimationFrame(() => (list.scrollTop = list.scrollHeight)); });
  void start();
}
