/**
 * home.ts : la page publique, visible SANS compte (vitrine de l'espace Mouvement).
 *
 * Qui l'appelle ? main.ts, dans lockedScreen(), quand l'appareil n'est pas inscrit.
 * publicHome() renvoie un élément que main.ts place dans #app.
 *
 * Contenu : votes ouverts à tous, prochaines AG (liste + mini-carte Leaflet), archive publique,
 * et deux boutons en haut : « Code de vote » et « Accès membres » (explications seulement).
 *
 * Notions :
 * - Les trois blocs se chargent en parallèle : on affiche d'abord « Chargement… », puis chaque
 *   fonction load*() remplace le contenu de son bloc quand la réponse du serveur arrive.
 * - Ici, aucune donnée de l'espace privé : uniquement les routes publiques de l'API.
 */
// Leaflet, pour la petite carte des AG.
import L from 'leaflet';
import { api, ApiError } from './api';
import { openSheet } from './sheet';
import { addBasemap } from './basemap';
// Briques réutilisées depuis le module archive : une carte d'élément et une frise chronologique.
import { itemCard, timeline } from './archive';
import { choicePicker } from './votes';
import { h, icon, clear, toast, dayLong, time } from './ui';
import type { PublicAg, Vote } from '../../shared/model';

/*
 * Page d'accueil publique (sans compte), dans le style sombre et neutre de l'accès :
 * - les votes ouverts à tous (AG annoncée publiquement, « peu importe la distance ») : on vote sans code ;
 * - les prochaines AG annoncées, sur une carte ;
 * - l'archive publique.
 * L'accès membres (sur invitation) et le code de vote restent accessibles en haut de la page.
 */

// Nombre d'éléments d'archive montrés avant le bouton « Voir tout ».
const ARCHIVE_PREVIEW = 6;

// Ce que main.ts fournit à la page : la fonction à appeler pour aller vers l'écran « code de vote ».
export interface HomeActions { onCode: () => void }

/**
 * Construit la page publique. Entrées : le logo (déjà construit par main.ts) et les actions.
 * Sortie : l'élément racine de la page. Les chargements démarrent avant même que la page soit affichée.
 */
export function publicHome(brand: HTMLElement, actions: HomeActions): HTMLElement {
  // Trois boîtes avec un message d'attente ; elles seront remplies par loadVotes / loadAgs / loadArchive.
  const votesBox = h('div', { class: 'home-votes' }, h('p', { class: 'home-loading' }, 'Chargement…'));
  const agsBox = h('div', { class: 'home-ags' }, h('p', { class: 'home-loading' }, 'Chargement…'));
  const archiveBox = h('div', { class: 'home-archive' }, h('p', { class: 'home-loading' }, 'Chargement…'));

  // Style Mouvement : bandeau noir à liseré rouge, page « papier », titres condensés.
  const page = h('div', { class: 'home-page' },
    h('header', { class: 'home-band' }, h('div', { class: 'home-top' },
      brand,
      h('div', { class: 'home-top-actions' },
        h('button', { class: 'btn btn-small btn-band', type: 'button', onclick: actions.onCode, 'aria-label': 'J\'ai un code de vote', title: 'J\'ai un code de vote' }, icon('vote', 16), h('span', null, 'Code de vote')),
        h('button', { class: 'btn btn-small btn-band-solid', type: 'button', onclick: openMembers, 'aria-label': 'Accès membres', title: 'Accès membres' }, icon('lock', 16), h('span', null, 'Accès membres')),
      ),
    )),
    // Contenu principal (l'indentation ici n'est pas tout à fait alignée, mais c'est bien un enfant de .home-page).
    h('main', { class: 'home' },
    h('section', { class: 'home-hero' },
      h('h1', { class: 'home-title' }, 'AG, votes', h('br'), 'et archives'),
      h('p', { class: 'home-lead' }, 'Les assemblées générales annoncées, les votes ouverts à tous et les documents publics. Pas besoin de compte pour suivre ni pour voter (les votes sans compte sont indicatifs).'),
    ),
    section('vote', 'Votes en cours', votesBox),
    section('users', 'Prochaines AG', agsBox),
    section('archive', 'Archive publique', archiveBox),
    h('footer', { class: 'home-foot' },
      h('p', null, 'Tu as un code à 5 chiffres affiché pendant une AG ?'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: actions.onCode }, icon('vote', 18), 'J\'ai un code de vote'),
    ),
    ),
  );

  // Lancement des trois chargements sans les attendre (`void` = Promise volontairement ignorée) :
  // la page s'affiche tout de suite, les blocs se remplissent au fur et à mesure.
  void loadVotes(votesBox);
  void loadAgs(agsBox);
  void loadArchive(archiveBox);
  return page;
}

