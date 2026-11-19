import L from 'leaflet';
import { store, type Group } from './store';
import { TYPES, colorOf, type Point } from '../../shared/model';
import { isActive, occurrences, liveProblems } from '../../shared/time';
import { h, icon, iconHtml, inkFor, startOfDay, addDays, toast } from './ui';
import { getPosition, type Pos } from './geo';

let map: L.Map;
const markers = L.layerGroup();
const routeLayer = L.layerGroup();
let meMarker: L.CircleMarker | null = null;
let meHalo: L.Circle | null = null;
let onPick: (p: Point) => void = () => {};

export const groupOf = (p: Point): Group => (TYPES[p.type].alert ? 'alert' : p.mode === 'fixe' ? 'fixe' : 'event');

export function visiblePoints(now = Date.now()): Point[] {
  const dayStart = startOfDay(now);
  const dayEnd = addDays(dayStart, 1) - 1;
  return store.points.filter((p) => {
    if (!isActive(p, now)) return false;
    // Un point avec un problème en cours reste toujours visible, quels que soient les filtres.
    if (liveProblems(p, now).length) return true;
    const g = groupOf(p);
    if (!store.filters[g]) return false;
    if (store.todayOnly && g === 'event' && occurrences(p, dayStart, dayEnd).length === 0) return false;
    return true;
  });
}

export function getMap() {
  return map;
}

const VIEW_KEY = 'terrain:view';

export function initMap(container: HTMLElement, onMarker: (p: Point) => void) {
  onPick = onMarker;
  map = L.map(container, { zoomControl: false, attributionControl: true, worldCopyJump: true, tapTolerance: 20 } as L.MapOptions);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  markers.addTo(map);
  routeLayer.addTo(map);

  let saved: { lat: number; lng: number; z: number } | null = null;
  try { saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null'); } catch { /* stockage indisponible */ }
  if (saved) map.setView([saved.lat, saved.lng], saved.z);
  else map.setView([46.6, 2.4], 6);
  map.on('moveend', () => {
    const c = map.getCenter();
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() })); } catch { /* ignore */ }
  });

  store.on('points', renderMarkers);
  store.on('route', renderMarkers);
  store.on('filters', renderMarkers);
  store.on('view', () => {
    renderMarkers();
    setTimeout(() => map.invalidateSize(), 260);
  });
  // Les alertes expirent : on redessine chaque minute.
  setInterval(renderMarkers, 60_000);
  return map;
}

/** Cadre la carte sur les points existants (premier lancement). */
export function fitToPoints() {
  const pts = visiblePoints();
  if (!pts.length) return;
  try { if (localStorage.getItem(VIEW_KEY)) return; } catch { /* ignore */ }
  map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])).pad(0.2), { maxZoom: 16 });
}

function markerIcon(p: Point, extra: { cls?: string; badge?: string | null } = {}) {
  const meta = TYPES[p.type];
  const color = colorOf(p);
  const ink = p.color ? inkFor(color) : meta.ink;
  const cls = ['pin', meta.alert ? `pin-alert pin-${p.type}` : '', p.type === 'panneau' && p.status ? `pin-st-${p.status}` : '', extra.cls ?? ''].join(' ');
  const html = `<div class="${cls}" style="--c:${color};--ink:${ink}"><div class="pin-head">${iconHtml(meta.icon, 18, 2.4)}</div>${extra.badge ? `<span class="pin-badge">${extra.badge}</span>` : ''}${p.photo ? '<span class="pin-photo"></span>' : ''}</div>`;
  return L.divIcon({ html, className: 'pin-wrap', iconSize: [36, 46], iconAnchor: [18, 42], tooltipAnchor: [0, -38] });
}

export function renderMarkers() {
  if (!map) return;
  markers.clearLayers();
  const routeMode = store.view === 'route';
  const order = store.routeOrder;
  for (const p of visiblePoints()) {
    const routable = !!TYPES[p.type].routable;
    const problems = liveProblems(p);
    let cls = problems.length ? 'pin-problem' : '';
    let badge: string | null = problems.length ? '!' : null;
    if (routeMode) {
      if (!routable && !problems.length) cls = 'pin-dim';
      else if (store.routeSelection.has(p.id)) {
        cls += ' pin-selected';
        const i = order.indexOf(p.id);
        badge = i >= 0 ? String(i + 1) : '✓';
      }
    }
    const m = L.marker([p.lat, p.lng], {
      icon: markerIcon(p, { cls, badge }),
      riseOnHover: true,
      zIndexOffset: TYPES[p.type].alert || problems.length ? 1000 : cls.includes('pin-selected') ? 500 : 0,
      keyboard: true,
      title: p.title,
    });
    m.bindTooltip(h('span', null, problems.length ? `⚠ ${problems[0].message} · ${p.title}` : p.title), { direction: 'top', className: 'pin-tip' });
    m.on('click', () => onPick(p));
    markers.addLayer(m);
  }
}

