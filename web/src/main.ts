/**
 * main.ts : POINT D'ENTRÉE du client (le premier fichier exécuté dans le navigateur).
 *
 * Qui l'appelle ? Personne en TypeScript : c'est index.html qui le charge via
 * <script type="module" src="/src/main.ts">, et Vite le compile/assemble.
 * Tout en bas, l'appel `boot()` lance l'application.
 *
 * Ce qu'il fait :
 * 1. Choisit l'écran à afficher selon l'URL (« routes par hash ») :
 *    - #/vote        → voter avec un code à 5 chiffres, sans compte ;
 *    - #/public      → ancien lien, redirigé vers la page d'accueil publique ;
 *    - #/join/<jeton> → lien d'invitation : on choisit un pseudo et l'appareil est enregistré ;
 *    - sinon : si l'appareil est connu → l'app ; sinon → page publique (« écran verrouillé »).
 * 2. Construit la « coquille » de l'app (barre du haut, carte, panneaux, boutons flottants).
 * 3. Ouvre un flux SSE (/api/stream) pour recevoir en direct les changements du serveur
 *    et afficher des notifications (filtrées selon la distance à pied).
 * 4. Gère les réglages propres à l'appareil (rayon de notification) et l'écran de bienvenue.
 *
 * Notions à connaître :
 * - Le « hash » est la partie de l'URL après # : le navigateur ne l'envoie pas au serveur,
 *   on peut donc s'en servir pour « router » côté client sans recharger la page.
 * - `h(tag, props, ...enfants)` (ui.ts) crée un élément DOM ; les props « onxxx » deviennent
 *   des écouteurs d'événements, le texte est toujours échappé (pas d'injection HTML).
 * - `store` (store.ts) est l'état global partagé : points, vue courante, filtres, et un petit
 *   système d'événements (store.on / store.emit) pour que les modules se redessinent.
 * - EventSource (SSE) : connexion HTTP qui reste ouverte, le serveur y « pousse » des messages.
 * - localStorage : petit stockage clé/valeur du navigateur, qui survit aux rechargements.
 */
// Les `import '...css'` ne récupèrent rien : ils demandent à Vite d'inclure ces feuilles de style.
// D'abord le CSS de Leaflet (bibliothèque de carte), sans lequel les tuiles s'affichent en vrac.
import 'leaflet/dist/leaflet.css';
// Polices embarquées (paquets @fontsource) : pas de dépendance à Google Fonts, donc pas de fuite d'IP.
// Inter = texte courant, chaque fichier = une graisse (400 normal … 700 gras).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// Barlow Condensed : titres étroits (espace Campagne).
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
// Espace Mouvement : esprit journal militant (titres condensés, menus en capitales, texte à empattements).
import '@fontsource/fjalla-one/400.css';
import '@fontsource/lato/400.css';
import '@fontsource/lato/700.css';
import '@fontsource/lato/900.css';
import '@fontsource/pt-serif/400.css';
// Nos propres styles, chargés en dernier pour pouvoir surcharger ceux de Leaflet.
import './styles.css';

// Appels HTTP au serveur ; setUnauthorizedHandler = que faire si le serveur répond 401 (non connecté).
import { api, setUnauthorizedHandler, ApiError } from './api';
// `type View`, `type Group` : imports de types seulement (effacés à la compilation).
import { store, type View, type Group } from './store';
// Fonctions de la carte Leaflet (voir map.ts).
import { initMap, renderMarkers, locateMe, flyTo, fitToPoints, getMap } from './map';
// Les autres écrans/panneaux de l'app, chacun dans son module.
import { openDetail } from './detail';
import { newPointFlow, openAlertForm } from './forms';
import { mountAgenda } from './agenda';
import { mountRoute, toggleInRoute } from './route';
import { mountTeam } from './team';
import { openSheet } from './sheet';
import { publicVotePage } from './votes';
import { mountArchive } from './archive';
import { publicHome } from './home';
import { mountChat } from './chat';
// Petits utilitaires d'interface : création d'éléments, icônes, notifications (toast), format d'heure.
import { h, icon, toast, isDesktop, time } from './ui';
// Géolocalisation « discrète » et estimation du temps de marche (geo.ts).
import { quietPosition, walkMinutes } from './geo';
// `chips` : rangée de boutons à choix unique (utilisée dans les réglages).
import { chips } from './forms';
// Modèle partagé avec le serveur (dossier shared/) : types de points, espaces, libellés.
import { TYPES, SPACES, SPACE_LABEL, type Point, type Space } from '../../shared/model';

// L'élément <div id="app"> d'index.html, dans lequel on dessine tout.
// Le « ! » dit à TypeScript : « je garantis qu'il existe » (sinon le type serait HTMLElement | null).
const app = document.getElementById('app')!;

// ---------- Démarrage ----------

/**
 * Démarrage : décide quel écran afficher.
 * Entrées : aucune (lit location.hash et interroge le serveur).
 * Sortie : rien d'utile (la fonction est async, donc renvoie une Promise ignorée).
 * Pourquoi async : il faut attendre la réponse de /api/me pour savoir si l'appareil est connu.
 */
