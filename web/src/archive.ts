// =============================================================================
// archive.ts : l'onglet « Archive » (côté Mouvement) et ses morceaux réutilisables.
// =============================================================================
// Deux sortes d'entrées, mélangées sur une frise chronologique par mois :
//   - les DOCUMENTS ajoutés à la main (photo, PDF/texte, copie de mail, note),
//     datés à la date du document (pas la date d'ajout), privés (membres) ou
//     publics (visibles sans compte) ;
//   - le REGISTRE automatique, calculé par le serveur : événements passés et
//     votes clos. Toujours privé, non modifiable.
//
// Qui l'appelle ?
//   - main.ts : mountArchive(el) au démarrage ;
//   - home.ts (page d'accueil publique) : itemCard() et timeline().
//   - publicArchivePage() ci-dessous n'est importée nulle part actuellement
//     (home.ts a sa propre version) : c'est du code mort.
//
// Notions : Leaflet (L) pour la petite carte publique, Intl.DateTimeFormat pour
// écrire les dates en français, upload de fichier binaire (Blob) via api.ts.
import { api, archiveFileUrl, compressImage, ApiError } from './api';
import { store } from './store';
import { openSheet, confirmSheet } from './sheet';
import { chips, segmented } from './forms';
import { resultBars } from './votes';
import { h, icon, clear, toast, dateLong, dayLong, time, toDateInput, fromInputs } from './ui';
import { ARCHIVE_KIND_LABEL, TYPES, type ArchiveItem, type PointType, type RegistryEntry } from '../../shared/model';

/*
 * Archive (côté Mouvement) : documents datés (photo, PDF, copie de mail, note), privés ou publics,
 * et un registre automatique des événements passés et des votes clos.
 */

// Icône lucide associée à chaque sorte de document.
const KIND_ICON: Record<ArchiveItem['kind'], string> = { document: 'file-text', image: 'image', mail: 'mail', note: 'sticky-note' };
// Taille maximale d'un fichier : 15 Mo (15 × 1024 × 1024 octets).
// Vérifiée ici pour un message clair ; le serveur doit aussi la faire respecter.
const MAX_FILE = 15 * 1024 * 1024;
// Formateur de date « novembre 2026 » (titres de mois de la frise).
const fmtMonth = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
// monthOf() : timestamp → « Novembre 2026 » (première lettre en majuscule).
const monthOf = (t: number) => { const s = fmtMonth.format(t); return s.charAt(0).toUpperCase() + s.slice(1); };

// Une entrée de la frise : soit un document (item), soit une ligne du registre
// (reg). Les deux champs sont facultatifs (« ? ») ; en pratique un seul est rempli.
export type Entry = { date: number; item?: ArchiveItem; reg?: RegistryEntry };
// Filtres proposés en haut de l'onglet.
type Filter = 'all' | 'docs' | 'events' | 'votes';

