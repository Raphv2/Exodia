import L from 'leaflet';
import type { Space } from '../../shared/model';

/*
 * Fond de carte épuré et aux couleurs de l'espace.
 *
 * - Fond vectoriel OpenFreeMap (style « Positron », gratuit, sans clé ni compte), rendu par MapLibre
 *   À L'INTÉRIEUR de Leaflet : les épingles, trajets et sélections restent gérés comme avant.
 * - On recolore chaque élément (eau, parcs, bâtiments, rues, noms) selon l'espace, et on retire
 *   ce qui charge la carte (icônes de routes, aéroports, relief ombré).
 * - MapLibre (~300 Ko) n'est chargé qu'à l'ouverture de la carte ; s'il ne peut pas tourner
 *   (pas de WebGL, réseau bloqué…), on repasse automatiquement sur le fond OpenStreetMap habituel.
 */

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · '
  + '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · '
  + '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>';

type Theme = Record<string, string>;

/** Palette par espace : clé = identifiant de couche du style Positron. */
const THEMES: Record<Space, Theme> = {
  // LFI : base très claire teintée de lilas, eau violette douce, noms en violet profond.
  lfi: {
    background: '#f6f3fa', landuse_residential: '#f1ecf7', park: '#e7efe2', landcover_wood: '#e0e9da',
    water: '#d3c8f0', waterway: '#c2b4ea', building: '#ebe5f3',
    highway_minor: '#ffffff', highway_major_inner: '#ffffff', highway_major_casing: '#dcd2ec', highway_major_subtle: '#e6dff1',
    highway_motorway_casing: '#d3c6ea', highway_motorway_subtle: '#e0d6ef', highway_path: '#e8e1f2',
    tunnel_motorway_casing: '#dcd2ec', tunnel_motorway_inner: '#f3eff9',
    railway: '#dcd3ea', railway_transit: '#dcd3ea', railway_service: '#dcd3ea',
    boundary_2: '#b8a9d6', boundary_3: '#c9bde3', boundary_disputed: '#b8a9d6',
    'text:highway-name-minor': '#6e6587', 'text:highway-name-major': '#5c5378', 'text:highway-name-path': '#8a82a0',
    'text:place': '#3a0870', 'text:water': '#5c0ea3', halo: '#f6f3fa',
  },
  // Mouvement : papier gris-beige, eau gris-bleu, noms en noir ; le rouge reste réservé aux épingles.
  mvt: {
    background: '#f1efeb', landuse_residential: '#ebe8e3', park: '#e1e4da', landcover_wood: '#d9ddd1',
    water: '#c8ccd0', waterway: '#b7bcc1', building: '#e3dfd9',
    highway_minor: '#ffffff', highway_major_inner: '#ffffff', highway_major_casing: '#d3cec7', highway_major_subtle: '#dedad4',
    highway_motorway_casing: '#c9c3bb', highway_motorway_subtle: '#d8d3cc', highway_path: '#e2ded7',
    tunnel_motorway_casing: '#d3cec7', tunnel_motorway_inner: '#f1efeb',
    railway: '#d2cdc6', railway_transit: '#d2cdc6', railway_service: '#d2cdc6',
    boundary_2: '#a39d94', boundary_3: '#b5afa6', boundary_disputed: '#a39d94',
    'text:highway-name-minor': '#5f5b55', 'text:highway-name-major': '#4a4640', 'text:highway-name-path': '#7d7871',
    'text:place': '#141414', 'text:water': '#4a5058', halo: '#f1efeb',
  },
};

// Couches qui encombrent la carte sans servir sur le terrain.
const DROP = /^(highway-shield|road_shield|airport|aeroway)/;

let styleCache: Promise<Record<string, unknown>> | null = null;
const loadStyle = () => (styleCache ??= fetch(STYLE_URL).then((r) => {
  if (!r.ok) throw new Error(`style ${r.status}`);
  return r.json();
}));

/** Style Positron recoloré pour l'espace, sans icônes ni relief. */
function themedStyle(base: Record<string, unknown>, space: Space) {
  const t = THEMES[space];
  const style = structuredClone(base) as { sources: Record<string, unknown>; layers: Record<string, any>[]; sprite?: unknown };
  delete style.sprite;
  delete style.sources.ne2_shaded;
  style.layers = style.layers.filter((l) => l.source !== 'ne2_shaded' && !DROP.test(l.id) && l.type !== 'raster');
  for (const l of style.layers) {
    l.paint ??= {};
    if (l.layout) { delete l.layout['icon-image']; delete l.layout['icon-size']; delete l.layout['icon-offset']; }
    if (l.type === 'background' && t.background) l.paint['background-color'] = t.background;
    if (l.type === 'fill' && t[l.id]) l.paint['fill-color'] = t[l.id];
    if (l.type === 'line' && t[l.id]) l.paint['line-color'] = t[l.id];
    if (l.id.endsWith('_dashline')) l.paint['line-color'] = t.background;
    if (l.type === 'symbol') {
      const key = l.id.startsWith('highway-name') ? `text:${l.id}` : l['source-layer'] === 'place' ? 'text:place' : l['source-layer']?.startsWith('water') ? 'text:water' : '';
      if (key && t[key]) l.paint['text-color'] = t[key];
      l.paint['text-halo-color'] = t.halo;
      // Moins de bruit : pas de noms de pays/régions en ville, pas de petits lieux-dits.
      if (l.id === 'label_other') l.minzoom = Math.max(l.minzoom ?? 0, 13);
    }
  }
  return style;
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function rasterFallback(map: L.Map) {
  map.getContainer().classList.remove('has-vector');
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
}

/** Ajoute le fond de carte de l'espace (vectoriel épuré, ou OpenStreetMap si impossible). */
export async function addBasemap(map: L.Map, space: Space): Promise<void> {
  if (!hasWebGL()) { rasterFallback(map); return; }
  map.getContainer().classList.add('has-vector');
  try {
    const [{ default: maplibregl }, , , { default: workerUrl }, base] = await Promise.all([
      import('maplibre-gl').then((m) => ({ default: m })),
      import('maplibre-gl/dist/maplibre-gl.css'),
      import('@maplibre/maplibre-gl-leaflet'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
      loadStyle(),
    ]);
    maplibregl.setWorkerUrl(workerUrl);
    const layer = L.maplibreGL({ style: themedStyle(base, space) as never, attributionControl: { customAttribution: ATTRIBUTION } } as L.LeafletMaplibreGLOptions);
    layer.addTo(map);
    // Si le fond n'arrive pas à se charger (tuiles bloquées…), on repasse sur OpenStreetMap.
    let ok = false;
    layer.getMaplibreMap().once('load', () => { ok = true; });
    layer.getMaplibreMap().on('error', () => {
      if (ok) return;
      ok = true;
      map.removeLayer(layer);
      rasterFallback(map);
    });
  } catch (e) {
    console.warn('Fond vectoriel indisponible, repli sur OpenStreetMap', e);
    rasterFallback(map);
  }
}
