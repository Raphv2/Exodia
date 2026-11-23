import { store, paintOf } from './store';
import { TYPES, iconOf } from '../../shared/model';
import { occurrences, liveProblems, type Occurrence } from '../../shared/time';
import { h, icon, clear, time, dayLong, startOfWeek, addDays, sameDay, startOfDay, isAllDay } from './ui';
import { newPointFlow, chips } from './forms';
import { openAppVote, openKahoot } from './votes';

let weekStart = startOfWeek(Date.now());
let showAlerts = true;
/** Filtre : tout, seulement les événements prévus, ou seulement les flashs. */
let kind: 'all' | 'events' | 'flash' = 'all';
let root: HTMLElement;
let onOpen: (o: Occurrence) => void;

const fmtRange = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fmtDow = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' });

export function mountAgenda(el: HTMLElement, open: (o: Occurrence) => void) {
  root = el;
  onOpen = open;
  store.on('points', render);
  store.on('open-votes', render);
  setInterval(() => store.view === 'agenda' && render(), 60_000);
  render();
}

function weekOccurrences(): Occurrence[] {
  const from = weekStart;
  const to = addDays(weekStart, 7) - 1;
  const out: Occurrence[] = [];
  for (const p of store.points) {
    if (p.mode !== 'event') continue;
    if (TYPES[p.type].alert && (!showAlerts || kind === 'flash' || (p.expiresAt ?? 0) < Date.now())) continue;
    if (kind === 'flash' && !p.flash) continue;
    if (kind === 'events' && p.flash) continue;
    out.push(...occurrences(p, from, to));
  }
  return out.sort((a, b) => a.start - b.start);
}

