import { api, photoUrl, ApiError } from './api';
import { store, paintOf } from './store';
import { openSheet, confirmSheet } from './sheet';
import { editPoint, durLabel, chips, newPointFlow } from './forms';
import { h, icon, clear, toast, rangeLabel, relative, dateLong, time, toTimeInput, toDateInput, fromInputs } from './ui';
import {
  TYPES, iconOf, canReportProblem, STATUS_LABEL, STATUS_HINT, STATUSES, RECURRENCE_LABEL, PROBLEM_PRESETS, PROBLEM_DURATIONS,
  type Point, type Problem,
} from '../../shared/model';
import { nextOccurrence, isActive, liveProblems } from '../../shared/time';
import { votesSection } from './votes';
import { getPosition, lastPosition, distance, fmtDistance, type Pos } from './geo';

async function act(fn: () => Promise<{ point: Point }>, msg: string) {
  try {
    const { point } = await fn();
    store.upsert(point);
    toast(msg, 'ok');
    openDetail(point);
  } catch (e) {
    toast((e as ApiError).message, 'err');
  }
}

/**
 * Bouton « Toujours là » : grisé tant que les 15 min ne sont pas écoulées depuis le signalement
 * ou la dernière confirmation (le serveur applique la même règle).
 */
function confirmButton(size: string, ico: number, fn: () => Promise<{ point: Point }>, okMsg: string) {
  // Toujours cliquable. Si c'est trop tôt (moins de 15 min), le serveur refuse :
  // on l'explique gentiment dans une notification, sans rien bloquer.
  return h('button', { class: `btn ${size} btn-light`, type: 'button', onclick: async () => {
    try {
      const { point } = await fn();
      store.upsert(point);
      toast(okMsg, 'ok');
      openDetail(point);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 429) toast(err.message, 'info', 5000, 'timer');
      else toast(err.message, 'err');
    }
  } }, icon('timer', ico), 'Toujours là !');
}

function problemCard(p: Point, pr: Problem) {
  return h('div', { class: 'problem-card', role: 'alert' },
    h('div', { class: 'problem-head' }, icon('circle-alert', 20), h('strong', null, pr.message)),
    h('span', { class: 'problem-meta' },
      `Signalé ${relative(pr.createdAt)}${pr.creatorName ? ` par ${pr.creatorName}` : ''} · expire ${relative(pr.expiresAt)}`),
    h('div', { class: 'problem-actions' },
      h('button', { class: 'btn btn-small btn-done', type: 'button', onclick: () => act(() => api.resolveProblem(pr.id), 'Problème marqué comme réglé') }, icon('check', 15), 'C\'est réglé'),
      confirmButton('btn-small', 15, () => api.extendProblem(pr.id, 30), 'Problème prolongé de 30 min'),
    ),
  );
}

/** Signaler un problème sur ce point, sans créer d'alerte séparée. */
export function openProblemForm(p: Point) {
  const state = { message: PROBLEM_PRESETS[0], duration: 60 as number };
  const input = h('input', { class: 'input', type: 'text', maxlength: '200', value: state.message, placeholder: 'Que se passe-t-il ?', oninput: (e: Event) => (state.message = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  const submit = h('button', { class: 'btn btn-danger btn-block', type: 'button' }, icon('circle-alert', 20), h('span', null, '')) as HTMLButtonElement;
  const label = () => (submit.querySelector('span')!.textContent = `Signaler · ${durLabel(state.duration)}`);
  submit.onclick = async () => {
    if (!state.message.trim()) return toast('Décris le problème en quelques mots.', 'err');
    submit.disabled = true;
    try {
      const { point } = await api.reportProblem(p.id, state.message.trim(), state.duration);
      store.upsert(point);
      s.close();
      toast('Problème signalé : le point clignote pour tout le monde', 'ok');
    } catch (e) {
      toast((e as ApiError).message, 'err');
      submit.disabled = false;
    }
  };
  const s = openSheet({
    title: 'Signaler un problème',
    accent: '#F53B3B',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, `Sur « ${p.title} ». Le point clignotera en rouge sur la carte de tout le monde.`),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Quoi ?'),
        chips(PROBLEM_PRESETS.map((x) => ({ value: x, label: x })), state.message, (v) => { state.message = v; input.value = v; }, '#F53B3B'),
        input),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Visible pendant'),
        chips(PROBLEM_DURATIONS.map((m) => ({ value: m, label: durLabel(m) })), state.duration, (v) => { state.duration = v; label(); }, '#F53B3B')),
    ),
    footer: submit,
  });
  label();
}