export function flyTo(p: { lat: number; lng: number }, zoom = 17) {
  map.flyTo([p.lat, p.lng], Math.max(zoom, map.getZoom()), { duration: 0.6 });
}

export function showMe(pos: Pos) {
  const ll: L.LatLngExpression = [pos.lat, pos.lng];
  if (!meMarker) {
    meHalo = L.circle(ll, { radius: pos.accuracy ?? 30, className: 'me-halo', interactive: false }).addTo(map);
    meMarker = L.circleMarker(ll, { radius: 8, className: 'me-dot', interactive: false }).addTo(map);
  } else {
    meMarker.setLatLng(ll);
    meHalo!.setLatLng(ll).setRadius(pos.accuracy ?? 30);
  }
}

export async function locateMe(fly = true): Promise<Pos | null> {
  try {
    const pos = await getPosition();
    showMe(pos);
    if (fly) map.flyTo([pos.lat, pos.lng], Math.max(16, map.getZoom()), { duration: 0.6 });
    return pos;
  } catch (e) {
    toast((e as Error).message, 'err', 4500);
    return null;
  }
}

// ---------- Choix d'un emplacement (viseur au centre) ----------

let picking = false;

export function pickLocation(opts: { title: string; color?: string; initial?: Pos | null }): Promise<Pos | null> {
  if (picking) return Promise.resolve(null);
  picking = true;
  const wrap = map.getContainer().parentElement!;
  if (opts.initial) map.setView([opts.initial.lat, opts.initial.lng], Math.max(17, map.getZoom()));
  else if (map.getZoom() < 15) toast('Zoome sur la rue, puis vise l\'emplacement exact.', 'info', 4000);

  return new Promise((resolve) => {
    const finish = (v: Pos | null) => {
      picking = false;
      overlay.remove();
      bar.remove();
      wrap.classList.remove('picking');
      map.off('click', clickMove);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const clickMove = (e: L.LeafletMouseEvent) => map.panTo(e.latlng);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish(null);

    const overlay = h('div', { class: 'picker', style: { '--c': opts.color ?? '#7B13D6' } as Record<string, string> },
      h('div', { class: 'picker-pin' }, icon('map-pin', 30, 2.4)),
      h('div', { class: 'picker-shadow' }),
    );
    const bar = h('div', { class: 'picker-bar' },
      h('div', { class: 'picker-hint' }, h('strong', null, opts.title), h('span', null, 'Déplace la carte pour viser l\'emplacement')),
      h('div', { class: 'picker-actions' },
        h('button', { class: 'btn btn-ghost', onclick: () => finish(null) }, 'Annuler'),
        h('button', { class: 'btn btn-outline', onclick: async () => { const p = await locateMe(); if (p) map.setView([p.lat, p.lng], Math.max(18, map.getZoom())); } }, icon('locate-fixed', 18), 'Ma position'),
        h('button', { class: 'btn btn-primary', onclick: () => { const c = map.getCenter(); finish({ lat: c.lat, lng: c.lng }); } }, icon('check', 18), 'Placer ici'),
      ),
    );
    wrap.classList.add('picking');
    wrap.append(overlay, bar);
    map.on('click', clickMove);
    document.addEventListener('keydown', onKey);
  });
}

// ---------- Trajet ----------

export function drawRoute(path: Pos[], closeLoop: boolean) {
  routeLayer.clearLayers();
  if (path.length < 2) return;
  const latlngs = path.map((p) => [p.lat, p.lng] as [number, number]);
  if (closeLoop) latlngs.push(latlngs[0]);
  L.polyline(latlngs, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
  L.polyline(latlngs, { color: '#7B13D6', weight: 5, opacity: 0.95, dashArray: '10 8', interactive: false }).addTo(routeLayer);
  // Sur mobile, le panneau du trajet couvre le bas de la carte : on cadre au-dessus.
  const covered = window.matchMedia('(max-width: 899.98px)').matches ? map.getContainer().clientHeight * 0.58 : 0;
  map.fitBounds(L.latLngBounds(latlngs), { maxZoom: 17, paddingTopLeft: [30, 70], paddingBottomRight: [30, covered + 30] });
}

export const clearRoute = () => routeLayer.clearLayers();
