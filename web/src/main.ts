import 'leaflet/dist/leaflet.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import './styles.css';

import { api, setUnauthorizedHandler, ApiError } from './api';
import { store, type View, type Group } from './store';
import { initMap, renderMarkers, locateMe, flyTo, fitToPoints, getMap } from './map';
import { openDetail } from './detail';
import { newPointFlow, openAlertForm } from './forms';
import { mountAgenda } from './agenda';
import { mountRoute, toggleInRoute } from './route';
import { mountTeam } from './team';
import { openSheet } from './sheet';
import { h, icon, toast, isDesktop, time } from './ui';
import { quietPosition, walkMinutes } from './geo';
import { chips } from './forms';
import { TYPES, type Point } from '../../shared/model';

const app = document.getElementById('app')!;

// ---------- Démarrage ----------

async function boot() {
  const join = location.hash.match(/^#\/join\/([A-Za-z0-9_-]{20,100})$/);
  let me = null;
  try {
    me = (await api.me()).device;
  } catch (e) {
    if ((e as ApiError).status !== 401) return offline((e as Error).message);
  }
  if (join) {
    history.replaceState(null, '', location.pathname); // le jeton ne reste pas dans l'historique
    if (!me) return joinScreen(join[1]);
    toast('Cet appareil a déjà accès à l\'app.', 'info');
  }
  if (!me) return lockedScreen();
  store.me = me;
  startApp();
}

function brand(big = false) {
  return h('div', { class: `brand${big ? ' brand-big' : ''}` },
    h('span', { class: 'brand-mark' }, icon('map-pin', big ? 34 : 20, 2.6)),
    h('span', { class: 'brand-text' }, h('strong', null, 'Terrain'), h('small', null, 'carte militante')),
  );
}

function splash(...children: Node[]) {
  app.replaceChildren(h('div', { class: 'splash' }, h('div', { class: 'splash-inner' }, brand(true), ...children)));
}

function lockedScreen() {
  splash(
    h('h1', { class: 'splash-title' }, 'Accès sur invitation'),
    h('p', { class: 'splash-text' }, 'Cette app est réservée aux militant·es du groupe. Pour entrer, demande à un·e responsable de te montrer son QR code, puis scanne-le avec l\'appareil photo de ton téléphone.'),
    h('div', { class: 'splash-steps' },
      step('1', 'Un·e responsable génère un QR code'),
      step('2', 'Tu le scannes avec ton téléphone'),
      step('3', 'Tu indiques ton prénom : c\'est parti'),
    ),
  );
}

const step = (n: string, t: string) => h('div', { class: 'splash-step' }, h('span', null, n), h('p', null, t));

function joinScreen(token: string) {
  const input = h('input', { class: 'input input-big', type: 'text', maxlength: '40', placeholder: 'Ton prénom ou pseudo', autocomplete: 'off', required: true }) as HTMLInputElement;
  const btn = h('button', { class: 'btn btn-yellow btn-big btn-block', type: 'submit' }, h('span', null, 'Rejoindre'), icon('arrow-right', 22)) as HTMLButtonElement;
  const form = h('form', { class: 'join-form', onsubmit: async (e: Event) => {
    e.preventDefault();
    if (!input.value.trim()) return input.focus();
    btn.disabled = true;
    try {
      store.me = (await api.claim(token, input.value.trim())).device;
      try { localStorage.removeItem('terrain:welcomed'); } catch { /* ignore */ }
      startApp();
    } catch (err) {
      btn.disabled = false;
      toast((err as Error).message, 'err', 6000);
    }
  } }, h('label', { class: 'sr-only' }, 'Prénom ou pseudo'), input, btn);
  splash(
    h('h1', { class: 'splash-title' }, 'Bienvenue dans l\'équipe'),
    h('p', { class: 'splash-text' }, 'Tu as été invité·e. Choisis le nom sous lequel l\'équipe te verra : un prénom ou un pseudo suffit.'),
    form,
    h('p', { class: 'splash-fine' }, 'Cet appareil sera mémorisé : pas de mot de passe à retenir.'),
  );
  setTimeout(() => input.focus(), 100);
}

function offline(msg: string) {
  splash(
    h('h1', { class: 'splash-title' }, 'Connexion impossible'),
    h('p', { class: 'splash-text' }, msg),
    h('button', { class: 'btn btn-yellow btn-big', onclick: () => location.reload() }, 'Réessayer'),
  );
}

// ---------- Application ----------

const NAV: { view: View; label: string; icon: string }[] = [
  { view: 'map', label: 'Carte', icon: 'map' },
  { view: 'agenda', label: 'Agenda', icon: 'calendar-days' },
  { view: 'route', label: 'Trajet', icon: 'route' },
  { view: 'team', label: 'Équipe', icon: 'users-round' },
];

function startApp() {
  setUnauthorizedHandler(() => location.reload());
  const teamLabel = store.me.role === 'membre' ? 'Profil' : 'Équipe';

  const navBtn = (n: (typeof NAV)[number], cls: string) => h('button', {
    class: cls, type: 'button', dataset: { view: n.view }, onclick: () => store.setView(n.view),
  }, icon(n.icon, 22), h('span', null, n.view === 'team' ? teamLabel : n.label));

  const panels = {
    agenda: h('section', { class: 'panel-view', dataset: { view: 'agenda' } }),
    route: h('section', { class: 'panel-view', dataset: { view: 'route' } }),
    team: h('section', { class: 'panel-view', dataset: { view: 'team' } }),
  };

  // Filtres de la carte : icône + texte (sur téléphone, l'icône seule).
  const filterChip = (g: Group, label: string, short: string, color: string, ico: string) => h('button', {
    class: `fchip fchip-${g}${store.filters[g] ? ' on' : ''}`, type: 'button', style: { '--c': color } as Record<string, string>,
    'aria-pressed': String(store.filters[g]), 'aria-label': label, title: label,
    onclick: (e: Event) => {
      store.filters[g] = !store.filters[g];
      const b = e.currentTarget as HTMLElement;
      b.classList.toggle('on', store.filters[g]);
      b.setAttribute('aria-pressed', String(store.filters[g]));
      store.emit('filters');
    },
  }, icon(ico, 16, 2.4), h('span', { class: 'fchip-label' }, label), h('span', { class: 'fchip-short' }, short));

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

  const mapEl = h('div', { id: 'map', 'aria-label': 'Carte' });
  const shell = h('div', { class: 'app' },
    h('header', { class: 'topbar' },
      brand(),
      h('nav', { class: 'toptabs', 'aria-label': 'Sections' }, NAV.filter((n) => n.view !== 'map').map((n) => navBtn(n, 'toptab'))),
      h('button', { class: 'settings-btn', type: 'button', onclick: openSettings, 'aria-label': 'Réglages', title: 'Réglages' }, icon('settings', 20)),
      h('button', { class: 'me-chip', type: 'button', onclick: () => store.setView('team'), title: 'Mon accès' },
        h('span', { class: 'avatar tiny' }, store.me.name.slice(0, 1).toUpperCase()),
        h('span', { class: 'me-name' }, store.me.name)),
    ),
    h('main', { class: 'main' },
      h('aside', { class: 'panel' }, h('div', { class: 'panel-grab' }, h('span')), panels.agenda, panels.route, panels.team),
      h('div', { class: 'map-wrap' },
        mapEl,
        h('div', { class: 'map-filters', role: 'toolbar', 'aria-label': 'Filtres' },
          filterChip('fixe', 'Points fixes', 'Fixes', '#7B13D6', 'map-pin'),
          filterChip('event', 'Événements', 'Events', '#FF7A00', 'calendar'),
          filterChip('flash', 'Flash', 'Flash', '#C99700', 'zap'),
          filterChip('alert', 'Alertes', 'Alertes', '#F53B3B', 'triangle-alert'),
          todayChip,
          blocusChip,
        ),
        h('button', { class: 'map-btn locate', type: 'button', 'aria-label': 'Me localiser', title: 'Me localiser', onclick: () => locateMe() }, icon('locate-fixed', 22)),
        h('div', { class: 'route-hint' }, icon('route', 16), h('span', { class: 'route-hint-text' }, 'Touche les panneaux pour les ajouter')),
        h('div', { class: 'fabs' },
          h('button', { class: 'fab fab-warning', type: 'button', onclick: () => openAlertForm('warning') }, icon('triangle-alert', 20, 2.6), h('span', null, 'Warning')),
          h('button', { class: 'fab fab-danger', type: 'button', onclick: () => openAlertForm('danger') }, icon('siren', 20, 2.6), h('span', null, 'Danger')),
          h('button', { class: 'fab fab-add', type: 'button', onclick: () => newPointFlow('fixe') }, icon('plus', 26, 2.8), h('span', null, 'Ajouter')),
        ),
      ),
    ),
    h('nav', { class: 'bottomnav', 'aria-label': 'Sections' }, NAV.map((n) => navBtn(n, 'navbtn'))),
  );
  app.replaceChildren(shell);

  initMap(mapEl, onMarker);
  mountAgenda(panels.agenda, (o) => {
    if (!isDesktop()) store.setView('map');
    setTimeout(() => { flyTo(o.point); openDetail(o.point); }, isDesktop() ? 0 : 280);
  });
  mountRoute(panels.route);
  mountTeam(panels.team);

  const applyView = () => {
    const v = store.view;
    const panelView = v === 'map' && isDesktop() ? 'agenda' : v;
    shell.dataset.view = v;
    shell.dataset.panel = panelView;
    shell.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => {
      if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.view === v || (b.dataset.view === 'agenda' && v === 'map' && isDesktop() && b.classList.contains('toptab')));
    });
    Object.entries(panels).forEach(([k, el]) => el.classList.toggle('on', k === panelView));
  };
  store.on('view', applyView);
  window.addEventListener('resize', applyView);
  applyView();

  store.refresh().then(() => { fitToPoints(); renderMarkers(); }).catch((e) => toast(e.message, 'err'));
  connectStream();
  setInterval(() => store.refresh().catch(() => {}), 5 * 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && store.refresh().catch(() => {}));
  welcome();
  setTimeout(() => getMap().invalidateSize(), 100);
}

