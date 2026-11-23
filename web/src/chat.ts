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
import type { ChatMember } from '../../shared/model';

/*
 * Onglet « Chat » (côté Mouvement), chiffré de bout en bout : voir chat-crypto.ts.
 * Ici : publier sa clé, ouvrir une nouvelle époque quand le groupe change, chiffrer / déchiffrer, afficher.
 */

interface Shown { id: string; senderId: string; senderName: string | null; createdAt: number; plain: Plain | null }

let me: DeviceKeys | null = null;
let members: ChatMember[] = [];
let lastEpoch: { id: number; members: { id: string; key: string }[] } | null = null;
const epochKeys = new Map<number, CryptoKey>();
let messages: Shown[] = [];
let root: HTMLElement;
let list: HTMLElement;
let ready = false;
let fatal: string | null = null;

/** Clé publique publiée, enveloppes ouvertes. */
async function sync() {
  me ??= await deviceKeys();
  await api.chatKey(JSON.parse(me.publicJwk));
  const st = await api.chatState();
  members = st.members;
  lastEpoch = st.lastEpoch;
  for (const k of st.keys) {
    if (epochKeys.has(k.epochId)) continue;
    try { epochKeys.set(k.epochId, await openEpoch(me, k)); } catch { /* enveloppe d'une ancienne clé de cet appareil */ }
  }
}

/** Le groupe a-t-il changé depuis la dernière clé (arrivée, départ, nouvelle clé) ? */
function epochUpToDate(): boolean {
  if (!lastEpoch || !epochKeys.has(lastEpoch.id)) return false;
  const a = lastEpoch.members.map((m) => `${m.id}:${m.key}`).sort().join(',');
  const b = members.map((m) => `${m.id}:${m.publicKey}`).sort().join(',');
  return a === b;
}

/** Clé de groupe à utiliser pour écrire : la dernière si le groupe n'a pas changé, sinon une nouvelle. */
async function writingEpoch(): Promise<{ id: number; key: CryptoKey }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (epochUpToDate()) return { id: lastEpoch!.id, key: epochKeys.get(lastEpoch!.id)! };
    const { key, wraps } = await newEpoch(me!, members.map((m) => ({ id: m.id, publicKey: m.publicKey })));
    try {
      const { epochId } = await api.chatEpoch({ wraps, senderKey: me!.publicJwk });
      epochKeys.set(epochId, key);
      lastEpoch = { id: epochId, members: members.map((m) => ({ id: m.id, key: m.publicKey })) };
      return { id: epochId, key };
    } catch (e) {
      if ((e as ApiError).status !== 409) throw e;
      await sync(); // la liste a changé entre-temps : on recommence avec la bonne
    }
  }
  throw new Error('Le groupe change trop vite, réessaie dans un instant.');
}

async function decrypt(m: { id: string; epochId: number; senderId: string; senderName: string | null; iv: string; ciphertext: string; createdAt: number }): Promise<Shown> {
  const key = epochKeys.get(m.epochId);
  let plain: Plain | null = null;
  if (key) { try { plain = await decryptMessage(key, m.epochId, m.senderId, m.iv, m.ciphertext); } catch { plain = null; } }
  return { id: m.id, senderId: m.senderId, senderName: m.senderName, createdAt: m.createdAt, plain };
}

async function loadLatest() {
  const { messages: raw } = await api.chatMessages();
  const shown = await Promise.all(raw.map(decrypt));
  const known = new Map(messages.map((m) => [m.id, m]));
  for (const m of shown) known.set(m.id, m);
  messages = [...known.values()].sort((a, b) => a.createdAt - b.createdAt);
}

async function loadOlder() {
  const oldest = messages[0]?.createdAt;
  if (!oldest) return;
  const { messages: raw } = await api.chatMessages(oldest);
  if (!raw.length) return toast('Pas de message plus ancien.', 'info');
  messages = [...(await Promise.all(raw.map(decrypt))), ...messages].sort((a, b) => a.createdAt - b.createdAt);
  renderList(false);
}

async function send(msg: Plain) {
  // Toujours repartir de la liste des membres à jour (retrait, arrivée, nouvelle clé).
  await sync();
  for (let attempt = 0; ; attempt++) {
    const { id, key } = await writingEpoch();
    const enc = await encryptMessage(key, id, store.me.id, msg);
    try {
      await api.chatSend({ epochId: id, ...enc });
      break;
    } catch (e) {
      // Le serveur refuse une clé qui ne correspond plus au groupe : on resynchronise et on chiffre à nouveau.
      if ((e as ApiError).status !== 409 || attempt >= 2) throw e;
      await sync();
    }
  }
  await loadLatest();
  renderList(true);
}

