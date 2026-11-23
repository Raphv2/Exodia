import L from 'leaflet';
import { api, archiveFileUrl, compressImage, ApiError } from './api';
import { store } from './store';
import { openSheet, confirmSheet } from './sheet';
import { chips, segmented } from './forms';
import { resultBars } from './votes';
import { addBasemap } from './basemap';
import { h, icon, clear, toast, dateLong, dayLong, time, toDateInput, fromInputs } from './ui';
import { ARCHIVE_KIND_LABEL, TYPES, type ArchiveItem, type PointType, type PublicAg, type RegistryEntry } from '../../shared/model';

/*
 * Archive (côté Mouvement) : documents datés (photo, PDF, copie de mail, note), privés ou publics,
 * et un registre automatique des événements passés et des votes clos.
 */

const KIND_ICON: Record<ArchiveItem['kind'], string> = { document: 'file-text', image: 'image', mail: 'mail', note: 'sticky-note' };
const MAX_FILE = 15 * 1024 * 1024;
const fmtMonth = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
const monthOf = (t: number) => { const s = fmtMonth.format(t); return s.charAt(0).toUpperCase() + s.slice(1); };

export type Entry = { date: number; item?: ArchiveItem; reg?: RegistryEntry };
type Filter = 'all' | 'docs' | 'events' | 'votes';

