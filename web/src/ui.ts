/*
 * web/src/ui.ts — la boîte à outils de l'interface.
 *
 * Contient :
 * 1. `icon()` : fabrique une icône SVG à partir de son nom (bibliothèque lucide).
 * 2. `h()` : un mini-créateur d'éléments HTML, qui remplace JSX/React dans ce projet sans framework.
 * 3. `toast()` : les petites notifications en bas de l'écran.
 * 4. Des fonctions de dates (formatage en français, débuts de jour/semaine, champs de formulaire).
 * 5. `inkFor()` : choisir un texte clair ou foncé selon la couleur de fond.
 *
 * Qui l'utilise : quasiment tous les fichiers de web/src (c'est la brique de base de chaque écran).
 */
// Chaque icône lucide est importée une par une : l'outil de build (Vite) n'embarque ainsi
// QUE les icônes utilisées, pas les 1500 de la bibliothèque. `Map as MapIcon` : renommage, car
// `Map` est déjà le nom d'un objet standard de JavaScript ; idem `Image as ImageIcon`.
// `type IconNode` : le type d'une icône lucide (description du dessin sous forme de tableau).
import {
  createElement, Bike, Calendar, CalendarDays, Camera, Car, Check, ChevronLeft, ChevronRight, Clock, Copy,
  Crosshair, Download, Footprints, House, ImagePlus, Layers, LocateFixed, LogOut, Map as MapIcon, MapPin,
  Navigation, Newspaper, Package, PaintRoller, Pencil, Plus, Presentation, QrCode, Repeat, Route, Share2,
  ShieldCheck, ShieldAlert, Siren, Smartphone, Trash2, TriangleAlert, UserPlus, Users, UsersRound, X, ArrowRight, Timer,
  CircleCheck, ListChecks, Construction, Megaphone, CircleAlert, Flag, Sun, Flame, Swords, Skull, Ambulance, Ban, Shield, IdCard, Fence, Bus, FileX, EyeOff, Zap, Settings, Bell, Vote, Archive, FileText, Mail, Image as ImageIcon, StickyNote, Globe, Lock, Paperclip, MessageCircle, Send, type IconNode,
} from 'lucide';

/** Képi de police, dessiné dans le style des icônes lucide. */
/*
 * Une icône lucide est un tableau : ['svg', {attributs de la balise svg}, [liste des tracés]].
 * On reprend les attributs de la sirène (`Siren[1]` : taille, épaisseur de trait…) pour que le képi
 * ait exactement le même style, et on fournit nos propres tracés `path` (le `d` décrit le dessin).
 * `as unknown as IconNode` : double conversion pour forcer TypeScript à accepter ce tableau fait main.
 */
const Police = ['svg', Siren[1], [
  ['path', { d: 'M4.2 12 3 6.6C5.8 5.2 8.9 4.5 12 4.5s6.2.7 9 2.1L19.8 12' }],
  ['path', { d: 'M4 12h16v3H4z' }],
  ['path', { d: 'M4 15c2 3 14 3 16 0' }],
  ['path', { d: 'm12 6.6.75 1.5 1.65.25-1.2 1.15.3 1.65-1.5-.8-1.5.8.3-1.65-1.2-1.15 1.65-.25z' }],
]] as unknown as IconNode;

/*
 * Table de correspondance « nom texte → icône ». Les noms (ex. 'paint-roller') sont ceux stockés
 * dans shared/model.ts (TYPES[...].icon, ALERT_ICONS) : le modèle partagé ne dépend ainsi pas de lucide.
 * Les noms avec un tiret doivent être entre guillemets (ce ne sont pas des identifiants JavaScript valides).
 */
