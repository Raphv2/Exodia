import { api, photoUrl, ApiError } from './api';
import { store } from './store';
import { openSheet, confirmSheet } from './sheet';
import { editPoint, durLabel } from './forms';
import { h, icon, toast, rangeLabel, relative, inkFor, dateLong } from './ui';
import { TYPES, STATUS_LABEL, RECURRENCE_LABEL, colorOf, type Point, type PanneauStatus } from '../../shared/model';
import { nextOccurrence } from '../../shared/time';

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
  const color = colorOf(p);
  const ink = p.color ? inkFor(color) : meta.ink;
  const canEdit = store.canEdit(p);
  const sched = scheduleText(p);

  const statusRow = p.type === 'panneau' ? h('div', { class: 'status-row' },
    (Object.keys(STATUS_LABEL) as PanneauStatus[]).map((s) => h('button', {
      class: `status-btn st-${s}${p.status === s ? ' on' : ''}`, type: 'button',
      onclick: async () => {
        try {
          const { point } = await api.setStatus(p.id, s);
          store.upsert(point);
          toast(`Panneau : ${STATUS_LABEL[s].toLowerCase()}`, 'ok');
          openDetail(point);
        } catch (e) { toast((e as ApiError).message, 'err'); }
      },
    }, s === 'colle' ? icon('check', 16) : null, STATUS_LABEL[s])),
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
    meta.alert ? h('button', { class: 'btn btn-outline', type: 'button', onclick: async () => {
      try {
        const { point } = await api.extend(p.id, 30);
        store.upsert(point);
        toast('Alerte prolongée de 30 min', 'ok');
        openDetail(point);
      } catch (e) { toast((e as ApiError).message, 'err'); }
    } }, icon('timer', 18), `Toujours là (+${durLabel(30)})`) : null,
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
      h('span', { class: 'tag', style: { background: color, color: ink } }, icon(meta.icon, 15), meta.label),
      p.mode === 'fixe' ? h('span', { class: 'tag tag-outline' }, 'Point fixe') : null,
      p.recurrence !== 'none' ? h('span', { class: 'tag tag-outline' }, icon('repeat', 14), RECURRENCE_LABEL[p.recurrence]) : null,
    ),
    h('h3', { class: 'detail-title' }, p.title),
    sched ? h('p', { class: `detail-when${meta.alert ? ' alert' : ''}` }, icon(meta.alert ? 'timer' : 'clock', 17), sched) : null,
    p.recurrence !== 'none' && p.recurrenceUntil ? h('p', { class: 'detail-meta' }, `Jusqu'au ${dateLong(p.recurrenceUntil)}`) : null,
    statusRow,
    p.description ? h('p', { class: 'detail-desc' }, p.description) : null,
    actions,
    h('p', { class: 'detail-meta' }, `Ajouté par ${p.creatorName ?? 'un appareil retiré'} · ${relative(p.createdAt)}`),
  );

  const sheet = openSheet({ title: meta.short, body, accent: color });
  sheet.el.style.setProperty('--accent', color);
}