async function boot() {
  // Page publique « J'ai un code de vote » : accessible sans compte.
  // `return voteScreen()` : on affiche cet écran et on s'arrête là (la suite ne s'exécute pas).
  if (location.hash === '#/vote') return voteScreen();
  if (location.hash === '#/public') return publicScreen();
  // Lien d'invitation « #/join/<jeton> » : l'expression régulière vérifie la forme du jeton
  // (20 à 100 caractères parmi lettres, chiffres, _ et -). `join` vaut null si ça ne correspond pas,
  // sinon un tableau dont join[1] est le jeton capturé entre parenthèses.
  const join = location.hash.match(/^#\/join\/([A-Za-z0-9_-]{20,100})$/);
  // L'appareil connecté (ou null si inconnu).
  let me = null;
  // Le serveur reconnaît l'appareil grâce à son cookie : s'il répond 401, l'appareil n'est pas inscrit.
  try {
    me = (await api.me()).device;
  } catch (e) {
    // Toute autre erreur (réseau coupé, serveur en panne…) : écran « Connexion impossible ».
    // Une 401, elle, est normale : on continue avec me = null.
    if ((e as ApiError).status !== 401) return offline((e as Error).message);
  }
  // On vient d'un lien d'invitation.
  if (join) {
    // replaceState remplace l'URL courante sans recharger ni créer d'entrée dans l'historique.
    history.replaceState(null, '', location.pathname); // le jeton ne reste pas dans l'historique
    // Appareil inconnu : écran « Bienvenue » pour choisir un pseudo.
    if (!me) return joinScreen(join[1]);
    // Appareil déjà inscrit : on ignore l'invitation et on démarre normalement.
    toast('Cet appareil a déjà accès à l\'app.', 'info');
  }
  // Ni inscrit ni invité : page publique.
  if (!me) return lockedScreen();
  // On mémorise l'appareil dans l'état global, puis on construit l'app.
  store.me = me;
  startApp();
}

// Entrées : big = grande version (écrans d'accueil) ; space = espace courant (undefined = neutre).
// Sortie : un <div class="brand ..."> ; les classes brand-lfi / brand-mvt / brand-neutral règlent les couleurs en CSS.
/** Marque : neutre sur les écrans d'accès (aucune référence à l'un ou l'autre espace), propre à l'espace dans l'app. */
function brand(big = false, space?: Space) {
  // Sous-titre selon l'espace.
  const sub = space === 'lfi' ? 'carte militante' : space === 'mvt' ? 'infos & actions' : 'accès protégé';
  // Classes construites dans un template string : « brand » + « brand-big » éventuel + classe d'espace.
  return h('div', { class: `brand${big ? ' brand-big' : ''}${space ? ` brand-${space}` : ' brand-neutral'}` },
    h('span', { class: 'brand-mark' }, icon('map-pin', big ? 34 : 20, 2.6)),
    h('span', { class: 'brand-text' }, h('strong', null, 'Terrain'), h('small', null, sub)),
  );
}

/**
 * Écran plein page centré (logo + contenu) utilisé pour l'invitation, le vote par code et les erreurs.
 * Entrée : les éléments à afficher sous le logo (paramètre « rest » : autant qu'on veut).
 * replaceChildren remplace tout le contenu de #app d'un coup.
 */
function splash(...children: Node[]) {
  app.replaceChildren(h('div', { class: 'splash' }, h('div', { class: 'splash-inner' }, brand(true), ...children)));
}

/** Page d'accueil publique : votes ouverts à tous, prochaines AG, archive publique ; accès membres en haut. */
function lockedScreen() {
  // La vitrine publique prend le style du côté Mouvement (les écrans d'accès restent neutres).
  // `dataset.space` = attribut HTML data-space sur <html> : le CSS s'en sert pour choisir le thème.
  document.documentElement.dataset.space = 'mvt';
  // Couleur de la barre d'adresse sur mobile (balise <meta name="theme-color"> d'index.html).
  // Le « ?. » évite une erreur si la balise n'existe pas.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#1b1b1b');
  // onCode (bouton « J'ai un code de vote ») : on retire le thème Mouvement, on passe l'URL en #/vote
  // et on affiche directement l'écran de vote.
  app.replaceChildren(publicHome(brand(false, 'mvt'), { onCode: () => { delete document.documentElement.dataset.space; location.hash = '#/vote'; voteScreen(); } }));
}

// Entrées/sortie : aucune. On nettoie l'URL (retire #/public) puis on affiche la page d'accueil.
/** Ancien lien « #/public » : c'est maintenant la page d'accueil. */
function publicScreen() {
  history.replaceState(null, '', location.pathname);
  lockedScreen();
}

/** Voter avec un code à 5 chiffres, sans compte (sur place uniquement). */
function voteScreen() {
  // publicVotePage reçoit une fonction « retour » : on nettoie l'URL et on recharge la page
  // (le plus simple pour repartir de zéro, quel que soit l'écran précédent).
  splash(publicVotePage(() => { history.replaceState(null, '', location.pathname); location.reload(); }));
}


/**
 * Écran « Bienvenue » après un lien d'invitation.
 * Entrée : token = jeton secret lu dans l'URL. Le serveur l'échange contre un accès pour cet appareil.
 */
function joinScreen(token: string) {
  // `as HTMLInputElement` : h() renvoie déjà le bon type, mais on le précise pour lire .value plus bas.
  // `required: true` devient l'attribut HTML required (validation native du navigateur).
  const input = h('input', { class: 'input input-big', type: 'text', maxlength: '40', placeholder: 'Ton prénom ou pseudo', autocomplete: 'off', required: true }) as HTMLInputElement;
  const btn = h('button', { class: 'btn btn-yellow btn-big btn-block', type: 'submit' }, h('span', null, 'Rejoindre'), icon('arrow-right', 22)) as HTMLButtonElement;
  // Le formulaire : onsubmit est déclenché par le bouton type="submit" ou par la touche Entrée.
  const form = h('form', { class: 'join-form', onsubmit: async (e: Event) => {
    // Empêche le comportement par défaut d'un <form> (envoyer la page et recharger) : on gère nous-mêmes.
    e.preventDefault();
    // Pseudo vide (que des espaces) : on remet le curseur dans le champ et on s'arrête.
    if (!input.value.trim()) return input.focus();
    // Désactive le bouton pendant la requête pour éviter un double envoi.
    btn.disabled = true;
    try {
      // api.claim : le serveur valide le jeton, crée l'appareil et pose le cookie de session.
      store.me = (await api.claim(token, input.value.trim())).device;
      // Effacer les drapeaux « bienvenue déjà vue » (un par espace, comme dans welcome()) pour que
      // le nouvel arrivant voie les astuces, même sur un appareil déjà utilisé par quelqu'un d'autre.
      // try/catch : localStorage peut lever une exception (navigation privée, stockage bloqué).
      try { for (const s of SPACES) localStorage.removeItem(`terrain:welcomed:${s}`); } catch { /* ignore */ }
      startApp();
    } catch (err) {
      // Échec (jeton expiré, déjà utilisé…) : on réactive le bouton et on affiche l'erreur 6 s.
      btn.disabled = false;
      toast((err as Error).message, 'err', 6000);
    }
  // Le <label class="sr-only"> est invisible mais lu par les lecteurs d'écran (accessibilité).
  } }, h('label', { class: 'sr-only' }, 'Prénom ou pseudo'), input, btn);
  splash(
    h('h1', { class: 'splash-title' }, 'Bienvenue'),
    h('p', { class: 'splash-text' }, 'Tu as été invité·e. Choisis le nom sous lequel le groupe te verra : un prénom ou un pseudo suffit.'),
    form,
    h('p', { class: 'splash-fine' }, 'Cet appareil sera mémorisé : pas de mot de passe à retenir.'),
  );
  // On donne le focus au champ un peu après l'affichage (sinon certains navigateurs mobiles l'ignorent).
  setTimeout(() => input.focus(), 100);
}

// Écran d'erreur réseau. Entrée : le message d'erreur. « Réessayer » recharge simplement la page.
function offline(msg: string) {
  splash(
    h('h1', { class: 'splash-title' }, 'Connexion impossible'),
    h('p', { class: 'splash-text' }, msg),
    h('button', { class: 'btn btn-yellow btn-big', onclick: () => location.reload() }, 'Réessayer'),
  );
}

// ---------- Application ----------

// Liste des onglets de navigation : la vue (clé utilisée dans store.view), le libellé, l'icône.
// Certains seront filtrés selon l'espace (voir startApp).
const NAV: { view: View; label: string; icon: string }[] = [
  { view: 'map', label: 'Carte', icon: 'map' },
  { view: 'agenda', label: 'Agenda', icon: 'calendar-days' },
  { view: 'route', label: 'Trajet', icon: 'route' },
  { view: 'archive', label: 'Archive', icon: 'archive' },
  { view: 'chat', label: 'Chat', icon: 'message-circle' },
  { view: 'team', label: 'Équipe', icon: 'users-round' },
];

/**
 * Construit et affiche l'application complète, une fois l'appareil connu (store.me rempli).
 * Pas d'entrée ni de sortie : elle crée le DOM, branche les modules, ouvre le flux temps réel
 * et programme les rafraîchissements. Appelée une seule fois (un changement d'espace recharge la page).
 */
function startApp() {
  // Si une requête répond 401 plus tard (accès révoqué), on recharge : boot() affichera la page publique.
  setUnauthorizedHandler(() => location.reload());
  // Choisit l'espace (dernier utilisé ou premier autorisé) et applique son thème.
  store.initSpace();
  const mvt = store.space === 'mvt';
  // Le trajet de collage n'existe que côté LFI, l'archive que côté Mouvement.
  // Lecture du filtre : on garde l'onglet sauf si (c'est 'route' ET on est en mvt)
  // ou si (c'est 'archive'/'chat' ET on n'est PAS en mvt). Le chat n'existe aussi que côté Mouvement.
  const nav = NAV.filter((n) => (n.view !== 'route' || !mvt) && ((n.view !== 'archive' && n.view !== 'chat') || mvt));
  // Un simple membre voit son « Profil » ; un admin voit « Équipe ».
  const teamLabel = store.me.role === 'membre' ? 'Profil' : 'Équipe';

  // Fabrique un bouton d'onglet. `(typeof NAV)[number]` = le type d'un élément du tableau NAV.
  // dataset.view → attribut data-view, relu plus bas par applyView pour allumer le bon bouton.
  const navBtn = (n: (typeof NAV)[number], cls: string) => h('button', {
    class: cls, type: 'button', dataset: { view: n.view }, onclick: () => store.setView(n.view),
  }, icon(n.icon, 22), h('span', null, n.view === 'team' ? teamLabel : n.label));

  // Un <section> vide par panneau latéral ; chaque module (agenda, trajet…) le remplira lui-même.
  const panels = {
    agenda: h('section', { class: 'panel-view', dataset: { view: 'agenda' } }),
    route: h('section', { class: 'panel-view', dataset: { view: 'route' } }),
    archive: h('section', { class: 'panel-view', dataset: { view: 'archive' } }),
    chat: h('section', { class: 'panel-view panel-chat', dataset: { view: 'chat' } }),
    team: h('section', { class: 'panel-view', dataset: { view: 'team' } }),
  };

  // Filtres de la carte : icône + texte (sur téléphone, l'icône seule).
  // Entrées : g = groupe filtré, label = texte complet, short = texte court, color = couleur, ico = icône.
  // La variable CSS --c porte la couleur du bouton (le CSS l'utilise quand il est allumé).
  const filterChip = (g: Group, label: string, short: string, color: string, ico: string) => h('button', {
    class: `fchip fchip-${g}${store.filters[g] ? ' on' : ''}`, type: 'button', style: { '--c': color } as Record<string, string>,
    // aria-pressed : indique aux lecteurs d'écran que c'est un bouton bascule (on/off).
    'aria-pressed': String(store.filters[g]), 'aria-label': label, title: label,
    onclick: (e: Event) => {
      // On inverse le filtre dans l'état global…
      store.filters[g] = !store.filters[g];
      // e.currentTarget = l'élément qui porte l'écouteur (le bouton), même si on a cliqué sur l'icône dedans.
      const b = e.currentTarget as HTMLElement;
      // classList.toggle(nom, condition) ajoute la classe si condition vraie, la retire sinon.
      b.classList.toggle('on', store.filters[g]);
      b.setAttribute('aria-pressed', String(store.filters[g]));
      // …puis on prévient les abonnés (la carte redessine ses épingles).
      store.emit('filters');
    },
  }, icon(ico, 16, 2.4), h('span', { class: 'fchip-label' }, label), h('span', { class: 'fchip-short' }, short));

  // Bouton « Aujourd'hui » : ne garder que les événements du jour. Même principe que filterChip.
  // Note : todayChip est utilisé dans son propre onclick ; ça marche car le clic arrive après la création.
  const todayChip = h('button', { class: 'fchip fchip-today', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Aujourd\'hui seulement', title: 'Aujourd\'hui seulement', onclick: () => {
    store.todayOnly = !store.todayOnly;
    todayChip.classList.toggle('on', store.todayOnly);
    todayChip.setAttribute('aria-pressed', String(store.todayOnly));
    store.emit('filters');
  } }, icon('sun', 16, 2.4), h('span', { class: 'fchip-today-label' }, 'Aujourd\'hui'));

  // « Blocus » : n'afficher que les blocus et les blocages (qui restent des points fixes).
  const blocusChip = h('button', { class: 'fchip fchip-today fchip-blocus', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Seulement les blocus et blocages', title: 'Seulement les blocus et blocages', onclick: () => {
    store.blocusOnly = !store.blocusOnly;
    blocusChip.classList.toggle('on', store.blocusOnly);
    blocusChip.setAttribute('aria-pressed', String(store.blocusOnly));
    store.emit('filters');
  } }, icon('flame', 16, 2.4), h('span', { class: 'fchip-today-label' }, 'Blocus'));

  // Conteneur de la carte Leaflet (l'id « map » sert au CSS).
  const mapEl = h('div', { id: 'map', 'aria-label': 'Carte' });
  // Toute la structure de l'app en un seul appel h() imbriqué : en-tête, zone principale, navigation du bas.
  const shell = h('div', { class: 'app' },
    h('header', { class: 'topbar' },
      brand(false, store.space),
      // Bascule d'espace : seulement pour qui a accès aux deux (le propriétaire, et qui il veut).
      // `cond ? élément : null` : h() ignore les enfants null, c'est la façon d'afficher conditionnellement.
      store.me.spaces.length > 1 ? h('div', { class: 'space-switch', role: 'group', 'aria-label': 'Espace' },
        SPACES.map((s) => h('button', {
          type: 'button', class: s === store.space ? 'on' : '', 'aria-pressed': String(s === store.space),
          onclick: () => store.switchSpace(s),
        }, s === 'lfi' ? 'Campagne' : 'Mvt'))) : null,
      // Onglets du haut (ordinateur) : tous sauf « Carte », toujours visible sur grand écran.
      h('nav', { class: 'toptabs', 'aria-label': 'Sections' }, nav.filter((n) => n.view !== 'map').map((n) => navBtn(n, 'toptab'))),
      h('button', { class: 'settings-btn', type: 'button', onclick: openSettings, 'aria-label': 'Réglages', title: 'Réglages' }, icon('settings', 20)),
      // Pastille avec l'initiale et le nom de l'appareil ; mène au profil/équipe.
      h('button', { class: 'me-chip', type: 'button', onclick: () => store.setView('team'), title: 'Mon accès' },
        h('span', { class: 'avatar tiny' }, store.me.name.slice(0, 1).toUpperCase()),
        h('span', { class: 'me-name' }, store.me.name)),
    ),
    h('main', { class: 'main' },
      // Panneau latéral (ordinateur) ou tiroir du bas (mobile), avec une poignée décorative.
      h('aside', { class: 'panel' }, h('div', { class: 'panel-grab' }, h('span')), panels.agenda, panels.route, panels.archive, panels.chat, panels.team),
      h('div', { class: 'map-wrap' },
        mapEl,
        h('div', { class: 'map-filters', role: 'toolbar', 'aria-label': 'Filtres' },
          filterChip('fixe', 'Points fixes', 'Fixes', mvt ? '#141414' : '#7B13D6', 'map-pin'),
          filterChip('event', 'Événements', 'Events', '#FF7A00', 'calendar'),
          filterChip('flash', 'Flash', 'Flash', '#C99700', 'zap'),
          filterChip('alert', 'Alertes', 'Alertes', '#F53B3B', 'triangle-alert'),
          mvt ? blocusChip : null,
          todayChip,
        ),
        // Bouton « Me localiser » : demande la position GPS et centre la carte.
        h('button', { class: 'map-btn locate', type: 'button', 'aria-label': 'Me localiser', title: 'Me localiser', onclick: () => locateMe() }, icon('locate-fixed', 22)),
        // Petit message affiché (via CSS) seulement en mode Trajet.
        h('div', { class: 'route-hint' }, icon('route', 16), h('span', { class: 'route-hint-text' }, 'Touche les panneaux pour les ajouter')),
        // Boutons flottants (« FAB ») : alertes rapides et ajout de point.
        h('div', { class: 'fabs' },
          h('button', { class: 'fab fab-warning', type: 'button', onclick: () => openAlertForm('warning') }, icon('triangle-alert', 20, 2.6), h('span', null, 'Warning')),
          h('button', { class: 'fab fab-danger', type: 'button', onclick: () => openAlertForm('danger') }, icon('siren', 20, 2.6), h('span', null, 'Danger')),
          h('button', { class: 'fab fab-add', type: 'button', onclick: () => newPointFlow('fixe') }, icon('plus', 26, 2.8), h('span', null, 'Ajouter')),
        ),
      ),
    ),
    // Barre de navigation du bas (mobile) : tous les onglets, y compris « Carte ».
    h('nav', { class: 'bottomnav', 'aria-label': 'Sections' }, nav.map((n) => navBtn(n, 'navbtn'))),
  );
  // On remplace le contenu de #app par la coquille complète.
  app.replaceChildren(shell);

  // La carte doit être créée APRÈS l'insertion dans la page : Leaflet a besoin de connaître la taille du conteneur.
  // onMarker sera appelé à chaque clic sur une épingle.
  initMap(mapEl, onMarker);
  // Clic sur un événement de l'agenda : sur mobile on bascule d'abord vers la carte,
  // puis on attend 280 ms (fin de l'animation du panneau) avant de centrer et d'ouvrir la fiche.
  mountAgenda(panels.agenda, (o) => {
    if (!isDesktop()) store.setView('map');
    setTimeout(() => { flyTo(o.point); openDetail(o.point); }, isDesktop() ? 0 : 280);
  });
  // Chaque module ne se monte que dans l'espace où il existe.
  if (!mvt) mountRoute(panels.route);
  if (mvt) mountArchive(panels.archive);
  if (mvt) mountChat(panels.chat);
  mountTeam(panels.team);

  // applyView : synchronise l'affichage avec store.view (onglet actif, panneau visible).
  const applyView = () => {
    const v = store.view;
    // Sur ordinateur, la carte est toujours visible : en vue « carte », le panneau de gauche montre l'agenda.
    const panelView = v === 'map' && isDesktop() ? 'agenda' : v;
    // data-view / data-panel sur la coquille : le CSS s'en sert pour afficher/masquer les zones.
    shell.dataset.view = v;
    shell.dataset.panel = panelView;
    // On parcourt tous les éléments portant data-view ; seuls les <button> (onglets) sont concernés.
    shell.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => {
      // Bouton allumé si c'est la vue courante, ou (cas ordinateur) l'onglet Agenda quand on est sur la carte.
      if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.view === v || (b.dataset.view === 'agenda' && v === 'map' && isDesktop() && b.classList.contains('toptab')));
    });
    // Allume le panneau correspondant, éteint les autres.
    Object.entries(panels).forEach(([k, el]) => el.classList.toggle('on', k === panelView));
  };
  // Recalcul à chaque changement de vue, et au redimensionnement (passage mobile ↔ ordinateur).
  store.on('view', applyView);
  window.addEventListener('resize', applyView);
  // Premier affichage.
  applyView();

  // Premier chargement des points : on cadre la carte dessus, on dessine les épingles, puis on charge les votes.
  // `void` marque une Promise volontairement non attendue.
  store.refresh().then(() => { fitToPoints(); renderMarkers(); void store.refreshVotes(); }).catch((e) => toast(e.message, 'err'));
  // Flux temps réel (SSE).
  connectStream();
  // Filet de sécurité : rechargement complet toutes les 5 minutes (5 × 60 000 ms), au cas où un message SSE serait perdu.
  setInterval(() => store.refresh().catch(() => {}), 5 * 60_000);
  // Quand on revient sur l'onglet/l'app (téléphone sorti de veille), on recharge aussitôt.
  // `cond && action()` : n'exécute l'action que si la condition est vraie.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && store.refresh().catch(() => {}));
  // Fenêtre d'astuces au premier lancement dans cet espace.
  welcome();
  // invalidateSize demande à Leaflet de remesurer son conteneur (sa taille finale n'est connue qu'après la mise en page).
  setTimeout(() => getMap().invalidateSize(), 100);
}