/** Carte d'un document d'archive (aussi utilisée sur la page publique). */
export function itemCard(it: ArchiveItem, opts: { editable: boolean; onChange?: () => void }) {
  const body = it.body ? h('p', { class: 'arch-body' }, it.body) : null;
  const long = !!it.body && it.body.length > 280;
  if (body && long) body.classList.add('clamped');
  return h('article', { class: `arch-card arch-${it.kind}` },
    h('div', { class: 'arch-head' },
      h('span', { class: 'arch-ico' }, icon(KIND_ICON[it.kind], 18)),
      h('div', { class: 'arch-main' },
        h('span', { class: 'arch-meta' }, `${ARCHIVE_KIND_LABEL[it.kind]} · ${dateLong(it.date)}`),
        h('strong', { class: 'arch-title' }, it.title)),
      h('span', { class: `arch-vis ${it.visibility}`, title: it.visibility === 'public' ? 'Visible sans compte' : 'Membres seulement' },
        icon(it.visibility === 'public' ? 'globe' : 'lock', 13), it.visibility === 'public' ? 'Public' : 'Privé'),
    ),
    it.file && it.fileType && ['jpg', 'png', 'webp'].includes(it.fileType)
      ? h('a', { class: 'arch-img', href: archiveFileUrl(it.file), target: '_blank', rel: 'noopener' }, h('img', { src: archiveFileUrl(it.file), alt: it.title, loading: 'lazy' }))
      : null,
    body,
    long ? h('button', { class: 'link-btn', type: 'button', onclick: (e: Event) => { body!.classList.toggle('clamped'); (e.currentTarget as HTMLElement).textContent = body!.classList.contains('clamped') ? 'Lire la suite' : 'Réduire'; } }, 'Lire la suite') : null,
    it.file && it.fileType && !['jpg', 'png', 'webp'].includes(it.fileType)
      ? h('a', { class: 'arch-file', href: archiveFileUrl(it.file), download: it.fileName ?? '' }, icon('paperclip', 15), it.fileName ?? `Fichier ${it.fileType.toUpperCase()}`)
      : null,
    opts.editable ? h('div', { class: 'arch-actions' },
      it.creatorName ? h('span', { class: 'field-hint' }, `Ajouté par ${it.creatorName}`) : null,
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: async () => {
        const next = it.visibility === 'public' ? 'private' : 'public';
        if (next === 'public' && !(await confirmSheet('Rendre public ?', `« ${it.title} » sera visible par n'importe qui, sans compte.`, 'Rendre public', false))) return;
        try { await api.updateArchive(it.id, { visibility: next }); toast(next === 'public' ? 'Document public' : 'Document privé', 'ok'); opts.onChange?.(); } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, icon(it.visibility === 'public' ? 'lock' : 'globe', 14), it.visibility === 'public' ? 'Rendre privé' : 'Rendre public'),
      h('button', { class: 'btn btn-small btn-light btn-text-danger', type: 'button', onclick: async () => {
        if (!(await confirmSheet('Supprimer ce document ?', `« ${it.title} » sera retiré de l'archive.`, 'Supprimer'))) return;
        try { await api.deleteArchive(it.id); toast('Document supprimé', 'ok'); opts.onChange?.(); } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, icon('trash-2', 14), 'Supprimer'),
    ) : null,
  );
}

/** Entrée du registre automatique (événement passé ou vote clos). */
function registryCard(r: RegistryEntry) {
  if (r.kind === 'event') {
    const meta = TYPES[r.type as PointType] ?? TYPES.autre;
    return h('article', { class: 'arch-card arch-reg' },
      h('div', { class: 'arch-head' },
        h('span', { class: 'arch-ico', style: { background: meta.color, color: meta.ink } }, icon(meta.icon, 18)),
        h('div', { class: 'arch-main' },
          h('span', { class: 'arch-meta' }, `${meta.label} · ${dayLong(r.date)} · ${time(r.date)} – ${time(r.end)}`),
          h('strong', { class: 'arch-title' }, r.title)),
        h('span', { class: 'arch-vis private', title: 'Registre automatique, membres seulement' }, icon('lock', 13), 'Registre')));
  }
  return h('article', { class: 'arch-card arch-reg' },
    h('div', { class: 'arch-head' },
      h('span', { class: 'arch-ico arch-ico-vote' }, icon('vote', 18)),
      h('div', { class: 'arch-main' },
        h('span', { class: 'arch-meta' }, `Vote clos · ${r.ag} · ${dateLong(r.date)}`),
        h('strong', { class: 'arch-title' }, r.title)),
      h('span', { class: 'arch-vis private', title: 'Registre automatique, membres seulement' }, icon('lock', 13), 'Registre')),
    resultBars(r.options, r.counts, r.counts.reduce((a, b) => a + b, 0)));
}

/** Frise par mois. */
export function timeline(entries: Entry[], render: (e: Entry) => HTMLElement, empty: HTMLElement) {
  if (!entries.length) return empty;
  const out = h('div', { class: 'arch-timeline' });
  let month = '';
  for (const e of entries.sort((a, b) => b.date - a.date)) {
    const m = monthOf(e.date);
    if (m !== month) { month = m; out.append(h('h3', { class: 'arch-month' }, m)); }
    out.append(render(e));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Onglet « Archive » de l'app
// ---------------------------------------------------------------------------

export function mountArchive(root: HTMLElement) {
  let filter: Filter = 'all';
  let publicOnly = false;
  let data: { items: ArchiveItem[]; registry: RegistryEntry[] } = { items: [], registry: [] };

  const render = () => {
    const entries: Entry[] = [
      ...(filter === 'all' || filter === 'docs' ? data.items.filter((i) => !publicOnly || i.visibility === 'public').map((item) => ({ date: item.date, item })) : []),
      ...(!publicOnly && (filter === 'all' || filter === 'events') ? data.registry.filter((r) => r.kind === 'event').map((reg) => ({ date: reg.date, reg })) : []),
      ...(!publicOnly && (filter === 'all' || filter === 'votes') ? data.registry.filter((r) => r.kind === 'vote').map((reg) => ({ date: reg.date, reg })) : []),
    ];
    clear(root,
      h('div', { class: 'panel-head' },
        h('h2', { class: 'panel-title' }, 'Archive'),
        h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => openArchiveForm(load) }, icon('plus', 16), 'Ajouter')),
      h('p', { class: 'panel-intro' }, 'Documents datés, photos, copies de mails, notes… et le registre des événements passés et des votes. Ce qui est « Public » est visible sans compte.'),
      chips<Filter>([
        { value: 'all', label: 'Tout' }, { value: 'docs', label: 'Documents', icon: 'file-text' },
        { value: 'events', label: 'Événements', icon: 'calendar' }, { value: 'votes', label: 'Votes', icon: 'vote' },
      ], filter, (v) => { filter = v; render(); }),
      h('label', { class: 'toggle-line' },
        h('input', { type: 'checkbox', checked: publicOnly, onchange: (e: Event) => { publicOnly = (e.target as HTMLInputElement).checked; render(); } }),
        h('span', { class: 'switch' }), 'Voir seulement ce qui est public'),
      timeline(entries,
        (e) => (e.item ? itemCard(e.item, { editable: e.item.createdBy === store.me.id || store.me.role === 'admin', onChange: load }) : registryCard(e.reg!)),
        h('div', { class: 'empty' }, icon('archive', 40, 1.6), h('strong', null, 'Rien dans l\'archive pour l\'instant'),
          h('span', null, 'Ajoute un document, une photo ou une copie de mail. Les événements passés et les votes clos s\'y ajoutent tout seuls.'))),
    );
  };

  const load = async () => {
    try { data = await api.archive(); } catch (e) { toast((e as ApiError).message, 'err'); }
    render();
  };
  store.on('archive', () => void load());
  store.on('votes', () => void load());
  store.on('view', () => { if (store.view === 'archive') void load(); });
  render();
}

/** Ajouter un document à l'archive. */
export function openArchiveForm(done: () => void) {
  const st = { kind: 'image' as ArchiveItem['kind'], title: '', date: toDateInput(Date.now()), body: '', file: null as File | null, visibility: 'private' as ArchiveItem['visibility'] };
  const body = h('div', { class: 'form' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('archive', 20), h('span', null, 'Ajouter à l\'archive')) as HTMLButtonElement;

  const ACCEPT: Record<ArchiveItem['kind'], string> = {
    image: 'image/*', document: '.pdf,.txt,application/pdf,text/plain', mail: '.eml,.txt,.pdf,message/rfc822,text/plain,application/pdf', note: '',
  };

  const render = () => {
    const fileInput = h('input', { type: 'file', class: 'sr-only', accept: ACCEPT[st.kind] }) as HTMLInputElement;
    fileInput.addEventListener('change', () => { st.file = fileInput.files?.[0] ?? null; render(); });
    const needsText = st.kind === 'mail' || st.kind === 'note';
    clear(body,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Quoi ?'),
        chips<ArchiveItem['kind']>([
          { value: 'image', label: 'Photo', icon: 'image' }, { value: 'document', label: 'Document (PDF, texte)', icon: 'file-text' },
          { value: 'mail', label: 'Copie de mail', icon: 'mail' }, { value: 'note', label: 'Note', icon: 'sticky-note' },
        ], st.kind, (v) => { st.kind = v; st.file = null; render(); })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Titre'),
        h('input', { class: 'input', type: 'text', maxlength: '120', value: st.title, placeholder: st.kind === 'mail' ? 'Mail de la présidence du 12 novembre' : 'Titre du document', oninput: (e: Event) => (st.title = (e.target as HTMLInputElement).value) })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Date du document'),
        h('input', { class: 'input', type: 'date', value: st.date, onchange: (e: Event) => (st.date = (e.target as HTMLInputElement).value) })),
      st.kind !== 'note' ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, st.kind === 'mail' ? 'Fichier (.eml, PDF…)' : 'Fichier', st.kind === 'mail' ? h('em', null, ' · facultatif si tu colles le texte') : null),
        h('button', { class: 'photo-empty arch-pick', type: 'button', onclick: () => fileInput.click() },
          icon(st.kind === 'image' ? 'camera' : 'paperclip', 22),
          h('strong', null, st.file ? st.file.name : st.kind === 'image' ? 'Choisir une photo' : 'Choisir un fichier'),
          h('span', null, st.file ? `${Math.round(st.file.size / 1024)} Ko` : st.kind === 'image' ? 'Les données de position (EXIF) sont retirées' : '15 Mo maximum')),
        fileInput) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, needsText ? (st.kind === 'mail' ? 'Texte du mail' : 'Note') : 'Description', needsText ? null : h('em', null, ' · facultatif')),
        h('textarea', { class: 'input', rows: needsText ? '8' : '3', maxlength: '50000', placeholder: st.kind === 'mail' ? 'Colle ici le contenu du mail (expéditeur, date, objet, texte)…' : 'Contexte, source…', oninput: (e: Event) => (st.body = (e.target as HTMLTextAreaElement).value) }, st.body)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Visibilité'),
        segmented<ArchiveItem['visibility']>([
          { value: 'private', label: 'Privé · membres', icon: 'lock' },
          { value: 'public', label: 'Public', icon: 'globe' },
        ], st.visibility, (v) => { st.visibility = v; render(); }),
        h('span', { class: 'field-hint' }, st.visibility === 'public'
          ? 'Visible par n\'importe qui, sans compte. Vérifie qu\'il n\'y a ni nom, ni numéro, ni adresse à cacher.'
          : 'Seulement les membres du côté Mouvement.')),
      st.kind === 'document' ? h('p', { class: 'field-hint' }, 'Un PDF peut contenir des informations cachées (auteur, logiciel, historique). En cas de doute, partage plutôt une capture.') : null,
    );
  };

  submit.onclick = async () => {
    if (!st.title.trim()) return toast('Donne un titre.', 'err');
    if (!st.date) return toast('Indique la date du document.', 'err');
    if (st.kind === 'note' && !st.body.trim()) return toast('Écris la note.', 'err');
    if (st.kind === 'mail' && !st.body.trim() && !st.file) return toast('Colle le texte du mail ou ajoute le fichier.', 'err');
    if ((st.kind === 'image' || st.kind === 'document') && !st.file) return toast('Choisis un fichier.', 'err');
    if (st.file && st.file.size > MAX_FILE) return toast('Fichier trop lourd (15 Mo maximum).', 'err');
    submit.disabled = true;
    try {
      let file: string | null = null;
      if (st.file) {
        // Les photos sont ré-encodées : ça retire les données EXIF (dont la position GPS).
        const blob = st.kind === 'image' ? await compressImage(st.file, 2400, 0.85) : st.file;
        file = (await api.uploadArchiveFile(blob)).file;
      }
      await api.createArchive({
        kind: st.kind, title: st.title.trim(), date: fromInputs(st.date, '12:00'), body: st.body.trim() || null,
        file, fileName: st.file && st.kind !== 'image' ? st.file.name : null, visibility: st.visibility,
      });
      s.close();
      toast(st.visibility === 'public' ? 'Ajouté à l\'archive publique' : 'Ajouté à l\'archive', 'ok');
      done();
    } catch (e) {
      toast((e as ApiError).message, 'err', 6000);
      submit.disabled = false;
    }
  };

  const s = openSheet({ title: 'Ajouter à l\'archive', body, footer: submit });
  render();
}