/** Une ligne cliquable vers un blocage (dans la fiche d'un blocus). */
function blocageRow(b: Point, onOpen: () => void) {
  const problems = liveProblems(b);
  return h('li', null, h('button', { class: `link-row${problems.length ? ' has-problem' : ''}`, type: 'button', onclick: onOpen },
    h('span', { class: `link-dot st-${b.status ?? 'vide'}` }),
    h('span', { class: 'link-main' },
      h('strong', null, b.title),
      h('span', null, problems.length ? problems[0].message : `${STATUS_LABEL[b.status ?? 'vide']}${b.statusAt ? ` · ${relative(b.statusAt)}` : ''}`)),
    problems.length ? icon('circle-alert', 18) : icon('chevron-right', 18),
  ));
}

/** Rattacher au blocus des blocages déjà posés sur la carte (les barricades restent d'un jour à l'autre). */
function openAttachSheet(blocus: Point) {
  const list = h('ul', { class: 'pick-list' });
  const render = () => {
    const all = store.points.filter((x) => x.type === 'blocage').sort((a, b) => a.title.localeCompare(b.title));
    if (!all.length) return clear(list, h('p', { class: 'muted' }, 'Aucun blocage sur la carte pour l\'instant.'));
    clear(list, ...all.map((b) => {
      const on = b.parentId === blocus.id;
      const other = b.parentId && !on ? store.points.find((x) => x.id === b.parentId) : null;
      return h('li', null, h('button', { class: `pick-row${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), onclick: async () => {
        try {
          const { point } = await api.setParent(b.id, on ? null : blocus.id);
          store.upsert(point);
          render();
        } catch (e) { toast((e as ApiError).message, 'err'); }
      } },
      h('span', { class: 'pick-check' }, on ? icon('check', 16) : null),
      h('span', { class: 'pick-main' }, h('strong', null, b.title),
        h('span', { class: 'pick-sub' }, other ? `Rattaché à « ${other.title} »` : STATUS_LABEL[b.status ?? 'vide']))));
    }));
  };
  render();
  const s = openSheet({
    title: 'Rattacher des blocages',
    accent: TYPES.blocus.color,
    body: h('div', { class: 'form' }, h('p', { class: 'muted' }, `Coche les blocages qui font partie de « ${blocus.title} ».`), list),
    footer: h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => { s.close(); openDetail(store.points.find((x) => x.id === blocus.id) ?? blocus); } }, 'Terminé'),
  });
}

const names = (people: { name: string }[]) =>
  people.length <= 3 ? people.map((x) => x.name).join(', ') : `${people.slice(0, 3).map((x) => x.name).join(', ')} +${people.length - 3}`;

/** Blocus : on vient dès le RDV, ou plus tard (avec une heure). */
function openArrivalSheet(p: Point) {
  const occ = nextOccurrence(p);
  const start = occ?.start ?? p.startsAt ?? Date.now();
  const mine = p.participants.find((x) => x.id === store.me.id);
  const later = mine?.arriveAt ?? start + 3600_000;
  const input = h('input', { class: 'input', type: 'time', step: '300', value: toTimeInput(later) }) as HTMLInputElement;
  const send = (arriveAt: number | null, msg: string) => { s.close(); act(() => api.participate(p.id, true, arriveAt), msg); };
  const s = openSheet({
    title: 'Tu viens quand ?',
    accent: paintOf(p).color,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, `« ${p.title} » · RDV à ${time(start)}`),
      h('button', { class: `btn btn-primary btn-block${mine && mine.arriveAt == null ? ' is-current' : ''}`, type: 'button',
        onclick: () => send(null, `Noté : tu viens au RDV de ${time(start)}`) }, icon('clock', 18), `Au RDV · ${time(start)}`),
      h('div', { class: 'card-section arrive-later' },
        h('span', { class: 'field-label' }, 'Plus tard, vers'),
        h('div', { class: 'material-add' }, input,
          h('button', { class: 'btn btn-outline', type: 'button', onclick: () => {
            if (!input.value) return toast('Indique une heure.', 'err');
            let t = fromInputs(toDateInput(start), input.value);
            if (t < start) t += 86400_000; // ex. RDV à 23 h, arrivée à 1 h
            send(t, `Noté : tu arrives vers ${time(t)}`);
          } }, 'Valider')),
      ),
      mine ? h('button', { class: 'btn btn-light btn-text-danger btn-block', type: 'button',
        onclick: () => { s.close(); act(() => api.participate(p.id, false), 'Tu ne participes plus'); } }, 'Je ne viens plus') : null,
    ),
  });
}

/** Liste des participant·es ; pour un blocus, séparée entre RDV et arrivées plus tard. */
function participantsText(p: Point) {
  if (!p.participants.length) return 'Personne pour l\'instant';
  if (p.type !== 'blocus') return names(p.participants);
  const atRdv = p.participants.filter((x) => x.arriveAt == null);
  const later = p.participants.filter((x) => x.arriveAt != null).sort((a, b) => a.arriveAt! - b.arriveAt!);
  return [
    atRdv.length ? `Au RDV : ${names(atRdv)}` : null,
    later.length ? `Plus tard : ${later.map((x) => `${x.name} (${time(x.arriveAt!)})`).join(', ')}` : null,
  ].filter(Boolean).join(' · ');
}

/** Qui vient, et qui fournit quoi. Fournir du matériel n'oblige pas à venir. */
function pledgeSection(p: Point) {
  const me = store.me.id;
  const mine = p.participants.find((x) => x.id === me);
  const going = !!mine;
  const blocus = p.type === 'blocus';
  const label = !going ? 'Je participe ?'
    : blocus ? (mine.arriveAt == null ? 'Je viens au RDV' : `J'arrive vers ${time(mine.arriveAt)}`)
    : 'Je participe';
  return h('div', { class: 'card-section pledges' },
    h('div', { class: 'pledge-head' },
      h('div', null,
        h('div', { class: 'section-title' }, icon('users', 18), `Qui vient ? (${p.participants.length})`),
        h('span', { class: 'field-hint' }, participantsText(p))),
      h('button', { class: `btn btn-small ${going ? 'btn-done' : 'btn-primary'}`, type: 'button',
        onclick: () => blocus ? openArrivalSheet(p)
          : act(() => api.participate(p.id, !going), going ? 'Tu ne participes plus' : 'Noté : tu participes') },
        going ? icon('check', 15) : null, label),
      blocus && going ? h('span', { class: 'field-hint' }, 'Touche le bouton pour changer ton heure ou te désinscrire.') : null,
    ),
    p.material.length ? h('div', { class: 'material' },
      h('div', { class: 'section-title' }, icon('package', 18), 'Matériel'),
      h('ul', { class: 'material-rows' }, p.material.map((m) => {
        const who = p.providers[m] ?? [];
        const mine = who.some((x) => x.id === me);
        return h('li', { class: `material-row${who.length ? '' : ' missing'}` },
          h('span', { class: 'material-main' }, h('strong', null, m),
            h('span', null, who.length ? `Fourni par ${names(who)}` : 'Personne ne le fournit')),
          h('button', { class: `btn btn-small ${mine ? 'btn-done' : 'btn-light'}`, type: 'button',
            onclick: () => act(() => api.provide(p.id, m, !mine), mine ? `Tu ne fournis plus : ${m}` : `Noté : tu fournis ${m}`) },
            mine ? icon('check', 15) : null, 'Je fournis'));
      })),
      h('span', { class: 'field-hint' }, 'Fournir du matériel n\'oblige pas à venir.'),
    ) : null,
  );
}

/** Vitesses moyennes en ville (km/h) et détour des rues par rapport à la ligne droite. */
const WALK_KMH = 4.5;
const BIKE_KMH = 13;
const DETOUR = 1.3;
const mins = (m: number, kmh: number) => {
  const t = Math.max(1, Math.round((m / 1000 / kmh) * 60));
  return t >= 60 ? `${Math.floor(t / 60)} h ${String(t % 60).padStart(2, '0')}` : `${t} min`;
};

/** « À combien je suis ? » : distance et temps estimés depuis ma position, à pied et à vélo. */
function howFar(p: Point) {
  const wrap = h('div', { class: 'how-far' });
  const show = (pos: Pos) => {
    const m = distance(pos, p) * DETOUR;
    clear(wrap,
      h('div', { class: 'how-far-res' },
        h('span', { class: 'how-far-item' }, icon('footprints', 16), h('strong', null, mins(m, WALK_KMH)), 'à pied'),
        h('span', { class: 'how-far-item' }, icon('bike', 16), h('strong', null, mins(m, BIKE_KMH)), 'à vélo'),
        h('span', { class: 'how-far-item muted' }, `≈ ${fmtDistance(m)}`),
      ),
      h('button', { class: 'link-btn', type: 'button', onclick: ask }, 'Actualiser'),
    );
  };
  const ask = async () => {
    clear(wrap, h('span', { class: 'how-far-wait' }, h('span', { class: 'spinner' }), 'Localisation…'));
    try {
      show(await getPosition(12000));
    } catch (e) {
      toast((e as Error).message, 'err', 4500);
      clear(wrap, button);
    }
  };
  const button = h('button', { class: 'btn btn-light btn-block', type: 'button', onclick: ask }, icon('locate-fixed', 18), 'À combien je suis ?');
  // Position déjà connue (récente) : on affiche directement l'estimation.
  const last = lastPosition();
  if (last) show(last); else wrap.append(button);
  return wrap;
}

/** Rajouter du temps à un flash : choix rapide de la durée. */
function openExtendFlash(p: Point) {
  const pick = (m: number) => { s.close(); act(() => api.extendFlash(p.id, m), `Flash prolongé de ${durLabel(m)}`); };
  const s = openSheet({
    title: 'Prolonger le flash',
    accent: paintOf(p).color,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, `« ${p.title} » se termine à ${time(p.endsAt!)}. Rajouter :`),
      h('div', { class: 'grid-3' }, [15, 30, 60].map((m) => h('button', { class: 'btn btn-outline', type: 'button', onclick: () => pick(m) }, `+ ${durLabel(m)}`))),
    ),
  });
}

export function directionsUrl(p: { lat: number; lng: number }) {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
}

export function scheduleText(p: Point): string | null {
  if (TYPES[p.type].alert) {
    return p.expiresAt && p.expiresAt > Date.now() ? `Signalé ${relative(p.createdAt)} · expire ${relative(p.expiresAt)}` : 'Alerte expirée';
  }
  if (p.mode !== 'event') return null;
  const occ = nextOccurrence(p);
  if (!occ) return 'Terminé';
  return rangeLabel(occ.start, occ.end);
}

export function openDetail(p: Point) {
  const meta = TYPES[p.type];
  const { color, ink } = paintOf(p);
  const canEdit = store.canEdit(p);
  const sched = scheduleText(p);

  const statuses = STATUSES[p.type];
  const statusRow = statuses ? h('div', { class: 'field' },
    p.type === 'blocage' ? h('span', { class: 'field-label' }, 'Sur place en ce moment') : null,
    h('div', { class: 'status-row' },
      statuses.map((s) => h('button', {
        class: `status-btn st-${s}${p.status === s ? ' on' : ''}`, type: 'button',
        onclick: async () => {
          try {
            const { point } = await api.setStatus(p.id, s);
            store.upsert(point);
            toast(`${meta.short} : ${STATUS_LABEL[s].toLowerCase()}`, 'ok');
            openDetail(point);
          } catch (e) { toast((e as ApiError).message, 'err'); }
        },
      }, s === 'colle' ? icon('check', 16) : null,
      STATUS_HINT[s] ? h('span', { class: 'status-two' }, h('b', null, STATUS_LABEL[s]), h('small', null, STATUS_HINT[s])) : STATUS_LABEL[s])),
    ),
    p.statusAt ? h('span', { class: 'field-hint' }, `Mis à jour ${relative(p.statusAt)}`) : null,
  ) : null;

  const parent = p.parentId ? store.points.find((x) => x.id === p.parentId) : null;
  const parentLine = parent ? h('button', { class: 'parent-line', type: 'button', onclick: () => openDetail(parent) },
    icon(TYPES[parent.type].icon, 16), h('span', null, 'Blocus : ', h('strong', null, parent.title)), icon('chevron-right', 16)) : null;

  const children = p.type === 'blocus' ? store.points.filter((x) => x.parentId === p.id) : [];
  const blocusSection = p.type === 'blocus' ? h('div', { class: 'card-section' },
    h('div', { class: 'section-title' }, icon('construction', 18), `Blocages (${children.length})`),
    children.length
      ? h('ul', { class: 'link-list' }, children
          .sort((a, b) => liveProblems(b).length - liveProblems(a).length || a.title.localeCompare(b.title))
          .map((c) => blocageRow(c, () => openDetail(c))))
      : h('p', { class: 'field-hint' }, 'Aucun blocage rattaché pour l\'instant.'),
    h('div', { class: 'grid-2' },
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { sheet.close(); newPointFlow('fixe', { type: 'blocage', parentId: p.id }); } }, icon('plus', 15), 'Nouveau blocage'),
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { sheet.close(); openAttachSheet(p); } }, icon('construction', 15), 'Rattacher'),
    ),
  ) : null;

  const inRoute = store.routeSelection.has(p.id);
  const actions = h('div', { class: 'detail-actions' },
    h('a', { class: 'btn btn-primary', href: directionsUrl(p), target: '_blank', rel: 'noopener' }, icon('navigation', 18), 'Y aller'),
    meta.routable ? h('button', { class: `btn ${inRoute ? 'btn-light' : 'btn-outline'}`, type: 'button', onclick: () => {
      if (inRoute) store.routeSelection.delete(p.id); else store.routeSelection.add(p.id);
      store.routeOrder = [];
      store.emit('route');
      toast(inRoute ? 'Retiré du trajet' : 'Ajouté au trajet de collage', 'ok');
      openDetail(p);
    } }, icon('route', 18), inRoute ? 'Retirer du trajet' : 'Ajouter au trajet') : null,
    meta.alert ? confirmButton('', 18, () => api.extend(p.id, 30), 'Alerte prolongée de 30 min') : null,
    canEdit && p.mode === 'event' && !meta.alert && isActive(p) && (nextOccurrence(p)?.start ?? Infinity) <= Date.now() ? h('button', { class: 'btn btn-light', type: 'button', onclick: async () => {
      const held = p.type === 'blocus' ? store.points.filter((x) => x.parentId === p.id && x.status === 'tenu').length : 0;
      const more = held ? ` ${held > 1 ? `Les ${held} blocages encore tenus passeront` : 'Le blocage encore tenu passera'} à « sans personne ».` : '';
      if (!(await confirmSheet('Terminer maintenant ?', `« ${p.title} » disparaîtra de la carte, mais restera visible dans l'agenda.${more}`, 'Terminer', false))) return;
      act(() => api.finish(p.id), 'Événement terminé');
    } }, icon('flag', 18), 'Terminer maintenant') : null,
    // Flash : l'auteur·rice (ou un admin) peut rajouter du temps tant qu'il n'est pas fini.
    canEdit && p.flash && (p.endsAt ?? 0) > Date.now() ? h('button', { class: 'btn btn-light', type: 'button', onclick: () => openExtendFlash(p) },
      icon('timer', 18), 'Prolonger') : null,
    canEdit ? h('button', { class: 'btn btn-light', type: 'button', onclick: () => { sheet.close(); editPoint(p); } }, icon('pencil', 18), 'Modifier') : null,
    canEdit ? h('button', { class: 'btn btn-light btn-text-danger', type: 'button', onclick: async () => {
      if (!(await confirmSheet('Supprimer ce point ?', `« ${p.title} » disparaîtra de la carte pour tout le monde.`, 'Supprimer'))) return;
      try {
        await api.deletePoint(p.id);
        store.remove(p.id);
        toast('Point supprimé', 'ok');
      } catch (e) { toast((e as ApiError).message, 'err'); }
    } }, icon('trash-2', 18), 'Supprimer') : null,
  );

  const body = h('div', { class: 'detail' },
    p.photo ? h('a', { href: photoUrl(p.photo), target: '_blank', rel: 'noopener', class: 'detail-photo' }, h('img', { src: photoUrl(p.photo), alt: `Photo : ${p.title}`, loading: 'lazy' })) : null,
    h('div', { class: 'detail-tags' },
      h('span', { class: 'tag', style: { background: color, color: ink } }, icon(iconOf(p), 15), meta.label),
      p.mode === 'fixe' ? h('span', { class: 'tag tag-outline' }, 'Point fixe') : null,
      p.flash ? h('span', { class: 'tag tag-flash' }, icon('zap', 14), 'Flash') : null,
      p.recurrence !== 'none' ? h('span', { class: 'tag tag-outline' }, icon('repeat', 14), RECURRENCE_LABEL[p.recurrence]) : null,
    ),
    h('h3', { class: 'detail-title' }, p.title),
    sched ? h('p', { class: `detail-when${meta.alert ? ' alert' : ''}` }, icon(meta.alert ? 'timer' : 'clock', 17), sched) : null,
    howFar(p),
    p.recurrence !== 'none' && p.recurrenceUntil ? h('p', { class: 'detail-meta' }, `Jusqu'au ${dateLong(p.recurrenceUntil)}`) : null,
    parentLine,
    liveProblems(p).map((pr) => problemCard(p, pr)),
    statusRow,
    blocusSection,
    p.description ? h('p', { class: 'detail-desc' }, p.description) : null,
    p.mode === 'event' && !meta.alert ? pledgeSection(p) : null,
    // AG : votes façon Kahoot (code à 5 chiffres, sur place).
    p.type === 'ag' ? votesSection(p) : null,
    // Un problème n'a de sens que sur un lieu tenu (blocage) : ailleurs, il ne dit pas où aller.
    !canReportProblem(p.type) ? null : h('button', { class: 'btn btn-outline-danger btn-block', type: 'button', onclick: () => { sheet.close(); openProblemForm(p); } },
      icon('circle-alert', 18), 'Signaler un problème ici'),
    actions,
    h('p', { class: 'detail-meta' }, `Ajouté par ${p.creatorName ?? 'un appareil retiré'} · ${relative(p.createdAt)}`),
  );

  const sheet = openSheet({ title: meta.short, body, accent: liveProblems(p).length ? '#F53B3B' : color });
  sheet.el.style.setProperty('--accent', color);
}