// Une section avec titre (icône + texte) et son contenu.
const section = (ico: string, title: string, body: HTMLElement) =>
  h('section', { class: 'home-section' }, h('h2', { class: 'home-h2' }, icon(ico, 20), title), body);

// Message « rien à afficher » (ou erreur), avec une icône grisée.
const emptyNote = (ico: string, text: string) => h('div', { class: 'home-empty' }, icon(ico, 26, 1.6), h('span', null, text));

/** Accès membres : comment entrer (sur invitation, par QR code). */
function openMembers() {
  // Petite fabrique d'étape numérotée (1, 2, 3).
  const step = (n: string, t: string) => h('div', { class: 'splash-step' }, h('span', null, n), h('p', null, t));
  // openSheet ouvre un panneau modal (glisse du bas sur mobile).
  openSheet({
    title: 'Accès membres',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'L\'espace membres est privé. Pour entrer, demande à une personne qui y a déjà accès de te montrer son QR code, puis scanne-le avec l\'appareil photo de ton téléphone.'),
      h('div', { class: 'splash-steps home-steps' },
        step('1', 'Une personne du groupe génère un QR code'),
        step('2', 'Tu le scannes avec ton téléphone'),
        step('3', 'Tu indiques ton prénom : c\'est parti')),
    ),
  });
}

// ---------- Votes ouverts à tous (sans code) ----------

// Charge les votes ouverts à tous et remplit la boîte. Entrée : la boîte à remplir.
async function loadVotes(box: HTMLElement) {
  try {
    const { votes } = await api.openVotes();
    // `return void clear(...)` : affiche le message vide et sort de la fonction (void = on ne renvoie rien d'utile).
    if (!votes.length) return void clear(box, emptyNote('vote', 'Aucun vote ouvert à tous pour l\'instant.'));
    clear(box, ...votes.map(({ vote, agTitle }) => voteCard(vote, agTitle)));
  } catch (e) {
    // Erreur (réseau, serveur) : on affiche son message dans la boîte au lieu de rester sur « Chargement… ».
    clear(box, emptyNote('circle-alert', (e as ApiError).message));
  }
}

/**
 * Carte d'un vote. Entrées : le vote et le titre de son AG. Sortie : un <article>.
 * La carte se redessine elle-même (fonction render interne) après qu'on a voté.
 */
function voteCard(v: Vote, agTitle: string): HTMLElement {
  const card = h('article', { class: 'home-card home-vote' });
  const render = (vote: Vote) => {
    // myChoice est renvoyé par le serveur : le choix de CE navigateur s'il a déjà voté (reconnu par cookie).
    const done = vote.myChoice != null;
    clear(card,
      h('div', { class: 'home-vote-head' },
        h('span', { class: 'home-meta' }, agTitle),
        // L'attribut title explique pourquoi le vote est seulement indicatif (affiché au survol).
        h('span', { class: 'home-badge', title: 'Sans compte, un même appareil peut revoter avec un autre navigateur : le résultat donne une tendance, pas une décision.' }, 'Vote indicatif')),
      h('h3', { class: 'home-q' }, vote.question),
      done
        // Déjà voté : on rappelle le choix (texte échappé par h(), aucun risque même si l'option contient du HTML).
        ? h('div', { class: 'home-voted' }, icon('check', 18), h('span', null, `Tu as voté « ${vote.options[vote.myChoice!]} ». Les résultats s'afficheront à la clôture.`))
        // Pas encore voté : un bouton par option ; i = numéro de l'option, envoyé au serveur.
        // Choisir, puis confirmer (choicePicker, votes.ts) : un toucher ne vote plus directement.
        : h('div', { class: 'home-choices' }, choicePicker(vote.options, 'btn btn-yellow', async (i) => {
            try { render((await api.openBallot(vote.id, i)).vote); toast('A voté !', 'ok', 3500, 'vote'); }
            catch (err) { toast((err as ApiError).message, 'err', 5000); throw err; }
          })),
      h('span', { class: 'home-fine' }, `${vote.total} vote${vote.total > 1 ? 's' : ''} · vote indicatif, ouvert à tous sans compte · choix anonyme`),
    );
  };
  // Premier dessin.
  render(v);
  return card;
}

// ---------- Prochaines AG ----------