// ---------------------------------------------------------------------------
// Page publique (sans compte) : AG annoncées et archive publique
// ---------------------------------------------------------------------------

export function publicArchivePage(back: () => void): HTMLElement {
  const root = h('div', { class: 'pub' });
  let tab: 'ags' | 'archive' = 'ags';
  let map: L.Map | null = null;

  const renderAgs = (ags: PublicAg[]) => {
    const mapEl = h('div', { class: 'pub-map', 'aria-label': 'Carte des AG' });
    const list = ags.length
      ? h('ul', { class: 'pub-ags' }, ags.map((a) => h('li', { class: 'pub-ag' },
          h('span', { class: 'arch-meta' }, `${dayLong(a.startsAt)} · ${time(a.startsAt)} – ${time(a.endsAt)}`),
          h('strong', null, a.title),
          a.description ? h('p', { class: 'arch-body' }, a.description) : null,
          h('a', { class: 'btn btn-small btn-light', href: `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=18/${a.lat}/${a.lng}`, target: '_blank', rel: 'noopener' }, icon('navigation', 14), 'Voir le lieu'))))
      : h('div', { class: 'empty' }, icon('users', 36, 1.6), h('strong', null, 'Aucune AG annoncée pour l\'instant'));
    setTimeout(() => {
      map?.remove();
      map = null;
      if (!ags.length || !mapEl.isConnected) return;
      map = L.map(mapEl, { zoomControl: true, attributionControl: true });
      void addBasemap(map, 'mvt'); // AG annoncées : côté Mouvement
      const pts = ags.map((a) => L.circleMarker([a.lat, a.lng], { radius: 10, color: '#fff', weight: 3, fillColor: '#a30006', fillOpacity: 1 })
        .bindPopup(`<strong>${a.title.replace(/[<>&]/g, '')}</strong><br>${dayLong(a.startsAt)} · ${time(a.startsAt)}`).addTo(map!));
      map.fitBounds(L.featureGroup(pts).getBounds().pad(0.3), { maxZoom: 16 });
    }, 50);
    return h('div', { class: 'pub-section' }, ags.length ? mapEl : null, list);
  };

  const render = async () => {
    const content = h('div', { class: 'pub-content' }, h('p', { class: 'splash-text' }, 'Chargement…'));
    clear(root,
      h('h1', { class: 'splash-title' }, 'Accès public'),
      h('p', { class: 'splash-text' }, 'Sans compte, tu vois seulement les AG annoncées publiquement et l\'archive publique.'),
      h('div', { class: 'pub-tabs' },
        h('button', { type: 'button', class: tab === 'ags' ? 'on' : '', onclick: () => { tab = 'ags'; void render(); } }, icon('users', 16), 'AG annoncées'),
        h('button', { type: 'button', class: tab === 'archive' ? 'on' : '', onclick: () => { tab = 'archive'; void render(); } }, icon('archive', 16), 'Archive')),
      content,
      h('button', { class: 'link-btn pv-back', type: 'button', onclick: back }, 'Retour'),
    );
    try {
      if (tab === 'ags') {
        clear(content, renderAgs((await api.publicAgs()).ags));
      } else {
        const { items } = await api.publicArchive();
        clear(content, timeline(items.map((item) => ({ date: item.date, item })), (e) => itemCard(e.item!, { editable: false }),
          h('div', { class: 'empty' }, icon('archive', 36, 1.6), h('strong', null, 'L\'archive publique est vide pour l\'instant'))));
      }
    } catch (e) {
      clear(content, h('p', { class: 'pv-error' }, icon('circle-alert', 18), (e as ApiError).message));
    }
  };
  void render();
  return root;
}
