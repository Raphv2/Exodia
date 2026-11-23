/**
 * map.ts : tout ce qui touche à la carte Leaflet de l'app (espace membres).
 *
 * Qui l'appelle ? main.ts (initMap, renderMarkers, locateMe, flyTo, fitToPoints, getMap),
 * forms.ts (pickLocation pour viser un emplacement, showMe), route.ts (drawRoute, clearRoute,
 * locateMe), chat.ts (markSpot). flyTo est utilisé un peu partout pour centrer la carte.
 * visiblePoints et groupOf sont exportés mais, aujourd'hui, servent surtout ici même.
 *
 * Ce qu'il fait :
 * - crée la carte, mémorise la dernière vue (centre + zoom) dans localStorage ;
 * - dessine une épingle par point visible, en tenant compte des filtres ;
 * - forme de l'épingle : goutte (point fixe), carré à pointe (événement), éclair (flash),
 *   variantes pour les alertes, badge de participation (je viens / je fournis), badge de vote ;
 * - affiche « ma position », le viseur pour placer un point, le tracé du trajet de collage.
 *
 * Notions Leaflet :
 * - L.map(élément) crée la carte ; coordonnées = [latitude, longitude] ; zoom 0 (monde) à ~19 (rue).
 * - Un « layer » (calque) est tout ce qu'on pose sur la carte ; L.layerGroup() regroupe des calques
 *   pour pouvoir tous les effacer d'un coup (clearLayers).
 * - L.marker = épingle ; L.divIcon = icône faite de HTML (ici une chaîne) au lieu d'une image.
 * - map.on('événement', fn) / map.off(...) : écouter / arrêter d'écouter un événement de carte.
 */
// L'objet L contient toute l'API Leaflet.
import L from 'leaflet';
// store = état global ; paintOf = couleurs (fond + encre) d'un point ; spaceColor = couleur de l'espace.
import { store, paintOf, spaceColor, type Group } from './store';
// TYPES = description de chaque type de point (alerte ? routable ? couleur…) ; iconOf = nom d'icône d'un point.
import { TYPES, iconOf, type Point } from '../../shared/model';
// Calculs de temps partagés : point actif ?, occurrences (répétitions) dans un intervalle, problèmes en cours.
import { isActive, occurrences, liveProblems } from '../../shared/time';
// h et icon construisent les épingles en éléments DOM (pas de HTML en texte).
import { h, icon, startOfDay, addDays, toast } from './ui';
import { getPosition, type Pos } from './geo';
// Ajoute le fond de carte (tuiles) adapté à l'espace.
import { addBasemap } from './basemap';

// Variables du module (privées à ce fichier, partagées entre ses fonctions).
// `let map: L.Map;` : déclarée sans valeur, remplie par initMap.
let map: L.Map;
// Calque de toutes les épingles de points, vidé et redessiné à chaque renderMarkers.
const markers = L.layerGroup();
// Calque du tracé de trajet.
const routeLayer = L.layerGroup();
// Point bleu « ma position » et cercle de précision autour ; null tant qu'on ne s'est pas localisé.
let meMarker: L.CircleMarker | null = null;
let meHalo: L.Circle | null = null;
// Fonction appelée au clic sur une épingle (fournie par main.ts) ; par défaut, ne fait rien.
let onPick: (p: Point) => void = () => {};

/**
 * Groupe de filtre d'un point. Entrée : un point. Sortie : 'alert' | 'fixe' | 'flash' | 'event'.
 * Ordre de priorité : alerte d'abord, puis point fixe, puis flash, sinon événement.
 * Sert aux pastilles de filtre de la carte (main.ts).
 */
export const groupOf = (p: Point): Group =>
  TYPES[p.type].alert ? 'alert' : p.mode === 'fixe' ? 'fixe' : p.flash ? 'flash' : 'event';

/**
 * Points à afficher sur la carte maintenant. Entrée : l'instant (par défaut maintenant, en ms).
 * Sortie : un sous-ensemble de store.points, après application de tous les filtres.
 */