function onMarker(p: Point) {
  if (store.view === 'route' && TYPES[p.type].routable) {
    toggleInRoute(p);
    return;
  }
  openDetail(p);
}

function connectStream() {
  const es = new EventSource('/api/stream');
  let t: number | undefined;
  es.addEventListener('points', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data || '{}') as { id?: string; by?: string; action?: string; type?: string; title?: string; flash?: boolean; startsAt?: number };
    // Toucher la notification : on montre le point sur la carte et on ouvre sa fiche.
    const show = data.id ? async () => {
      let p = store.get(data.id!);
      if (!p) { await store.refresh().catch(() => {}); p = store.get(data.id!); }
      if (!p) return toast('Ce point n\'existe plus.', 'info');
      store.setView('map');
      flyTo(p, 17);
      openDetail(p);
    } : undefined;
    clearTimeout(t);
    t = window.setTimeout(() => store.refresh().catch(() => {}), 300);
    if (data.by === store.me.id) return;
    const isAlert = data.action === 'create' && (data.type === 'warning' || data.type === 'danger' || data.type === 'police');
    const isFlash = data.action === 'create' && !!data.flash;
    const isProblem = data.action === 'problem';
    if (!isAlert && !isFlash && !isProblem) return;
    void (async () => {
      const near = await shouldNotify(data.id);
      if (!near.ok) return;
      const away = near.minutes != null ? ` · à ${Math.max(1, Math.round(near.minutes))} min à pied` : '';
      // Chaque notification porte l'icône de ce qu'elle signale (pas d'emoji).
      if (isAlert) {
        if (data.type === 'police') toast(`Police / CRS signalée${away}`, 'police', 8000, 'police', show);
        else if (data.type === 'danger') toast(`Danger signalé${away}`, 'err', 8000, 'siren', show);
        else toast(`Warning signalé${away}`, 'warning', 8000, 'triangle-alert', show);
        navigator.vibrate?.([200, 100, 200]);
      } else if (isFlash) {
        const when = !data.startsAt || data.startsAt <= Date.now() + 60_000 ? 'maintenant' : `à ${time(data.startsAt)}`;
        toast(`Flash : « ${data.title ?? 'événement'} » ${when}${away}`, 'flash', 8000, 'zap', show);
        navigator.vibrate?.([120, 60, 120, 60, 120]);
      } else {
        toast(`Problème signalé : « ${data.title ?? 'un point'} »${away}`, 'err', 8000, 'circle-alert', show);
        navigator.vibrate?.([200, 100, 200]);
      }
    })();
  });
  es.addEventListener('revoked', () => location.reload());
}

