/**
 * agenda.ts : le panneau « Agenda » (liste des événements d'une semaine, jour par jour).
 *
 * Qui l'appelle ? main.ts, via mountAgenda(panneau, fonctionOuverture), une seule fois au démarrage.
 *
 * Ce qu'il affiche :
 * - une navigation semaine précédente / suivante (clic sur les dates = revenir à cette semaine) ;
 * - une bande de 7 pastilles (lun → dim) avec des points de couleur par événement ;
 * - côté Mouvement, un bandeau des votes en cours ;
 * - un filtre Tout / Événements / Flash, et un interrupteur pour montrer les alertes ;
 * - les cartes d'événements groupées par jour.
 *
 * Notions :
 * - Les dates sont manipulées en millisecondes depuis 1970 (« timestamp », comme Date.now()).
 * - Une « occurrence » = une séance précise d'un événement (un événement répété chaque semaine
 *   a plusieurs occurrences) ; calculées par occurrences() dans shared/time.ts.
 * - Le rendu est « tout effacer puis tout redessiner » (fonction render) à chaque changement.
 */
import { store, paintOf } from './store';
import { TYPES, iconOf } from '../../shared/model';
// Occurrence = { point, start, end } : une séance d'un événement.
import { occurrences, liveProblems, type Occurrence } from '../../shared/time';
// Utilitaires de dates (ui.ts) : startOfWeek = lundi 00:00, addDays, sameDay, etc.
import { h, icon, clear, time, dayLong, startOfWeek, addDays, sameDay, startOfDay, isAllDay } from './ui';
import { newPointFlow, chips } from './forms';
// Votes : ouvrir le bulletin dans l'app, ou l'écran « code à 5 chiffres » (façon Kahoot) pour l'animateur.
import { openAppVote, openKahoot } from './votes';

// État du module (variables privées à ce fichier, conservées entre deux rendus) :
// lundi 00:00 de la semaine affichée.
let weekStart = startOfWeek(Date.now());
// Interrupteur « Afficher les alertes ».
let showAlerts = true;
/** Filtre : tout, seulement les événements prévus, ou seulement les flashs. */
let kind: 'all' | 'events' | 'flash' = 'all';
// Le <section> du panneau (fourni par main.ts) et la fonction à appeler quand on clique un événement.
let root: HTMLElement;
let onOpen: (o: Occurrence) => void;

// Formateurs de dates en français, créés une seule fois (en créer à chaque rendu coûterait plus cher).
// fmtRange → « 3 nov. » ; fmtDow → « lun. ».
const fmtRange = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fmtDow = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' });

/**
 * Installe l'agenda dans `el`. Entrées : le conteneur, et la fonction appelée au clic sur un événement
 * (main.ts s'en sert pour centrer la carte et ouvrir la fiche). Pas de sortie.
 */
export function mountAgenda(el: HTMLElement, open: (o: Occurrence) => void) {
  root = el;
  onOpen = open;
  // Redessiner quand les points ou les votes ouverts changent.
  store.on('points', render);
  store.on('open-votes', render);
  // Chaque minute, si l'agenda est affiché, on redessine (« en cours », « passé » évoluent avec l'heure).
  // Note : intervalle jamais arrêté ; il ne coûte presque rien quand la vue n'est pas l'agenda.
  setInterval(() => store.view === 'agenda' && render(), 60_000);
  render();
}

/**
 * Toutes les occurrences de la semaine affichée, filtrées et triées par heure de début.
 * Sortie : un tableau d'Occurrence.
 */