// ---------- Affichage ----------

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
  return h('li', { class: `chat-msg${mine ? ' mine' : ''}` },
    mine ? null : h('span', { class: 'chat-from' }, m.senderName ?? 'Appareil retiré'),
    h('div', { class: 'chat-bubble' }, content),
    h('span', { class: 'chat-meta' }, time(m.createdAt),
      mine || store.me.role === 'admin' ? h('button', { class: 'chat-del', type: 'button', 'aria-label': 'Effacer ce message', onclick: async () => {
        if (!(await confirmSheet('Effacer ce message ?', 'Il disparaîtra pour tout le monde.', 'Effacer'))) return;
        try { await api.chatDelete(m.id); messages = messages.filter((x) => x.id !== m.id); renderList(false); } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, icon('trash-2', 12)) : null));
}

function renderList(scrollToEnd: boolean) {
  if (!list) return;
  const items: Node[] = [];
  if (messages.length >= 60) items.push(h('li', { class: 'chat-older' }, h('button', { class: 'link-btn', type: 'button', onclick: () => void loadOlder() }, 'Messages plus anciens')));
  let day = 0;
  for (const m of messages) {
    if (!day || !sameDay(day, m.createdAt)) { day = m.createdAt; items.push(h('li', { class: 'chat-day' }, dayLong(m.createdAt))); }
    items.push(bubble(m));
  }
  if (!messages.length) items.push(h('li', { class: 'chat-empty' }, icon('message-circle', 32, 1.6), h('strong', null, 'Aucun message'), h('span', null, 'Écris le premier : il sera chiffré sur ton téléphone avant de partir.')));
  clear(list, ...items);
  if (scrollToEnd) requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
}

async function openMembers() {
  const rows = await Promise.all(members.map(async (m) => ({ m, code: await safetyCode(m.publicKey) })));
  openSheet({
    title: 'Membres du chat',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'Pour être sûr·e que personne ne s\'est glissé au milieu, comparez de vive voix le code de sécurité de chaque appareil : celui affiché ici doit être le même que celui affiché sur le téléphone de la personne.'),
      h('ul', { class: 'chat-members' }, rows.map(({ m, code }) => h('li', null,
        h('strong', null, m.name, m.id === store.me.id ? h('em', null, ' (moi)') : null),
        h('code', { class: 'chat-code' }, code)))),
      h('p', { class: 'field-hint' }, 'Un membre qui efface les données du site ou change de téléphone obtient une nouvelle clé (et un nouveau code) : il ne pourra plus relire les anciens messages.'),
    ),
  });
}

export function mountChat(el: HTMLElement) {
  root = el;
  list = h('ul', { class: 'chat-list', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'input chat-input', rows: '1', maxlength: '4000', placeholder: 'Message chiffré…', 'aria-label': 'Message' }) as HTMLTextAreaElement;
  const sendBtn = h('button', { class: 'btn btn-primary chat-send', type: 'button', 'aria-label': 'Envoyer' }, icon('send', 18)) as HTMLButtonElement;
  const locBtn = h('button', { class: 'btn btn-light chat-send', type: 'button', 'aria-label': 'Envoyer ma position', title: 'Envoyer ma position' }, icon('map-pin', 18)) as HTMLButtonElement;
  const status = h('p', { class: 'field-hint chat-status' });

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
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(140, input.scrollHeight)}px`; });
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
    status,
    list,
    h('div', { class: 'chat-compose' }, locBtn, input, sendBtn),
  );

  const start = async () => {
    status.textContent = 'Préparation des clés de chiffrement…';
    try {
      await sync();
      await loadLatest();
      ready = true;
      status.textContent = '';
      renderList(true);
    } catch (e) {
      fatal = (e as Error).message;
      status.textContent = fatal;
    }
  };

  // Temps réel : nouveaux messages, membres qui changent.
  store.on('chat', async () => {
    if (!ready) return;
    try { await sync(); await loadLatest(); renderList(store.view === 'chat'); } catch { /* prochaine fois */ }
  });
  store.on('view', () => { if (store.view === 'chat' && ready) requestAnimationFrame(() => (list.scrollTop = list.scrollHeight)); });
  void start();
}