/**
 * Clic sur une épingle. Entrée : le point cliqué.
 * En mode Trajet, un panneau « routable » s'ajoute/se retire du trajet au lieu d'ouvrir sa fiche.
 */
function onMarker(p: Point) {
  if (store.view === 'route' && TYPES[p.type].routable) {
    toggleInRoute(p);
    return;
  }
  openDetail(p);
}

/**
 * Lit le JSON d'un message SSE sans jamais planter : un message mal formé donne un objet vide
 * (avant, une exception dans l'écouteur faisait perdre ce message et ceux de la même rafale).
 */
function readEvent<T>(ev: Event): Partial<T> {
  try { return JSON.parse((ev as MessageEvent).data || '{}') as Partial<T>; } catch { return {}; }
}

/** Délai avant la prochaine tentative de reconnexion (augmente à chaque échec, plafonné à 30 s). */
let retryDelay = 1000;

/**
 * Ouvre la connexion temps réel avec le serveur (Server-Sent Events).
 * Le serveur envoie des événements nommés (points, votes, archive, chat, revoked) ;
 * on les écoute avec addEventListener(nom, ...).
 *
 * Reconnexion : EventSource se reconnecte tout seul après une simple coupure réseau, MAIS il
 * abandonne définitivement si le serveur répond une erreur (ex. 502 du proxy pendant une mise à
 * jour). Avant, le direct s'arrêtait alors jusqu'au rechargement de la page. Maintenant, si la
 * connexion est fermée pour de bon (readyState CLOSED), on en rouvre une nouvelle après un délai
 * croissant (1 s, 2 s, 4 s… 30 s max), et on recharge les données au retour pour ne rien rater.
 */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => {
    // Connexion (re)établie : on remet le délai à zéro et on rattrape ce qui a pu être manqué.
    if (retryDelay > 1000) { void store.refresh().catch(() => {}); void store.refreshVotes(); }
    retryDelay = 1000;
  });
  es.addEventListener('error', () => {
    // CONNECTING : le navigateur réessaie déjà tout seul, on le laisse faire.
    if (es.readyState !== EventSource.CLOSED) return;
    es.close();
    const wait = retryDelay;
    retryDelay = Math.min(retryDelay * 2, 30_000);
    // Avant de rouvrir, on vérifie que l'accès est toujours valable : un appareil révoqué
    // (réponse 401) recharge la page, qui affichera l'écran public.
    window.setTimeout(() => {
      api.me().then(() => connectStream()).catch((e) => {
        if ((e as ApiError).status === 401) location.reload();
        else connectStream();
      });
    }, wait);
  });
  // Identifiant du minuteur de « debounce » (voir plus bas).
  let t: number | undefined;
  es.addEventListener('points', (ev) => {
    // ev.data est du texte JSON envoyé par le serveur ; readEvent le transforme en objet (sans planter).
    // Le type décrit les champs possibles (tous optionnels) : TypeScript ne vérifie rien à l'exécution.
    const data = readEvent<{ id: string; by: string; action: string; type: string; title: string; flash: boolean; startsAt: number; space: string }>(ev);
    // Toucher la notification : on montre le point sur la carte et on ouvre sa fiche.
    const show = data.id ? async () => {
      let p = store.get(data.id!);
      // Point pas encore connu localement (création très récente) : on recharge, puis on réessaie.
      if (!p) { await store.refresh().catch(() => {}); p = store.get(data.id!); }
      if (!p) return toast('Ce point n\'existe plus.', 'info');
      store.setView('map');
      // Zoom 17 = niveau rue.
      flyTo(p, 17);
      openDetail(p);
    } : undefined;
    // « Debounce » : si plusieurs messages arrivent en rafale, on annule le rechargement prévu
    // et on n'en fait qu'un seul, 300 ms après le dernier message.
    clearTimeout(t);
    t = window.setTimeout(() => store.refresh().catch(() => {}), 300);
    // Ma propre action : pas de notification (la carte se met quand même à jour via le rechargement ci-dessus).
    if (data.by === store.me.id) return;
    if (data.space && data.space !== store.space) return; // l'autre espace : rien ici
    // On ne notifie que trois cas : création d'une alerte, création d'un flash, signalement d'un problème.
    const isAlert = data.action === 'create' && (data.type === 'warning' || data.type === 'danger' || data.type === 'police');
    const isFlash = data.action === 'create' && !!data.flash;
    const isProblem = data.action === 'problem';
    if (!isAlert && !isFlash && !isProblem) return;
    // Fonction async exécutée immédiatement (IIFE) : l'écouteur lui-même n'a pas à attendre.
    void (async () => {
      // Suis-je assez près (ou concerné·e) pour être prévenu·e ?
      const near = await shouldNotify(data.id);
      if (!near.ok) return;
      // Texte « · à N min à pied », arrondi et au minimum 1 min ; vide si la position est inconnue.
      const away = near.minutes != null ? ` · à ${Math.max(1, Math.round(near.minutes))} min à pied` : '';
      // Chaque notification porte l'icône de ce qu'elle signale (pas d'emoji).
      if (isAlert) {
        // toast(message, genre, durée en ms, icône, action au clic).
        if (data.type === 'police') toast(`Police / CRS signalée${away}`, 'police', 8000, 'police', show);
        else if (data.type === 'danger') toast(`Danger signalé${away}`, 'err', 8000, 'siren', show);
        else toast(`Warning signalé${away}`, 'warning', 8000, 'triangle-alert', show);
        // Vibration du téléphone : [vibre 200 ms, pause 100, vibre 200]. Le « ?. » ignore les appareils sans vibreur (iPhone).
        navigator.vibrate?.([200, 100, 200]);
      } else if (isFlash) {
        // Flash qui commence dans moins d'une minute (ou sans heure) : « maintenant », sinon l'heure de début.
        const when = !data.startsAt || data.startsAt <= Date.now() + 60_000 ? 'maintenant' : `à ${time(data.startsAt)}`;
        toast(`Flash : « ${data.title ?? 'événement'} » ${when}${away}`, 'flash', 8000, 'zap', show);
        navigator.vibrate?.([120, 60, 120, 60, 120]);
      } else {
        toast(`Problème signalé : « ${data.title ?? 'un point'} »${away}`, 'err', 8000, 'circle-alert', show);
        navigator.vibrate?.([200, 100, 200]);
      }
    })();
  });
  // Votes : participation et résultats en direct.
  // Un vote a changé : on prévient les abonnés et on recharge la liste des votes ouverts.
  es.addEventListener('votes', () => { store.emit('votes'); void store.refreshVotes(); });
  // L'archive a changé : le module archive se rechargera.
  es.addEventListener('archive', () => store.emit('archive'));
  // Chat : on ne reçoit qu'un signal (le contenu est chiffré) ; petite notification si on n'est pas dans le chat.
  es.addEventListener('chat', (ev) => {
    store.emit('chat');
    const d = readEvent<{ kind: string; by: string }>(ev);
    // Notification seulement si : nouveau message, d'une autre personne, chat non affiché, et notifications non désactivées (-1).
    if (d.kind === 'message' && d.by !== store.me.id && store.view !== 'chat' && notifRadius() >= 0) {
      toast('Nouveau message dans le chat', 'info', 5000, 'message-circle', () => store.setView('chat'));
    }
  });
  // Mon accès a été retiré : on recharge, boot() affichera la page publique.
  es.addEventListener('revoked', () => location.reload());
}

