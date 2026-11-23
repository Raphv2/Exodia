/*
 * web/src/basemap.ts — le fond de carte (rues, bâtiments, eau, noms de lieux) sous les épingles.
 *
 * Qui l'appelle : map.ts (la carte principale, avec l'espace courant), home.ts et archive.ts
 * (les cartes publiques des AG annoncées, toujours aux couleurs du Mouvement).
 *
 * Notions :
 * - Leaflet : la bibliothèque de carte de l'appli (zoom, déplacement, épingles). Elle affiche
 *   normalement des « tuiles raster » : des images PNG de 256 px déjà dessinées par un serveur.
 * - Tuiles « vectorielles » : au lieu d'images, le serveur envoie les formes brutes (tracés des rues,
 *   contours des bâtiments…) et c'est le navigateur qui les dessine. Avantage : on peut choisir
 *   NOUS-MÊMES les couleurs. Le dessin se fait avec la carte graphique (WebGL) via MapLibre.
 * - « Style » MapLibre : un gros fichier JSON qui liste des « couches » (layers) ; chaque couche dit
 *   quoi dessiner (eau, routes…), avec quelle forme (`type` : fill = surface, line = trait,
 *   symbol = texte/icône, background = fond) et avec quelles couleurs (`paint`) / quelle mise en
 *   page (`layout`). On télécharge le style Positron et on le modifie avant de le donner à MapLibre.
 * - Le greffon maplibre-gl-leaflet fait tourner MapLibre comme une simple couche à l'intérieur de Leaflet.
 */
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

// Adresse du style Positron (JSON) chez OpenFreeMap.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
// Mentions légales obligatoires (crédits des données), affichées en bas à droite de la carte.
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · '
  + '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · '
  + '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>';

// Un thème = un dictionnaire « nom de couche (ou clé spéciale) → couleur ».
type Theme = Record<string, string>;

/** Palette par espace : clé = identifiant de couche du style Positron. */
/*
 * Les clés doivent correspondre EXACTEMENT aux `id` des couches du style Positron (water, park,
 * highway_minor…), sinon la couleur n'est simplement pas appliquée. Clés spéciales inventées ici :
 * - `background` : couleur du fond, et aussi des traits pointillés masqués (voir `_dashline`) ;
 * - `text:…` : couleur des textes (noms de rues, de lieux, des cours d'eau) ;
 * - `halo` : le liseré autour des textes, couleur du fond pour qu'ils restent lisibles sur les routes.
 */
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
// Expression régulière : `^` = « commence par », `(a|b|c)` = « a ou b ou c ». Toute couche dont l'id
// commence par un de ces mots (panneaux de numéros de route, aéroports) sera supprimée.
const DROP = /^(highway-shield|road_shield|airport|aeroway)/;

/*
 * Le style n'est téléchargé qu'UNE fois par session : on garde la promesse en mémoire (cache).
 * `??=` : « affecte seulement si la variable vaut null/undefined » ; au 2e appel, on renvoie la même
 * promesse (déjà résolue) sans refaire de requête. `r.ok` faux → on lève une erreur (404, 500…).
 */
let styleCache: Promise<Record<string, unknown>> | null = null;
const loadStyle = () => (styleCache ??= fetch(STYLE_URL).then((r) => {
  if (!r.ok) throw new Error(`style ${r.status}`);
  return r.json();
}));

/** Style Positron recoloré pour l'espace, sans icônes ni relief. */
// Entrée : le style d'origine (JSON) et l'espace. Sortie : une COPIE modifiée (l'original en cache reste intact).
function themedStyle(base: Record<string, unknown>, space: Space) {
  const t = THEMES[space];
  // structuredClone : copie profonde (tous les sous-objets sont copiés, pas seulement référencés).
  // Le `as {…}` décrit à TypeScript les seuls champs qu'on va toucher ; `any` pour les couches,
  // dont la forme varie trop selon leur type pour être décrite simplement.
  const style = structuredClone(base) as { sources: Record<string, unknown>; layers: Record<string, any>[]; sprite?: unknown };
  // `sprite` = la planche d'images des icônes (routes, lieux…). Sans elle, aucune icône n'est chargée.
  delete style.sprite;
  // `ne2_shaded` = la source du relief ombré (image raster) : on la supprime…
  delete style.sources.ne2_shaded;
  // … ainsi que toutes les couches qui l'utilisent, celles de la liste DROP, et toute couche raster.
  style.layers = style.layers.filter((l) => l.source !== 'ne2_shaded' && !DROP.test(l.id) && l.type !== 'raster');
  for (const l of style.layers) {
    // Toute couche reçoit un objet `paint` (vide s'il n'existait pas) pour pouvoir y écrire.
    l.paint ??= {};
    // Retire toute référence à une icône (puisque la planche `sprite` a été supprimée).
    if (l.layout) { delete l.layout['icon-image']; delete l.layout['icon-size']; delete l.layout['icon-offset']; }
    // Recoloration selon le type de couche : `background-color`, `fill-color`, `line-color` sont les
    // noms des propriétés de couleur dans la spécification des styles MapLibre.
    if (l.type === 'background' && t.background) l.paint['background-color'] = t.background;
    if (l.type === 'fill' && t[l.id]) l.paint['fill-color'] = t[l.id];
    if (l.type === 'line' && t[l.id]) l.paint['line-color'] = t[l.id];
    // Les couches « …_dashline » (pointillés dessinés par-dessus certaines lignes) prennent la couleur
    // du fond : elles deviennent invisibles, la carte est plus calme.
    if (l.id.endsWith('_dashline')) l.paint['line-color'] = t.background;
    if (l.type === 'symbol') {
      // Choix de la clé de couleur du texte :
      // - nom de rue : 'text:' + id de la couche (ex. 'text:highway-name-minor') ;
      // - lieux (villes, quartiers…) : la couche lit la « source-layer » 'place' → 'text:place' ;
      // - cours d'eau / plans d'eau : source-layer commençant par 'water' → 'text:water' ;
      // - sinon '' (aucune couleur spécifique, on garde celle du style d'origine).
      // `l['source-layer']` : crochets obligatoires à cause du tiret dans le nom.
      const key = l.id.startsWith('highway-name') ? `text:${l.id}` : l['source-layer'] === 'place' ? 'text:place' : l['source-layer']?.startsWith('water') ? 'text:water' : '';
      if (key && t[key]) l.paint['text-color'] = t[key];
      // Halo de TOUS les textes = couleur du fond.
      l.paint['text-halo-color'] = t.halo;
      // Moins de bruit : pas de noms de pays/régions en ville, pas de petits lieux-dits.
      // `minzoom` : niveau de zoom en dessous duquel la couche n'est pas dessinée (13 ≈ vue d'un quartier).
      if (l.id === 'label_other') l.minzoom = Math.max(l.minzoom ?? 0, 13);
    }
  }
  return style;
}