function weekOccurrences(): Occurrence[] {
  const from = weekStart;
  // Dimanche 23:59:59.999 (lundi suivant moins 1 ms).
  const to = addDays(weekStart, 7) - 1;
  const out: Occurrence[] = [];
  for (const p of store.points) {
    // Les points fixes (panneaux, locaux…) n'ont pas d'horaire : pas dans l'agenda.
    if (p.mode !== 'event') continue;
    // Alertes : cachées si l'interrupteur est éteint, si on filtre sur les flashs, ou si elles ont expiré.
    // `?? 0` : sans date d'expiration, on considère l'alerte expirée.
    if (TYPES[p.type].alert && (!showAlerts || kind === 'flash' || (p.expiresAt ?? 0) < Date.now())) continue;
    if (kind === 'flash' && !p.flash) continue;
    if (kind === 'events' && p.flash) continue;
    // `...` (spread) ajoute chaque élément du tableau renvoyé, au lieu d'ajouter le tableau lui-même.
    out.push(...occurrences(p, from, to));
  }
  // Tri croissant : une valeur négative place a avant b.
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Redessine tout le panneau. Exportée (et appelée aussi par les abonnements et l'intervalle).
 */
export function render() {
  // Pas encore monté : rien à faire.
  if (!root) return;
  const occ = weekOccurrences();
  const now = Date.now();
  // Les 7 jours de la semaine (timestamps de minuit). Array.from({ length: 7 }, fn) crée un tableau de 7 cases.
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  // Un événement multi-jours n'apparaît qu'au jour de son début (ou au lundi s'il a commencé avant).
  const dayOf = (o: Occurrence) => (o.start < weekStart ? weekStart : startOfDay(o.start));
  // Pour chaque jour, ses occurrences.
  const grouped = days.map((d) => occ.filter((o) => dayOf(o) === d));

  // Bande des 7 jours : classes « today » (aujourd'hui) et « has » (au moins un événement).
  const strip = h('div', { class: 'day-strip' }, days.map((d, i) => h('button', {
    class: `day-pill${sameDay(d, now) ? ' today' : ''}${grouped[i].length ? ' has' : ''}`, type: 'button',
    // Clic sur un jour : défilement doux jusqu'à sa section (repérée par l'attribut data-day = timestamp).
    onclick: () => root.querySelector(`[data-day="${d}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  },
  // « lun. » → « lun » (on retire le point d'abréviation).
  h('span', { class: 'dow' }, fmtDow.format(d).replace('.', '')),
  h('span', { class: 'dnum' }, new Date(d).getDate()),
  // Jusqu'à 4 petits points colorés, un par événement du jour (couleur du point sur la carte).
  h('span', { class: 'dots' }, grouped[i].slice(0, 4).map((o) => h('i', { style: { background: paintOf(o.point).color } }))),
  )));

  // La liste des jours ; `any` retiendra s'il y a au moins un événement dans la semaine.
  const list = h('div', { class: 'agenda-list' });
  let any = false;
  grouped.forEach((items, i) => {
    const d = days[i];
    // Un jour vide n'est affiché que si c'est aujourd'hui (pour dire « Rien de prévu aujourd'hui »).
    if (!items.length && !sameDay(d, now)) return;
    any = any || items.length > 0;
    list.append(h('section', { class: 'agenda-day', dataset: { day: String(d) } },
      // Titre : « Aujourd'hui » + la date en petit, ou simplement la date longue.
      h('h3', { class: `agenda-day-title${sameDay(d, now) ? ' today' : ''}` }, sameDay(d, now) ? 'Aujourd\'hui' : dayLong(d), sameDay(d, now) ? h('small', null, dayLong(d)) : null),
      // items.map(card) : une carte par occurrence.
      items.length ? items.map(card) : h('p', { class: 'agenda-empty-day' }, 'Rien de prévu aujourd\'hui.'),
    ));
  });

  // clear(root, ...) vide le panneau et y met tous ces éléments (les anciens écouteurs partent avec l'ancien DOM).
  clear(root,
    h('div', { class: 'panel-head' },
      h('h2', { class: 'panel-title' }, 'Agenda'),
      h('div', { class: 'week-nav' },
        // Les flèches décalent la semaine de ±7 jours puis redessinent.
        h('button', { class: 'icon-btn', 'aria-label': 'Semaine précédente', onclick: () => { weekStart = addDays(weekStart, -7); render(); } }, icon('chevron-left', 22)),
        h('button', { class: 'week-label', onclick: () => { weekStart = startOfWeek(Date.now()); render(); }, title: 'Revenir à cette semaine' },
          `${fmtRange.format(weekStart)} – ${fmtRange.format(addDays(weekStart, 6))}`),
        h('button', { class: 'icon-btn', 'aria-label': 'Semaine suivante', onclick: () => { weekStart = addDays(weekStart, 7); render(); } }, icon('chevron-right', 22)),
      ),
    ),
    strip,
    votesBanner(),
    // chips<type>(options, valeur actuelle, au changement) : le filtre Tout / Événements / Flash.
    h('div', { class: 'agenda-kind' }, chips<'all' | 'events' | 'flash'>([
      { value: 'all', label: 'Tout' },
      { value: 'events', label: 'Événements', icon: 'calendar' },
      { value: 'flash', label: 'Flash', icon: 'zap' },
    ], kind, (v) => { kind = v; render(); })),
    // L'interrupteur des alertes n'a pas de sens quand on ne regarde que les flashs.
    kind === 'flash' ? null : h('label', { class: 'toggle-line' },
      // Case à cocher stylée en interrupteur (le <span class="switch"> est le dessin, en CSS).
      h('input', { type: 'checkbox', checked: showAlerts, onchange: (e: Event) => { showAlerts = (e.target as HTMLInputElement).checked; render(); } }),
      h('span', { class: 'switch' }), store.space === 'mvt' ? 'Afficher les alertes (warning, danger, police)' : 'Afficher les alertes (warning, danger)'),
    list,
    // Semaine vide : message et bouton de création. Le bouton bascule vers la carte puis lance la création.
    any ? null : h('div', { class: 'empty' },
      icon(kind === 'flash' ? 'zap' : 'calendar-days', 40, 1.6),
      h('strong', null, kind === 'flash' ? 'Aucun flash cette semaine' : 'Aucun événement cette semaine'),
      h('span', null, kind === 'flash' ? 'Un flash, c\'est une action improvisée qui commence dans les minutes qui viennent.' : store.space === 'mvt' ? 'Ajoute une AG, un rassemblement ou un blocus pour le voir apparaître ici.' : 'Ajoute une AG, un tractage ou un collage pour le voir apparaître ici.'),
      h('button', { class: 'btn btn-primary', onclick: () => { store.setView('map'); newPointFlow(kind === 'flash' ? 'flash' : 'event'); } }, icon('plus', 18), kind === 'flash' ? 'Lancer un flash' : 'Créer un événement'),
    ),
  );
}

/** Votes en cours (côté Mouvement) : tout en un coup d'œil, sans chercher l'AG. */
// Sortie : une <section> ou null (h() ignore null, donc rien n'est affiché).
function votesBanner() {
  if (store.space !== 'mvt' || !store.openVotes.length) return null;
  return h('section', { class: 'votes-banner' },
    h('div', { class: 'section-title' }, icon('vote', 18), `Votes en cours (${store.openVotes.length})`),
    // Déstructuration dans les paramètres : { vote: v, ... } renomme la propriété « vote » en « v ».
    h('ul', { class: 'votes-banner-list' }, store.openVotes.map(({ vote: v, agTitle, canRun }) => h('li', { class: 'votes-banner-item' },
      h('div', { class: 'vb-main' },
        // « indicatif » : vote ouvert à tous, sans compte (donc sans valeur de décision).
        h('span', { class: 'vb-ag' }, agTitle, v.openToAll ? h('em', null, ' · indicatif') : null),
        h('strong', null, v.question),
        // Pluriel de « vote » et rayon de présence éventuel (vote seulement sur place).
        h('span', { class: 'vb-meta' }, `${v.total} vote${v.total > 1 ? 's' : ''}${v.radius ? ` · sur place à moins de ${v.radius} m` : ''}`)),
      h('div', { class: 'vb-actions' },
        // myChoice == null (null ou undefined) : je n'ai pas encore voté.
        v.myChoice == null
          ? h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => openAppVote(v) }, icon('vote', 15), 'Voter')
          : h('span', { class: 'vote-done' }, icon('check', 15), 'Voté'),
        // canRun : je peux animer ce vote (afficher le code à projeter).
        canRun ? h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => openKahoot(v.id) }, icon('qr-code', 15), 'Code') : null,
        // Bouton « Voir l'AG » : on fabrique une occurrence factice pour réutiliser onOpen (centrer + fiche).
        h('button', { class: 'btn btn-small btn-light', type: 'button', 'aria-label': 'Voir l\'AG', title: 'Voir l\'AG', onclick: () => {
          const ag = store.get(v.pointId);
          if (ag) onOpen({ point: ag, start: ag.startsAt ?? Date.now(), end: ag.endsAt ?? Date.now() });
        } }, icon('map-pin', 15)),
      ),
    ))),
  );
}

/**
 * Carte d'un événement dans la liste. Entrée : une occurrence. Sortie : un <button>.
 * Couleur de fond = couleur du point ; « live » si en cours, « past » si terminé.
 */
function card(o: Occurrence) {
  const p = o.point;
  const meta = TYPES[p.type];
  const { color: bg, ink } = paintOf(p);
  const now = Date.now();
  const live = o.start <= now && o.end > now;
  const past = o.end <= now;
  return h('button', {
    class: `ev-card${live ? ' live' : ''}${past ? ' past' : ''}${p.flash ? ' is-flash' : ''}`, type: 'button',
    // Couleurs inline : fond, texte, et variable CSS --c pour les détails (bordures, etc.).
    style: { background: bg, color: ink, '--c': bg } as Record<string, string>,
    onclick: () => onOpen(o),
  },
  h('span', { class: 'ev-ico' }, icon(iconOf(p), 22)),
  h('span', { class: 'ev-main' },
    h('span', { class: 'ev-time' },
      p.flash ? h('span', { class: 'ev-flash' }, icon('zap', 13), 'Flash') : null,
      // Horaire : alertes avec une flèche (de… jusqu'à expiration), événements avec un tiret.
      isAllDay(o.start, o.end) ? 'Toute la journée' : meta.alert ? `${time(o.start)} → ${time(o.end)}` : `${time(o.start)} – ${time(o.end)}`,
      live ? h('span', { class: 'ev-live' }, 'en cours') : null,
      // Icône « répétition » pour les événements récurrents.
      p.recurrence !== 'none' ? icon('repeat', 14) : null),
    h('span', { class: 'ev-title' }, p.title),
    p.description ? h('span', { class: 'ev-desc' }, p.description) : h('span', { class: 'ev-desc ev-type' }, meta.label),
    // Participants et matériel : « matos 2/5 » = nombre d'objets ayant au moins un fournisseur / total.
    p.participants?.length || p.material?.length ? h('span', { class: 'ev-material' },
      p.participants?.length ? h('span', null, icon('users', 13), ` ${p.participants.length}`) : null,
      p.material?.length ? h('span', null, icon('package', 13),
        ` matos ${p.material.filter((m) => p.providers?.[m]?.length).length}/${p.material.length}`) : null) : null,
    // Problème en cours, seulement pendant l'événement. (liveProblems est calculé deux fois ici.)
    live && liveProblems(p).length ? h('span', { class: 'ev-problem' }, icon('circle-alert', 13), liveProblems(p)[0].message) : null,
  ),
  p.photo ? h('span', { class: 'ev-photo-flag', title: 'Avec photo' }, icon('camera', 16)) : null,
  );
}
