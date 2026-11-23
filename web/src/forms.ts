import { api, compressImage, photoUrl, ApiError } from './api';
import { store, spaceColor } from './store';
import { openSheet, closeSheet } from './sheet';
import { pickLocation, flyTo, showMe } from './map';
import { getPosition, type Pos } from './geo';
import {
  h, icon, clear, toast, toDateInput, toTimeInput, fromInputs, addDays, startOfDay, inkFor, isAllDay,
} from './ui';
import {
  TYPES, ALERT_ICONS, materialPresets, FLASH_STARTS, FLASH_DURATIONS, COLOR_CHOICES, RECURRENCE_LABEL, STATUS_LABEL, STATUS_HINT, STATUSES, ALERT_DURATIONS, alertPresets, typeInSpace,
  type Mode, type PointType, type Recurrence, type PointStatus, type Point, type PointInput, type AlertType,
} from '../../shared/model';
import { isActive, nextOccurrence } from '../../shared/time';

// ---------- Petits composants de formulaire ----------

export function segmented<T extends string>(options: { value: T; label: string; icon?: string }[], value: T, onChange: (v: T) => void, cls = '') {
  const wrap = h('div', { class: `seg ${cls}`, role: 'radiogroup' });
  const render = (v: T) => {
    wrap.replaceChildren(...options.map((o) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === v), class: `seg-btn${o.value === v ? ' on' : ''}`,
      onclick: () => { render(o.value); onChange(o.value); },
    }, o.icon ? icon(o.icon, 18) : null, h('span', null, o.label))));
  };
  render(value);
  return wrap;
}

export function chips<T extends string | number>(options: { value: T; label: string; icon?: string }[], value: T | null, onChange: (v: T) => void, accent?: string) {
  const wrap = h('div', { class: 'chips', role: 'radiogroup' });
  const render = (v: T | null) => {
    wrap.replaceChildren(...options.map((o) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === v), class: `chip${o.value === v ? ' on' : ''}`,
      style: accent && o.value === v ? { background: accent, borderColor: accent, color: inkFor(accent) } : undefined,
      onclick: () => { render(o.value); onChange(o.value); },
    }, o.icon ? icon(o.icon, 16) : null, o.label)));
  };
  render(value);
  return wrap;
}

export const field = (label: string, control: Node, hint?: string, optional = false) =>
  h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label, optional ? h('em', null, ' · facultatif') : null),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );

/** Liste de matériel : puces à cocher (suggestions du type + ajouts) et champ pour en ajouter. */
function materialPicker(d: { type: PointType; material: string[] }, accent: string) {
  const wrap = h('div', { class: 'material-pick' });
  const render = () => {
    const suggestions = materialPresets(d.type, store.space);
    const all = [...suggestions, ...d.material.filter((m) => !suggestions.includes(m))];
    const input = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'Autre chose ?', enterkeyhint: 'done' }) as HTMLInputElement;
    const add = () => {
      const v = input.value.trim();
      if (v && !d.material.some((m) => m.toLowerCase() === v.toLowerCase()) && d.material.length < 20) d.material.push(v);
      render();
      (wrap.querySelector('input') as HTMLInputElement | null)?.focus();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    wrap.replaceChildren(
      h('div', { class: 'chips' }, all.map((m) => {
        const on = d.material.includes(m);
        return h('button', {
          type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on),
          style: on ? { background: accent, borderColor: accent, color: inkFor(accent) } : undefined,
          onclick: () => { d.material = on ? d.material.filter((x) => x !== m) : [...d.material, m]; render(); },
        }, on ? icon('check', 15) : null, m);
      })),
      h('div', { class: 'material-add' }, input,
        h('button', { type: 'button', class: 'btn btn-small btn-light', 'aria-label': 'Ajouter ce matériel', onclick: add }, icon('plus', 16))),
    );
  };
  render();
  return wrap;
}

const group = (label: string, ...content: Node[]) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), ...content);