/** L'appareil sait-il faire du WebGL (dessin par la carte graphique, nécessaire à MapLibre) ? */
function hasWebGL() {
  try {
    // On crée un canvas jetable et on lui demande un contexte WebGL 2, sinon WebGL 1.
    const c = document.createElement('canvas');
    // `!!` convertit le résultat (contexte ou null) en booléen.
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Repli : tuiles images classiques d'OpenStreetMap (couleurs non personnalisables). */
function rasterFallback(map: L.Map) {
  // La classe `has-vector` sert au CSS (réglages propres au fond vectoriel) : on l'enlève.
  map.getContainer().classList.remove('has-vector');
  // {z} = niveau de zoom, {x}/{y} = numéro de colonne/ligne de la tuile : Leaflet remplit l'adresse
  // pour chaque image à charger.
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
}

/** Ajoute le fond de carte de l'espace (vectoriel épuré, ou OpenStreetMap si impossible). */
export async function addBasemap(map: L.Map, space: Space): Promise<void> {
  // Pas de WebGL : inutile de télécharger MapLibre, on passe directement au repli.
  if (!hasWebGL()) { rasterFallback(map); return; }
  map.getContainer().classList.add('has-vector');
  try {
    /*
     * Chargement EN PARALLÈLE (Promise.all) de 5 choses, et on attend qu'elles soient toutes là :
     * 1. la bibliothèque MapLibre ;  2. sa feuille de style CSS ;  3. le greffon Leaflet↔MapLibre
     * (il s'ajoute tout seul à `L`, d'où rien à récupérer) ;  4. l'adresse du fichier « worker »
     * de MapLibre (`?url` : Vite fournit l'URL du fichier au lieu de son contenu) ;  5. le style JSON.
     * `import('…')` (avec parenthèses) = import DYNAMIQUE : le code n'est téléchargé qu'à ce moment-là,
     * pas au chargement de l'appli (MapLibre pèse ~300 Ko).
     * La déstructuration `[a, , , b, c]` : les virgules vides sautent les résultats 2 et 3, inutiles ici.
     * `.then((m) => ({ default: m }))` emballe le module MapLibre pour que `{ default: maplibregl }`
     * fonctionne quelle que soit la façon dont il est exporté.
     */
    const [{ default: maplibregl }, , , { default: workerUrl }, base] = await Promise.all([
      import('maplibre-gl').then((m) => ({ default: m })),
      import('maplibre-gl/dist/maplibre-gl.css'),
      import('@maplibre/maplibre-gl-leaflet'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
      loadStyle(),
    ]);
    // Le « worker » est un script qui découpe les tuiles en arrière-plan (sans figer la page) ;
    // MapLibre doit savoir où le trouver une fois l'appli compilée par Vite.
    maplibregl.setWorkerUrl(workerUrl);
    // Crée la couche MapLibre pour Leaflet, avec notre style recoloré et nos crédits.
    // `as never` / `as L.LeafletMaplibreGLOptions` : conversions pour faire taire des définitions
    // de types trop strictes ou incomplètes du greffon (aucun effet à l'exécution).
    const layer = L.maplibreGL({ style: themedStyle(base, space) as never, attributionControl: { customAttribution: ATTRIBUTION } } as L.LeafletMaplibreGLOptions);
    layer.addTo(map);
    // Si le fond n'arrive pas à se charger (tuiles bloquées…), on repasse sur OpenStreetMap.
    // `ok` passe à true dès que la carte s'est chargée une fois : les erreurs suivantes sont alors ignorées.
    let ok = false;
    // `once` : écouteur exécuté une seule fois. getMaplibreMap() donne accès à la carte MapLibre interne.
    layer.getMaplibreMap().once('load', () => { ok = true; });
    layer.getMaplibreMap().on('error', () => {
      if (ok) return;
      // On met `ok` à true pour ne faire le repli qu'une fois, même si plusieurs erreurs arrivent.
      ok = true;
      map.removeLayer(layer);
      rasterFallback(map);
    });
  } catch (e) {
    // Échec du chargement de MapLibre ou du style (réseau, bloqueur…) : repli + message en console.
    console.warn('Fond vectoriel indisponible, repli sur OpenStreetMap', e);
    rasterFallback(map);
  }
}
