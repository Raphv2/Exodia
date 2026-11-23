import L from 'leaflet';
import { api, ApiError } from './api';
import { openSheet } from './sheet';
import { addBasemap } from './basemap';
import { itemCard, timeline } from './archive';
import { h, icon, clear, toast, dayLong, time } from './ui';
import type { PublicAg, Vote } from '../../shared/model';

/*
 * Page d'accueil publique (sans compte), dans le style sombre et neutre de l'accès :
 * - les votes ouverts à tous (AG annoncée publiquement, « peu importe la distance ») : on vote sans code ;
 * - les prochaines AG annoncées, sur une carte ;
 * - l'archive publique.
 * L'accès membres (sur invitation) et le code de vote restent accessibles en haut de la page.
 */

const ARCHIVE_PREVIEW = 6;

export interface HomeActions { onCode: () => void }

export function publicHome(brand: HTMLElement, actions: HomeActions): HTMLElement {
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
    h('main', { class: 'home' },
    h('section', { class: 'home-hero' },
      h('h1', { class: 'home-title' }, 'AG, votes', h('br'), 'et archives'),
      h('p', { class: 'home-lead' }, 'Les assemblées générales annoncées, les votes ouverts à tous et les documents publics. Pas besoin de compte pour suivre ni pour voter.'),
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

  void loadVotes(votesBox);
  void loadAgs(agsBox);
  void loadArchive(archiveBox);
  return page;
}

const section = (ico: string, title: string, body: HTMLElement) =>
  h('section', { class: 'home-section' }, h('h2', { class: 'home-h2' }, icon(ico, 20), title), body);

const emptyNote = (ico: string, text: string) => h('div', { class: 'home-empty' }, icon(ico, 26, 1.6), h('span', null, text));

/** Accès membres : comment entrer (sur invitation, par QR code). */
function openMembers() {
  const step = (n: string, t: string) => h('div', { class: 'splash-step' }, h('span', null, n), h('p', null, t));
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

async function loadVotes(box: HTMLElement) {
  try {
    const { votes } = await api.openVotes();
    if (!votes.length) return void clear(box, emptyNote('vote', 'Aucun vote ouvert à tous pour l\'instant.'));
    clear(box, ...votes.map(({ vote, agTitle }) => voteCard(vote, agTitle)));
  } catch (e) {
    clear(box, emptyNote('circle-alert', (e as ApiError).message));
  }
}

function voteCard(v: Vote, agTitle: string): HTMLElement {
  const card = h('article', { class: 'home-card home-vote' });
  const render = (vote: Vote) => {
    const done = vote.myChoice != null;
    clear(card,
      h('span', { class: 'home-meta' }, agTitle),
      h('h3', { class: 'home-q' }, vote.question),
      done
        ? h('div', { class: 'home-voted' }, icon('check', 18), h('span', null, `Tu as voté « ${vote.options[vote.myChoice!]} ». Les résultats s'afficheront à la clôture.`))
        : h('div', { class: 'home-choices' }, vote.options.map((o, i) => h('button', { class: 'btn btn-yellow', type: 'button', onclick: async (e: Event) => {
            (e.currentTarget as HTMLButtonElement).disabled = true;
            try { render((await api.openBallot(vote.id, i)).vote); toast('A voté !', 'ok', 3500, 'vote'); }
            catch (err) { toast((err as ApiError).message, 'err', 5000); render(vote); }
          } }, o))),
      h('span', { class: 'home-fine' }, `${vote.total} vote${vote.total > 1 ? 's' : ''} · un seul vote par appareil · choix anonyme`),
    );
  };
  render(v);
  return card;
}

// ---------- Prochaines AG ----------

async function loadAgs(box: HTMLElement) {
  try {
    const { ags } = await api.publicAgs();
    if (!ags.length) return void clear(box, emptyNote('users', 'Aucune AG annoncée pour l\'instant.'));
    const mapEl = h('div', { class: 'home-map', 'aria-label': 'Carte des AG' });
    clear(box, mapEl, h('ul', { class: 'home-ag-list' }, ags.map(agCard)));
    requestAnimationFrame(() => drawMap(mapEl, ags));
  } catch (e) {
    clear(box, emptyNote('circle-alert', (e as ApiError).message));
  }
}

function agCard(a: PublicAg) {
  return h('li', { class: 'home-card home-ag' },
    h('div', { class: 'home-ag-date' },
      h('strong', null, String(new Date(a.startsAt).getDate())),
      h('span', null, new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(a.startsAt).replace('.', ''))),
    h('div', { class: 'home-ag-main' },
      h('span', { class: 'home-meta' }, `${dayLong(a.startsAt)} · ${time(a.startsAt)} – ${time(a.endsAt)}`),
      h('h3', { class: 'home-q' }, a.title),
      a.description ? h('p', { class: 'home-desc' }, a.description) : null,
      h('a', { class: 'home-link', href: `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=18/${a.lat}/${a.lng}`, target: '_blank', rel: 'noopener' }, icon('navigation', 14), 'Voir le lieu')),
  );
}

function drawMap(el: HTMLElement, ags: PublicAg[]) {
  if (!el.isConnected) return;
  const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  void addBasemap(map, 'mvt');
  const pts = ags.map((a) => L.circleMarker([a.lat, a.lng], { radius: 10, color: '#fff', weight: 3, fillColor: '#a30006', fillOpacity: 1 })
    .bindTooltip(a.title.replace(/[<>&]/g, ''), { direction: 'top' }).addTo(map));
  map.fitBounds(L.featureGroup(pts).getBounds().pad(0.4), { maxZoom: 16 });
}

// ---------- Archive publique ----------

async function loadArchive(box: HTMLElement) {
  try {
    const { items } = await api.publicArchive();
    if (!items.length) return void clear(box, emptyNote('archive', 'L\'archive publique est vide pour l\'instant.'));
    const render = (all: boolean) => clear(box,
      timeline((all ? items : items.slice(0, ARCHIVE_PREVIEW)).map((item) => ({ date: item.date, item })), (e) => itemCard(e.item!, { editable: false }), h('span')),
      !all && items.length > ARCHIVE_PREVIEW
        ? h('button', { class: 'btn btn-light home-more', type: 'button', onclick: () => render(true) }, `Voir tout (${items.length})`)
        : null);
    render(false);
  } catch (e) {
    clear(box, emptyNote('circle-alert', (e as ApiError).message));
  }
}