/** Zone photo : prise de vue ou galerie, aperçu, suppression. */
function photoPicker(current: { existing: string | null; blob: Blob | null }, onChange: () => void) {
  const wrap = h('div', { class: 'photo-pick' });
  const input = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', 'aria-label': 'Ajouter une photo' }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      current.blob = await compressImage(f);
      current.existing = null;
      onChange();
      render();
    } catch {
      toast('Impossible de lire cette image.', 'err');
    }
  });
  const render = () => {
    const src = current.blob ? URL.createObjectURL(current.blob) : current.existing ? photoUrl(current.existing) : null;
    if (src) {
      wrap.replaceChildren(
        h('img', { src, alt: 'Aperçu de la photo', class: 'photo-preview' }),
        h('div', { class: 'photo-actions' },
          h('button', { type: 'button', class: 'btn btn-small btn-light', onclick: () => input.click() }, icon('camera', 16), 'Changer'),
          h('button', { type: 'button', class: 'btn btn-small btn-light', onclick: () => { current.blob = null; current.existing = null; onChange(); render(); } }, icon('trash-2', 16), 'Retirer'),
        ),
        input,
      );
    } else {
      wrap.replaceChildren(
        h('button', { type: 'button', class: 'photo-empty', onclick: () => input.click() },
          icon('camera', 26), h('strong', null, 'Ajouter une photo'), h('span', null, 'Appareil photo ou galerie')),
        input,
      );
    }
  };
  render();
  return wrap;
}

function busy(btn: HTMLButtonElement, on: boolean, label?: string) {
  btn.disabled = on;
  btn.classList.toggle('loading', on);
  if (label) btn.querySelector('span')!.textContent = label;
}

async function uploadIfNeeded(ph: { existing: string | null; blob: Blob | null }) {
  if (ph.blob) return (await api.uploadPhoto(ph.blob)).photo;
  return ph.existing;
}

// ---------- Formulaire de point (fixe / événement) ----------

interface Draft {
  id?: string;
  mode: Mode;
  type: PointType;
  title: string;
  description: string;
  lat: number;
  lng: number;
  color: string | null;
  photo: { existing: string | null; blob: Blob | null };
  date: string;
  start: string;
  end: string;
  recurrence: Recurrence;
  until: string;
  status: PointStatus;
  /** Blocage : blocus auquel il est rattaché. */
  parentId: string | null;
  /** Événement : matériel à prévoir. */
  material: string[];
  /** AG côté Mouvement annoncée publiquement (visible sans compte). */
  isPublic: boolean;
  /** Flash : événement improvisé (commence dans `flashIn` min, dure `flashDur` min). */
  flash: boolean;
  flashIn: number;
  flashDur: number;
  allDay: boolean;
  /** L'utilisateur a choisi lui-même « toute la journée » ou non. */
  allDayTouched: boolean;
}

const FIXE_ORDER: PointType[] = ['panneau', 'blocage', 'collage', 'materiel', 'local', 'autre'];
const EVENT_ORDER: PointType[] = ['rassemblement', 'blocus', 'tractage', 'ag', 'collage', 'materiel', 'local', 'autre'];

/** Blocus pas encore terminés, celui en cours d'abord. */
export function activeBlocus(): Point[] {
  const now = Date.now();
  return store.points
    .filter((p) => p.type === 'blocus' && isActive(p, now))
    .sort((a, b) => (nextOccurrence(a, now)?.start ?? Infinity) - (nextOccurrence(b, now)?.start ?? Infinity));
}

export interface Preset { type?: PointType; parentId?: string | null }

/** Ce que propose le haut du formulaire : un flash est un événement improvisé. */
export type FormMode = Mode | 'flash';