const ICONS: Record<string, IconNode> = {
  bike: Bike, calendar: Calendar, 'calendar-days': CalendarDays, camera: Camera, car: Car, check: Check,
  'chevron-left': ChevronLeft, 'chevron-right': ChevronRight, clock: Clock, copy: Copy, crosshair: Crosshair,
  download: Download, footprints: Footprints, house: House, 'image-plus': ImagePlus, layers: Layers,
  'locate-fixed': LocateFixed, 'log-out': LogOut, map: MapIcon, 'map-pin': MapPin, navigation: Navigation,
  newspaper: Newspaper, package: Package, 'paint-roller': PaintRoller, pencil: Pencil, plus: Plus,
  presentation: Presentation, 'qr-code': QrCode, repeat: Repeat, route: Route, 'share-2': Share2,
  'shield-check': ShieldCheck, 'shield-alert': ShieldAlert, siren: Siren, smartphone: Smartphone, 'trash-2': Trash2,
  'triangle-alert': TriangleAlert, 'user-plus': UserPlus, users: Users, 'users-round': UsersRound, x: X,
  'arrow-right': ArrowRight, timer: Timer, 'circle-check': CircleCheck, 'list-checks': ListChecks,
  construction: Construction, megaphone: Megaphone, 'circle-alert': CircleAlert, flag: Flag, sun: Sun, flame: Flame, police: Police,
  swords: Swords, skull: Skull, ambulance: Ambulance, ban: Ban, shield: Shield, 'id-card': IdCard, fence: Fence,
  bus: Bus, 'file-x': FileX, 'eye-off': EyeOff, zap: Zap, settings: Settings, bell: Bell, vote: Vote,
  archive: Archive, 'file-text': FileText, mail: Mail, image: ImageIcon, 'sticky-note': StickyNote, globe: Globe, lock: Lock, paperclip: Paperclip, 'message-circle': MessageCircle, send: Send,
};

/**
 * Crée un élément <svg> pour l'icône `name`, de `size` pixels, avec un trait d'épaisseur `stroke`.
 * Nom inconnu → épingle (MapPin) plutôt qu'une erreur.
 */
export function icon(name: string, size = 20, stroke = 2.25): SVGElement {
  const el = createElement(ICONS[name] ?? MapPin);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('stroke-width', String(stroke));
  // Icône purement décorative : les lecteurs d'écran l'ignorent (le texte à côté suffit).
  el.setAttribute('aria-hidden', 'true');
  // Classe commune, pour le CSS.
  el.classList.add('ico');
  return el;
}

// Même icône, mais sous forme de texte HTML (`outerHTML`), pour les endroits qui attendent une chaîne
// (ex. les épingles Leaflet, dont le contenu se donne en HTML).
export const iconHtml = (name: string, size = 20, stroke = 2.25) => icon(name, size, stroke).outerHTML;

// ---------- Mini hyperscript (texte toujours échappé) ----------

/*
 * « Hyperscript » = construire du HTML avec des appels de fonction au lieu d'écrire du HTML en texte.
 * Exemple :
 *   h('button', { class: 'btn', onclick: () => alert('ok') }, icon('check'), 'Valider')
 * crée l'équivalent de :  <button class="btn"> [icône] Valider </button>  avec le clic déjà branché.
 *
 * Avantage majeur : le texte est TOUJOURS inséré comme texte (createTextNode), jamais interprété comme
 * du HTML. Un titre de point contenant « <script> » s'affiche tel quel au lieu de s'exécuter : on est
 * protégé contre l'injection de code (XSS) sans y penser.
 */
/*
 * Ce qu'on peut passer comme enfant : un élément déjà construit (Node), du texte, un nombre,
 * ou des valeurs « vides » (null, undefined, false) qui sont simplement ignorées — pratique pour écrire
 * `condition ? h(...) : null` ou `condition && h(...)`. `Child[]` : type récursif, un enfant peut être
 * un tableau d'enfants (par ex. le résultat d'un `.map(...)`), lui-même pouvant contenir des tableaux.
 */
type Child = Node | string | number | null | undefined | false | Child[];
// Les propriétés : un objet libre (nom → valeur quelconque), ou null quand on n'en a aucune.
type Props = Record<string, unknown> | null;