export function visiblePoints(now = Date.now()): Point[] {
  // Bornes de la journée : de 00:00:00.000 à 23:59:59.999 (le jour suivant à minuit, moins 1 ms).
  const dayStart = startOfDay(now);
  const dayEnd = addDays(dayStart, 1) - 1;
  return store.points.filter((p) => {
    // Point terminé, expiré ou pas encore commencé : jamais affiché.
    if (!isActive(p, now)) return false;
    // Vue « Blocus » : on ne garde que les blocus et leurs blocages, rien d'autre.
    if (store.blocusOnly) return p.type === 'blocus' || p.type === 'blocage';
    // Un point avec un problème en cours reste toujours visible, quels que soient les filtres.
    if (liveProblems(p, now).length) return true;
    const g = groupOf(p);
    // Pastille de filtre éteinte pour ce groupe : on cache.
    if (!store.filters[g]) return false;
    // « Aujourd'hui seulement » : un événement ou flash est caché s'il n'a aucune occurrence aujourd'hui.
    // (Les points fixes et alertes ne sont pas concernés.)
    if (store.todayOnly && (g === 'event' || g === 'flash') && occurrences(p, dayStart, dayEnd).length === 0) return false;
    return true;
  });
}

// Accès à la carte depuis d'autres modules (ex. main.ts pour invalidateSize).
export function getMap() {
  return map;
}

// Clé localStorage pour retrouver la carte là où on l'a laissée.
const VIEW_KEY = 'terrain:view';

/**
 * Crée la carte dans `container` et branche les mises à jour automatiques.
 * Entrées : le <div> conteneur, et la fonction à appeler au clic sur une épingle.
 * Sortie : l'objet carte Leaflet. Appelée une seule fois par main.ts.
 */
export function initMap(container: HTMLElement, onMarker: (p: Point) => void) {
  onPick = onMarker;
  // Options : pas de boutons +/- par défaut (on les replace en haut à droite), crédits visibles,
  // worldCopyJump = les épingles suivent quand on fait le tour du monde, tapTolerance = clic tolérant
  // au doigt qui bouge un peu. `as L.MapOptions` car tapTolerance manque des types officiels.
  map = L.map(container, { zoomControl: false, attributionControl: true, worldCopyJump: true, tapTolerance: 20 } as L.MapOptions);
  // Fond épuré aux couleurs de l'espace (repli automatique sur OpenStreetMap si besoin).
  void addBasemap(map, store.space);
  // Boutons de zoom, puis les deux calques ajoutés à la carte (vides pour l'instant).
  L.control.zoom({ position: 'topright' }).addTo(map);
  markers.addTo(map);
  routeLayer.addTo(map);

  // Restaure la dernière vue enregistrée ; JSON.parse('null') donne null si rien n'est enregistré.
  let saved: { lat: number; lng: number; z: number } | null = null;
  try { saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null'); } catch { /* stockage indisponible */ }
  if (saved) map.setView([saved.lat, saved.lng], saved.z);
  // Sinon : vue de la France entière (centre approximatif, zoom 6).
  else map.setView([46.6, 2.4], 6);
  // 'moveend' se déclenche à la fin de chaque déplacement/zoom : on enregistre la vue.
  map.on('moveend', () => {
    const c = map.getCenter();
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() })); } catch { /* ignore */ }
  });

  // Redessiner les épingles dès que les données, les votes, le trajet ou les filtres changent.
  store.on('points', renderMarkers);
  store.on('open-votes', renderMarkers);
  store.on('route', renderMarkers);
  store.on('filters', renderMarkers);
  // Changement de vue : la taille de la carte change (panneau qui s'ouvre/se ferme) ;
  // on attend la fin de l'animation CSS (~260 ms) avant de faire remesurer la carte à Leaflet.
  store.on('view', () => {
    renderMarkers();
    setTimeout(() => map.invalidateSize(), 260);
  });
  // Les alertes expirent : on redessine chaque minute.
  // Note : ni ces abonnements ni cet intervalle ne sont jamais retirés (la carte vit aussi longtemps que la page).
  setInterval(renderMarkers, 60_000);
  return map;
}

/** Cadre la carte sur les points existants (premier lancement). */
export function fitToPoints() {
  // Aucun point : on garde la vue par défaut.
  const pts = visiblePoints();
  if (!pts.length) return;
  // Si une vue a déjà été enregistrée, on la respecte (seulement au tout premier lancement).
  try { if (localStorage.getItem(VIEW_KEY)) return; } catch { /* ignore */ }
  // fitBounds cadre un rectangle englobant tous les points ; pad(0.2) ajoute 20 % de marge ;
  // maxZoom: 16 évite de zoomer trop fort s'il n'y a qu'un seul point.
  map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])).pad(0.2), { maxZoom: 16 });
}