/**
 * Faut-il me notifier ? (Sur la carte, le point s'affiche et clignote quand même pour tout le monde.)
 * - Blocage rattaché à un blocus : toujours si je suis concerné·e par ce blocus
 *   (inscrit·e, organisateur·rice, auteur·rice du blocage).
 * - Sinon : seulement si je suis à moins de N minutes à pied (réglage, 15 min par défaut).
 * - Position inconnue : on prévient quand même (mieux vaut une notif de trop qu'une alerte ratée).
 */
// Entrée : l'id du point concerné (optionnel). Sortie : ok (notifier ?) et, si connue, la distance en minutes.
async function shouldNotify(pointId?: string): Promise<{ ok: boolean; minutes?: number }> {
  // On cherche le point localement ; s'il manque, on recharge une fois depuis le serveur.
  let p = pointId ? store.get(pointId) : undefined;
  if (pointId && !p) { await store.refresh().catch(() => {}); p = store.get(pointId); }
  const limit = notifRadius();
  if (limit < 0) return { ok: false }; // « Aucune » : plus aucune notification
  if (!p) return { ok: !pointId }; // point introuvable dans l'espace en cours : pas de notification
  const me = store.me.id;
  // Cas particulier : un blocage rattaché à un blocus. Si je participe au blocus, l'ai créé,
  // ou ai créé ce blocage, je suis prévenu·e quelle que soit la distance.
  if (p.type === 'blocage' && p.parentId) {
    const blocus = store.get(p.parentId);
    if (blocus && (blocus.createdBy === me || p.createdBy === me || blocus.participants.some((x) => x.id === me))) return { ok: true };
  }
  // Position sans jamais afficher de demande d'autorisation (voir geo.ts) ; null si inconnue.
  const pos = await quietPosition();
  if (!pos) return { ok: true };
  // Estimation : distance à vol d'oiseau × 1,3 (détours des rues), à 4,5 km/h.
  const minutes = walkMinutes(pos, p);
  // limit === 0 signifie « Partout » : toujours notifier.
  return { ok: limit === 0 || minutes <= limit, minutes };
}