// Charge les AG annoncées publiquement : une mini-carte puis la liste.
async function loadAgs(box: HTMLElement) {
  try {
    const { ags } = await api.publicAgs();
    if (!ags.length) return void clear(box, emptyNote('users', 'Aucune AG annoncée pour l\'instant.'));
    // Le conteneur de la carte doit être dans la page AVANT de créer la carte Leaflet (elle mesure sa taille).
    const mapEl = h('div', { class: 'home-map', 'aria-label': 'Carte des AG' });
    clear(box, mapEl, h('ul', { class: 'home-ag-list' }, ags.map(agCard)));
    // requestAnimationFrame : attendre la prochaine image affichée, pour que la mise en page soit faite.
    requestAnimationFrame(() => drawMap(mapEl, ags));
  } catch (e) {
    clear(box, emptyNote('circle-alert', (e as ApiError).message));
  }
}

// Une AG dans la liste : la date en gros (jour + mois abrégé), l'horaire, le titre, le lien vers le lieu.
function agCard(a: PublicAg) {
  return h('li', { class: 'home-card home-ag' },
    h('div', { class: 'home-ag-date' },
      h('strong', null, String(new Date(a.startsAt).getDate())),
      // « nov. » → « nov ».
      h('span', null, new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(a.startsAt).replace('.', ''))),
    h('div', { class: 'home-ag-main' },
      h('span', { class: 'home-meta' }, `${dayLong(a.startsAt)} · ${time(a.startsAt)} – ${time(a.endsAt)}`),
      h('h3', { class: 'home-q' }, a.title),
      a.description ? h('p', { class: 'home-desc' }, a.description) : null,
      // Lien vers OpenStreetMap centré sur le lieu. target="_blank" ouvre un nouvel onglet ;
      // rel="noopener" empêche ce nouvel onglet de contrôler le nôtre (bonne pratique de sécurité).
      h('a', { class: 'home-link', href: `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=18/${a.lat}/${a.lng}`, target: '_blank', rel: 'noopener' }, icon('navigation', 14), 'Voir le lieu')),
  );
}

/**
 * Dessine la mini-carte des AG. Entrées : le conteneur et la liste des AG.
 */
function drawMap(el: HTMLElement, ags: PublicAg[]) {
  // Si la page a changé entre-temps (élément retiré du document), on abandonne.
  if (!el.isConnected) return;
  // scrollWheelZoom: false : la molette fait défiler la page au lieu de zoomer la carte par surprise.
  const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  void addBasemap(map, 'mvt');
  // Un rond rouge par AG. circleMarker : rayon en pixels (reste de la même taille quel que soit le zoom).
  const pts = ags.map((a) => L.circleMarker([a.lat, a.lng], { radius: 10, color: '#fff', weight: 3, fillColor: '#a30006', fillOpacity: 1 })
    // Infobulle : un élément DOM créé par h(), donc le titre (écrit par un utilisateur) est
    // toujours traité comme du texte, jamais comme du HTML.
    .bindTooltip(h('span', null, a.title), { direction: 'top' }).addTo(map));
  // featureGroup permet de calculer le rectangle englobant de tous les ronds ; pad(0.4) = 40 % de marge.
  map.fitBounds(L.featureGroup(pts).getBounds().pad(0.4), { maxZoom: 16 });
}

// ---------- Archive publique ----------

// Charge l'archive publique, en affichant d'abord un aperçu limité.
async function loadArchive(box: HTMLElement) {
  try {
    const { items } = await api.publicArchive();
    if (!items.length) return void clear(box, emptyNote('archive', 'L\'archive publique est vide pour l\'instant.'));
    // render(all) : affiche tout (true) ou seulement les ARCHIVE_PREVIEW premiers (false).
    // timeline(entrées, fabrique de carte, élément de fin) vient de archive.ts ; editable: false = lecture seule.
    const render = (all: boolean) => clear(box,
      timeline((all ? items : items.slice(0, ARCHIVE_PREVIEW)).map((item) => ({ date: item.date, item })), (e) => itemCard(e.item!, { editable: false }), h('span')),
      // Bouton « Voir tout » seulement s'il reste des éléments cachés ; il redessine en mode complet.
      !all && items.length > ARCHIVE_PREVIEW
        ? h('button', { class: 'btn btn-light home-more', type: 'button', onclick: () => render(true) }, `Voir tout (${items.length})`)
        : null);
    render(false);
  } catch (e) {
    clear(box, emptyNote('circle-alert', (e as ApiError).message));
  }
}