/** Ce que j'ai promis sur ce point : venir, et/ou fournir du matériel (visible par moi seul). */
// Entrée : un point. Sortie : 'going' (je participe), 'providing' (je fournis du matériel) ou null.
function myPledge(p: Point): 'going' | 'providing' | null {
  // store.me?.id : « ?. » au cas où l'appareil ne serait pas encore connu.
  const me = store.me?.id;
  if (!me) return null;
  if (p.participants?.some((x) => x.id === me)) return 'going';
  // p.providers ressemble à { "mégaphone": [personnes], "banderole": [...] } : on cherche dans toutes les listes.
  if (Object.values(p.providers ?? {}).some((list) => list.some((x) => x.id === me))) return 'providing';
  return null;
}

/**
 * Fabrique l'icône d'une épingle. Entrées : le point, et des extras (classe CSS en plus, badge).
 * Sortie : un L.DivIcon. Toute l'apparence (forme, couleur, animation) vient des classes CSS « pin-* ».
 *
 * L'épingle est construite en ÉLÉMENTS DOM (h(), icon()) et non plus en texte HTML :
 *  - aucun texte ne peut être interprété comme du HTML (protection XSS sans dépendre du serveur) ;
 *  - les couleurs passent par style.setProperty (CSSOM), autorisé par une politique de sécurité
 *    (CSP) stricte, alors qu'un attribut style="..." dans du HTML serait bloqué.
 */
function markerIcon(p: Point, extra: { cls?: string; badge?: string | 'check' | null } = {}) {
  const meta = TYPES[p.type];
  const { color, ink } = paintOf(p);
  const mine = myPledge(p);
  // AG avec un vote ouvert : petit badge de vote qui pulse.
  const voting = store.votingAgs.has(p.id);
  // Liste de classes : chaque condition ajoute une classe ou une chaîne vide (filtrée ensuite).
  // pin-voting (badge vote), pin-event (forme événement : carré à pointe ; sinon goutte), pin-going /
  // pin-providing, pin-flash, pin-alert + pin-<type> pour les alertes, pin-st-<statut> (ex. blocage tenu/vide).
  const cls = ['pin', voting ? 'pin-voting' : '', p.mode === 'event' && !meta.alert ? 'pin-event' : '', mine ? `pin-${mine}` : '',
    p.flash ? 'pin-flash' : '', meta.alert ? `pin-alert pin-${p.type}` : '', p.status ? `pin-st-${p.status}` : '', extra.cls ?? '']
    .filter(Boolean).join(' ');
  const el = h('div', { class: cls },
    h('div', { class: 'pin-head' }, icon(iconOf(p), 18, 2.4)),
    // Badge : « ! » (problème), numéro d'ordre (trajet) ou une coche (point choisi pour le trajet).
    extra.badge ? h('span', { class: 'pin-badge' }, extra.badge === 'check' ? icon('check', 13, 3.2) : extra.badge) : null,
    p.photo ? h('span', { class: 'pin-photo' }) : null,
    p.flash ? h('span', { class: 'pin-zap' }, icon('zap', 11, 2.6)) : null,
    voting ? h('span', { class: 'pin-vote', title: 'Vote en cours' }, icon('vote', 12, 2.6)) : null,
    mine ? h('span', { class: 'pin-me', title: mine === 'going' ? 'Tu y participes' : 'Tu fournis du matériel' },
      icon(mine === 'going' ? 'check' : 'package', 12, 3)) : null,
  );
  // --c et --ink : variables CSS de couleur de fond et d'encre, posées via le CSSOM.
  el.style.setProperty('--c', color);
  el.style.setProperty('--ink', ink);
  // className = classe du conteneur ; iconSize = taille en pixels ; iconAnchor = le pixel de l'icône
  // posé exactement sur les coordonnées (ici la pointe en bas) ; tooltipAnchor = où naît l'infobulle.
  // `html` accepte un élément DOM (Leaflet 1.9).
  return L.divIcon({ html: el, className: 'pin-wrap', iconSize: [36, 46], iconAnchor: [18, 42], tooltipAnchor: [0, -38] });
}

