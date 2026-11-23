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
 *   époque, réessayer en cas de 409) et l'affichage (bulles, membres, envoi de position).
 *
 * Notions : « état de module ». Les variables `let` ci-dessous vivent tant que la page est ouverte ;
 * elles servent de mémoire au chat (clés déchiffrées, messages affichés…). Rien de secret n'est écrit
 * sur disque ici : seules les clés d'appareil sont dans IndexedDB (géré par chat-crypto.ts).
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
import type { ChatMember } from '../../shared/model';

/*
 * Onglet « Chat » (côté Mouvement), chiffré de bout en bout : voir chat-crypto.ts.
 * Ici : publier sa clé, ouvrir une nouvelle époque quand le groupe change, chiffrer / déchiffrer, afficher.
 */

// Un message tel qu'on l'affiche : métadonnées + contenu déchiffré (null = impossible à déchiffrer ici).
interface Shown { id: string; senderId: string; senderName: string | null; createdAt: number; plain: Plain | null }

// Mes clés d'appareil (chargées au premier sync).
let me: DeviceKeys | null = null;
// Le groupe actuel, tel que renvoyé par le serveur.
let members: ChatMember[] = [];
// La dernière époque connue et pour quels (appareil, clé) elle a été faite.
let lastEpoch: { id: number; members: { id: string; key: string }[] } | null = null;
// Clés de groupe déjà ouvertes, par numéro d'époque. Gardées en mémoire seulement (perdues au rechargement,
// puis rouvertes depuis les enveloppes). Les CryptoKey sont non extractibles.
const epochKeys = new Map<number, CryptoKey>();
// Messages affichés, triés du plus ancien au plus récent.
let messages: Shown[] = [];
// Le panneau du chat, et la liste <ul> des messages.
let root: HTMLElement;
let list: HTMLElement;
// ready : la préparation (clés + premiers messages) est terminée ; on n'envoie rien avant.
let ready = false;
// Message d'erreur bloquant au démarrage (ex. pas de https).
let fatal: string | null = null;

/** Clé publique publiée, enveloppes ouvertes. */
/*
 * Synchronise l'état local avec le serveur :
 * 1) crée/relit ma clé d'appareil (une seule fois grâce à ??=) ;
 * 2) (re)publie ma clé publique (le serveur ignore si elle n'a pas changé) ;
 * 3) récupère membres, dernière époque et mes enveloppes ;
 * 4) ouvre les enveloppes que je n'ai pas encore ouvertes.
 */
async function sync() {
  // ??= : n'affecte que si `me` est encore null.
  me ??= await deviceKeys();
  // publicJwk est du texte JSON ; l'API attend l'objet.
  await api.chatKey(JSON.parse(me.publicJwk));
  const st = await api.chatState();
  members = st.members;
  lastEpoch = st.lastEpoch;
  for (const k of st.keys) {
    // Déjà ouverte : inutile de refaire le calcul.
    if (epochKeys.has(k.epochId)) continue;
    // Une enveloppe qui ne s'ouvre pas n'est pas une erreur fatale : on l'ignore simplement
    // (les messages de cette époque s'afficheront « illisibles »).
    try { epochKeys.set(k.epochId, await openEpoch(me, k)); } catch { /* enveloppe d'une ancienne clé de cet appareil */ }
  }
}

/** Le groupe a-t-il changé depuis la dernière clé (arrivée, départ, nouvelle clé) ? */
/*
 * Renvoie true si on peut réutiliser la dernière époque pour écrire : il faut l'avoir ouverte, et que
 * l'ensemble (appareil, clé publique) de l'époque soit identique au groupe actuel. Même comparaison
 * « chaîne triée » que côté serveur (routes-chat.ts, POST /chat/messages), pour décider pareil que lui.
 */
function epochUpToDate(): boolean {
  if (!lastEpoch || !epochKeys.has(lastEpoch.id)) return false;
  const a = lastEpoch.members.map((m) => `${m.id}:${m.key}`).sort().join(',');
  const b = members.map((m) => `${m.id}:${m.publicKey}`).sort().join(',');
  return a === b;
}

/** Clé de groupe à utiliser pour écrire : la dernière si le groupe n'a pas changé, sinon une nouvelle. */
/*
 * Sortie : { id: numéro d'époque, key: clé de groupe }.
 * Deux tentatives au plus : si le serveur répond 409 (quelqu'un est arrivé/parti pendant qu'on préparait
 * les enveloppes), on resynchronise et on recommence avec la bonne liste.
 */