function draftFrom(p: Point | null, pos: Pos, formMode: FormMode = 'fixe', preset: Preset = {}): Draft {
  const mode: Mode = formMode === 'fixe' ? 'fixe' : 'event';
  const nextHour = new Date();
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  const s = p?.startsAt ?? nextHour.getTime();
  const e = p?.endsAt ?? s + 2 * 3600_000;
  const allDay = p ? p.mode === 'event' && isAllDay(s, e) : false;
  return {
    allDay,
    allDayTouched: !!p,
    id: p?.id,
    mode: p?.mode ?? mode,
    type: p?.type ?? preset.type ?? (mode === 'fixe' ? 'panneau' : 'tractage'),
    title: p?.title ?? '',
    description: p?.description ?? '',
    lat: p?.lat ?? pos.lat,
    lng: p?.lng ?? pos.lng,
    color: p?.color ?? null,
    photo: { existing: p?.photo ?? null, blob: null },
    date: toDateInput(s),
    start: allDay ? '09:00' : toTimeInput(s),
    end: allDay ? '18:00' : toTimeInput(e),
    recurrence: p?.recurrence ?? 'none',
    until: p?.recurrenceUntil ? toDateInput(p.recurrenceUntil) : '',
    status: p?.status ?? 'a_coller',
    parentId: p ? p.parentId : preset.parentId !== undefined ? preset.parentId : activeBlocus()[0]?.id ?? null,
    material: [...(p?.material ?? [])],
    isPublic: p?.isPublic ?? false,
    flash: p ? p.flash : formMode === 'flash',
    flashIn: 15,
    flashDur: 60,
  };
}

export async function newPointFlow(mode: FormMode = 'fixe', preset: Preset = {}) {
  const color = preset.type ? TYPES[preset.type].color : spaceColor();
  const pos = await pickLocation({ title: preset.type ? `Nouveau ${TYPES[preset.type].label.toLowerCase()}` : 'Nouveau point', color });
  if (!pos) return;
  openPointForm(draftFrom(null, pos, mode, preset));
}

export function editPoint(p: Point) {
  if (TYPES[p.type].alert) return openAlertForm(p.type as AlertType, p);
  openPointForm(draftFrom(p, p));
}