export function render() {
  if (!root) return;
  const occ = weekOccurrences();
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  // Un événement multi-jours n'apparaît qu'au jour de son début (ou au lundi s'il a commencé avant).
  const dayOf = (o: Occurrence) => (o.start < weekStart ? weekStart : startOfDay(o.start));
  const grouped = days.map((d) => occ.filter((o) => dayOf(o) === d));

  const strip = h('div', { class: 'day-strip' }, days.map((d, i) => h('button', {
    class: `day-pill${sameDay(d, now) ? ' today' : ''}${grouped[i].length ? ' has' : ''}`, type: 'button',
    onclick: () => root.querySelector(`[data-day="${d}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  },
  h('span', { class: 'dow' }, fmtDow.format(d).replace('.', '')),
  h('span', { class: 'dnum' }, new Date(d).getDate()),
  h('span', { class: 'dots' }, grouped[i].slice(0, 4).map((o) => h('i', { style: { background: paintOf(o.point).color } }))),
  )));

  const list = h('div', { class: 'agenda-list' });
  let any = false;
  grouped.forEach((items, i) => {
    const d = days[i];
    if (!items.length && !sameDay(d, now)) return;
    any = any || items.length > 0;
    list.append(h('section', { class: 'agenda-day', dataset: { day: String(d) } },
      h('h3', { class: `agenda-day-title${sameDay(d, now) ? ' today' : ''}` }, sameDay(d, now) ? 'Aujourd\'hui' : dayLong(d), sameDay(d, now) ? h('small', null, dayLong(d)) : null),
      items.length ? items.map(card) : h('p', { class: 'agenda-empty-day' }, 'Rien de prévu aujourd\'hui.'),
    ));
  });

  clear(root,
    h('div', { class: 'panel-head' },
      h('h2', { class: 'panel-title' }, 'Agenda'),
      h('div', { class: 'week-nav' },
        h('button', { class: 'icon-btn', 'aria-label': 'Semaine précédente', onclick: () => { weekStart = addDays(weekStart, -7); render(); } }, icon('chevron-left', 22)),
        h('button', { class: 'week-label', onclick: () => { weekStart = startOfWeek(Date.now()); render(); }, title: 'Revenir à cette semaine' },
          `${fmtRange.format(weekStart)} – ${fmtRange.format(addDays(weekStart, 6))}`),
        h('button', { class: 'icon-btn', 'aria-label': 'Semaine suivante', onclick: () => { weekStart = addDays(weekStart, 7); render(); } }, icon('chevron-right', 22)),
      ),
    ),
    strip,
    votesBanner(),
    h('div', { class: 'agenda-kind' }, chips<'all' | 'events' | 'flash'>([
      { value: 'all', label: 'Tout' },
      { value: 'events', label: 'Événements', icon: 'calendar' },
      { value: 'flash', label: 'Flash', icon: 'zap' },
    ], kind, (v) => { kind = v; render(); })),
    kind === 'flash' ? null : h('label', { class: 'toggle-line' },
      h('input', { type: 'checkbox', checked: showAlerts, onchange: (e: Event) => { showAlerts = (e.target as HTMLInputElement).checked; render(); } }),
      h('span', { class: 'switch' }), store.space === 'mvt' ? 'Afficher les alertes (warning, danger, police)' : 'Afficher les alertes (warning, danger)'),
    list,
    any ? null : h('div', { class: 'empty' },
      icon(kind === 'flash' ? 'zap' : 'calendar-days', 40, 1.6),
      h('strong', null, kind === 'flash' ? 'Aucun flash cette semaine' : 'Aucun événement cette semaine'),
      h('span', null, kind === 'flash' ? 'Un flash, c\'est une action improvisée qui commence dans les minutes qui viennent.' : store.space === 'mvt' ? 'Ajoute une AG, un rassemblement ou un blocus pour le voir apparaître ici.' : 'Ajoute une AG, un tractage ou un collage pour le voir apparaître ici.'),
      h('button', { class: 'btn btn-primary', onclick: () => { store.setView('map'); newPointFlow(kind === 'flash' ? 'flash' : 'event'); } }, icon('plus', 18), kind === 'flash' ? 'Lancer un flash' : 'Créer un événement'),
    ),
  );
}

/** Votes en cours (côté Mouvement) : tout en un coup d'œil, sans chercher l'AG. */
function votesBanner() {
  if (store.space !== 'mvt' || !store.openVotes.length) return null;
  return h('section', { class: 'votes-banner' },
    h('div', { class: 'section-title' }, icon('vote', 18), `Votes en cours (${store.openVotes.length})`),
    h('ul', { class: 'votes-banner-list' }, store.openVotes.map(({ vote: v, agTitle, canRun }) => h('li', { class: 'votes-banner-item' },
      h('div', { class: 'vb-main' },
        h('span', { class: 'vb-ag' }, agTitle, v.openToAll ? h('em', null, ' · indicatif') : null),
        h('strong', null, v.question),
        h('span', { class: 'vb-meta' }, `${v.total} vote${v.total > 1 ? 's' : ''}${v.radius ? ` · sur place à moins de ${v.radius} m` : ''}`)),
      h('div', { class: 'vb-actions' },
        v.myChoice == null
          ? h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => openAppVote(v) }, icon('vote', 15), 'Voter')
          : h('span', { class: 'vote-done' }, icon('check', 15), 'Voté'),
        canRun ? h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => openKahoot(v.id) }, icon('qr-code', 15), 'Code') : null,
        h('button', { class: 'btn btn-small btn-light', type: 'button', 'aria-label': 'Voir l\'AG', title: 'Voir l\'AG', onclick: () => {
          const ag = store.get(v.pointId);
          if (ag) onOpen({ point: ag, start: ag.startsAt ?? Date.now(), end: ag.endsAt ?? Date.now() });
        } }, icon('map-pin', 15)),
      ),
    ))),
  );
}

function card(o: Occurrence) {
  const p = o.point;
  const meta = TYPES[p.type];
  const { color: bg, ink } = paintOf(p);
  const now = Date.now();
  const live = o.start <= now && o.end > now;
  const past = o.end <= now;
  return h('button', {
    class: `ev-card${live ? ' live' : ''}${past ? ' past' : ''}${p.flash ? ' is-flash' : ''}`, type: 'button',
    style: { background: bg, color: ink, '--c': bg } as Record<string, string>,
    onclick: () => onOpen(o),
  },
  h('span', { class: 'ev-ico' }, icon(iconOf(p), 22)),
  h('span', { class: 'ev-main' },
    h('span', { class: 'ev-time' },
      p.flash ? h('span', { class: 'ev-flash' }, icon('zap', 13), 'Flash') : null,
      isAllDay(o.start, o.end) ? 'Toute la journée' : meta.alert ? `${time(o.start)} → ${time(o.end)}` : `${time(o.start)} – ${time(o.end)}`,
      live ? h('span', { class: 'ev-live' }, 'en cours') : null,
      p.recurrence !== 'none' ? icon('repeat', 14) : null),
    h('span', { class: 'ev-title' }, p.title),
    p.description ? h('span', { class: 'ev-desc' }, p.description) : h('span', { class: 'ev-desc ev-type' }, meta.label),
    p.participants?.length || p.material?.length ? h('span', { class: 'ev-material' },
      p.participants?.length ? h('span', null, icon('users', 13), ` ${p.participants.length}`) : null,
      p.material?.length ? h('span', null, icon('package', 13),
        ` matos ${p.material.filter((m) => p.providers?.[m]?.length).length}/${p.material.length}`) : null) : null,
    live && liveProblems(p).length ? h('span', { class: 'ev-problem' }, icon('circle-alert', 13), liveProblems(p)[0].message) : null,
  ),
  p.photo ? h('span', { class: 'ev-photo-flag', title: 'Avec photo' }, icon('camera', 16)) : null,
  );
}