// ---------- Réglages (propres à cet appareil) ----------

// Clé localStorage du réglage (préfixée « terrain: » pour éviter les collisions avec d'autres données).
const RADIUS_KEY = 'terrain:notif-minutes';
// Valeurs proposées, dans l'ordre d'affichage.
const RADIUS_CHOICES = [5, 15, 30, 60, 0, -1]; // 0 = partout, -1 = aucune

/** Distance max (en minutes à pied) pour être notifié·e. 0 = partout, -1 = aucune. 15 par défaut. */
function notifRadius(): number {
  try {
    // Number(null) vaut 0 : d'où la vérification séparée « la clé existe bien » ci-dessous,
    // sinon une absence de réglage serait lue comme « Partout ».
    const v = Number(localStorage.getItem(RADIUS_KEY));
    // Valeur inconnue (ancienne version, saisie manuelle) : on retombe sur 15.
    return RADIUS_CHOICES.includes(v) && localStorage.getItem(RADIUS_KEY) !== null ? v : 15;
  } catch { return 15; }
}

// Fenêtre « Réglages » (rayon de notification). Le choix est enregistré immédiatement, sans bouton Valider.
function openSettings() {
  const hint = h('p', { class: 'field-hint' });
  // explain(v) met à jour le texte d'aide sous les choix. L'affectation entre parenthèses renvoie aussi la valeur.
  const explain = (v: number) => (hint.textContent = v < 0
    ? 'Tu ne recevras plus aucune notification. Tout reste visible sur la carte.'
    : v === 0
      ? 'Tu seras prévenu·e de tout, où que tu sois.'
      : `Tu seras prévenu·e seulement si c'est à moins de ${v} min à pied de toi.`);
  // Texte initial selon le réglage actuel.
  explain(notifRadius());
  openSheet({
    title: 'Réglages',
    body: h('div', { class: 'form' },
      h('div', { class: 'section-title' }, icon('bell', 18), 'Notifications'),
      h('p', { class: 'muted' }, 'Alertes (warning, danger, police), flashs et problèmes : me prévenir quand c\'est à moins de…'),
      // Chaque valeur devient une pastille avec son libellé ; le 3e argument est la valeur cochée,
      // le 4e la fonction appelée au changement (sauvegarde + mise à jour du texte).
      chips(RADIUS_CHOICES.map((v) => ({ value: v, label: v < 0 ? 'Aucune' : v === 0 ? 'Partout' : v === 60 ? '1 h à pied' : `${v} min à pied` })), notifRadius(), (v) => {
        try { localStorage.setItem(RADIUS_KEY, String(v)); } catch { /* ignore */ }
        explain(v);
      }),
      hint,
      h('p', { class: 'field-hint' }, 'Les points restent visibles sur la carte pour tout le monde. Pour un blocus auquel tu participes, tu es toujours prévenu·e des problèmes sur ses blocages. Si ta position est inconnue, tu es prévenu·e quand même.'),
    ),
  });
}

