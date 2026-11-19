import { api, compressImage, photoUrl, ApiError } from './api';
import { store } from './store';
import { openSheet, closeSheet } from './sheet';
import { pickLocation, flyTo, showMe } from './map';
import { getPosition, type Pos } from './geo';
import {
  h, icon, clear, toast, toDateInput, toTimeInput, fromInputs, addDays, startOfDay, inkFor,
} from './ui';
import {
  TYPES, TYPE_KEYS, COLOR_CHOICES, RECURRENCE_LABEL, STATUS_LABEL, ALERT_DURATIONS, ALERT_PRESETS,
  type Mode, type PointType, type Recurrence, type PanneauStatus, type Point, type PointInput,
} from '../../shared/model';

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

export function chips<T extends string | number>(options: { value: T; label: string }[], value: T | null, onChange: (v: T) => void, accent?: string) {
  const wrap = h('div', { class: 'chips', role: 'radiogroup' });
  const render = (v: T | null) => {
    wrap.replaceChildren(...options.map((o) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === v), class: `chip${o.value === v ? ' on' : ''}`,
      style: accent && o.value === v ? { background: accent, borderColor: accent, color: inkFor(accent) } : undefined,
      onclick: () => { render(o.value); onChange(o.value); },
    }, o.label)));
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
  status: PanneauStatus;
}

const FORM_TYPES = TYPE_KEYS.filter((t) => !TYPES[t].alert);
const EVENT_ORDER: PointType[] = ['tractage', 'ag', 'collage', 'materiel', 'local', 'autre'];

function draftFrom(p: Point | null, pos: Pos, mode: Mode = 'fixe'): Draft {
  const nextHour = new Date();
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  const s = p?.startsAt ?? nextHour.getTime();
  const e = p?.endsAt ?? s + 2 * 3600_000;
  return {
    id: p?.id,
    mode: p?.mode ?? mode,
    type: p?.type ?? (mode === 'fixe' ? 'panneau' : 'tractage'),
    title: p?.title ?? '',
    description: p?.description ?? '',
    lat: p?.lat ?? pos.lat,
    lng: p?.lng ?? pos.lng,
    color: p?.color ?? null,
    photo: { existing: p?.photo ?? null, blob: null },
    date: toDateInput(s),
    start: toTimeInput(s),
    end: toTimeInput(e),
    recurrence: p?.recurrence ?? 'none',
    until: p?.recurrenceUntil ? toDateInput(p.recurrenceUntil) : '',
    status: p?.status ?? 'a_coller',
  };
}

export async function newPointFlow(mode: Mode = 'fixe') {
  const pos = await pickLocation({ title: 'Nouveau point', color: '#7B13D6' });
  if (!pos) return;
  openPointForm(draftFrom(null, pos, mode));
}

export function editPoint(p: Point) {
  if (TYPES[p.type].alert) return openAlertForm(p.type as 'warning' | 'danger', p);
  openPointForm(draftFrom(p, p));
}