/**
 * Crée un élément HTML `tag`, lui applique `props`, puis y ajoute `children`.
 *
 * Le générique `<K extends keyof HTMLElementTagNameMap>` : `HTMLElementTagNameMap` est une table fournie
 * par TypeScript qui associe chaque nom de balise à son type d'élément ('input' → HTMLInputElement,
 * 'a' → HTMLAnchorElement…). `K` est donc le nom de balise passé, et la valeur de retour
 * `HTMLElementTagNameMap[K]` est le type exact correspondant : `h('input')` est connu comme un
 * HTMLInputElement, on peut lire `.value` sans conversion.
 *
 * `...children` (paramètre « rest ») : tous les arguments après le 2e sont rangés dans un tableau.
 *
 * Règles appliquées à chaque propriété (dans cet ordre) :
 * - valeur null, undefined ou false → ignorée (permet `{ disabled: estBloqué }`) ;
 * - nom commençant par « on » + fonction → écouteur d'événement (`onclick` → 'click') ;
 * - `class` → className ;
 * - `style` objet → propriétés CSS une par une (variables CSS `--x` comprises) ;
 * - `dataset` objet → attributs data-* ;
 * - value / checked / disabled / selected → propriétés DOM (pas attributs : voir plus bas) ;
 * - tout le reste → attribut HTML (true devient un attribut vide, ex. `required=""`).
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    // Object.entries transforme { a: 1, b: 2 } en [['a', 1], ['b', 2]] ; on déstructure en [k, v].
    for (const [k, v] of Object.entries(props)) {
      // `continue` : passer directement à la propriété suivante.
      if (v == null || v === false) continue;
      // `k.slice(2)` retire « on » : 'onclick' → 'click'. Attention : le nom doit être en minuscules
      // ('onClick' donnerait l'événement 'Click', qui n'existe pas).
      // `.toLowerCase()` : `onClick` (écriture façon React) marche aussi. Avant, il enregistrait un
      // événement « Click » (avec majuscule), qui n'existe pas : le clic ne faisait rien, sans erreur.
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      // `class` est un mot réservé en JS ; côté DOM la propriété s'appelle className.
      else if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
          if (sv == null) continue;
          // Les variables CSS (`--accent`) ne sont accessibles que par setProperty.
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          // Les autres (`borderTopColor`…) s'affectent directement ; la double conversion permet
          // d'indexer `el.style` avec un nom calculé, ce que TypeScript refuse sinon.
          else (el.style as unknown as Record<string, string>)[sk] = sv;
        }
      }
      // `{ dataset: { id: '42' } }` → attribut `data-id="42"`. Object.assign copie toutes les clés.
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      // Pour ces quatre-là, c'est la PROPRIÉTÉ qui compte (l'état actuel du champ), pas l'attribut
      // (qui n'est que la valeur initiale). `as any` : on sort du typage pour écrire n'importe quelle clé.
      // `value` est appliqué APRÈS l'ajout des enfants (voir plus bas) : pour un <select>, la valeur
      // n'existe qu'une fois ses <option> ajoutées ; appliquée avant, elle était perdue.
      else if (k === 'value') continue;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') (el as unknown as Record<string, unknown>)[k] = v;
      // Cas général : attribut HTML (aria-label, type, href, role, placeholder…).
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  if (props?.value != null) (el as unknown as { value: unknown }).value = props.value;
  return el;
}

/**
 * Appelle `fn` une seule fois, dès que `el` est retiré de la page (fiche fermée, écran redessiné).
 * Sert à se désabonner des événements du store au bon moment, sans attendre le prochain événement.
 * MutationObserver : le navigateur nous prévient à chaque changement du DOM ; on vérifie alors si
 * l'élément est toujours attaché (`isConnected`). L'observateur est arrêté aussitôt après.
 */