/**
 * Fenêtre d'astuces au premier lancement, une fois par espace et par appareil.
 * Le drapeau « terrain:welcomed:<espace> » dans localStorage retient qu'elle a déjà été vue.
 */
function welcome() {
  const key = `terrain:welcomed:${store.space}`;
  // Déjà vue → on sort ; sinon on note qu'elle est vue. Stockage indisponible → on ne l'affiche pas
  // (sinon elle reviendrait à chaque lancement).
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { return; }
  const mvt = store.space === 'mvt';
  // Petite fabrique pour une ligne d'astuce (icône colorée + titre + texte).
  const tip = (ico: string, cls: string, title: string, text: string) => h('li', { class: 'tip' }, h('span', { class: `tip-ico ${cls}` }, icon(ico, 20)), h('div', null, h('strong', null, title), h('span', null, text)));
  // On garde la poignée `s` pour que le bouton du bas puisse fermer la fenêtre.
  // (s est utilisé dans le onclick du footer : ça marche car le clic arrive après l'affectation.)
  const s = openSheet({
    title: `Salut ${store.me.name} !`,
    body: h('div', null,
      store.me.spaces.length > 1 ? h('p', { class: 'muted' }, `Tu es dans l'espace ${SPACE_LABEL[store.space]}. Le bouton Campagne / Mvt en haut permet de changer.`) : null,
      h('ul', { class: 'tips' },
        mvt
          ? tip('plus', 'tip-add', 'Ajouter un point', 'Blocus, blocage, AG, rassemblement, dépôt de matériel… vise l\'endroit sur la carte, puis remplis la fiche.')
          : tip('plus', 'tip-add', 'Ajouter un point', 'Panneau, AG, tractage, local… vise l\'endroit sur la carte, puis remplis la fiche.'),
        tip('triangle-alert', 'tip-warning', 'Warning & Danger', mvt
          ? 'Deux boutons pour signaler un problème en 2 gestes, et la police / CRS depuis Danger. L\'alerte disparaît toute seule.'
          : 'Deux boutons pour signaler un problème en 2 gestes. L\'alerte disparaît toute seule.'),
        tip('calendar-days', 'tip-agenda', 'Agenda', 'Tous les événements de la semaine, avec leurs horaires.'),
        mvt
          ? tip('flame', 'tip-route', 'Blocus', 'Le RDV, puis les blocages rattachés : qui tient quoi, et les problèmes en direct.')
          : tip('route', 'tip-route', 'Trajet de collage', 'Choisis les panneaux, l\'app calcule le chemin le plus court et l\'ouvre dans Google Maps.'),
      ),
      h('p', { class: 'muted' }, 'Astuce : ajoute l\'app à ton écran d\'accueil (menu du navigateur → « Sur l\'écran d\'accueil »).'),
    ),
    footer: h('button', { class: 'btn btn-primary btn-block', onclick: () => s.close() }, 'C\'est parti'),
  });
}

// Un lien d'invitation ouvert alors que l'app est déjà affichée : on relance le démarrage.
// « hashchange » se déclenche quand la partie # de l'URL change sans rechargement.
window.addEventListener('hashchange', () => location.hash.startsWith('#/join/') && location.reload());

// Lancement ! (exécuté dès le chargement du module)
boot();