function openPointForm(d: Draft) {
  const isEdit = !!d.id;
  const body = h('div', { class: 'form' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('check', 20), h('span', null, isEdit ? 'Enregistrer' : 'Ajouter le point')) as HTMLButtonElement;

  const render = () => {
    // Seulement les types de l'espace en cours (rien du collage côté Mouvement, rien des blocus côté LFI).
    const typesForMode = (d.mode === 'event' ? EVENT_ORDER : FIXE_ORDER).filter((t) => TYPES[t].modes.includes(d.mode) && typeInSpace(t, store.space));
    if (!typesForMode.includes(d.type)) d.type = typesForMode[0];
    const statuses = STATUSES[d.type];
    if (statuses && !statuses.includes(d.status)) d.status = statuses[0];
    if (!d.allDayTouched) d.allDay = !!TYPES[d.type].allDay;
    const meta = TYPES[d.type];
    const color = d.color ?? TYPES[d.type].color;
    sheet.el.style.setProperty('--accent', color);

    const typeGrid = h('div', { class: 'type-grid' }, typesForMode.map((t) => h('button', {
      type: 'button', class: `type-tile${t === d.type ? ' on' : ''}`, style: { '--c': TYPES[t].color, '--ink': TYPES[t].ink } as Record<string, string>,
      'aria-pressed': String(t === d.type),
      onclick: () => {
        d.type = t;
        d.color = null;
        if (!d.allDayTouched) d.allDay = !!TYPES[t].allDay;
        render();
      },
    }, h('span', { class: 'type-ico' }, icon(TYPES[t].icon, 22)), h('span', { class: 'type-label' }, TYPES[t].short))));

    const title = h('input', { class: 'input', type: 'text', maxlength: '80', value: d.title, placeholder: meta.placeholder, autocomplete: 'off', oninput: (e: Event) => (d.title = (e.target as HTMLInputElement).value) });
    const desc = h('textarea', { class: 'input', rows: '3', maxlength: '2000', placeholder: 'Infos utiles : accès, consignes, contact…', oninput: (e: Event) => (d.description = (e.target as HTMLTextAreaElement).value) }, d.description);

    // Flash (à la création) : pas de date à saisir, juste « dans combien de temps » et « combien de temps ».
    const flashSchedule = d.mode === 'event' && d.flash && !isEdit ? h('div', { class: 'card-section flash-section' },
      h('div', { class: 'section-title' }, icon('zap', 18), 'Flash'),
      group('Ça commence', chips(FLASH_STARTS.map((m) => ({ value: m as number, label: m === 0 ? 'Maintenant' : `Dans ${durLabel(m)}` })), d.flashIn, (v) => (d.flashIn = v), color)),
      group('Durée', chips(FLASH_DURATIONS.map((m) => ({ value: m as number, label: durLabel(m) })), d.flashDur, (v) => (d.flashDur = v), color)),
      h('p', { class: 'field-hint' }, 'Tout le monde reçoit une notification dès que tu valides.'),
    ) : null;

    const schedule = flashSchedule ?? (d.mode === 'event' ? h('div', { class: 'card-section' },
      h('div', { class: 'section-title' }, icon('clock', 18), 'Quand ?'),
      h('label', { class: 'toggle-line' },
        h('input', { type: 'checkbox', checked: d.allDay, onchange: (e: Event) => { d.allDay = (e.target as HTMLInputElement).checked; d.allDayTouched = true; render(); } }),
        h('span', { class: 'switch' }), 'Toute la journée'),
      h('div', { class: d.allDay ? 'grid-1' : 'grid-3' },
        field('Date', h('input', { class: 'input', type: 'date', value: d.date, required: true, onchange: (e: Event) => (d.date = (e.target as HTMLInputElement).value) })),
        d.allDay ? null : field('Début', h('input', { class: 'input', type: 'time', value: d.start, step: '300', onchange: (e: Event) => (d.start = (e.target as HTMLInputElement).value) })),
        d.allDay ? null : field('Fin', h('input', { class: 'input', type: 'time', value: d.end, step: '300', onchange: (e: Event) => (d.end = (e.target as HTMLInputElement).value) })),
      ),
      d.allDay ? h('p', { class: 'field-hint' }, 'Visible sur la carte jusqu\'à minuit, puis le point disparaît tout seul.') : null,
      d.flash ? null : group('Répéter', chips((Object.keys(RECURRENCE_LABEL) as Recurrence[]).map((r) => ({ value: r, label: RECURRENCE_LABEL[r] })), d.recurrence, (v) => { d.recurrence = v; render(); }, color)),
      !d.flash && d.recurrence !== 'none'
        ? field('Jusqu\'au', h('input', { class: 'input', type: 'date', value: d.until, min: d.date, onchange: (e: Event) => (d.until = (e.target as HTMLInputElement).value) }), 'Laisse vide pour répéter sans fin.', true)
        : null,
    ) : null);

    const status = statuses ? group(d.type === 'blocage' ? 'Sur place en ce moment' : 'État du panneau',
      chips(statuses.map((s) => ({ value: s, label: STATUS_HINT[s] ? `${STATUS_LABEL[s]} · ${STATUS_HINT[s]}` : STATUS_LABEL[s] })), d.status, (v) => (d.status = v), color)) : null;

    const blocusList = d.type === 'blocage' ? activeBlocus() : [];
    // Garder le blocus déjà choisi même s'il est terminé (modification d'un ancien blocage).
    const current = d.parentId ? store.points.find((x) => x.id === d.parentId) : null;
    if (current && !blocusList.includes(current)) blocusList.unshift(current);
    const blocus = d.type === 'blocage' ? h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Blocus', h('em', null, ' · facultatif')),
      blocusList.length
        ? chips<string>([...blocusList.map((b) => ({ value: b.id, label: b.title })), { value: '', label: 'Aucun' }], d.parentId ?? '', (v) => (d.parentId = v || null), color)
        : h('p', { class: 'field-hint' }, 'Aucun blocus prévu pour l\'instant. Tu pourras rattacher ce blocage depuis la fiche d\'un blocus.'),
      blocusList.length ? h('span', { class: 'field-hint' }, 'À la fin du blocus, s\'il est encore « tenu », le blocage passe tout seul à « sans personne ».') : null,
    ) : null;

    // La couleur du type est la première : la choisir revient à ne pas personnaliser (null).
    const typeColor = TYPES[d.type].color;
    const colors = h('div', { class: 'swatches' },
      [typeColor, ...COLOR_CHOICES.filter((c) => c.toLowerCase() !== typeColor.toLowerCase())].map((c) => {
        const on = (d.color ?? typeColor).toLowerCase() === c.toLowerCase();
        return h('button', {
          type: 'button', class: `swatch${on ? ' on' : ''}`, style: { background: c },
          'aria-label': c === typeColor ? 'Couleur du type' : `Couleur ${c}`, 'aria-pressed': String(on),
          onclick: () => { d.color = c === typeColor ? null : c; render(); },
        });
      }));

    clear(body,
      segmented<FormMode>([
        { value: 'fixe', label: 'Point fixe', icon: 'map-pin' },
        { value: 'event', label: 'Événement', icon: 'calendar' },
        { value: 'flash', label: 'Flash', icon: 'zap' },
      ], d.mode === 'event' && d.flash ? 'flash' : d.mode, (m) => {
        d.mode = m === 'fixe' ? 'fixe' : 'event';
        d.flash = m === 'flash';
        if (d.flash) d.recurrence = 'none';
        render();
      }, 'seg-big seg-3'),
      group('Type', typeGrid),
      field('Titre', title),
      schedule,
      d.mode === 'event' ? h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Matériel nécessaire', h('em', null, ' · facultatif')),
        materialPicker(d, color)) : null,
      // AG côté Mouvement : l'annoncer publiquement (décoché par défaut, pour qu'une AG interne ne fuie pas).
      d.mode === 'event' && d.type === 'ag' && store.space === 'mvt' ? h('div', { class: 'field' },
        h('label', { class: 'toggle-line' },
          h('input', { type: 'checkbox', checked: d.isPublic, onchange: (e: Event) => (d.isPublic = (e.target as HTMLInputElement).checked) }),
          h('span', { class: 'switch' }), 'Annoncer publiquement'),
        h('span', { class: 'field-hint' }, 'Visible sans compte (titre, lieu, horaire, description), depuis « Archive publique » sur la page d\'accueil.')) : null,
      status,
      blocus,
      group('Photo', photoPicker(d.photo, () => {})),
      field('Description', desc, undefined, true),
      group('Couleur du point', colors),
      h('div', { class: 'loc-line' },
        icon('map-pin', 16), h('span', null, `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`),
        h('button', { type: 'button', class: 'link-btn', onclick: async () => {
          sheet.close();
          const pos = await pickLocation({ title: 'Déplacer le point', color, initial: d });
          if (pos) { d.lat = pos.lat; d.lng = pos.lng; }
          openPointForm(d);
        } }, 'Déplacer'),
      ),
    );
  };

  submit.onclick = async () => {
    if (!d.title.trim()) d.title = TYPES[d.type].label;
    const input: PointInput = {
      mode: d.mode, type: d.type, title: d.title.trim(), description: d.description.trim() || null,
      lat: d.lat, lng: d.lng, color: d.color, status: STATUSES[d.type] ? d.status : null,
      parentId: d.type === 'blocage' ? d.parentId : null,
      material: d.mode === 'event' ? d.material : [],
      isPublic: d.type === 'ag' && store.space === 'mvt' && d.isPublic,
      flash: d.mode === 'event' && d.flash,
    };
    if (d.mode === 'event' && d.flash && !isEdit) {
      const s = new Date(Date.now() + d.flashIn * 60_000);
      s.setSeconds(0, 0);
      input.startsAt = s.getTime();
      input.endsAt = input.startsAt + d.flashDur * 60_000;
      input.recurrence = 'none';
      input.recurrenceUntil = null;
    } else if (d.mode === 'event') {
      if (!d.date || (!d.allDay && (!d.start || !d.end))) return toast('Indique la date, l\'heure de début et de fin.', 'err');
      let s: number, e: number;
      if (d.allDay) {
        s = startOfDay(fromInputs(d.date, '00:00'));
        e = addDays(s, 1) - 1; // 23:59:59
      } else {
        s = fromInputs(d.date, d.start);
        e = fromInputs(d.date, d.end);
        if (e <= s) e = addDays(e, 1); // fin après minuit
      }
      input.startsAt = s;
      input.endsAt = e;
      input.recurrence = d.recurrence;
      input.recurrenceUntil = d.recurrence !== 'none' && d.until ? addDays(startOfDay(fromInputs(d.until, '00:00')), 1) - 1 : null;
    }
    busy(submit, true, 'Envoi…');
    try {
      input.photo = await uploadIfNeeded(d.photo);
      const { point } = d.id ? await api.updatePoint(d.id, input) : await api.createPoint({ ...input, space: store.space });
      store.upsert(point);
      sheet.close();
      toast(isEdit ? 'Point mis à jour' : 'Point ajouté sur la carte', 'ok');
      flyTo(point, 16);
    } catch (e) {
      toast((e as ApiError).message, 'err', 5000);
      busy(submit, false, isEdit ? 'Enregistrer' : 'Ajouter le point');
    }
  };

  const sheet = openSheet({ title: isEdit ? 'Modifier le point' : 'Nouveau point', body, footer: submit });
  render();
}

