import {
  createElement, Bike, Calendar, CalendarDays, Camera, Car, Check, ChevronLeft, ChevronRight, Clock, Copy,
  Crosshair, Download, Footprints, House, ImagePlus, Layers, LocateFixed, LogOut, Map as MapIcon, MapPin,
  Navigation, Newspaper, Package, PaintRoller, Pencil, Plus, Presentation, QrCode, Repeat, Route, Share2,
  ShieldCheck, Siren, Smartphone, Trash2, TriangleAlert, UserPlus, Users, UsersRound, X, ArrowRight, Timer,
  CircleCheck, ListChecks, Construction, Megaphone, CircleAlert, Flag, Sun, type IconNode,
} from 'lucide';

const ICONS: Record<string, IconNode> = {
  bike: Bike, calendar: Calendar, 'calendar-days': CalendarDays, camera: Camera, car: Car, check: Check,
  'chevron-left': ChevronLeft, 'chevron-right': ChevronRight, clock: Clock, copy: Copy, crosshair: Crosshair,
  download: Download, footprints: Footprints, house: House, 'image-plus': ImagePlus, layers: Layers,
  'locate-fixed': LocateFixed, 'log-out': LogOut, map: MapIcon, 'map-pin': MapPin, navigation: Navigation,
  newspaper: Newspaper, package: Package, 'paint-roller': PaintRoller, pencil: Pencil, plus: Plus,
  presentation: Presentation, 'qr-code': QrCode, repeat: Repeat, route: Route, 'share-2': Share2,
  'shield-check': ShieldCheck, siren: Siren, smartphone: Smartphone, 'trash-2': Trash2,
  'triangle-alert': TriangleAlert, 'user-plus': UserPlus, users: Users, 'users-round': UsersRound, x: X,
  'arrow-right': ArrowRight, timer: Timer, 'circle-check': CircleCheck, 'list-checks': ListChecks,
  construction: Construction, megaphone: Megaphone, 'circle-alert': CircleAlert, flag: Flag, sun: Sun,
};

export function icon(name: string, size = 20, stroke = 2.25): SVGElement {
  const el = createElement(ICONS[name] ?? MapPin);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('stroke-width', String(stroke));
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('ico');
  return el;
}

export const iconHtml = (name: string, size = 20, stroke = 2.25) => icon(name, size, stroke).outerHTML;

// ---------- Mini hyperscript (texte toujours échappé) ----------

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else (el.style as unknown as Record<string, string>)[sk] = sv;
        }
      }
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

// ---------- Toasts ----------

let toastWrap: HTMLElement | null = null;
export function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info', ms = 3200) {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }
  const t = h('div', { class: `toast toast-${kind}` }, kind === 'ok' ? icon('circle-check', 18) : kind === 'err' ? icon('triangle-alert', 18) : null, h('span', null, msg));
  toastWrap.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ---------- Dates ----------

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('fr-FR', o);
const fTime = fmt({ hour: '2-digit', minute: '2-digit' });
const fDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const fDayShort = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const fDate = fmt({ day: 'numeric', month: 'long', year: 'numeric' });

export const time = (t: number) => fTime.format(t);
export const dayLong = (t: number) => cap(fDay.format(t));
export const dayShort = (t: number) => fDayShort.format(t);
export const dateLong = (t: number) => fDate.format(t);
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function addDays(t: number, n: number) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
export function startOfWeek(t: number) {
  const d = new Date(startOfDay(t));
  const dow = (d.getDay() + 6) % 7; // lundi = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}
export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

export function relative(t: number, now = Date.now()) {
  const diff = t - now;
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const label = m < 1 ? 'quelques secondes' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}` : `${Math.round(m / 1440)} j`;
  return diff >= 0 ? `dans ${label}` : `il y a ${label}`;
}

/** Toute la journée = de 00:00 à 23:59 le même jour. */
export function isAllDay(start: number, end: number) {
  const s = new Date(start), e = new Date(end);
  return sameDay(start, end) && s.getHours() === 0 && s.getMinutes() === 0 && e.getHours() === 23 && e.getMinutes() === 59;
}

export function rangeLabel(start: number, end: number) {
  if (isAllDay(start, end)) return `${dayLong(start)} · toute la journée`;
  if (sameDay(start, end)) return `${dayLong(start)} · ${time(start)} – ${time(end)}`;
  return `${dayShort(start)} ${time(start)} → ${dayShort(end)} ${time(end)}`;
}

/** Valeurs pour <input type="date"> / <input type="time"> en heure locale. */
export const toDateInput = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const toTimeInput = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const fromInputs = (date: string, timeStr: string) => new Date(`${date}T${timeStr || '00:00'}`).getTime();

export const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;

/** Texte lisible sur une couleur de fond. */
export function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#00232C' : '#ffffff';
}