/**
 * Faut-il me notifier ? (Sur la carte, le point s'affiche et clignote quand même pour tout le monde.)
 * - Blocage rattaché à un blocus : toujours si je suis concerné·e par ce blocus
 *   (inscrit·e, organisateur·rice, auteur·rice du blocage).
 * - Sinon : seulement si je suis à moins de N minutes à pied (réglage, 15 min par défaut).
 * - Position inconnue : on prévient quand même (mieux vaut une notif de trop qu'une alerte ratée).
 */
async function shouldNotify(pointId?: string): Promise<{ ok: boolean; minutes?: number }> {
  let p = pointId ? store.get(pointId) : undefined;
  if (pointId && !p) { await store.refresh().catch(() => {}); p = store.get(pointId); }
  const limit = notifRadius();
  if (limit < 0) return { ok: false }; // « Aucune » : plus aucune notification
  if (!p) return { ok: true };
  const me = store.me.id;
  if (p.type === 'blocage' && p.parentId) {
    const blocus = store.get(p.parentId);
    if (blocus && (blocus.createdBy === me || p.createdBy === me || blocus.participants.some((x) => x.id === me))) return { ok: true };
  }
  const pos = await quietPosition();
  if (!pos) return { ok: true };
  const minutes = walkMinutes(pos, p);
  return { ok: limit === 0 || minutes <= limit, minutes };
}