/** Une épingle affichée : le marqueur Leaflet, le point qu'il montre, et sa « signature » visuelle. */
interface Shown { m: L.Marker; p: Point; sig: string }
// Les épingles actuellement sur la carte, par id de point.
const shown = new Map<string, Shown>();

/**
 * (Re)dessine les épingles. Pas d'entrée ni de sortie.
 * Avant, on effaçait tout et on recréait tout à chaque événement et chaque minute : coûteux avec
 * beaucoup de points, et une infobulle ouverte se refermait. Maintenant on calcule pour chaque point
 * une « signature » (tout ce qui change son apparence) et on ne touche qu'aux épingles dont la
 * signature a changé ; les points qui ne sont plus visibles sont retirés.
 */
export function renderMarkers() {
  // La carte n'existe pas encore (appel trop tôt) : rien à faire.
  if (!map) return;
  const routeMode = store.view === 'route';
  const order = store.routeOrder;
  const seen = new Set<string>();
  for (const p of visiblePoints()) {
    seen.add(p.id);
    // Peut-on ajouter ce type de point au trajet de collage ? (panneau, collage)
    const routable = !!TYPES[p.type].routable;
    const problems = liveProblems(p);
    // Un problème en cours : épingle qui clignote (pin-problem) avec un badge « ! ».
    let cls = problems.length ? 'pin-problem' : '';
    let badge: string | null = problems.length ? '!' : null;
    // En mode Trajet : on grise ce qui n'est pas ajoutable, et on numérote les points choisis
    // selon l'ordre optimisé (ou une coche si l'ordre n'est pas encore calculé).
    if (routeMode) {
      if (!routable && !problems.length) cls = 'pin-dim';
      else if (store.routeSelection.has(p.id)) {
        cls += ' pin-selected';
        const i = order.indexOf(p.id);
        badge = i >= 0 ? String(i + 1) : 'check';
      }
    }
    const mine = myPledge(p);
    const { color, ink } = paintOf(p);
    // Signature : tout ce qui influence l'épingle ou son infobulle. Identique → on ne touche à rien.
    const sig = JSON.stringify([p.lat, p.lng, p.title, p.type, p.mode, p.flash, p.status, p.photo, iconOf(p), color, ink,
      cls, badge, mine, store.votingAgs.has(p.id), problems[0]?.message ?? null]);
    const prev = shown.get(p.id);
    if (prev && prev.sig === sig) { prev.p = p; continue; }
    const zIndexOffset = TYPES[p.type].alert || problems.length ? 1000 : cls.includes('pin-selected') ? 500 : 0;
    // Infobulle : un élément DOM (créé par h(), donc texte échappé), avec de vraies icônes.
    const tip = h('span', { class: 'tip-line' },
      problems.length ? icon('circle-alert', 14) : null,
      mine === 'going' ? icon('check', 14) : mine === 'providing' ? icon('package', 14) : null,
      h('span', null, [
        mine === 'going' ? 'Tu y vas' : mine === 'providing' ? 'Tu fournis du matos' : null,
        problems.length ? problems[0].message : null,
        p.title,
      ].filter(Boolean).join(' · ')));
    if (prev) {
      // Épingle existante qui a changé : on met à jour sur place (position, icône, ordre, infobulle).
      prev.m.setLatLng([p.lat, p.lng]);
      prev.m.setIcon(markerIcon(p, { cls, badge }));
      prev.m.setZIndexOffset(zIndexOffset);
      prev.m.setTooltipContent(tip);
      prev.p = p;
      prev.sig = sig;
      continue;
    }
    // Nouvelle épingle. keyboard + title : atteignable au clavier, avec un titre pour les lecteurs d'écran.
    const m = L.marker([p.lat, p.lng], { icon: markerIcon(p, { cls, badge }), riseOnHover: true, zIndexOffset, keyboard: true, title: p.title });
    m.bindTooltip(tip, { direction: 'top', className: 'pin-tip' });
    const rec: Shown = { m, p, sig };
    // Clic : on passe la version À JOUR du point (rec.p est remplacé à chaque rendu).
    m.on('click', () => onPick(rec.p));
    markers.addLayer(m);
    shown.set(p.id, rec);
  }
  // Points qui ne sont plus visibles (supprimés, filtrés, expirés) : on retire leur épingle.
  for (const [id, rec] of shown) {
    if (!seen.has(id)) { markers.removeLayer(rec.m); shown.delete(id); }
  }
}

