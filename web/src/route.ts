// =============================================================================
// route.ts : l'onglet « Trajet » = tournée de collage optimisée (côté Campagne).
// =============================================================================
// On coche des panneaux électoraux / points de collage (ou on les touche sur la
// carte), l'app calcule l'ordre de passage le plus court (optimize.ts), le
// dessine sur la carte, estime distance et durée, puis propose de lancer la
// navigation (Google Maps, Waze) ou d'exporter le trajet (fichier GPX, texte).
//
// Qui l'appelle ?
//   - main.ts : mountRoute(el) au démarrage, et toggleInRoute(p) quand on
//     touche un point sur la carte en mode trajet ;
//   - detail.ts déclenche aussi l'événement 'route' du store.
//
// Où sont les données ?
//   - store.routeSelection : ensemble (Set) des ids cochés ;
//   - store.routeOrder : ordre optimisé (ids), vide tant qu'on n'a pas calculé ;
//   - opts (ci-dessous) : réglages de l'écran (départ, boucle, moyen de transport).
// Toute modification de la sélection « invalide » l'ordre calculé : il faut
// recliquer sur « Optimiser ».
//
// Notions : Set et Map (collections JS), URLSearchParams (fabrique la partie
// « ?a=1&b=2 » d'une URL), Blob (fichier en mémoire), template string `...`.
import { store, paintOf } from './store';
import { api, ApiError } from './api';
import { TYPES, STATUS_LABEL, type Point } from '../../shared/model';
import { isActive } from '../../shared/time';
import { h, icon, clear, toast } from './ui';
import { segmented } from './forms';
import { drawRoute, clearRoute, flyTo, locateMe } from './map';
import { distance, fmtDistance, lastPosition, type Pos } from './geo';
import { optimizeOrder, pathLength } from './optimize';

// Moyen de déplacement, avec la vitesse moyenne retenue en ville.
// Les noms ('walking'…) sont ceux qu'attend Google Maps (travelmode).
type Travel = 'walking' | 'bicycling' | 'driving';
const SPEED: Record<Travel, number> = { walking: 4.5, bicycling: 13, driving: 22 }; // km/h en ville
const DETOUR = 1.3; // les rues ne sont pas des lignes droites
const STOP_MIN = 4; // minutes de collage par arrêt

// Réglages de l'écran Trajet. Variable de module : ils sont gardés quand on
// change d'onglet et qu'on revient (mais pas après un rechargement de page).
const opts = {
  // Masquer les panneaux déjà collés (sauf s'ils sont déjà cochés).
  onlyToDo: true,
  // Partir de ma position GPS (sinon du point le plus excentré).
  startFromMe: true,
  // Revenir au point de départ à la fin.
  loop: false,
  travel: 'walking' as Travel,
  // Position de départ effectivement utilisée lors du dernier calcul.
  start: null as Pos | null,
};

let root: HTMLElement;

// mountRoute() : branche l'écran sur son conteneur et s'abonne aux événements
// du store : redessiner quand les points changent ('points') ou quand la
// sélection / l'ordre change ('route').
export function mountRoute(el: HTMLElement) {
  root = el;
  store.on('points', render);
  store.on('route', render);
  // En ouvrant l'onglet Trajet, on retrie par distance (puis l'ordre ne bouge plus pendant qu'on coche).
  store.on('view', () => { if (store.view === 'route') { resortRouteList(); render(); } });
  render();
}

/**
 * Ordre d'affichage figé : trié par distance la première fois, puis on n'y touche plus
 * (sinon la liste se réordonne à chaque mouvement du GPS, pendant qu'on coche).
 * Les nouveaux points vont à la fin.
 */
let listOrder: string[] = [];

// candidates() : les points qu'on peut mettre dans le trajet, dans l'ordre
// d'affichage stable (voir listOrder).
function candidates(): Point[] {
  // Dernière position GPS connue (sans en redemander une), ou null.
  const ref = lastPosition();
  // Garder : types « routables » (panneau, collage) encore actifs ;
  const pts = store.points
    .filter((p) => TYPES[p.type].routable && isActive(p))
    // puis, si « masquer les collés » : retirer les panneaux collés, SAUF ceux
    // déjà cochés (on ne fait pas disparaître un point qu'on vient de cocher).
    .filter((p) => !opts.onlyToDo || p.type !== 'panneau' || p.status !== 'colle' || store.routeSelection.has(p.id));
  // Les points jamais vus jusqu'ici (« fresh ») sont triés par distance (ou par
  // titre si on ne sait pas où on est) et ajoutés à la fin de l'ordre figé.
  const known = new Set(listOrder);
  const fresh = pts.filter((p) => !known.has(p.id))
    .sort((a, b) => (ref ? distance(ref, a) - distance(ref, b) : a.title.localeCompare(b.title, 'fr')));
  listOrder = [...listOrder, ...fresh.map((p) => p.id)];
  // rank : id → position dans l'ordre figé, pour trier rapidement.
  // Le « ! » affirme que l'id est bien présent (il vient d'y être ajouté).
  const rank = new Map(listOrder.map((id, i) => [id, i]));
  return pts.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
}