// ---------- Réglages (propres à cet appareil) ----------

const RADIUS_KEY = 'terrain:notif-minutes';
const RADIUS_CHOICES = [5, 15, 30, 60, 0, -1]; // 0 = partout, -1 = aucune

/** Distance max (en minutes à pied) pour être notifié·e. 0 = partout, -1 = aucune. 15 par défaut. */
function notifRadius(): number {
  try {
    const v = Number(localStorage.getItem(RADIUS_KEY));
    return RADIUS_CHOICES.includes(v) && localStorage.getItem(RADIUS_KEY) !== null ? v : 15;
  } catch { return 15; }
}

function openSettings() {
  const hint = h('p', { class: 'field-hint' });
  const explain = (v: number) => (hint.textContent = v < 0
    ? 'Tu ne recevras plus aucune notification. Tout reste visible sur la carte.'
    : v === 0
      ? 'Tu seras prévenu·e de tout, où que tu sois.'
      : `Tu seras prévenu·e seulement si c'est à moins de ${v} min à pied de toi.`);
  explain(notifRadius());
  openSheet({
    title: 'Réglages',
    body: h('div', { class: 'form' },
      h('div', { class: 'section-title' }, icon('bell', 18), 'Notifications'),
      h('p', { class: 'muted' }, 'Alertes (warning, danger, police), flashs et problèmes : me prévenir quand c\'est à moins de…'),
      chips(RADIUS_CHOICES.map((v) => ({ value: v, label: v < 0 ? 'Aucune' : v === 0 ? 'Partout' : v === 60 ? '1 h à pied' : `${v} min à pied` })), notifRadius(), (v) => {
        try { localStorage.setItem(RADIUS_KEY, String(v)); } catch { /* ignore */ }
        explain(v);
      }),
      hint,
      h('p', { class: 'field-hint' }, 'Les points restent visibles sur la carte pour tout le monde. Pour un blocus auquel tu participes, tu es toujours prévenu·e des problèmes sur ses blocages. Si ta position est inconnue, tu es prévenu·e quand même.'),
    ),
  });
}

function welcome() {
  try { if (localStorage.getItem('terrain:welcomed')) return; localStorage.setItem('terrain:welcomed', '1'); } catch { return; }
  const tip = (ico: string, cls: string, title: string, text: string) => h('li', { class: 'tip' }, h('span', { class: `tip-ico ${cls}` }, icon(ico, 20)), h('div', null, h('strong', null, title), h('span', null, text)));
  const s = openSheet({
    title: `Salut ${store.me.name} !`,
    body: h('div', null,
      h('ul', { class: 'tips' },
        tip('plus', 'tip-add', 'Ajouter un point', 'Panneau, AG, tractage, local… vise l\'endroit sur la carte, puis remplis la fiche.'),
        tip('triangle-alert', 'tip-warning', 'Warning & Danger', 'Deux boutons pour signaler un problème en 2 gestes. L\'alerte disparaît toute seule.'),
        tip('calendar-days', 'tip-agenda', 'Agenda', 'Tous les événements de la semaine, avec leurs horaires.'),
        tip('route', 'tip-route', 'Trajet de collage', 'Choisis les panneaux, l\'app calcule le chemin le plus court et l\'ouvre dans Google Maps.'),
      ),
      h('p', { class: 'muted' }, 'Astuce : ajoute l\'app à ton écran d\'accueil (menu du navigateur → « Sur l\'écran d\'accueil »).'),
    ),
    footer: h('button', { class: 'btn btn-primary btn-block', onclick: () => s.close() }, 'C\'est parti'),
  });
}

// Un lien d'invitation ouvert alors que l'app est déjà affichée : on relance le démarrage.
window.addEventListener('hashchange', () => location.hash.startsWith('#/join/') && location.reload());

boot();