// Vol animé (0,6 s) vers un point. On ne dézoome jamais : on garde le zoom actuel s'il est plus fort.
export function flyTo(p: { lat: number; lng: number }, zoom = 17) {
  map.flyTo([p.lat, p.lng], Math.max(zoom, map.getZoom()), { duration: 0.6 });
}

// Affiche ou déplace le point bleu « ma position » et son cercle de précision (rayon en mètres).
export function showMe(pos: Pos) {
  const ll: L.LatLngExpression = [pos.lat, pos.lng];
  // Première fois : on crée le halo (L.circle, rayon en mètres) et le point (L.circleMarker, rayon en pixels).
  // interactive: false = ne réagissent pas aux clics (on peut cliquer à travers).
  if (!meMarker) {
    meHalo = L.circle(ll, { radius: pos.accuracy ?? 30, className: 'me-halo', interactive: false }).addTo(map);
    meMarker = L.circleMarker(ll, { radius: 8, className: 'me-dot', interactive: false }).addTo(map);
  // Fois suivantes : on déplace simplement les deux. Le « ! » affirme que meHalo existe aussi.
  } else {
    meMarker.setLatLng(ll);
    meHalo!.setLatLng(ll).setRadius(pos.accuracy ?? 30);
  }
}

/**
 * Demande la position GPS, l'affiche, et (par défaut) centre la carte dessus.
 * Entrée : fly = faut-il déplacer la carte. Sortie : la position, ou null en cas d'échec (message affiché).
 */
export async function locateMe(fly = true): Promise<Pos | null> {
  try {
    // Peut afficher la demande d'autorisation du navigateur la première fois.
    const pos = await getPosition();
    showMe(pos);
    // Zoom au moins 16 (quartier).
    if (fly) map.flyTo([pos.lat, pos.lng], Math.max(16, map.getZoom()), { duration: 0.6 });
    return pos;
  } catch (e) {
    toast((e as Error).message, 'err', 4500);
    return null;
  }
}

// ---------- Choix d'un emplacement (viseur au centre) ----------

// Verrou : un seul viseur à la fois (évite deux superpositions si on clique deux fois).
let picking = false;

/**
 * Mode « viseur » : un repère fixe au centre de l'écran, on déplace la carte dessous pour viser.
 * Entrées : titre affiché, couleur, position de départ éventuelle.
 * Sortie : une Promise qui se résout avec la position visée, ou null si on annule.
 */