/** Carte d'un document d'archive (aussi utilisée sur la page publique). */
// Entrées : le document, et opts.editable (afficher les boutons Public/Privé et
// Supprimer) + opts.onChange (à appeler après une modification, pour recharger).
// Sortie : un <article>.
export function itemCard(it: ArchiveItem, opts: { editable: boolean; onChange?: () => void }) {
  // Le texte (note, mail, description) s'affiche dans un <p> ; h() échappe le
  // texte, donc aucun risque d'injection HTML.
  const body = it.body ? h('p', { class: 'arch-body' }, it.body) : null;
  // Au-delà de 280 caractères, on coupe l'affichage (classe CSS « clamped »)
  // avec un bouton « Lire la suite ».
  const long = !!it.body && it.body.length > 280;
  if (body && long) body.classList.add('clamped');
  return h('article', { class: `arch-card arch-${it.kind}` },
    h('div', { class: 'arch-head' },
      h('span', { class: 'arch-ico' }, icon(KIND_ICON[it.kind], 18)),
      h('div', { class: 'arch-main' },
        h('span', { class: 'arch-meta' }, `${ARCHIVE_KIND_LABEL[it.kind]} · ${dateLong(it.date)}`),
        h('strong', { class: 'arch-title' }, it.title)),
      // Badge « Public » / « Privé » ; title = infobulle au survol.
      h('span', { class: `arch-vis ${it.visibility}`, title: it.visibility === 'public' ? 'Visible sans compte' : 'Membres seulement' },
        icon(it.visibility === 'public' ? 'globe' : 'lock', 13), it.visibility === 'public' ? 'Public' : 'Privé'),
    ),
    // Image (jpg/png/webp) : affichée directement, cliquable pour l'ouvrir en grand.
    // loading lazy : le navigateur ne la charge que quand on s'en approche.
    it.file && it.fileType && ['jpg', 'png', 'webp'].includes(it.fileType)
      ? h('a', { class: 'arch-img', href: archiveFileUrl(it.file), target: '_blank', rel: 'noopener' }, h('img', { src: archiveFileUrl(it.file), alt: it.title, loading: 'lazy' }))
      : null,
    body,
    // Le « ! » après body affirme qu'il existe (vrai, puisque long implique body).
    long ? h('button', { class: 'link-btn', type: 'button', onclick: (e: Event) => { body!.classList.toggle('clamped'); (e.currentTarget as HTMLElement).textContent = body!.classList.contains('clamped') ? 'Lire la suite' : 'Réduire'; } }, 'Lire la suite') : null,
    // Autre fichier (PDF, .eml, .txt) : simple lien de téléchargement.
    it.file && it.fileType && !['jpg', 'png', 'webp'].includes(it.fileType)
      ? h('a', { class: 'arch-file', href: archiveFileUrl(it.file), download: it.fileName ?? '' }, icon('paperclip', 15), it.fileName ?? `Fichier ${it.fileType.toUpperCase()}`)
      : null,
    // Actions, seulement si l'appareil a le droit de modifier ce document.
    opts.editable ? h('div', { class: 'arch-actions' },
      it.creatorName ? h('span', { class: 'field-hint' }, `Ajouté par ${it.creatorName}`) : null,
      // Bascule de visibilité. Passer en PUBLIC demande une confirmation (c'est
      // l'action risquée) ; repasser en privé, non.
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: async () => {
        const next = it.visibility === 'public' ? 'private' : 'public';
        // Le 4e argument « false » de confirmSheet : bouton de confirmation non rouge
        // (ce n'est pas une suppression).
        if (next === 'public' && !(await confirmSheet('Rendre public ?', `« ${it.title} » sera visible par n'importe qui, sans compte.`, 'Rendre public', false))) return;
        // « ?.() » : appelle onChange seulement s'il a été fourni.
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
// Entrée : une RegistryEntry, soit un événement (kind 'event'), soit un vote
// (kind 'vote'). TypeScript sait, après le « if », quels champs existent
// (c'est une « union discriminée » par le champ kind).
function registryCard(r: RegistryEntry) {
  if (r.kind === 'event') {
    // Type de l'événement → couleur et icône ; type inconnu → « Autre ».
    const meta = TYPES[r.type as PointType] ?? TYPES.autre;
    return h('article', { class: 'arch-card arch-reg' },
      h('div', { class: 'arch-head' },
        h('span', { class: 'arch-ico', style: { background: meta.color, color: meta.ink } }, icon(meta.icon, 18)),
        h('div', { class: 'arch-main' },
          h('span', { class: 'arch-meta' }, `${meta.label} · ${dayLong(r.date)} · ${time(r.date)} – ${time(r.end)}`),
          h('strong', { class: 'arch-title' }, r.title)),
        h('span', { class: 'arch-vis private', title: 'Registre automatique, membres seulement' }, icon('lock', 13), 'Registre')));
  }
  // Sinon c'est un vote clos : on affiche ses résultats avec resultBars (votes.ts).
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
// Entrées :
//   - entries : les entrées à afficher (documents et/ou registre) ;
//   - render : fonction qui dessine une entrée (permet de réutiliser la frise
//     pour la page publique avec un autre rendu) ;
//   - empty : ce qu'on affiche s'il n'y a rien.
// Sortie : un <div> avec un titre à chaque changement de mois.
export function timeline(entries: Entry[], render: (e: Entry) => HTMLElement, empty: HTMLElement) {
  if (!entries.length) return empty;
  const out = h('div', { class: 'arch-timeline' });
  let month = '';
  // Tri du plus récent au plus ancien. Attention : sort() modifie le tableau
  // reçu lui-même (sans gravité ici, il est fabriqué juste avant l'appel).
  // [...entries] : on trie une COPIE (sort modifie le tableau sur place, celui de l'appelant aussi).
  for (const e of [...entries].sort((a, b) => b.date - a.date)) {
    const m = monthOf(e.date);
    // Nouveau mois → on insère un titre « Novembre 2026 ».
    if (m !== month) { month = m; out.append(h('h3', { class: 'arch-month' }, m)); }
    out.append(render(e));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Onglet « Archive » de l'app
// ---------------------------------------------------------------------------

// mountArchive() : branche l'onglet Archive sur son conteneur.
// L'état (filtre, public seulement, données) vit dans la closure de cette fonction.
export function mountArchive(root: HTMLElement) {
  let filter: Filter = 'all';
  let publicOnly = false;
  // Données reçues du serveur (vides au départ).
  let data: { items: ArchiveItem[]; registry: RegistryEntry[] } = { items: [], registry: [] };

  // render() : construit la liste des entrées selon le filtre, puis l'affiche.
  const render = () => {
    // Trois morceaux concaténés (« ... ») : documents, événements du registre,
    // votes du registre. Chacun n'est inclus que si le filtre le permet. Le
    // registre étant privé, il disparaît quand on coche « seulement public ».
    const entries: Entry[] = [
      ...(filter === 'all' || filter === 'docs' ? data.items.filter((i) => !publicOnly || i.visibility === 'public').map((item) => ({ date: item.date, item })) : []),
      ...(!publicOnly && (filter === 'all' || filter === 'events') ? data.registry.filter((r) => r.kind === 'event').map((reg) => ({ date: reg.date, reg })) : []),
      ...(!publicOnly && (filter === 'all' || filter === 'votes') ? data.registry.filter((r) => r.kind === 'vote').map((reg) => ({ date: reg.date, reg })) : []),
    ];
    clear(root,
      h('div', { class: 'panel-head' },
        h('h2', { class: 'panel-title' }, 'Archive'),
        // « Ajouter » : on passe load pour recharger après l'ajout.
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
        // Modifiable si je l'ai ajouté ou si je suis admin (le serveur revérifie).
        (e) => (e.item ? itemCard(e.item, { editable: e.item.createdBy === store.me.id || store.me.role === 'admin', onChange: load }) : registryCard(e.reg!)),
        h('div', { class: 'empty' }, icon('archive', 40, 1.6), h('strong', null, 'Rien dans l\'archive pour l\'instant'),
          h('span', null, 'Ajoute un document, une photo ou une copie de mail. Les événements passés et les votes clos s\'y ajoutent tout seuls.'))),
    );
  };

  // load() : recharge depuis le serveur. En cas d'erreur, on garde les anciennes
  // données et on redessine quand même.
  const load = async () => {
    try { data = await api.archive(); } catch (e) { toast((e as ApiError).message, 'err'); }
    render();
  };
  // On recharge : quand le serveur signale un changement d'archive, quand un
  // vote change (le registre des votes clos peut évoluer), et à l'ouverture de
  // l'onglet.
  store.on('archive', () => void load());
  store.on('votes', () => void load());
  store.on('view', () => { if (store.view === 'archive') void load(); });
  // Premier affichage (vide), en attendant l'ouverture de l'onglet.
  render();
}

/** Ajouter un document à l'archive. */
// Entrée : done = fonction appelée après un ajout réussi (recharger la liste).
export function openArchiveForm(done: () => void) {
  // État du formulaire : sorte, titre, date (texte 'AAAA-MM-JJ', aujourd'hui par
  // défaut), texte, fichier choisi, visibilité (privé par défaut, par prudence).
  const st = { kind: 'image' as ArchiveItem['kind'], title: '', date: toDateInput(Date.now()), body: '', file: null as File | null, visibility: 'private' as ArchiveItem['visibility'] };
  const body = h('div', { class: 'form' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('archive', 20), h('span', null, 'Ajouter à l\'archive')) as HTMLButtonElement;

  // Types de fichiers proposés par le sélecteur, selon la sorte de document
  // (c'est un filtre de confort : le serveur doit vérifier le vrai type).
  const ACCEPT: Record<ArchiveItem['kind'], string> = {
    image: 'image/*', document: '.pdf,.txt,application/pdf,text/plain', mail: '.eml,.txt,.pdf,message/rfc822,text/plain,application/pdf', note: '',
  };

  // render() : redessine tout le formulaire (appelé à chaque choix structurant).
  const render = () => {
    // L'<input type="file"> est recréé à chaque render() (son « accept » dépend de
    // la sorte) ; il est caché et déclenché par le gros bouton.
    const fileInput = h('input', { type: 'file', class: 'sr-only', accept: ACCEPT[st.kind] }) as HTMLInputElement;
    fileInput.addEventListener('change', () => { st.file = fileInput.files?.[0] ?? null; render(); });
    // Mail et note : le texte est le contenu principal (grande zone de texte).
    const needsText = st.kind === 'mail' || st.kind === 'note';
    clear(body,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Quoi ?'),
        chips<ArchiveItem['kind']>([
          { value: 'image', label: 'Photo', icon: 'image' }, { value: 'document', label: 'Document (PDF, texte)', icon: 'file-text' },
          { value: 'mail', label: 'Copie de mail', icon: 'mail' }, { value: 'note', label: 'Note', icon: 'sticky-note' },
        // Changer de sorte oublie le fichier choisi (il ne conviendrait peut-être plus).
        ], st.kind, (v) => { st.kind = v; st.file = null; render(); })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Titre'),
        h('input', { class: 'input', type: 'text', maxlength: '120', value: st.title, placeholder: st.kind === 'mail' ? 'Mail de la présidence du 12 novembre' : 'Titre du document', oninput: (e: Event) => (st.title = (e.target as HTMLInputElement).value) })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Date du document'),
        h('input', { class: 'input', type: 'date', value: st.date, onchange: (e: Event) => (st.date = (e.target as HTMLInputElement).value) })),
      // Pas de fichier pour une note.
      st.kind !== 'note' ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, st.kind === 'mail' ? 'Fichier (.eml, PDF…)' : 'Fichier', st.kind === 'mail' ? h('em', null, ' · facultatif si tu colles le texte') : null),
        h('button', { class: 'photo-empty arch-pick', type: 'button', onclick: () => fileInput.click() },
          icon(st.kind === 'image' ? 'camera' : 'paperclip', 22),
          h('strong', null, st.file ? st.file.name : st.kind === 'image' ? 'Choisir une photo' : 'Choisir un fichier'),
          // Taille du fichier en Ko, ou une aide selon la sorte.
          h('span', null, st.file ? `${Math.round(st.file.size / 1024)} Ko` : st.kind === 'image' ? 'Les données de position (EXIF) sont retirées' : '15 Mo maximum')),
        fileInput) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, needsText ? (st.kind === 'mail' ? 'Texte du mail' : 'Note') : 'Description', needsText ? null : h('em', null, ' · facultatif')),
        h('textarea', { class: 'input', rows: needsText ? '8' : '3', maxlength: '50000', placeholder: st.kind === 'mail' ? 'Colle ici le contenu du mail (expéditeur, date, objet, texte)…' : 'Contexte, source…', oninput: (e: Event) => (st.body = (e.target as HTMLTextAreaElement).value) }, st.body)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Visibilité'),
        segmented<ArchiveItem['visibility']>([
          { value: 'private', label: 'Privé · membres', icon: 'lock' },
          { value: 'public', label: 'Public', icon: 'globe' },
        ], st.visibility, (v) => { st.visibility = v; render(); }),
        // Avertissement adapté : en public, penser à ce qui pourrait identifier quelqu'un.
        h('span', { class: 'field-hint' }, st.visibility === 'public'
          ? 'Visible par n\'importe qui, sans compte. Vérifie qu\'il n\'y a ni nom, ni numéro, ni adresse à cacher.'
          : 'Seulement les membres du côté Mouvement.')),
      st.kind === 'document' ? h('p', { class: 'field-hint' }, 'Un PDF peut contenir des informations cachées (auteur, logiciel, historique). En cas de doute, partage plutôt une capture.') : null,
    );
  };

  // Validation : vérifications dans l'ordre, chacune arrête avec un message clair.
  submit.onclick = async () => {
    if (!st.title.trim()) return toast('Donne un titre.', 'err');
    if (!st.date) return toast('Indique la date du document.', 'err');
    if (st.kind === 'note' && !st.body.trim()) return toast('Écris la note.', 'err');
    if (st.kind === 'mail' && !st.body.trim() && !st.file) return toast('Colle le texte du mail ou ajoute le fichier.', 'err');
    if ((st.kind === 'image' || st.kind === 'document') && !st.file) return toast('Choisis un fichier.', 'err');
    // Limite de 15 Mo : pour un document, sur le fichier tel quel ; pour une photo, APRÈS compression
    // (une photo de 20 Mo en fait souvent moins de 2 une fois ré-encodée, inutile de la refuser).
    if (st.file && st.kind !== 'image' && st.file.size > MAX_FILE) return toast('Fichier trop lourd (15 Mo maximum).', 'err');
    submit.disabled = true;
    try {
      let file: string | null = null;
      // D'abord le fichier (s'il y en a un), pour obtenir son nom sur le serveur.
      if (st.file) {
        // Les photos sont ré-encodées : ça retire les données EXIF (dont la position GPS).
        // Les autres fichiers (PDF…) partent tels quels : leurs métadonnées ne sont
        // PAS nettoyées (d'où l'avertissement affiché pour les documents).
        const blob = st.kind === 'image' ? await compressImage(st.file, 2400, 0.85) : st.file;
        if (blob.size > MAX_FILE) { toast('Fichier trop lourd (15 Mo maximum).', 'err'); submit.disabled = false; return; }
        file = (await api.uploadArchiveFile(blob)).file;
      }
      // Puis l'entrée d'archive elle-même.
      await api.createArchive({
        // Date fixée à midi : évite qu'un décalage de fuseau horaire fasse basculer
        // le document sur la veille ou le lendemain.
        kind: st.kind, title: st.title.trim(), date: fromInputs(st.date, '12:00'), body: st.body.trim() || null,
        // On garde le nom d'origine du fichier (sauf pour les photos, ré-encodées).
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

  // « s » est utilisée dans submit.onclick plus haut (déclarée avant tout clic).
  const s = openSheet({ title: 'Ajouter à l\'archive', body, footer: submit });
  render();
}

// ---------------------------------------------------------------------------
// Page publique (sans compte) : AG annoncées et archive publique
// ---------------------------------------------------------------------------