/** Retrier la liste par distance (à l'ouverture de l'onglet Trajet). */
export function resortRouteList() {
  // Vider l'ordre figé : candidates() retriera tout par distance au prochain affichage.
  listOrder = [];
}

// On remonte les parents de root jusqu'à trouver celui qui a une barre de
// défilement (overflow auto/scroll ET contenu plus haut que la zone visible).
/** Élément qui défile autour de l'écran Trajet (pour garder la position quand on redessine). */
function scroller(): HTMLElement | null {
  for (let el: HTMLElement | null = root; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

// Les points cochés, dans l'ordre du store (pas encore optimisé).
const selected = () => store.points.filter((p) => store.routeSelection.has(p.id));

// invalidate() : la sélection ou un réglage a changé, l'ordre calculé n'est
// plus valable. On l'efface, on retire le tracé de la carte et on prévient
// l'écran (événement 'route' → render).
function invalidate() {
  store.routeOrder = [];
  clearRoute();
  store.emit('route');
}

// toggleInRoute() : coche / décoche un point (exporté : utilisé depuis la carte).
export function toggleInRoute(p: Point) {
  if (store.routeSelection.has(p.id)) store.routeSelection.delete(p.id);
  else store.routeSelection.add(p.id);
  invalidate();
}

// compute() : bouton « Optimiser le trajet ».
// 1) vérifie qu'il y a assez de points ; 2) récupère la position si demandé ;
// 3) calcule l'ordre ; 4) dessine sur la carte ; 5) fait défiler vers le résultat.
async function compute() {
  const pts = selected();
  // Il faut au moins 2 points, ou 1 seul si on part de sa position (trajet moi → point).
  if (pts.length < 2 && !(opts.startFromMe && pts.length === 1)) return toast('Sélectionne au moins 2 points.', 'err');
  let start: Pos | null = null;
  if (opts.startFromMe) {
    // locateMe(false) : demande la position GPS sans déplacer la carte.
    // En cas d'échec, on continue quand même en partant d'un point.
    start = await locateMe(false);
    if (!start) toast('Départ depuis le premier point à la place.', 'info');
  }
  opts.start = start;
  // optimizeOrder renvoie des INDICES dans pts (ex. [2, 0, 1]) ; on les
  // traduit en ids de points.
  const order = optimizeOrder(pts, start, opts.loop);
  store.routeOrder = order.map((i) => pts[i].id);
  const path = orderedPath();
  drawRoute(path, opts.loop);
  store.emit('route');
  // Fait défiler doucement jusqu'au bloc résultat, s'il existe.
  root.querySelector('.route-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Points du trajet dans l'ordre optimisé. Le filtre retire ceux qui auraient
// été supprimés entre-temps. « p is Point » est un « type guard » : il dit à
// TypeScript qu'après le filtre il n'y a plus d'undefined.
function orderedPoints(): Point[] {
  return store.routeOrder.map((id) => store.get(id)).filter((p): p is Point => !!p);
}

// Chemin géographique complet : position de départ (si utilisée) puis les points.
function orderedPath(): Pos[] {
  const pts = orderedPoints().map((p) => ({ lat: p.lat, lng: p.lng }));
  return opts.start ? [opts.start, ...pts] : pts;
}

// Exports : liens Google Maps / Waze, fichier GPX, texte à partager.
// ---------- Exports ----------

// Coordonnées au format « lat,lng » (6 décimales ≈ 10 cm), utilisé dans les URL.
const ll = (p: Pos) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Google Maps accepte 9 étapes intermédiaires par lien : on découpe le trajet en tronçons. */
// Sortie : une liste de tronçons { url, from, to } ; from / to = numéros des
// arrêts couverts, pour l'afficher sur les boutons (« arrêts 1–10 »).
function googleLegs(): { url: string; from: number; to: number }[] {
  const path = orderedPath();
  // En boucle, on ajoute le départ à la fin pour revenir au point de départ.
  if (opts.loop && path.length > 2) path.push(path[0]);
  const offset = opts.start ? 0 : 1; // numéro d'arrêt du premier élément du chemin
  const legs: { url: string; from: number; to: number }[] = [];
  const MAX = 11; // origine + 9 étapes + destination
  // Chaque tronçon commence là où le précédent finit (pas de MAX - 1) : la
  // destination d'une partie est l'origine de la suivante.
  for (let i = 0; i < path.length - 1; i += MAX - 1) {
    const chunk = path.slice(i, i + MAX);
    // Paramètres de l'URL Google Maps « dir » (itinéraire), documentés par Google.
    const q = new URLSearchParams({ api: '1', origin: ll(chunk[0]), destination: ll(chunk[chunk.length - 1]), travelmode: opts.travel });
    // Étapes intermédiaires séparées par « | ».
    if (chunk.length > 2) q.set('waypoints', chunk.slice(1, -1).map(ll).join('|'));
    legs.push({ url: `https://www.google.com/maps/dir/?${q.toString()}`, from: Math.max(1, i + offset), to: i + chunk.length - 1 + offset });
  }
  return legs;
}

// gpx() : produit le texte d'un fichier GPX (format XML standard des GPS et
// applis de rando/vélo). Deux parties : des « waypoints » (les arrêts
// numérotés, avec titre et description) et une « route » (le chemin à suivre).
function gpx(): string {
  const pts = orderedPoints();
  // esc() : échappe les caractères spéciaux XML pour qu'un titre contenant
  // « < » ou « & » ne casse pas le fichier.
  const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
  const wpts = pts.map((p, i) => `  <wpt lat="${p.lat}" lon="${p.lng}"><name>${i + 1}. ${esc(p.title)}</name>${p.description ? `<desc>${esc(p.description)}</desc>` : ''}</wpt>`).join('\n');
  // La route : le chemin, plus le retour au départ en boucle. Le premier point
  // s'appelle « Départ » si on part de sa position, sinon les arrêts sont numérotés.
  const rte = orderedPath().concat(opts.loop && opts.start ? [opts.start] : [])
    .map((p, i) => `    <rtept lat="${p.lat}" lon="${p.lng}"><name>${opts.start && i === 0 ? 'Départ' : esc(String(i + (opts.start ? 0 : 1)))}</name></rtept>`).join('\n');
  // Le contenu de ce template string est le fichier lui-même, retours à la
  // ligne compris : on ne doit rien y insérer.
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

// downloadGpx() : fait télécharger le GPX par le navigateur.
// Technique classique : un Blob (fichier en mémoire), une URL temporaire, un
// lien <a download> invisible sur lequel on « clique » par code, puis on
// nettoie après 1 s (le téléchargement a eu le temps de démarrer).
function downloadGpx() {
  const blob = new Blob([gpx()], { type: 'application/gpx+xml' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `trajet-collage-${new Date().toISOString().slice(0, 10)}.gpx` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Fichier GPX téléchargé : ouvre-le avec Organic Maps, OsmAnd, Komoot…', 'ok', 5000);
}

// share() : partage le trajet en texte (liste des arrêts + liens Google Maps).
// Partage natif du téléphone si possible ; sinon copie dans le presse-papier.
async function share() {
  const pts = orderedPoints();
  const legs = googleLegs();
  const text = ['Trajet de collage :', ...pts.map((p, i) => `${i + 1}. ${p.title}`), '', ...legs.map((l, i) => `${legs.length > 1 ? `Partie ${i + 1} : ` : ''}${l.url}`)].join('\n');
  if (navigator.share) {
    // Annulation volontaire (AbortError) : on s'arrête là. Autre erreur (partage indisponible) : on copie.
    try { await navigator.share({ title: 'Trajet de collage', text }); return; }
    catch (e) { if ((e as DOMException).name === 'AbortError') return; }
  }
  // Le presse-papier peut manquer (http, vieux navigateur) ou refuser : on ne dit « copié » que si c'est vrai.
  try { await navigator.clipboard.writeText(text); toast('Trajet copié : colle-le dans une conversation.', 'ok'); }
  catch { toast('Copie impossible sur ce navigateur.', 'err'); }
}

// ---------- Rendu ----------

// render() : redessine l'écran en gardant la position de défilement.
// Exportée : d'autres modules peuvent demander un rafraîchissement.
export function render() {
  if (!root) return;
  // Garder la position de défilement : cocher un point ne doit pas renvoyer en haut de la liste.
  // (le panneau défile, et la liste des points a aussi sa propre zone de défilement)
  const sc = scroller();
  const keepTop = sc?.scrollTop ?? 0;
  const listTop = root.querySelector<HTMLElement>('.pick-list')?.scrollTop ?? 0;
  // renderContent() reconstruit tout le HTML, ce qui remettrait le défilement à
  // zéro ; on restaure donc les deux positions sauvegardées juste avant.
  renderContent();
  if (sc) sc.scrollTop = keepTop;
  const list = root.querySelector<HTMLElement>('.pick-list');
  if (list) list.scrollTop = listTop;
}

// renderContent() : construit tout le contenu de l'écran Trajet.
function renderContent() {
  const cands = candidates();
  const sel = selected();
  const ordered = orderedPoints();
  const ref = lastPosition();

  // Liste à cocher des points candidats.
  const list = h('ul', { class: 'pick-list' }, cands.map((p) => {
    const on = store.routeSelection.has(p.id);
    // paintOf (store.ts) : couleur du point (un blocage prend celle de son blocus).
    const { color: c, ink: cInk } = paintOf(p);
    // Le <label> englobe la case : cliquer n'importe où sur la ligne coche / décoche.
    return h('li', null, h('label', { class: `pick-row${on ? ' on' : ''}` },
      h('input', { type: 'checkbox', checked: on, onchange: () => toggleInRoute(p) }),
      h('span', { class: 'pick-dot', style: { background: c, color: cInk } }, icon(TYPES[p.type].icon, 16)),
      h('span', { class: 'pick-main' },
        h('span', { class: 'pick-title' }, p.title),
        // Sous-titre : état du panneau (ou type), plus la distance si on connaît notre position.
        h('span', { class: 'pick-sub' }, p.type === 'panneau' && p.status ? STATUS_LABEL[p.status] : TYPES[p.type].label, ref ? ` · ${fmtDistance(distance(ref, p))}` : ''),
      ),
      // preventDefault : le bouton est dans le <label>, sans ça le clic cocherait
      // aussi la case. Ici on veut seulement centrer la carte sur le point.
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Voir sur la carte', onclick: (e: Event) => { e.preventDefault(); flyTo(p); } }, icon('map-pin', 18)),
    ));
  }));

  // Bloc résultat : seulement si un ordre a été calculé.
  let result: HTMLElement | null = null;
  if (ordered.length) {
    const path = orderedPath();
    // Distance à vol d'oiseau × 1,3 (DETOUR) pour approcher la distance par les rues.
    const meters = pathLength(path, opts.loop) * DETOUR;
    // Durée = trajet (distance / vitesse, converti en minutes) + 4 min par arrêt.
    const minutes = Math.round((meters / 1000 / SPEED[opts.travel]) * 60 + ordered.length * STOP_MIN);
    const legs = googleLegs();
    result = h('section', { class: 'route-result' },
      h('div', { class: 'route-stats' },
        stat(String(ordered.length), 'arrêts'),
        stat(`≈ ${fmtDistance(meters)}`, 'à parcourir'),
        // Format « 1 h 05 » au-delà d'une heure, sinon « 45 min ».
        stat(minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`, 'collage compris'),
      ),
      h('ol', { class: 'route-steps' },
        opts.start ? h('li', { class: 'step start' }, h('span', { class: 'step-num' }, icon('locate-fixed', 14)), h('span', { class: 'step-title' }, 'Départ : ma position')) : null,
        ordered.map((p, i) => h('li', { class: 'step' },
          h('span', { class: 'step-num' }, String(i + 1)),
          h('button', { class: 'step-title link-like', type: 'button', onclick: () => flyTo(p) }, p.title),
          // Sur un panneau : bouton pour basculer collé / à coller directement depuis la liste.
          p.type === 'panneau' ? h('button', {
            class: `btn btn-small ${p.status === 'colle' ? 'btn-done' : 'btn-light'}`, type: 'button',
            onclick: async () => {
              try {
                // On inverse l'état ; le serveur renvoie le point à jour, qu'on remet dans le store.
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
        // Un bouton Google Maps par tronçon (un seul si le trajet est court).
        // target _blank + rel noopener : ouvre dans un nouvel onglet, sans donner à
        // la page ouverte d'accès à la nôtre (bonne pratique de sécurité).
        legs.map((l, i) => h('a', { class: 'btn btn-primary btn-block', href: l.url, target: '_blank', rel: 'noopener' }, icon('navigation', 18),
          legs.length > 1 ? `Google Maps · partie ${i + 1} (arrêts ${l.from}–${l.to})` : 'Ouvrir dans Google Maps')),
        legs.length > 1 ? h('p', { class: 'field-hint' }, 'Google Maps limite le nombre d\'étapes : le trajet est découpé en parties à enchaîner.') : null,
        h('div', { class: 'grid-2' },
          h('button', { class: 'btn btn-outline', type: 'button', onclick: downloadGpx }, icon('download', 18), 'GPX'),
          h('button', { class: 'btn btn-outline', type: 'button', onclick: share }, icon('share-2', 18), 'Partager'),
        ),
        // Waze ne gère qu'une destination : on propose le prochain arrêt pas encore
        // fait. (nextStop est appelée trois fois ici ; c'est peu coûteux.)
        nextStop(ordered) ? h('a', { class: 'btn btn-light btn-block btn-two', href: `https://waze.com/ul?ll=${ll(nextStop(ordered)!)}&navigate=yes`, target: '_blank', rel: 'noopener' },
          icon('navigation', 18),
          h('span', { class: 'btn-two-text' }, h('span', null, 'Prochain arrêt dans Waze'), h('small', null, nextStop(ordered)!.title))) : null,
        h('p', { class: 'field-hint' }, 'GPX : compatible Organic Maps, OsmAnd, Komoot, Garmin… Waze ne gère qu\'une destination à la fois.'),
      ),
    );
  }

  // Assemblage de l'écran.
  clear(root,
    h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title' }, 'Trajet de collage')),
    h('p', { class: 'panel-intro' }, 'Coche les panneaux et points de collage (ou touche-les sur la carte), l\'app calcule l\'ordre le plus court.'),
    h('div', { class: 'route-toolbar' },
      h('label', { class: 'toggle-line compact' },
        h('input', { type: 'checkbox', checked: opts.onlyToDo, onchange: (e: Event) => { opts.onlyToDo = (e.target as HTMLInputElement).checked; render(); } }),
        h('span', { class: 'switch' }), 'Masquer les panneaux déjà collés'),
      h('div', { class: 'row-gap' },
        // « Tout » coche tous les candidats affichés, « Aucun » vide la sélection.
        h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { cands.forEach((p) => store.routeSelection.add(p.id)); invalidate(); } }, 'Tout'),
        h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { store.routeSelection.clear(); invalidate(); } }, 'Aucun'),
      ),
    ),
    // Liste, ou message si aucun point n'est disponible.
    cands.length ? list : h('div', { class: 'empty small' }, icon('presentation', 32, 1.6), h('strong', null, 'Aucun panneau à coller'), h('span', null, 'Ajoute des panneaux électoraux ou des points de collage sur la carte.')),
    h('div', { class: 'card-section' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Départ'),
        // Choix du départ. « Au plus loin » : optimize.ts part du point le plus
        // éloigné du centre (on commence par un bout du quartier).
        segmented<'me' | 'first'>([{ value: 'me', label: 'Ma position', icon: 'locate-fixed' }, { value: 'first', label: 'Au plus loin', icon: 'map-pin' }],
          opts.startFromMe ? 'me' : 'first', (v) => { opts.startFromMe = v === 'me'; invalidate(); })),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Je me déplace'),
        segmented<Travel>([{ value: 'walking', label: 'À pied', icon: 'footprints' }, { value: 'bicycling', label: 'Vélo', icon: 'bike' }, { value: 'driving', label: 'Voiture', icon: 'car' }],
          // Changer de moyen de transport ne change pas l'ordre : on se contente de
          // redessiner (durée et liens Google Maps).
          opts.travel, (v) => { opts.travel = v; if (store.routeOrder.length) render(); })),
      h('label', { class: 'toggle-line compact' },
        h('input', { type: 'checkbox', checked: opts.loop, onchange: (e: Event) => { opts.loop = (e.target as HTMLInputElement).checked; invalidate(); } }),
        h('span', { class: 'switch' }), 'Revenir au point de départ'),
    ),
    // Bouton principal, désactivé tant que rien n'est coché.
    // « sticky-cta » : il reste collé en bas de l'écran pendant qu'on fait défiler.
    h('button', { class: 'btn btn-primary btn-block btn-big sticky-cta', type: 'button', disabled: sel.length === 0, onclick: compute },
      icon('route', 20), sel.length ? `Optimiser le trajet (${sel.length} point${sel.length > 1 ? 's' : ''})` : 'Sélectionne des points'),
    result,
  );
}

// nextStop() : le premier arrêt du trajet qui reste à faire (un panneau non
// collé, ou tout autre type de point). null si tout est fait.
function nextStop(ordered: Point[]) {
  return ordered.find((p) => p.type !== 'panneau' || p.status !== 'colle') ?? null;
}

// stat() : petite case « valeur + légende » des statistiques du trajet.
const stat = (v: string, l: string) => h('div', { class: 'stat' }, h('strong', null, v), h('span', null, l));