export function pickLocation(opts: { title: string; color?: string; initial?: Pos | null }): Promise<Pos | null> {
  if (picking) return Promise.resolve(null);
  picking = true;
  // Le parent du conteneur de carte (.map-wrap) : on y ajoute le viseur et la barre d'actions.
  const wrap = map.getContainer().parentElement!;
  // Position de départ fournie (modification d'un point) : on s'y place, zoom au moins 17.
  if (opts.initial) map.setView([opts.initial.lat, opts.initial.lng], Math.max(17, map.getZoom()));
  else if (map.getZoom() < 15) toast('Zoome sur la rue, puis vise l\'emplacement exact.', 'info', 4000);

  // On construit une Promise à la main : `resolve` sera appelé plus tard par finish().
  return new Promise((resolve) => {
    // finish : nettoie TOUT ce qu'on a ajouté (éléments, classe, écouteurs) puis renvoie le résultat.
    // Indispensable pour ne pas laisser traîner d'écouteurs après la sélection.
    const finish = (v: Pos | null) => {
      picking = false;
      overlay.remove();
      bar.remove();
      wrap.classList.remove('picking');
      map.off('click', clickMove);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    // Clic sur la carte : on la recentre sur l'endroit cliqué (le viseur reste au centre).
    const clickMove = (e: L.LeafletMouseEvent) => map.panTo(e.latlng);
    // Touche Échap : annuler.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish(null);

    // Le viseur : une épingle et son ombre, centrées par le CSS de .picker. Note : overlay et bar
    // sont utilisés dans finish() déclarée plus haut, ce qui marche car finish n'est appelée qu'après.
    const overlay = h('div', { class: 'picker', style: { '--c': opts.color ?? spaceColor() } as Record<string, string> },
      h('div', { class: 'picker-pin' }, icon('map-pin', 30, 2.4)),
      h('div', { class: 'picker-shadow' }),
    );
    const bar = h('div', { class: 'picker-bar' },
      h('div', { class: 'picker-hint' }, h('strong', null, opts.title), h('span', null, 'Déplace la carte pour viser l\'emplacement')),
      h('div', { class: 'picker-actions' },
        h('button', { class: 'btn btn-ghost', onclick: () => finish(null) }, 'Annuler'),
        // « Ma position » : on se localise puis on zoome très près (18) pour viser précisément.
        h('button', { class: 'btn btn-outline', onclick: async () => { const p = await locateMe(); if (p) map.setView([p.lat, p.lng], Math.max(18, map.getZoom())); } }, icon('locate-fixed', 18), 'Ma position'),
        // « Placer ici » : le centre de la carte = l'endroit sous le viseur.
        h('button', { class: 'btn btn-primary', onclick: () => { const c = map.getCenter(); finish({ lat: c.lat, lng: c.lng }); } }, icon('check', 18), 'Placer ici'),
      ),
    );
    // La classe « picking » permet au CSS de masquer les boutons flottants pendant la visée.
    wrap.classList.add('picking');
    wrap.append(overlay, bar);
    map.on('click', clickMove);
    document.addEventListener('keydown', onKey);
  });
}

// ---------- Trajet ----------

/**
 * Dessine le trajet de collage. Entrées : la liste ordonnée des positions, et s'il faut revenir au départ.
 */
export function drawRoute(path: Pos[], closeLoop: boolean) {
  // On efface l'ancien tracé ; moins de 2 points = pas de ligne possible.
  routeLayer.clearLayers();
  if (path.length < 2) return;
  const latlngs = path.map((p) => [p.lat, p.lng] as [number, number]);
  // Boucle : on rajoute le premier point à la fin pour fermer le circuit.
  if (closeLoop) latlngs.push(latlngs[0]);
  // Deux lignes superposées : une blanche épaisse en dessous (contour lisible), une violette en pointillés dessus.
  L.polyline(latlngs, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
  L.polyline(latlngs, { color: '#7B13D6', weight: 5, opacity: 0.95, dashArray: '10 8', interactive: false }).addTo(routeLayer);
  // Sur mobile, le panneau du trajet couvre le bas de la carte : on cadre au-dessus.
  // matchMedia teste une media query CSS en JavaScript : écran de moins de 900 px de large = mobile.
  // Sur mobile, ~58 % du bas de la carte est caché par le panneau : on réserve cette hauteur en marge.
  const covered = window.matchMedia('(max-width: 899.98px)').matches ? map.getContainer().clientHeight * 0.58 : 0;
  map.fitBounds(L.latLngBounds(latlngs), { maxZoom: 17, paddingTopLeft: [30, 70], paddingBottomRight: [30, covered + 30] });
}

// Efface le tracé (quand on quitte le mode trajet ou vide la sélection).
export const clearRoute = () => routeLayer.clearLayers();

// Repère temporaire unique (un seul à la fois).
let spot: L.Marker | null = null;
/** Repère temporaire (position partagée dans le chat), distinct de « ma position ». */
export function markSpot(pos: { lat: number; lng: number }, label: string) {
  // On retire l'ancien repère s'il y en a un.
  spot?.remove();
  spot = L.marker([pos.lat, pos.lng], {
    // Repère HTML fixe (aucun texte utilisateur dedans) ; iconAnchor au centre car c'est un rond.
    icon: L.divIcon({ className: 'spot-wrap', html: '<div class="spot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    zIndexOffset: 2000,
  // Infobulle permanente avec le libellé ; passée en élément DOM, donc échappée.
  }).bindTooltip(h('span', null, label), { direction: 'top', permanent: true, className: 'pin-tip' }).addTo(map);
  // Disparaît tout seul après 5 minutes. Note : si un nouveau repère est posé entre-temps,
  // ce minuteur-ci supprimera quand même le nouveau (il ne vérifie pas lequel il visait).
  setTimeout(() => { spot?.remove(); spot = null; }, 5 * 60_000);
}