// ---------- Alerte rapide : warning / danger / police ----------

export function openAlertForm(type: AlertType, existing?: Point, presetPos?: Pos) {
  const meta = TYPES[type];
  const state = {
    pos: (existing ? { lat: existing.lat, lng: existing.lng } : presetPos ?? null) as Pos | null,
    source: existing || presetPos ? 'map' : 'gps',
    locating: false,
    duration: 30 as number,
    title: existing?.title ?? alertPresets(type, store.space)[0] ?? meta.label,
    description: existing?.description ?? '',
    photo: { existing: existing?.photo ?? null, blob: null as Blob | null },
  };

  const body = h('div', { class: 'form' });
  const submit = h('button', { class: `btn btn-block btn-${type}`, type: 'button' }, icon(meta.icon, 20), h('span', null, '')) as HTMLButtonElement;
  const setSubmitLabel = () => (submit.querySelector('span')!.textContent = existing ? 'Enregistrer' : `Signaler · ${durLabel(state.duration)}`);

  const locCard = h('div', { class: 'loc-card' });
  const renderLoc = () => {
    const status = state.locating
      ? h('div', { class: 'loc-status' }, h('span', { class: 'spinner' }), h('span', null, 'Localisation en cours…'))
      : state.pos
        ? h('div', { class: 'loc-status ok' }, icon('locate-fixed', 20),
            h('div', null, h('strong', null, state.source === 'gps' ? 'Ma position actuelle' : 'Emplacement choisi'),
              h('span', null, state.pos.accuracy ? `précision ± ${Math.round(state.pos.accuracy)} m` : `${state.pos.lat.toFixed(5)}, ${state.pos.lng.toFixed(5)}`)))
        : h('div', { class: 'loc-status err' }, icon('map-pin', 20), h('span', null, 'Position inconnue'));
    locCard.replaceChildren(status, h('div', { class: 'loc-actions' },
      h('button', { type: 'button', class: 'btn btn-small btn-light', onclick: locate }, icon('locate-fixed', 16), 'Ma position'),
      h('button', { type: 'button', class: 'btn btn-small btn-light', onclick: chooseOnMap }, icon('crosshair', 16), 'Sur la carte'),
    ));
  };

  const locate = async () => {
    state.locating = true;
    renderLoc();
    try {
      state.pos = await getPosition(12000);
      state.source = 'gps';
      showMe(state.pos);
    } catch (e) {
      toast((e as Error).message, 'err', 4500);
    }
    state.locating = false;
    renderLoc();
  };

  const chooseOnMap = async () => {
    sheet.close();
    const pos = await pickLocation({ title: `Où est le ${meta.label.toLowerCase()} ?`, color: meta.color, initial: state.pos });
    openAlertForm(type, existing, pos ?? state.pos ?? undefined);
  };

  const titleInput = h('input', { class: 'input', type: 'text', maxlength: '80', value: state.title, oninput: (e: Event) => (state.title = (e.target as HTMLInputElement).value) }) as HTMLInputElement;

  // Depuis le bouton Danger : choisir entre un danger « classique » et la présence de police / CRS.
  // Police / CRS n'existe que côté Mouvement.
  const switchToPolice = !existing && (type === 'danger' || type === 'police') && typeInSpace('police', store.space) ? segmented<AlertType>([
    { value: 'danger', label: 'Danger', icon: 'siren' },
    { value: 'police', label: 'Police / CRS', icon: 'police' },
  ], type, (t) => { sheet.close(); openAlertForm(t, undefined, state.pos ?? undefined); }, `seg-alert seg-${type}`) : null;

  clear(body,
    switchToPolice,
    locCard,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Quoi ?'),
      chips(alertPresets(type, store.space).map((p) => ({ value: p, label: p, icon: ALERT_ICONS[type][p] })), alertPresets(type, store.space).includes(state.title) ? state.title : null, (v) => { state.title = v; titleInput.value = v; }, meta.color),
      titleInput),
    existing ? null : h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Visible pendant'),
      chips(ALERT_DURATIONS.map((m) => ({ value: m, label: durLabel(m) })), state.duration, (v) => { state.duration = v; setSubmitLabel(); }, meta.color)),
    h('details', { class: 'more', open: !!(state.description || state.photo.existing) },
      h('summary', null, 'Ajouter une photo ou des précisions'),
      h('div', { class: 'form' },
        photoPicker(state.photo, () => {}),
        h('textarea', { class: 'input', rows: '3', maxlength: '2000', placeholder: 'Précisions (facultatif)', oninput: (e: Event) => (state.description = (e.target as HTMLTextAreaElement).value) }, state.description),
      ),
    ),
  );

  submit.onclick = async () => {
    if (!state.pos) return toast('Indique d\'abord où se trouve l\'alerte.', 'err');
    const input: PointInput = {
      mode: 'event', type, title: state.title.trim() || meta.label, description: state.description.trim() || null,
      lat: state.pos.lat, lng: state.pos.lng, durationMinutes: existing ? undefined : state.duration,
    };
    busy(submit, true, 'Envoi…');
    try {
      input.photo = await uploadIfNeeded(state.photo);
      const { point } = existing ? await api.updatePoint(existing.id, input) : await api.createPoint({ ...input, space: store.space });
      store.upsert(point);
      sheet.close();
      toast(existing ? 'Alerte mise à jour' : `${meta.label} signalé${type === 'police' ? 'e' : ''} pour ${durLabel(state.duration)}`, 'ok');
      flyTo(point, 16);
    } catch (e) {
      toast((e as ApiError).message, 'err', 5000);
      busy(submit, false);
      setSubmitLabel();
    }
  };

  const sheet = openSheet({ title: existing ? `Modifier · ${meta.label}` : `Signaler · ${meta.label}`, body, footer: submit, accent: meta.color });
  sheet.el.classList.add(`sheet-${type}`);
  sheet.el.style.setProperty('--accent', meta.color);
  setSubmitLabel();
  renderLoc();
  if (!state.pos) locate();
}

export const durLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

export { closeSheet };
