import { store } from './store';
import { TYPES, colorOf } from '../../shared/model';
import { occurrences, type Occurrence } from '../../shared/time';
import { h, icon, clear, time, dayLong, startOfWeek, addDays, sameDay, inkFor, startOfDay } from './ui';
import { newPointFlow } from './forms';

let weekStart = startOfWeek(Date.now());
let showAlerts = true;
let root: HTMLElement;
let onOpen: (o: Occurrence) => void;

const fmtRange = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fmtDow = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' });

export function mountAgenda(el: HTMLElement, open: (o: Occurrence) => void) {
  root = el;
  onOpen = open;
  store.on('points', render);
  setInterval(() => store.view === 'agenda' && render(), 60_000);
  render();
}

function weekOccurrences(): Occurrence[] {
  const from = weekStart;
  const to = addDays(weekStart, 7) - 1;
  const out: Occurrence[] = [];
  for (const p of store.points) {
    if (p.mode !== 'event') continue;
    if (TYPES[p.type].alert && (!showAlerts || (p.expiresAt ?? 0) < Date.now())) continue;
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
  h('span', { class: 'dots' }, grouped[i].slice(0, 4).map((o) => h('i', { style: { background: colorOf(o.point) } }))),
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
    h('label', { class: 'toggle-line' },
      h('input', { type: 'checkbox', checked: showAlerts, onchange: (e: Event) => { showAlerts = (e.target as HTMLInputElement).checked; render(); } }),
      h('span', { class: 'switch' }), 'Afficher les alertes (warning, danger)'),
    list,
    any ? null : h('div', { class: 'empty' },
      icon('calendar-days', 40, 1.6),
      h('strong', null, 'Aucun événement cette semaine'),
      h('span', null, 'Ajoute une AG, un tractage ou un collage pour le voir apparaître ici.'),
      h('button', { class: 'btn btn-primary', onclick: () => { store.setView('map'); newPointFlow('event'); } }, icon('plus', 18), 'Créer un événement'),
    ),
  );
}

function card(o: Occurrence) {
  const p = o.point;
  const meta = TYPES[p.type];
  const bg = colorOf(p);
  const ink = p.color ? inkFor(bg) : meta.ink;
  const now = Date.now();
  const live = o.start <= now && o.end > now;
  const past = o.end <= now;
  return h('button', {
    class: `ev-card${live ? ' live' : ''}${past ? ' past' : ''}`, type: 'button',
    style: { background: bg, color: ink },
    onclick: () => onOpen(o),
  },
  h('span', { class: 'ev-ico' }, icon(meta.icon, 22)),
  h('span', { class: 'ev-main' },
    h('span', { class: 'ev-time' }, meta.alert ? `${time(o.start)} → ${time(o.end)}` : `${time(o.start)} – ${time(o.end)}`,
      live ? h('span', { class: 'ev-live' }, 'en cours') : null,
      p.recurrence !== 'none' ? icon('repeat', 14) : null),
    h('span', { class: 'ev-title' }, p.title),
    p.description ? h('span', { class: 'ev-desc' }, p.description) : h('span', { class: 'ev-desc ev-type' }, meta.label),
  ),
  p.photo ? h('span', { class: 'ev-photo-flag', title: 'Avec photo' }, icon('camera', 16)) : null,
  );
}