async function writingEpoch(): Promise<{ id: number; key: CryptoKey }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Cas courant : rien n'a changé, on réutilise la dernière époque (pas de nouvelle clé à chaque message).
    if (epochUpToDate()) return { id: lastEpoch!.id, key: epochKeys.get(lastEpoch!.id)! };
    // Sinon : nouvelle clé de groupe + une enveloppe par membre actuel (moi compris).
    const { key, wraps } = await newEpoch(me!, members.map((m) => ({ id: m.id, publicKey: m.publicKey })));
    try {
      // Envoi des enveloppes ; senderKey permet au serveur de vérifier que j'utilise ma vraie clé.
      const { epochId } = await api.chatEpoch({ wraps, senderKey: me!.publicJwk });
      // On mémorise directement la clé (inutile de rouvrir notre propre enveloppe).
      epochKeys.set(epochId, key);
      lastEpoch = { id: epochId, members: members.map((m) => ({ id: m.id, key: m.publicKey })) };
      return { id: epochId, key };
    } catch (e) {
      // Toute autre erreur que 409 (réseau, 403…) est remontée telle quelle.
      if ((e as ApiError).status !== 409) throw e;
      await sync(); // la liste a changé entre-temps : on recommence avec la bonne
    }
  }
  throw new Error('Le groupe change trop vite, réessaie dans un instant.');
}

/*
 * Transforme un message reçu du serveur (chiffré) en message affichable.
 * Si on n'a pas la clé de son époque (arrivé·e après, ou clé d'appareil changée) ou si le déchiffrement
 * échoue (message altéré, AAD incohérente), plain reste null : on affichera un cadenas, sans planter.
 */
async function decrypt(m: { id: string; epochId: number; senderId: string; senderName: string | null; iv: string; ciphertext: string; createdAt: number }): Promise<Shown> {
  const key = epochKeys.get(m.epochId);
  let plain: Plain | null = null;
  if (key) { try { plain = await decryptMessage(key, m.epochId, m.senderId, m.iv, m.ciphertext); } catch { plain = null; } }
  return { id: m.id, senderId: m.senderId, senderName: m.senderName, createdAt: m.createdAt, plain };
}

/*
 * Charge les 60 messages les plus récents, les déchiffre et les fusionne avec ceux déjà affichés
 * (une Map par id évite les doublons ; les nouvelles versions remplacent les anciennes), puis trie par date.
 */