function openPointForm(d: Draft) {
  const isEdit = !!d.id;
  const body = h('div', { class: 'form' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('check', 20), h('span', null, isEdit ? 'Enregistrer' : 'Ajouter le point')) as HTMLButtonElement;

  const render = () => {
    const typesForMode = (d.mode === 'event' ? EVENT_ORDER : FORM_TYPES).filter((t) => TYPES[t].modes.includes(d.mode));
    if (!typesForMode.includes(d.type)) d.type = typesForMode[0];
    const meta = TYPES[d.type];
    const color = d.color ?? TYPES[d.type].color;
    sheet.el.style.setProperty('--accent', color);

    const typeGrid = h('div', { class: 'type-grid' }, typesForMode.map((t) => h('button', {
      type: 'button', class: `type-tile${t === d.type ? ' on' : ''}`, style: { '--c': TYPES[t].color, '--ink': TYPES[t].ink } as Record<string, string>,
      'aria-pressed': String(t === d.type),
      onclick: () => { d.type = t; d.color = null; render(); },
    }, h('span', { class: 'type-ico' }, icon(TYPES[t].icon, 22)), h('span', { class: 'type-label' }, TYPES[t].short))));

    const title = h('input', { class: 'input', type: 'text', maxlength: '80', value: d.title, placeholder: meta.placeholder, autocomplete: 'off', oninput: (e: Event) => (d.title = (e.target as HTMLInputElement).value) });
    const desc = h('textarea', { class: 'input', rows: '3', maxlength: '2000', placeholder: 'Infos utiles : accès, consignes, contact…', oninput: (e: Event) => (d.description = (e.target as HTMLTextAreaElement).value) }, d.description);

    const schedule = d.mode === 'event' ? h('div', { class: 'card-section' },
      h('div', { class: 'section-title' }, icon('clock', 18), 'Quand ?'),
      h('div', { class: 'grid-3' },
        field('Date', h('input', { class: 'input', type: 'date', value: d.date, required: true, onchange: (e: Event) => (d.date = (e.target as HTMLInputElement).value) })),
        field('Début', h('input', { class: 'input', type: 'time', value: d.start, step: '300', onchange: (e: Event) => (d.start = (e.target as HTMLInputElement).value) })),
        field('Fin', h('input', { class: 'input', type: 'time', value: d.end, step: '300', onchange: (e: Event) => (d.end = (e.target as HTMLInputElement).value) })),
      ),
      group('Répéter', chips((Object.keys(RECURRENCE_LABEL) as Recurrence[]).map((r) => ({ value: r, label: RECURRENCE_LABEL[r] })), d.recurrence, (v) => { d.recurrence = v; render(); }, color)),
      d.recurrence !== 'none'
        ? field('Jusqu\'au', h('input', { class: 'input', type: 'date', value: d.until, min: d.date, onchange: (e: Event) => (d.until = (e.target as HTMLInputElement).value) }), 'Laisse vide pour répéter sans fin.', true)
        : null,
    ) : null;

    const status = d.type === 'panneau' ? group('État du panneau', chips((Object.keys(STATUS_LABEL) as PanneauStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })), d.status, (v) => (d.status = v), color)) : null;

    const colors = h('div', { class: 'swatches' },
      [null, ...COLOR_CHOICES.filter((c) => c !== TYPES[d.type].color)].map((c) => h('button', {
        type: 'button', class: `swatch${(d.color ?? null) === c ? ' on' : ''}`, style: { background: c ?? TYPES[d.type].color },
        'aria-label': c ? `Couleur ${c}` : 'Couleur du type', title: c ? c : 'Couleur du type',
        onclick: () => { d.color = c; render(); },
      }, c === null ? h('span', { class: 'swatch-auto' }, 'auto') : null)));

    clear(body,
      segmented<Mode>([
        { value: 'fixe', label: 'Point fixe', icon: 'map-pin' },
        { value: 'event', label: 'Événement', icon: 'calendar' },
      ], d.mode, (m) => { d.mode = m; render(); }, 'seg-big'),
      group('Type', typeGrid),
      field('Titre', title),
      schedule,
      status,
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
      lat: d.lat, lng: d.lng, color: d.color, status: d.type === 'panneau' ? d.status : null,
    };
    if (d.mode === 'event') {
      if (!d.date || !d.start || !d.end) return toast('Indique la date, l\'heure de début et de fin.', 'err');
      const s = fromInputs(d.date, d.start);
      let e = fromInputs(d.date, d.end);
      if (e <= s) e = addDays(e, 1); // fin après minuit
      input.startsAt = s;
      input.endsAt = e;
      input.recurrence = d.recurrence;
      input.recurrenceUntil = d.recurrence !== 'none' && d.until ? addDays(startOfDay(fromInputs(d.until, '00:00')), 1) - 1 : null;
    }
    busy(submit, true, 'Envoi…');
    try {
      input.photo = await uploadIfNeeded(d.photo);
      const { point } = d.id ? await api.updatePoint(d.id, input) : await api.createPoint(input);
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

// ---------- Alerte rapide : warning / danger ----------

export function openAlertForm(type: 'warning' | 'danger', existing?: Point, presetPos?: Pos) {
  const meta = TYPES[type];
  const state = {
    pos: (existing ? { lat: existing.lat, lng: existing.lng } : presetPos ?? null) as Pos | null,
    source: existing || presetPos ? 'map' : 'gps',
    locating: false,
    duration: 30 as number,
    title: existing?.title ?? ALERT_PRESETS[type][0],
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

  clear(body,
    locCard,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Quoi ?'),
      chips(ALERT_PRESETS[type].map((p) => ({ value: p, label: p })), ALERT_PRESETS[type].includes(state.title) ? state.title : null, (v) => { state.title = v; titleInput.value = v; }, meta.color),
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
      const { point } = existing ? await api.updatePoint(existing.id, input) : await api.createPoint(input);
      store.upsert(point);
      sheet.close();
      toast(existing ? 'Alerte mise à jour' : `${meta.label} signalé pour ${durLabel(state.duration)}`, 'ok');
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
