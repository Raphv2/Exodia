import { store, paintOf } from './store';
import { api, ApiError } from './api';
import { TYPES, STATUS_LABEL, type Point } from '../../shared/model';
import { isActive } from '../../shared/time';
import { h, icon, clear, toast } from './ui';
import { segmented } from './forms';
import { drawRoute, clearRoute, flyTo, locateMe } from './map';
import { distance, fmtDistance, lastPosition, type Pos } from './geo';
import { optimizeOrder, pathLength } from './optimize';

type Travel = 'walking' | 'bicycling' | 'driving';
const SPEED: Record<Travel, number> = { walking: 4.5, bicycling: 13, driving: 22 }; // km/h en ville
const DETOUR = 1.3; // les rues ne sont pas des lignes droites
const STOP_MIN = 4; // minutes de collage par arrêt

const opts = {
  onlyToDo: true,
  startFromMe: true,
  loop: false,
  travel: 'walking' as Travel,
  start: null as Pos | null,
};

let root: HTMLElement;

export function mountRoute(el: HTMLElement) {
  root = el;
  store.on('points', render);
  store.on('route', render);
  render();
}

function candidates(): Point[] {
  const ref = lastPosition();
  return store.points
    .filter((p) => TYPES[p.type].routable && isActive(p))
    .filter((p) => !opts.onlyToDo || p.type !== 'panneau' || p.status !== 'colle' || store.routeSelection.has(p.id))
    .sort((a, b) => (ref ? distance(ref, a) - distance(ref, b) : a.title.localeCompare(b.title, 'fr')));
}

const selected = () => store.points.filter((p) => store.routeSelection.has(p.id));

function invalidate() {
  store.routeOrder = [];
  clearRoute();
  store.emit('route');
}

export function toggleInRoute(p: Point) {
  if (store.routeSelection.has(p.id)) store.routeSelection.delete(p.id);
  else store.routeSelection.add(p.id);
  invalidate();
}