async function loadLatest() {
  const { messages: raw } = await api.chatMessages();
  // Déchiffrement en parallèle de tous les messages reçus.
  const shown = await Promise.all(raw.map(decrypt));
  const known = new Map(messages.map((m) => [m.id, m]));
  for (const m of shown) known.set(m.id, m);
  messages = [...known.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/*
 * Bouton « Messages plus anciens » : demande la page précédente (messages antérieurs au plus ancien
 * affiché), la déchiffre et l'ajoute en tête. Sans faire défiler vers le bas (renderList(false)).
 */
async function loadOlder() {
  const oldest = messages[0]?.createdAt;
  if (!oldest) return;
  const { messages: raw } = await api.chatMessages(oldest);
  if (!raw.length) return toast('Pas de message plus ancien.', 'info');
  messages = [...(await Promise.all(raw.map(decrypt))), ...messages].sort((a, b) => a.createdAt - b.createdAt);
  renderList(false);
}

/*
 * Envoyer un message (texte ou position).
 * Le chiffrement a lieu ICI, sur l'appareil, avant tout envoi : le serveur ne reçoit que { epochId, iv, ciphertext }.
 * Jusqu'à 3 essais si le serveur répond 409 (« le groupe a changé ») : on resynchronise, on obtient une
 * nouvelle époque, et on rechiffre (un message chiffré pour l'ancienne époque ne peut pas être réutilisé,
 * car l'époque fait partie de l'AAD).
 */
async function send(msg: Plain) {
  // Toujours repartir de la liste des membres à jour (retrait, arrivée, nouvelle clé).
  await sync();
  for (let attempt = 0; ; attempt++) {
    const { id, key } = await writingEpoch();
    // store.me.id = mon identifiant d'appareil, inclus dans l'AAD (doit correspondre au sender_id enregistré par le serveur).
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
  // Recharger pour afficher notre message (avec l'heure officielle du serveur) et descendre en bas.
  await loadLatest();
  renderList(true);
}

// ---------- Affichage ----------

/*
 * Fabrique la bulle <li> d'un message. Trois contenus possibles :
 * - illisible (cadenas) si plain est null ;
 * - position partagée, avec un bouton « Voir » qui bascule sur la carte et y place un repère ;
 * - texte simple.
 * Mes messages ont la classe « mine » (alignés à droite par le CSS) et pas de nom d'expéditeur.
 * Bouton corbeille : sur mes messages, ou sur tous si je suis admin (le serveur revérifie de toute façon).
 */
function bubble(m: Shown) {
  const mine = m.senderId === store.me.id;
  let content: Node;
  if (!m.plain) {
    content = h('span', { class: 'chat-locked' }, icon('lock', 14), 'Message illisible sur cet appareil (envoyé avant ton arrivée, ou avec une ancienne clé).');
  } else if (m.plain.t === 'loc') {
    const pos = { lat: m.plain.lat, lng: m.plain.lng };
    // Au clic sur « Voir » : on change de vue, puis on attend 250 ms (le temps que la carte s'affiche
    // et prenne sa taille) avant de poser le repère et de zoomer dessus.
    content = h('span', { class: 'chat-loc' }, icon('map-pin', 16), h('span', null, 'Position partagée', m.plain.acc ? h('small', null, ` · ± ${Math.round(m.plain.acc)} m`) : null),
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { store.setView('map'); setTimeout(() => { markSpot(pos, m.senderName ?? 'Position partagée'); flyTo(pos, 18); }, 250); } }, 'Voir'));
  } else {
    content = h('span', { class: 'chat-text' }, m.plain.body);
  }
  return h('li', { class: `chat-msg${mine ? ' mine' : ''}` },
    // senderName est null si l'appareil expéditeur n'existe plus côté serveur.
    mine ? null : h('span', { class: 'chat-from' }, m.senderName ?? 'Appareil retiré'),
    h('div', { class: 'chat-bubble' }, content),
    h('span', { class: 'chat-meta' }, time(m.createdAt),
      mine || store.me.role === 'admin' ? h('button', { class: 'chat-del', type: 'button', 'aria-label': 'Effacer ce message', onclick: async () => {
        // Confirmation avant suppression définitive.
        if (!(await confirmSheet('Effacer ce message ?', 'Il disparaîtra pour tout le monde.', 'Effacer'))) return;
        try { await api.chatDelete(m.id); messages = messages.filter((x) => x.id !== m.id); renderList(false); } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, icon('trash-2', 12)) : null));
}

/*
 * Redessine toute la liste des messages.
 * - Bouton « Messages plus anciens » seulement si on a au moins une page pleine (60) : il y en a peut-être d'autres.
 * - Un séparateur de date (chat-day) à chaque changement de jour.
 * - Un message d'accueil si la liste est vide.
 * scrollToEnd : faire défiler tout en bas (après un envoi ou à l'arrivée d'un message).
 */
function renderList(scrollToEnd: boolean) {
  // Sécurité : rien à faire si l'onglet n'est pas encore monté.
  if (!list) return;
  const items: Node[] = [];
  if (messages.length >= 60) items.push(h('li', { class: 'chat-older' }, h('button', { class: 'link-btn', type: 'button', onclick: () => void loadOlder() }, 'Messages plus anciens')));
  // `day` = horodatage du dernier séparateur posé (0 = aucun encore).
  let day = 0;
  for (const m of messages) {
    if (!day || !sameDay(day, m.createdAt)) { day = m.createdAt; items.push(h('li', { class: 'chat-day' }, dayLong(m.createdAt))); }
    items.push(bubble(m));
  }
  if (!messages.length) items.push(h('li', { class: 'chat-empty' }, icon('message-circle', 32, 1.6), h('strong', null, 'Aucun message'), h('span', null, 'Écris le premier : il sera chiffré sur ton téléphone avant de partir.')));
  clear(list, ...items);
  // requestAnimationFrame : on attend que le navigateur ait mis en page la liste avant de mesurer sa hauteur.
  if (scrollToEnd) requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
}

/*
 * Feuille « Membres du chat » : la liste des membres avec le code de sécurité de chacun.
 * C'est la parade à un serveur malveillant qui substituerait une clé : on compare les codes de vive voix.
 */
async function openMembers() {
  // Calcul des codes en parallèle (chacun demande un SHA-256).
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

/*
 * Point d'entrée (appelé par main.ts) : construit l'interface du chat dans `el`, branche les événements,
 * puis lance la préparation asynchrone (clés + premiers messages).
 */
export function mountChat(el: HTMLElement) {
  root = el;
  // aria-live="polite" : les lecteurs d'écran annoncent les nouveaux messages sans interrompre.
  list = h('ul', { class: 'chat-list', 'aria-live': 'polite' });
  // Zone de saisie : 4000 caractères max (reste sous la limite serveur de 16 000 caractères chiffrés).
  const input = h('textarea', { class: 'input chat-input', rows: '1', maxlength: '4000', placeholder: 'Message chiffré…', 'aria-label': 'Message' }) as HTMLTextAreaElement;
  const sendBtn = h('button', { class: 'btn btn-primary chat-send', type: 'button', 'aria-label': 'Envoyer' }, icon('send', 18)) as HTMLButtonElement;
  const locBtn = h('button', { class: 'btn btn-light chat-send', type: 'button', 'aria-label': 'Envoyer ma position', title: 'Envoyer ma position' }, icon('map-pin', 18)) as HTMLButtonElement;
  // Ligne d'état (« Préparation des clés… » ou message d'erreur).
  const status = h('p', { class: 'field-hint chat-status' });

  /*
   * Envoi du texte saisi. Le bouton est désactivé pendant l'envoi pour éviter les doubles clics.
   * En cas d'échec, le texte reste dans la zone (on ne vide qu'après succès).
   */
  const doSend = async () => {
    const text = input.value.trim();
    if (!text || !ready) return;
    sendBtn.disabled = true;
    // Après succès : on vide la zone et on remet sa hauteur par défaut.
    try { await send({ t: 'text', body: text }); input.value = ''; input.style.height = ''; }
    catch (e) { toast((e as Error).message, 'err', 5000); }
    sendBtn.disabled = false;
    input.focus();
  };
  sendBtn.onclick = () => void doSend();
  // Entrée envoie, Maj+Entrée va à la ligne.
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend(); } });
  // La zone grandit avec le texte, jusqu'à 140 px (on remet d'abord la hauteur à zéro pour mesurer le contenu réel).
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(140, input.scrollHeight)}px`; });
  /*
   * Partage de position : donnée sensible, donc confirmation explicite d'abord.
   * La position est arrondie à 5 décimales (≈ 1 m) avant d'être chiffrée et envoyée.
   */
  locBtn.onclick = async () => {
    if (!ready) return;
    if (!(await confirmSheet('Envoyer ta position ?', 'Ta position actuelle sera envoyée, chiffrée, à tous les membres du chat.', 'Envoyer', false))) return;
    locBtn.disabled = true;
    try {
      // Délai max de 15 s pour obtenir la position GPS.
      const p = await getPosition(15000);
      await send({ t: 'loc', lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5, acc: p.accuracy });
    } catch (e) { toast((e as Error).message, 'err', 5000); }
    locBtn.disabled = false;
  };

  // Construction du panneau : en-tête (titre + bouton Membres), bandeau « chiffré », état, liste, saisie.
  clear(root,
    h('div', { class: 'panel-head' },
      h('h2', { class: 'panel-title' }, 'Chat'),
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => void openMembers() }, icon('shield-check', 16), 'Membres')),
    h('p', { class: 'chat-e2e' }, icon('lock', 14), 'Chiffré de bout en bout : le serveur ne voit que du charabia. Messages effacés au bout de 30 jours.'),
    status,
    list,
    h('div', { class: 'chat-compose' }, locBtn, input, sendBtn),
  );

  /*
   * Préparation : clés, enveloppes, premiers messages. En cas d'échec (pas de https, réseau…), l'erreur
   * est affichée dans la ligne d'état et le chat reste inutilisable (ready = false).
   */
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
  // À chaque signal « chat » du serveur : resynchroniser (nouvelles enveloppes, membres) puis recharger.
  // On ne fait défiler vers le bas que si l'utilisateur regarde l'onglet Chat. Les erreurs sont ignorées
  // (le prochain signal réessaiera).
  store.on('chat', async () => {
    if (!ready) return;
    try { await sync(); await loadLatest(); renderList(store.view === 'chat'); } catch { /* prochaine fois */ }
  });
  // En revenant sur l'onglet Chat, on se place sur les derniers messages.
  store.on('view', () => { if (store.view === 'chat' && ready) requestAnimationFrame(() => (list.scrollTop = list.scrollHeight)); });
  // « void » : on lance la préparation sans l'attendre (mountChat reste synchrone).
  void start();
}