export function onDetach(el: Element, fn: () => void) {
  let seen = false;
  const obs = new MutationObserver(() => {
    if (el.isConnected) { seen = true; return; }
    // Pas encore inséré dans la page : on attend qu'il le soit avant de surveiller son départ.
    if (!seen) return;
    obs.disconnect();
    fn();
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

/** Ajoute une liste d'enfants à un élément (récursif : aplatit les tableaux imbriqués). */
function append(el: Node, children: Child[]) {
  for (const c of children) {
    // Valeurs vides : on n'ajoute rien. (0 n'est PAS ignoré : `c == null` ne vise que null/undefined.)
    if (c == null || c === false) continue;
    // Un tableau : on rappelle append dessus (récursivité).
    if (Array.isArray(c)) append(el, c);
    // Un élément est ajouté tel quel ; tout le reste est converti en nœud TEXTE (donc jamais interprété en HTML).
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Vide un élément puis le remplit avec de nouveaux enfants (sert à « redessiner » une zone). */
export function clear(el: Element, ...children: Child[]) {
  // replaceChildren() sans argument retire tous les enfants.
  el.replaceChildren();
  append(el, children);
}

// ---------- Toasts ----------

// Conteneur des notifications, créé à la première utilisation (puis réutilisé).
let toastWrap: HTMLElement | null = null;
// Genre de notification : change la couleur (classe CSS `toast-ok`, `toast-err`…) et l'icône par défaut.
export type ToastKind = 'ok' | 'err' | 'info' | 'warning' | 'police' | 'flash';

/** Notification en bas de l'écran. `ico` : icône de l'app à afficher (sinon celle du genre de message). */
// `ms` : durée d'affichage en millisecondes. `onClick` : si fourni, la notification devient un bouton.
export function toast(msg: string, kind: ToastKind = 'info', ms = 3200, ico?: string, onClick?: () => void) {
  if (!toastWrap) {
    // `role: 'status'` + `aria-live: 'polite'` : les lecteurs d'écran annoncent les nouvelles notifications.
    toastWrap = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }
  // Icône : celle demandée, sinon coche pour « ok », triangle pour « err », aucune pour le reste.
  const name = ico ?? (kind === 'ok' ? 'circle-check' : kind === 'err' ? 'triangle-alert' : null);
  // Balise <button> si cliquable (accessible au clavier), <div> sinon. `type: undefined` est ignoré par h().
  const t = h(onClick ? 'button' : 'div', { class: `toast toast-${kind}${onClick ? ' toast-link' : ''}`, type: onClick ? 'button' : undefined },
    name ? h('span', { class: 'toast-ico' }, icon(name, 18)) : null, h('span', null, msg),
    onClick ? h('span', { class: 'toast-go' }, icon('chevron-right', 18)) : null);
  // Notification cliquable : montre le point concerné, puis disparaît.
  if (onClick) t.addEventListener('click', () => { t.remove(); onClick(); });
  toastWrap.append(t);
  // Pas plus de 3 notifications à l'écran : la plus ancienne laisse sa place.
  while (toastWrap.children.length > 3) toastWrap.firstElementChild?.remove();
  // On attend la prochaine image affichée avant d'ajouter la classe `in` : ainsi le navigateur voit
  // d'abord l'état « caché » puis l'état « visible », et la transition CSS (glissement) se joue.
  requestAnimationFrame(() => t.classList.add('in'));
  // Au bout de `ms` : on lance l'animation de sortie, puis on retire l'élément 300 ms plus tard
  // (le temps que l'animation se termine).
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ---------- Dates ----------

/*
 * `Intl.DateTimeFormat` : l'outil standard du navigateur pour écrire une date dans une langue donnée.
 * On crée les formateurs UNE fois (c'est coûteux) et on les réutilise. Les options choisissent
 * les morceaux affichés : '2-digit' = toujours 2 chiffres (09), 'numeric' = sans zéro (9),
 * 'long' = en toutes lettres (lundi, janvier), 'short' = abrégé (lun., janv.).
 */
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('fr-FR', o);
// « 09:05 »
const fTime = fmt({ hour: '2-digit', minute: '2-digit' });
// « lundi 3 mars »
const fDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
// « lun. 3 mars »
const fDayShort = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
// « 3 mars 2025 »
const fDate = fmt({ day: 'numeric', month: 'long', year: 'numeric' });

// Raccourcis d'affichage d'un timestamp. `dayLong` met une majuscule (« Lundi 3 mars ») car il commence souvent une ligne.
export const time = (t: number) => fTime.format(t);
export const dayLong = (t: number) => cap(fDay.format(t));
export const dayShort = (t: number) => fDayShort.format(t);
export const dateLong = (t: number) => fDate.format(t);
// Met la première lettre en majuscule.
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Minuit (heure locale) du jour de `t`. */
export function startOfDay(t: number) {
  const d = new Date(t);
  // Heures, minutes, secondes, millisecondes à zéro.
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** `t` décalé de `n` jours (n négatif = en arrière), à la même heure locale (sûr au changement d'heure). */
export function addDays(t: number, n: number) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
/** Lundi 00:00 de la semaine de `t` (semaine à la française). */
export function startOfWeek(t: number) {
  const d = new Date(startOfDay(t));
  // getDay() : 0 = dimanche, 1 = lundi… 6 = samedi. `(x + 6) % 7` décale pour que lundi = 0, dimanche = 6.
  const dow = (d.getDay() + 6) % 7; // lundi = 0
  // On recule du nombre de jours écoulés depuis lundi.
  d.setDate(d.getDate() - dow);
  return d.getTime();
}
// Deux dates tombent-elles le même jour (calendaire, heure locale) ?
export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

/** Durée relative lisible : « dans 5 min », « il y a 2 h 05 », « dans 3 j ». */
export function relative(t: number, now = Date.now()) {
  // Positif = dans le futur, négatif = dans le passé.
  const diff = t - now;
  const abs = Math.abs(diff);
  // En minutes (60 000 ms = 1 min), arrondi.
  const m = Math.round(abs / 60000);
  // Ternaires en cascade : < 1 min → « quelques secondes » ; < 60 min → « 12 min » ;
  // < 1440 min (24 h) → « 2 h » ou « 2 h 05 » (minutes ajoutées seulement si non nulles, sur 2 chiffres) ;
  // sinon en jours arrondis.
  const label = m < 1 ? 'quelques secondes' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}` : `${Math.round(m / 1440)} j`;
  return diff >= 0 ? `dans ${label}` : `il y a ${label}`;
}

/** Toute la journée = de 00:00 à 23:59 le même jour. */
// C'est une convention de l'appli : un événement « toute la journée » est enregistré de 00:00 à 23:59.
export function isAllDay(start: number, end: number) {
  const s = new Date(start), e = new Date(end);
  return sameDay(start, end) && s.getHours() === 0 && s.getMinutes() === 0 && e.getHours() === 23 && e.getMinutes() === 59;
}

/** Texte d'une plage horaire, adapté au cas : journée entière, même jour, ou sur plusieurs jours. */
export function rangeLabel(start: number, end: number) {
  if (isAllDay(start, end)) return `${dayLong(start)} · toute la journée`;
  if (sameDay(start, end)) return `${dayLong(start)} · ${time(start)} – ${time(end)}`;
  return `${dayShort(start)} ${time(start)} → ${dayShort(end)} ${time(end)}`;
}

/** Valeurs pour <input type="date"> / <input type="time"> en heure locale. */
// Ces champs exigent un format fixe : « AAAA-MM-JJ » et « HH:MM ». On le construit à la main car
// `toISOString()` donnerait l'heure UTC (décalée d'1 ou 2 h en France). `getMonth()` compte de 0 à 11,
// d'où le `+ 1`. `padStart(2, '0')` ajoute un zéro devant si besoin (3 → « 03 »).
export const toDateInput = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const toTimeInput = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// Inverse : les deux champs → timestamp. Une chaîne « 2025-03-03T18:00 » SANS fuseau est lue en heure
// locale par JavaScript (c'est ce qu'on veut). Heure vide → minuit.
export const fromInputs = (date: string, timeStr: string) => new Date(`${date}T${timeStr || '00:00'}`).getTime();

// Écran large (≥ 900 px) ? Même seuil que dans le CSS, pour choisir la mise en page ordinateur.
export const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;

/** Texte lisible sur une couleur de fond. */
// Entrée : couleur « #RRGGBB ». Sortie : bleu nuit (fond clair) ou blanc (fond foncé).
export function inkFor(hex: string) {
  // Formats acceptés : #RGB (court) et #RRGGBB. Le format court est d'abord « déplié » (#abc → #aabbcc).
  // Toute autre valeur (nom de couleur, rgb()…) : encre blanche par défaut.
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#ffffff';
  // On enlève le « # » et on lit le reste comme un nombre en base 16 (hexadécimal).
  const n = parseInt(hex.slice(1), 16);
  // Extraction des 3 composantes (0 à 255) par décalage de bits : `>> 16` garde les 2 premiers chiffres
  // hexa (rouge), `>> 8` les 2 suivants, et `& 255` ne garde que les 8 derniers bits.
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // Luminosité perçue (l'œil est plus sensible au vert qu'au bleu, d'où ces coefficients standard),
  // ramenée entre 0 et 1. Au-dessus de 0,62 le fond est clair → texte foncé.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#00232C' : '#ffffff';
}