async function compute() {
  const pts = selected();
  if (pts.length < 2 && !(opts.startFromMe && pts.length === 1)) return toast('Sélectionne au moins 2 points.', 'err');
  let start: Pos | null = null;
  if (opts.startFromMe) {
    start = await locateMe(false);
    if (!start) toast('Départ depuis le premier point à la place.', 'info');
  }
  opts.start = start;
  const order = optimizeOrder(pts, start, opts.loop);
  store.routeOrder = order.map((i) => pts[i].id);
  const path = orderedPath();
  drawRoute(path, opts.loop);
  store.emit('route');
  root.querySelector('.route-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function orderedPoints(): Point[] {
  return store.routeOrder.map((id) => store.get(id)).filter((p): p is Point => !!p);
}

function orderedPath(): Pos[] {
  const pts = orderedPoints().map((p) => ({ lat: p.lat, lng: p.lng }));
  return opts.start ? [opts.start, ...pts] : pts;
}

// ---------- Exports ----------

const ll = (p: Pos) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Google Maps accepte 9 étapes intermédiaires par lien : on découpe le trajet en tronçons. */
function googleLegs(): { url: string; from: number; to: number }[] {
  const path = orderedPath();
  if (opts.loop && path.length > 2) path.push(path[0]);
  const offset = opts.start ? 0 : 1; // numéro d'arrêt du premier élément du chemin
  const legs: { url: string; from: number; to: number }[] = [];
  const MAX = 11; // origine + 9 étapes + destination
  for (let i = 0; i < path.length - 1; i += MAX - 1) {
    const chunk = path.slice(i, i + MAX);
    const q = new URLSearchParams({ api: '1', origin: ll(chunk[0]), destination: ll(chunk[chunk.length - 1]), travelmode: opts.travel });
    if (chunk.length > 2) q.set('waypoints', chunk.slice(1, -1).map(ll).join('|'));
    legs.push({ url: `https://www.google.com/maps/dir/?${q.toString()}`, from: Math.max(1, i + offset), to: i + chunk.length - 1 + offset });
  }
  return legs;
}

function gpx(): string {
  const pts = orderedPoints();
  const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
  const wpts = pts.map((p, i) => `  <wpt lat="${p.lat}" lon="${p.lng}"><name>${i + 1}. ${esc(p.title)}</name>${p.description ? `<desc>${esc(p.description)}</desc>` : ''}</wpt>`).join('\n');
  const rte = orderedPath().concat(opts.loop && opts.start ? [opts.start] : [])
    .map((p, i) => `    <rtept lat="${p.lat}" lon="${p.lng}"><name>${opts.start && i === 0 ? 'Départ' : esc(String(i + (opts.start ? 0 : 1)))}</name></rtept>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Terrain" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Trajet de collage</name><time>${new Date().toISOString()}</time></metadata>
${wpts}
  <rte><name>Trajet de collage</name>
${rte}
  </rte>
</gpx>
`;
}

function downloadGpx() {
  const blob = new Blob([gpx()], { type: 'application/gpx+xml' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `trajet-collage-${new Date().toISOString().slice(0, 10)}.gpx` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Fichier GPX téléchargé : ouvre-le avec Organic Maps, OsmAnd, Komoot…', 'ok', 5000);
}

async function share() {
  const pts = orderedPoints();
  const legs = googleLegs();
  const text = ['Trajet de collage :', ...pts.map((p, i) => `${i + 1}. ${p.title}`), '', ...legs.map((l, i) => `${legs.length > 1 ? `Partie ${i + 1} : ` : ''}${l.url}`)].join('\n');
  if (navigator.share) {
    try { await navigator.share({ title: 'Trajet de collage', text }); return; } catch { /* annulé */ }
  }
  await navigator.clipboard?.writeText(text);
  toast('Trajet copié : colle-le dans une conversation.', 'ok');
}

// ---------- Rendu ----------

export function render() {
  if (!root) return;
  const cands = candidates();
  const sel = selected();
  const ordered = orderedPoints();
  const ref = lastPosition();

  const list = h('ul', { class: 'pick-list' }, cands.map((p) => {
    const on = store.routeSelection.has(p.id);
    const { color: c, ink: cInk } = paintOf(p);
    return h('li', null, h('label', { class: `pick-row${on ? ' on' : ''}` },
      h('input', { type: 'checkbox', checked: on, onchange: () => toggleInRoute(p) }),
      h('span', { class: 'pick-dot', style: { background: c, color: cInk } }, icon(TYPES[p.type].icon, 16)),
      h('span', { class: 'pick-main' },
        h('span', { class: 'pick-title' }, p.title),
        h('span', { class: 'pick-sub' }, p.type === 'panneau' && p.status ? STATUS_LABEL[p.status] : TYPES[p.type].label, ref ? ` · ${fmtDistance(distance(ref, p))}` : ''),
      ),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Voir sur la carte', onclick: (e: Event) => { e.preventDefault(); flyTo(p); } }, icon('map-pin', 18)),
    ));
  }));

  let result: HTMLElement | null = null;
  if (ordered.length) {
    const path = orderedPath();
    const meters = pathLength(path, opts.loop) * DETOUR;
    const minutes = Math.round((meters / 1000 / SPEED[opts.travel]) * 60 + ordered.length * STOP_MIN);
    const legs = googleLegs();
    result = h('section', { class: 'route-result' },
      h('div', { class: 'route-stats' },
        stat(String(ordered.length), 'arrêts'),
        stat(`≈ ${fmtDistance(meters)}`, 'à parcourir'),
        stat(minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`, 'collage compris'),
      ),
      h('ol', { class: 'route-steps' },
        opts.start ? h('li', { class: 'step start' }, h('span', { class: 'step-num' }, icon('locate-fixed', 14)), h('span', { class: 'step-title' }, 'Départ : ma position')) : null,
        ordered.map((p, i) => h('li', { class: 'step' },
          h('span', { class: 'step-num' }, String(i + 1)),
          h('button', { class: 'step-title link-like', type: 'button', onclick: () => flyTo(p) }, p.title),
          p.type === 'panneau' ? h('button', {
            class: `btn btn-small ${p.status === 'colle' ? 'btn-done' : 'btn-light'}`, type: 'button',
            onclick: async () => {
              try {
                const { point } = await api.setStatus(p.id, p.status === 'colle' ? 'a_coller' : 'colle');
                store.upsert(point);
              } catch (e) { toast((e as ApiError).message, 'err'); }
            },
          }, icon('check', 14), p.status === 'colle' ? 'Collé' : 'Marquer collé') : null,
        )),
        opts.loop ? h('li', { class: 'step start' }, h('span', { class: 'step-num' }, icon('repeat', 14)), h('span', { class: 'step-title' }, 'Retour au départ')) : null,
      ),
      h('div', { class: 'export' },
        h('div', { class: 'section-title' }, icon('share-2', 18), 'Lancer la navigation'),
        legs.map((l, i) => h('a', { class: 'btn btn-primary btn-block', href: l.url, target: '_blank', rel: 'noopener' }, icon('navigation', 18),
          legs.length > 1 ? `Google Maps · partie ${i + 1} (arrêts ${l.from}–${l.to})` : 'Ouvrir dans Google Maps')),
        legs.length > 1 ? h('p', { class: 'field-hint' }, 'Google Maps limite le nombre d\'étapes : le trajet est découpé en parties à enchaîner.') : null,
        h('div', { class: 'grid-2' },
          h('button', { class: 'btn btn-outline', type: 'button', onclick: downloadGpx }, icon('download', 18), 'GPX'),
          h('button', { class: 'btn btn-outline', type: 'button', onclick: share }, icon('share-2', 18), 'Partager'),
        ),
        nextStop(ordered) ? h('a', { class: 'btn btn-light btn-block', href: `https://waze.com/ul?ll=${ll(nextStop(ordered)!)}&navigate=yes`, target: '_blank', rel: 'noopener' }, icon('navigation', 18), `Prochain arrêt dans Waze : ${nextStop(ordered)!.title}`) : null,
        h('p', { class: 'field-hint' }, 'GPX : compatible Organic Maps, OsmAnd, Komoot, Garmin… Waze ne gère qu\'une destination à la fois.'),
      ),
    );
  }

  clear(root,
    h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title' }, 'Trajet de collage')),
    h('p', { class: 'panel-intro' }, 'Coche les panneaux et points de collage (ou touche-les sur la carte), l\'app calcule l\'ordre le plus court.'),
    h('div', { class: 'route-toolbar' },
      h('label', { class: 'toggle-line compact' },
        h('input', { type: 'checkbox', checked: opts.onlyToDo, onchange: (e: Event) => { opts.onlyToDo = (e.target as HTMLInputElement).checked; render(); } }),
        h('span', { class: 'switch' }), 'Masquer les panneaux déjà collés'),
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { cands.forEach((p) => store.routeSelection.add(p.id)); invalidate(); } }, 'Tout'),
        h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { store.routeSelection.clear(); invalidate(); } }, 'Aucun'),
      ),
    ),
    cands.length ? list : h('div', { class: 'empty small' }, icon('presentation', 32, 1.6), h('strong', null, 'Aucun panneau à coller'), h('span', null, 'Ajoute des panneaux électoraux ou des points de collage sur la carte.')),
    h('div', { class: 'card-section' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Départ'),
        segmented<'me' | 'first'>([{ value: 'me', label: 'Ma position', icon: 'locate-fixed' }, { value: 'first', label: 'Au plus loin', icon: 'map-pin' }],
          opts.startFromMe ? 'me' : 'first', (v) => { opts.startFromMe = v === 'me'; invalidate(); })),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Je me déplace'),
        segmented<Travel>([{ value: 'walking', label: 'À pied', icon: 'footprints' }, { value: 'bicycling', label: 'Vélo', icon: 'bike' }, { value: 'driving', label: 'Voiture', icon: 'car' }],
          opts.travel, (v) => { opts.travel = v; if (store.routeOrder.length) render(); })),
      h('label', { class: 'toggle-line compact' },
        h('input', { type: 'checkbox', checked: opts.loop, onchange: (e: Event) => { opts.loop = (e.target as HTMLInputElement).checked; invalidate(); } }),
        h('span', { class: 'switch' }), 'Revenir au point de départ'),
    ),
    h('button', { class: 'btn btn-primary btn-block btn-big sticky-cta', type: 'button', disabled: sel.length === 0, onclick: compute },
      icon('route', 20), sel.length ? `Optimiser le trajet (${sel.length} point${sel.length > 1 ? 's' : ''})` : 'Sélectionne des points'),
    result,
  );
}

function nextStop(ordered: Point[]) {
  return ordered.find((p) => p.type !== 'panneau' || p.status !== 'colle') ?? null;
}

const stat = (v: string, l: string) => h('div', { class: 'stat' }, h('strong', null, v), h('span', null, l));
