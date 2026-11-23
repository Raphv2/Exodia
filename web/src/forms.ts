// =============================================================================
// forms.ts : les formulaires de création et de modification des points.
// =============================================================================
// Ce fichier contient :
//   1. de petits composants réutilisables (segmented, chips, field…) que d'autres
//      écrans importent aussi (team.ts, route.ts, votes.ts, archive.ts, agenda.ts…) ;
//   2. le grand formulaire « point » : point fixe (panneau, blocage, local…),
//      événement daté (AG, tractage, blocus…) ou « flash » (événement improvisé) ;
//   3. le formulaire « alerte rapide » (warning / danger / police), pensé pour
//      être rempli en quelques secondes sur le terrain.
//
// Qui l'appelle ?
//   - main.ts : boutons « + » et « Alerte » (newPointFlow, openAlertForm) ;
//   - detail.ts : bouton « Modifier » d'une fiche (editPoint) ;
//   - agenda.ts : « Nouvel événement » (newPointFlow).
//
// Notions à connaître pour lire ce fichier :
//   - h(tag, props, ...enfants) (ui.ts) fabrique un élément HTML. Les props qui
//     commencent par « on » (onclick, oninput…) deviennent des écouteurs d'événements.
//   - Le motif « render() » : on garde l'état dans un objet (le « brouillon » d),
//     et à chaque changement on redessine tout le contenu avec clear(). Pas de
//     framework (React, Vue…) : c'est fait à la main.
//   - Les « sheets » (sheet.ts) : panneaux qui glissent du bas de l'écran.
//   - Les deux espaces : store.space vaut 'lfi' (Campagne) ou 'mvt' (Mouvement) ;
//     certains types de points n'existent que d'un côté (typeInSpace).
//   - Les génériques TypeScript <T> : une fonction qui marche pour plusieurs types
//     de valeurs (ex. chips<Role>, chips<number>), en gardant la vérification de type.
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

// Ces composants sont exportés : d'autres écrans les réutilisent pour garder
// le même look partout.
// ---------- Petits composants de formulaire ----------

// segmented() : une rangée de boutons collés dont UN SEUL est actif à la fois
// (comme les onglets « Point fixe / Événement / Flash » en haut du formulaire).
// Entrées :
//   - options : la liste des choix { value, label, icon? } ;
//   - value : le choix actif au départ ;
//   - onChange : fonction appelée avec la nouvelle valeur quand on clique ;
//   - cls : classes CSS en plus (taille, couleur…).
// Sortie : l'élément <div> à insérer dans la page.
// <T extends string> : la valeur est une chaîne (ex. 'fixe' | 'event'), et
// TypeScript vérifie qu'on ne passe pas une valeur hors liste.
export function segmented<T extends string>(options: { value: T; label: string; icon?: string }[], value: T, onChange: (v: T) => void, cls = '') {
  // role="radiogroup" : indique aux lecteurs d'écran (accessibilité) que c'est
  // un groupe de choix exclusifs, comme des boutons radio.
  const wrap = h('div', { class: `seg ${cls}`, role: 'radiogroup' });
  // render(v) redessine tous les boutons en marquant « on » celui qui vaut v.
  // On redessine tout plutôt que de modifier un seul bouton : plus simple, et la
  // liste est courte.
  const render = (v: T) => {
    // replaceChildren(...) vide le conteneur puis y met les nouveaux boutons.
    // Le « ... » (spread) transforme le tableau en liste d'arguments.
    wrap.replaceChildren(...options.map((o) => h('button', {
      // type: 'button' évite qu'un clic soumette un éventuel <form> parent.
      // aria-checked dit au lecteur d'écran quel bouton est sélectionné.
      type: 'button', role: 'radio', 'aria-checked': String(o.value === v), class: `seg-btn${o.value === v ? ' on' : ''}`,
      // Au clic : on met d'abord à jour l'affichage, puis on prévient l'appelant.
      onclick: () => { render(o.value); onChange(o.value); },
    }, o.icon ? icon(o.icon, 18) : null, h('span', null, o.label))));
  };
  // Premier affichage avec la valeur de départ.
  render(value);
  return wrap;
}

// chips() : des « pastilles » cliquables, une seule sélectionnée (choix d'une
// durée, d'un rôle, d'un rayon de vote…). Même principe que segmented() mais
// les pastilles passent à la ligne quand il n'y a plus de place.
// Entrées :
//   - options, onChange : comme segmented() ;
//   - value : la valeur choisie, ou null si rien n'est choisi au départ ;
//   - accent : couleur de fond facultative pour la pastille active (ex. la
//     couleur du type de point).
// <T extends string | number> : les valeurs peuvent être des textes ou des
// nombres (ex. des minutes).
export function chips<T extends string | number>(options: { value: T; label: string; icon?: string }[], value: T | null, onChange: (v: T) => void, accent?: string) {
  const wrap = h('div', { class: 'chips', role: 'radiogroup' });
  const render = (v: T | null) => {
    wrap.replaceChildren(...options.map((o) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === v), class: `chip${o.value === v ? ' on' : ''}`,
      // Si une couleur d'accent est donnée, la pastille active prend cette couleur ;
      // inkFor() choisit un texte noir ou blanc pour rester lisible dessus.
      style: accent && o.value === v ? { background: accent, borderColor: accent, color: inkFor(accent) } : undefined,
      onclick: () => { render(o.value); onChange(o.value); },
    }, o.icon ? icon(o.icon, 16) : null, o.label)));
  };
  render(value);
  return wrap;
}

// field() : un champ de formulaire avec son libellé au-dessus.
// Entrées : le libellé, le contrôle (input, textarea…), une aide facultative
// sous le champ, et « optional » pour afficher « · facultatif ».
// On utilise <label> comme conteneur : cliquer sur le libellé donne le focus
// au champ qu'il contient (comportement natif du navigateur).
export const field = (label: string, control: Node, hint?: string, optional = false) =>
  h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label, optional ? h('em', null, ' · facultatif') : null),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );

// Entrées : d = le brouillon (on lit son type, on modifie sa liste « material »
// directement : c'est un objet partagé, pas une copie) ; accent = couleur active.
// Sortie : un <div> qui se redessine tout seul quand on coche ou ajoute.
/** Liste de matériel : puces à cocher (suggestions du type + ajouts) et champ pour en ajouter. */
function materialPicker(d: { type: PointType; material: string[] }, accent: string) {
  const wrap = h('div', { class: 'material-pick' });
  // On reconstruit tout à chaque changement (render) : suggestions + champ.
  const render = () => {
    // Suggestions propres au type ET à l'espace (pas de « Colle » côté Mouvement…).
    const suggestions = materialPresets(d.type, store.space);
    // Toutes les pastilles = suggestions + ce que l'utilisateur a ajouté à la main
    // (sans doublon avec les suggestions).
    const all = [...suggestions, ...d.material.filter((m) => !suggestions.includes(m))];
    // enterkeyhint: 'done' : sur mobile, la touche Entrée du clavier affiche « OK ».
    // « as HTMLInputElement » dit à TypeScript le type précis de l'élément.
    const input = h('input', { class: 'input', type: 'text', maxlength: '40', placeholder: 'Autre chose ?', enterkeyhint: 'done' }) as HTMLInputElement;
    // add() : ajoute le texte tapé à la liste du matériel.
    const add = () => {
      const v = input.value.trim();
      // On refuse : le vide, les doublons (sans tenir compte des majuscules), et
      // au-delà de 20 éléments (garde-fou ; le serveur limite sans doute aussi).
      if (v && !d.material.some((m) => m.toLowerCase() === v.toLowerCase()) && d.material.length < 20) d.material.push(v);
      render();
      // Après render(), l'ancien <input> a été remplacé par un nouveau : on cherche
      // le nouveau pour lui redonner le focus et pouvoir enchaîner les ajouts.
      (wrap.querySelector('input') as HTMLInputElement | null)?.focus();
    };
    // Entrée = ajouter, sans soumettre de formulaire (preventDefault).
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    wrap.replaceChildren(
      h('div', { class: 'chips' }, all.map((m) => {
        // « on » = cet élément est-il déjà coché ?
        const on = d.material.includes(m);
        return h('button', {
          type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on),
          style: on ? { background: accent, borderColor: accent, color: inkFor(accent) } : undefined,
          // Clic : on retire l'élément s'il était coché, on l'ajoute sinon, puis on redessine.
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

// group() : comme field(), mais avec un <div> au lieu d'un <label>. Utile quand
// le contenu contient plusieurs boutons : un <label> autour de plusieurs
// contrôles crée des clics « fantômes » sur le premier.
const group = (label: string, ...content: Node[]) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), ...content);

// Entrées : current = { existing: nom de la photo déjà sur le serveur, blob:
// nouvelle photo pas encore envoyée } (objet partagé, modifié sur place) ;
// onChange = prévenir l'appelant (souvent une fonction vide).
// La photo n'est envoyée au serveur qu'à la validation du formulaire
// (voir uploadIfNeeded) : si on annule, rien n'est téléversé.
/** Zone photo : prise de vue ou galerie, aperçu, suppression. */
function photoPicker(current: { existing: string | null; blob: Blob | null }, onChange: () => void) {
  const wrap = h('div', { class: 'photo-pick' });
  // Le vrai <input type="file"> est caché (sr-only = visible seulement pour les
  // lecteurs d'écran) : on le déclenche depuis de jolis boutons avec input.click().
  // accept="image/*" : sur mobile, le téléphone propose appareil photo ou galerie.
  const input = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', 'aria-label': 'Ajouter une photo' }) as HTMLInputElement;
  // « change » se déclenche quand l'utilisateur a choisi un fichier.
  input.addEventListener('change', async () => {
    // ?.[0] : le premier fichier choisi, ou undefined s'il n'y en a pas.
    const f = input.files?.[0];
    if (!f) return;
    try {
      // compressImage (api.ts) réduit la taille ET retire les données EXIF (dont la
      // position GPS de la photo) : important pour la sécurité des militant·es.
      current.blob = await compressImage(f);
      // La nouvelle photo remplace l'ancienne.
      current.existing = null;
      onChange();
      render();
    } catch {
      toast('Impossible de lire cette image.', 'err');
    }
  });
  const render = () => {
    // URL.createObjectURL crée une adresse locale temporaire pour afficher le blob
    // sans l'envoyer. (On ne la libère jamais avec revokeObjectURL : petite fuite
    // mémoire, sans gravité pour quelques photos.)
    const src = current.blob ? URL.createObjectURL(current.blob) : current.existing ? photoUrl(current.existing) : null;
    // Deux affichages : avec photo (aperçu + Changer / Retirer) ou sans (gros bouton).
    if (src) {
      wrap.replaceChildren(
        h('img', { src, alt: 'Aperçu de la photo', class: 'photo-preview' }),
        h('div', { class: 'photo-actions' },
          h('button', { type: 'button', class: 'btn btn-small btn-light', onclick: () => input.click() }, icon('camera', 16), 'Changer'),
          // « Retirer » : on oublie la nouvelle ET l'ancienne photo ; à l'enregistrement,
          // photo vaudra null et le serveur l'effacera du point.
          h('button', { type: 'button', class: 'btn btn-small btn-light', onclick: () => { current.blob = null; current.existing = null; onChange(); render(); } }, icon('trash-2', 16), 'Retirer'),
        ),
        // L'<input> caché doit rester dans la page, sinon input.click() ne marcherait plus.
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

// busy() : met un bouton en état « en cours » (désactivé + animation CSS
// « loading ») pour éviter les doubles clics pendant un envoi.
// label : si donné, remplace le texte du <span> du bouton (ex. « Envoi… »).
// Le « ! » après querySelector affirme à TypeScript que le <span> existe.
function busy(btn: HTMLButtonElement, on: boolean, label?: string) {
  btn.disabled = on;
  btn.classList.toggle('loading', on);
  if (label) btn.querySelector('span')!.textContent = label;
}

// uploadIfNeeded() : envoie la nouvelle photo s'il y en a une et renvoie son nom
// sur le serveur ; sinon renvoie le nom de l'ancienne (ou null si retirée).
// « async » : la fonction renvoie une Promise, on l'attend avec « await ».
async function uploadIfNeeded(ph: { existing: string | null; blob: Blob | null }) {
  if (ph.blob) return (await api.uploadPhoto(ph.blob)).photo;
  return ph.existing;
}

// ---------- Formulaire de point (fixe / événement) ----------

// Draft = « brouillon » : tout ce que le formulaire est en train d'éditer.
// Il diffère de Point (modèle serveur) : les dates y sont des TEXTES au format
// des champs HTML ('2026-11-23', '14:30'), convertis en timestamps seulement
// à l'envoi. Ça évite de reconvertir à chaque frappe.
interface Draft {
  // id présent = modification d'un point existant ; absent = création.
  id?: string;
  mode: Mode;
  type: PointType;
  title: string;
  description: string;
  lat: number;
  lng: number;
  color: string | null;
  // Photo en deux parties : celle déjà enregistrée et une éventuelle nouvelle.
  photo: { existing: string | null; blob: Blob | null };
  // Date ('AAAA-MM-JJ') et heures de début / fin ('HH:MM') d'un événement.
  date: string;
  start: string;
  end: string;
  // Répétition (aucune, chaque jour…) et date de fin de répétition.
  recurrence: Recurrence;
  until: string;
  // État du point (panneau : à coller / collé / abîmé ; blocage : tenu / vide / levé).
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
  // Événement sur toute la journée (00:00 → 23:59).
  allDay: boolean;
  /** L'utilisateur a choisi lui-même « toute la journée » ou non. */
  allDayTouched: boolean;
}

// Ordre d'affichage des types dans la grille, selon le mode. Les types les plus
// utilisés d'abord. Ces listes sont ensuite filtrées selon l'espace courant.
const FIXE_ORDER: PointType[] = ['panneau', 'blocage', 'collage', 'materiel', 'local', 'autre'];
const EVENT_ORDER: PointType[] = ['rassemblement', 'blocus', 'tractage', 'ag', 'collage', 'materiel', 'local', 'autre'];

// Utilisé pour proposer de rattacher un blocage à un blocus.
// Sortie : les points de type 'blocus' encore actifs, triés par prochaine date
// de début (le plus proche d'abord). isActive / nextOccurrence viennent de
// shared/time.ts et gèrent les événements répétés.
/** Blocus pas encore terminés, celui en cours d'abord. */
export function activeBlocus(): Point[] {
  const now = Date.now();
  return store.points
    .filter((p) => p.type === 'blocus' && isActive(p, now))
    // « ?? Infinity » : un blocus sans prochaine date part tout à la fin du tri.
    .sort((a, b) => (nextOccurrence(a, now)?.start ?? Infinity) - (nextOccurrence(b, now)?.start ?? Infinity));
}

// Preset : valeurs imposées au départ (ex. « Ajouter un blocage » depuis la fiche
// d'un blocus impose type = 'blocage' et parentId = ce blocus).
export interface Preset { type?: PointType; parentId?: string | null }

// « flash » n'est pas un mode côté serveur : c'est un événement (mode 'event')
// avec flash = true. Côté formulaire, on le présente comme un troisième onglet.
/** Ce que propose le haut du formulaire : un flash est un événement improvisé. */
export type FormMode = Mode | 'flash';

// draftFrom() : fabrique le brouillon de départ du formulaire.
// Entrées :
//   - p : le point à modifier, ou null pour une création ;
//   - pos : l'emplacement (choisi sur la carte pour une création) ;
//   - formMode : onglet de départ (fixe / event / flash) ;
//   - preset : type ou blocus imposés.
// Sortie : un Draft prêt à être affiché.
// Principe partout : « valeur du point existant ?? valeur par défaut ».
function draftFrom(p: Point | null, pos: Pos, formMode: FormMode = 'fixe', preset: Preset = {}): Draft {
  // Un flash est un événement : on ramène 'flash' à 'event'.
  const mode: Mode = formMode === 'fixe' ? 'fixe' : 'event';
  // Heure par défaut d'un nouvel événement : la prochaine heure pile (14:37 → 15:00).
  const nextHour = new Date();
  // setMinutes(0, 0, 0) met minutes, secondes et millisecondes à zéro.
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  // Début et fin : ceux du point, sinon prochaine heure pile et +2 h
  // (3600_000 ms = 1 h ; le « _ » sert juste à lire le nombre plus facilement).
  const s = p?.startsAt ?? nextHour.getTime();
  const e = p?.endsAt ?? s + 2 * 3600_000;
  // En modification, on détecte « toute la journée » d'après les heures enregistrées.
  const allDay = p ? p.mode === 'event' && isAllDay(s, e) : false;
  return {
    // En modification, on considère que le choix « toute la journée » a déjà été
    // fait (allDayTouched) : changer de type ne doit pas l'écraser.
    allDay,
    allDayTouched: !!p,
    id: p?.id,
    mode: p?.mode ?? mode,
    // Type par défaut : celui imposé, sinon panneau (fixe) ou tractage (événement).
    // Si ce type n'existe pas dans l'espace courant, render() le corrigera.
    type: p?.type ?? preset.type ?? (mode === 'fixe' ? 'panneau' : 'tractage'),
    title: p?.title ?? '',
    description: p?.description ?? '',
    lat: p?.lat ?? pos.lat,
    lng: p?.lng ?? pos.lng,
    color: p?.color ?? null,
    photo: { existing: p?.photo ?? null, blob: null },
    date: toDateInput(s),
    // Si « toute la journée », on pré-remplit 9 h - 18 h pour le cas où
    // l'utilisateur décoche la case.
    start: allDay ? '09:00' : toTimeInput(s),
    end: allDay ? '18:00' : toTimeInput(e),
    recurrence: p?.recurrence ?? 'none',
    until: p?.recurrenceUntil ? toDateInput(p.recurrenceUntil) : '',
    status: p?.status ?? 'a_coller',
    // parentId (blocus du blocage) : celui du point existant ; sinon celui du
    // preset (même s'il vaut null : « !== undefined » distingue « pas fourni » de
    // « explicitement aucun ») ; sinon le premier blocus actif, ou null.
    parentId: p ? p.parentId : preset.parentId !== undefined ? preset.parentId : activeBlocus()[0]?.id ?? null,
    // [...] : on COPIE la liste, pour ne pas modifier le point du store avant
    // l'enregistrement (si l'utilisateur annule, le point reste intact).
    material: [...(p?.material ?? [])],
    isPublic: p?.isPublic ?? false,
    // flash : on garde celui du point existant ; à la création, vrai si on vient
    // de l'onglet Flash.
    flash: p ? p.flash : formMode === 'flash',
    // Valeurs par défaut d'un flash : commence dans 15 min, dure 60 min.
    flashIn: 15,
    flashDur: 60,
  };
}

// newPointFlow() : parcours « nouveau point ».
// 1) on choisit l'emplacement sur la carte (pickLocation, dans map.ts) ;
// 2) si l'utilisateur n'a pas annulé, on ouvre le formulaire pré-rempli.
// Fonction « async » car il faut attendre que l'utilisateur place le viseur.
export async function newPointFlow(mode: FormMode = 'fixe', preset: Preset = {}) {
  // Couleur du viseur : celle du type imposé, sinon celle de l'espace.
  const color = preset.type ? TYPES[preset.type].color : spaceColor();
  const pos = await pickLocation({ title: preset.type ? `Nouveau ${TYPES[preset.type].label.toLowerCase()}` : 'Nouveau point', color });
  // pos === null : l'utilisateur a annulé le choix d'emplacement.
  if (!pos) return;
  openPointForm(draftFrom(null, pos, mode, preset));
}

// editPoint() : ouvre le bon formulaire pour modifier un point existant.
// Les alertes ont leur propre formulaire simplifié ; les autres, le formulaire
// complet. On passe p deux fois à draftFrom : comme point et comme position
// (un Point a bien lat et lng, il « ressemble » à un Pos).
export function editPoint(p: Point) {
  if (TYPES[p.type].alert) return openAlertForm(p.type as AlertType, p);
  openPointForm(draftFrom(p, p));
}

// openPointForm() : affiche le formulaire complet dans une sheet.
// Entrée : le brouillon d (modifié directement pendant la saisie).
// Pas de sortie : à la validation, on envoie au serveur et on met à jour le store.
function openPointForm(d: Draft) {
  // !! convertit en vrai booléen : un id présent → true.
  const isEdit = !!d.id;
  // body : le conteneur qu'on remplit à chaque render().
  const body = h('div', { class: 'form' });
  // Le bouton de validation est créé UNE fois, hors render(), pour être placé
  // dans le pied de la sheet (il reste visible pendant qu'on fait défiler).
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('check', 20), h('span', null, isEdit ? 'Enregistrer' : 'Ajouter le point')) as HTMLButtonElement;

  // render() reconstruit tout le formulaire à partir de d. Appelée au départ
  // puis à chaque choix qui change la structure (type, mode, journée entière…).
  // Les simples frappes de texte (oninput) modifient d sans redessiner : sinon
  // le champ perdrait le focus à chaque lettre.
  const render = () => {
    // Seulement les types de l'espace en cours (rien du collage côté Mouvement, rien des blocus côté LFI).
    const typesForMode = (d.mode === 'event' ? EVENT_ORDER : FIXE_ORDER).filter((t) => TYPES[t].modes.includes(d.mode) && typeInSpace(t, store.space));
    // Si le type actuel n'est pas permis (on vient de changer de mode ou
    // d'espace), on prend le premier type permis.
    if (!typesForMode.includes(d.type)) d.type = typesForMode[0];
    // États possibles pour ce type (undefined si le type n'a pas d'état).
    const statuses = STATUSES[d.type];
    // Même logique : on recale l'état s'il ne correspond pas au type.
    if (statuses && !statuses.includes(d.status)) d.status = statuses[0];
    // Tant que l'utilisateur n'a pas touché « toute la journée », on suit le
    // réglage par défaut du type (TYPES[...].allDay).
    if (!d.allDayTouched) d.allDay = !!TYPES[d.type].allDay;
    const meta = TYPES[d.type];
    // Couleur effective : la couleur personnalisée, sinon celle du type.
    const color = d.color ?? TYPES[d.type].color;
    // « sheet » est déclarée plus bas (const sheet = openSheet(...)). Ça marche car
    // render() n'est appelée qu'APRÈS cette déclaration (dernière ligne de la
    // fonction). La variable CSS --accent colore boutons et bordures de la sheet.
    sheet.el.style.setProperty('--accent', color);

    // Grille des types : une tuile par type permis, avec sa couleur et son icône.
    // --c / --ink sont des variables CSS lues par la feuille de style.
    const typeGrid = h('div', { class: 'type-grid' }, typesForMode.map((t) => h('button', {
      // « as Record<string, string> » : TypeScript ne connaît pas les propriétés CSS
      // personnalisées (--c), on lui dit d'accepter cet objet tel quel.
      type: 'button', class: `type-tile${t === d.type ? ' on' : ''}`, style: { '--c': TYPES[t].color, '--ink': TYPES[t].ink } as Record<string, string>,
      'aria-pressed': String(t === d.type),
      // Changer de type remet la couleur au défaut du nouveau type, et recalcule
      // « toute la journée » si l'utilisateur n'y a pas touché.
      onclick: () => {
        d.type = t;
        d.color = null;
        if (!d.allDayTouched) d.allDay = !!TYPES[t].allDay;
        render();
      },
    }, h('span', { class: 'type-ico' }, icon(TYPES[t].icon, 22)), h('span', { class: 'type-label' }, TYPES[t].short))));

    // Champ titre : value pré-remplie, et chaque frappe met à jour d.title.
    // Le placeholder (texte gris) donne un exemple propre au type.
    const title = h('input', { class: 'input', type: 'text', maxlength: '80', value: d.title, placeholder: meta.placeholder, autocomplete: 'off', oninput: (e: Event) => (d.title = (e.target as HTMLInputElement).value) });
    // Le contenu d'un <textarea> se passe en enfant (et non via « value »).
    const desc = h('textarea', { class: 'input', rows: '3', maxlength: '2000', placeholder: 'Infos utiles : accès, consignes, contact…', oninput: (e: Event) => (d.description = (e.target as HTMLTextAreaElement).value) }, d.description);

    // Flash (à la création) : pas de date à saisir, juste « dans combien de temps » et « combien de temps ».
    // Seulement pour un flash en création ; en modification, un flash se modifie
    // avec les dates normales (bloc suivant).
    const flashSchedule = d.mode === 'event' && d.flash && !isEdit ? h('div', { class: 'card-section flash-section' },
      h('div', { class: 'section-title' }, icon('zap', 18), 'Flash'),
      // « as number » : FLASH_STARTS est un tableau « as const » (types littéraux
      // 0 | 15 | 30 | 60) ; on élargit en number pour que chips<number> l'accepte.
      group('Ça commence', chips(FLASH_STARTS.map((m) => ({ value: m as number, label: m === 0 ? 'Maintenant' : `Dans ${durLabel(m)}` })), d.flashIn, (v) => (d.flashIn = v), color)),
      group('Durée', chips(FLASH_DURATIONS.map((m) => ({ value: m as number, label: durLabel(m) })), d.flashDur, (v) => (d.flashDur = v), color)),
      h('p', { class: 'field-hint' }, 'Tout le monde reçoit une notification dès que tu valides.'),
    ) : null;

    // « ?? » : si flashSchedule existe on l'affiche, sinon le bloc « Quand ? »
    // pour un événement, sinon rien (point fixe : pas de date).
    const schedule = flashSchedule ?? (d.mode === 'event' ? h('div', { class: 'card-section' },
      h('div', { class: 'section-title' }, icon('clock', 18), 'Quand ?'),
      h('label', { class: 'toggle-line' },
        // Cocher / décocher « toute la journée » : on retient que c'est un choix
        // explicite (allDayTouched) et on redessine (les heures apparaissent / disparaissent).
        h('input', { type: 'checkbox', checked: d.allDay, onchange: (e: Event) => { d.allDay = (e.target as HTMLInputElement).checked; d.allDayTouched = true; render(); } }),
        h('span', { class: 'switch' }), 'Toute la journée'),
      // grid-1 / grid-3 : une colonne (date seule) ou trois (date, début, fin).
      h('div', { class: d.allDay ? 'grid-1' : 'grid-3' },
        field('Date', h('input', { class: 'input', type: 'date', value: d.date, required: true, onchange: (e: Event) => (d.date = (e.target as HTMLInputElement).value) })),
        // step: '300' : le sélecteur d'heure avance de 5 min en 5 min (300 secondes).
        d.allDay ? null : field('Début', h('input', { class: 'input', type: 'time', value: d.start, step: '300', onchange: (e: Event) => (d.start = (e.target as HTMLInputElement).value) })),
        d.allDay ? null : field('Fin', h('input', { class: 'input', type: 'time', value: d.end, step: '300', onchange: (e: Event) => (d.end = (e.target as HTMLInputElement).value) })),
      ),
      d.allDay ? h('p', { class: 'field-hint' }, 'Visible sur la carte jusqu\'à minuit, puis le point disparaît tout seul.') : null,
      // « Répéter » : pas pour un flash (un flash est par nature ponctuel).
      // Object.keys(...) liste les clés de RECURRENCE_LABEL : none, daily, weekly, monthly.
      d.flash ? null : group('Répéter', chips((Object.keys(RECURRENCE_LABEL) as Recurrence[]).map((r) => ({ value: r, label: RECURRENCE_LABEL[r] })), d.recurrence, (v) => { d.recurrence = v; render(); }, color)),
      // La date de fin de répétition n'apparaît que si on répète vraiment.
      // min: d.date empêche de choisir une fin avant le début.
      !d.flash && d.recurrence !== 'none'
        ? field('Jusqu\'au', h('input', { class: 'input', type: 'date', value: d.until, min: d.date, onchange: (e: Event) => (d.until = (e.target as HTMLInputElement).value) }), 'Laisse vide pour répéter sans fin.', true)
        : null,
    ) : null);

    // Choix de l'état, seulement si le type en a (panneau, blocage).
    // Le libellé est enrichi d'une explication quand elle existe (« Tenu · Du monde sur place »).
    const status = statuses ? group(d.type === 'blocage' ? 'Sur place en ce moment' : 'État du panneau',
      chips(statuses.map((s) => ({ value: s, label: STATUS_HINT[s] ? `${STATUS_LABEL[s]} · ${STATUS_HINT[s]}` : STATUS_LABEL[s] })), d.status, (v) => (d.status = v), color)) : null;

    // Rattachement à un blocus : uniquement pour un blocage.
    const blocusList = d.type === 'blocage' ? activeBlocus() : [];
    // Garder le blocus déjà choisi même s'il est terminé (modification d'un ancien blocage).
    const current = d.parentId ? store.points.find((x) => x.id === d.parentId) : null;
    if (current && !blocusList.includes(current)) blocusList.unshift(current);
    // L'option « Aucun » a la valeur '' (une pastille ne peut pas valoir null) ;
    // « v || null » retransforme '' en null avant de le stocker.
    const blocus = d.type === 'blocage' ? h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Blocus', h('em', null, ' · facultatif')),
      blocusList.length
        ? chips<string>([...blocusList.map((b) => ({ value: b.id, label: b.title })), { value: '', label: 'Aucun' }], d.parentId ?? '', (v) => (d.parentId = v || null), color)
        : h('p', { class: 'field-hint' }, 'Aucun blocus prévu pour l\'instant. Tu pourras rattacher ce blocage depuis la fiche d\'un blocus.'),
      blocusList.length ? h('span', { class: 'field-hint' }, 'À la fin du blocus, s\'il est encore « tenu », le blocage passe tout seul à « sans personne ».') : null,
    ) : null;

    // La couleur du type est la première : la choisir revient à ne pas personnaliser (null).
    const typeColor = TYPES[d.type].color;
    // Pastilles de couleur : la couleur du type d'abord, puis les autres couleurs
    // (sans répéter celle du type). Comparaison en minuscules : '#ABC' = '#abc'.
    const colors = h('div', { class: 'swatches' },
      [typeColor, ...COLOR_CHOICES.filter((c) => c.toLowerCase() !== typeColor.toLowerCase())].map((c) => {
        // Pastille active : celle qui correspond à la couleur actuelle (perso ou du type).
        const on = (d.color ?? typeColor).toLowerCase() === c.toLowerCase();
        return h('button', {
          type: 'button', class: `swatch${on ? ' on' : ''}`, style: { background: c },
          'aria-label': c === typeColor ? 'Couleur du type' : `Couleur ${c}`, 'aria-pressed': String(on),
          onclick: () => { d.color = c === typeColor ? null : c; render(); },
        });
      }));

    // Assemblage final du formulaire, dans l'ordre d'affichage. Les « null »
    // (blocs non pertinents) sont simplement ignorés par clear() / h().
    clear(body,
      // Onglets du haut : point fixe / événement / flash.
      segmented<FormMode>([
        { value: 'fixe', label: 'Point fixe', icon: 'map-pin' },
        { value: 'event', label: 'Événement', icon: 'calendar' },
        { value: 'flash', label: 'Flash', icon: 'zap' },
      // Onglet actif : 'flash' si c'est un événement flash, sinon le mode.
      ], d.mode === 'event' && d.flash ? 'flash' : d.mode, (m) => {
        // Traduction onglet → (mode, flash) ; un flash ne se répète jamais.
        d.mode = m === 'fixe' ? 'fixe' : 'event';
        d.flash = m === 'flash';
        if (d.flash) d.recurrence = 'none';
        render();
      }, 'seg-big seg-3'),
      group('Type', typeGrid),
      field('Titre', title),
      schedule,
      // Matériel : seulement pour un événement.
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
      // Ligne de position, avec un bouton pour déplacer le point.
      // toFixed(5) : 5 décimales ≈ précision d'un mètre.
      h('div', { class: 'loc-line' },
        icon('map-pin', 16), h('span', null, `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`),
        // « Déplacer » : on ferme la sheet (la carte doit être visible), on laisse
        // choisir un nouvel endroit, puis on ROUVRE le formulaire avec le même
        // brouillon d : rien de ce qui a été saisi n'est perdu (sauf annulation : on
        // garde l'ancienne position).
        h('button', { type: 'button', class: 'link-btn', onclick: async () => {
          sheet.close();
          const pos = await pickLocation({ title: 'Déplacer le point', color, initial: d });
          if (pos) { d.lat = pos.lat; d.lng = pos.lng; }
          openPointForm(d);
        } }, 'Déplacer'),
      ),
    );
  };

  // Validation : on transforme le brouillon en PointInput (format attendu par
  // l'API), on envoie, puis on met à jour la carte.
  submit.onclick = async () => {
    // Titre vide : on met le nom du type (« Panneau électoral ») plutôt que de refuser.
    if (!d.title.trim()) d.title = TYPES[d.type].label;
    // Champs communs. Certains ne sont envoyés que s'ils ont du sens pour ce type
    // (état, blocus, matériel, annonce publique) ; sinon valeur neutre, pour ne
    // pas garder des restes d'un type choisi puis abandonné.
    const input: PointInput = {
      mode: d.mode, type: d.type, title: d.title.trim(), description: d.description.trim() || null,
      lat: d.lat, lng: d.lng, color: d.color, status: STATUSES[d.type] ? d.status : null,
      parentId: d.type === 'blocage' ? d.parentId : null,
      material: d.mode === 'event' ? d.material : [],
      // Annonce publique : seulement pour une AG côté Mouvement (double sécurité
      // avec l'affichage conditionnel plus haut).
      isPublic: d.type === 'ag' && store.space === 'mvt' && d.isPublic,
      flash: d.mode === 'event' && d.flash,
    };
    // Cas 1 : flash en création. Les dates sont calculées à partir de maintenant.
    if (d.mode === 'event' && d.flash && !isEdit) {
      const s = new Date(Date.now() + d.flashIn * 60_000);
      // On arrondit à la minute (secondes et millisecondes à zéro).
      s.setSeconds(0, 0);
      input.startsAt = s.getTime();
      input.endsAt = input.startsAt + d.flashDur * 60_000;
      input.recurrence = 'none';
      input.recurrenceUntil = null;
    // Cas 2 : événement normal (ou flash en modification). On lit les champs date/heure.
    } else if (d.mode === 'event') {
      // « return toast(...) » : affiche l'erreur et arrête la fonction en une ligne.
      if (!d.date || (!d.allDay && (!d.start || !d.end))) return toast('Indique la date, l\'heure de début et de fin.', 'err');
      let s: number, e: number;
      // Journée entière : de 00:00:00 à 23:59:59,999 (minuit du lendemain − 1 ms).
      if (d.allDay) {
        s = startOfDay(fromInputs(d.date, '00:00'));
        e = addDays(s, 1) - 1; // 23:59:59
      // Sinon : début et fin le même jour ; si la fin est avant le début
      // (ex. 22:00 → 02:00), on comprend « le lendemain ».
      } else {
        s = fromInputs(d.date, d.start);
        e = fromInputs(d.date, d.end);
        if (e <= s) e = addDays(e, 1); // fin après minuit
      }
      input.startsAt = s;
      input.endsAt = e;
      input.recurrence = d.recurrence;
      // Fin de répétition : on inclut toute la journée choisie (23:59:59,999).
      input.recurrenceUntil = d.recurrence !== 'none' && d.until ? addDays(startOfDay(fromInputs(d.until, '00:00')), 1) - 1 : null;
    // Cas 3 (implicite) : point fixe, pas de dates du tout.
    }
    busy(submit, true, 'Envoi…');
    // try / catch : si le réseau ou le serveur échoue, on affiche l'erreur et on
    // réactive le bouton pour pouvoir réessayer.
    try {
      // Photo d'abord (elle doit exister sur le serveur avant d'y faire référence).
      input.photo = await uploadIfNeeded(d.photo);
      // Modification → PUT /points/:id ; création → POST /points, en précisant
      // l'espace courant (le serveur vérifie qu'on y a accès).
      const { point } = d.id ? await api.updatePoint(d.id, input) : await api.createPoint({ ...input, space: store.space });
      // On met à jour la liste locale tout de suite (sans attendre le rafraîchissement).
      store.upsert(point);
      sheet.close();
      toast(isEdit ? 'Point mis à jour' : 'Point ajouté sur la carte', 'ok');
      // On centre la carte sur le point, zoom 16 (niveau d'une rue).
      flyTo(point, 16);
    } catch (e) {
      // On suppose que l'erreur est une ApiError (qui a un message lisible en français).
      toast((e as ApiError).message, 'err', 5000);
      busy(submit, false, isEdit ? 'Enregistrer' : 'Ajouter le point');
    }
  };

  // Ouverture de la sheet (la déclaration de « sheet » utilisée dans render()).
  const sheet = openSheet({ title: isEdit ? 'Modifier le point' : 'Nouveau point', body, footer: submit });
  // Premier affichage du formulaire.
  render();
}

// Les alertes sont des points 'event' à durée de vie courte (expiresAt), créés
// en deux gestes : position (GPS par défaut) + nature du problème.
// ---------- Alerte rapide : warning / danger / police ----------

// openAlertForm() : formulaire de signalement ou de modification d'une alerte.
// Entrées :
//   - type : 'warning' | 'danger' | 'police' ;
//   - existing : l'alerte à modifier (absente en création) ;
//   - presetPos : position déjà connue (ex. retour du choix sur la carte).
// Sans existing ni presetPos, on lance tout de suite la localisation GPS.
export function openAlertForm(type: AlertType, existing?: Point, presetPos?: Pos) {
  const meta = TYPES[type];
  // État local du formulaire (comme le Draft, en plus simple).
  const state = {
    // Position : celle de l'alerte existante, ou celle fournie, ou inconnue (null).
    pos: (existing ? { lat: existing.lat, lng: existing.lng } : presetPos ?? null) as Pos | null,
    // D'où vient la position ? 'map' (choisie à la main) ou 'gps' (localisation).
    source: existing || presetPos ? 'map' : 'gps',
    locating: false,
    // Durée de visibilité par défaut : 30 min.
    duration: 30 as number,
    // Titre par défaut : le premier problème prédéfini pour ce type et cet espace.
    title: existing?.title ?? alertPresets(type, store.space)[0] ?? meta.label,
    description: existing?.description ?? '',
    photo: { existing: existing?.photo ?? null, blob: null as Blob | null },
  };

  const body = h('div', { class: 'form' });
  // Le texte du bouton est rempli par setSubmitLabel() (il dépend de la durée).
  const submit = h('button', { class: `btn btn-block btn-${type}`, type: 'button' }, icon(meta.icon, 20), h('span', null, '')) as HTMLButtonElement;
  // « Signaler · 30 min » en création, « Enregistrer » en modification.
  const setSubmitLabel = () => (submit.querySelector('span')!.textContent = existing ? 'Enregistrer' : `Signaler · ${durLabel(state.duration)}`);

  // Carte « position » : statut (en cours / trouvée / inconnue) + 2 boutons.
  const locCard = h('div', { class: 'loc-card' });
  // renderLoc() ne redessine QUE cette carte, pas tout le formulaire : on ne
  // perd pas ce que l'utilisateur est en train de taper.
  const renderLoc = () => {
    // Ternaire imbriqué : en cours de localisation ? sinon position connue ? sinon inconnue.
    const status = state.locating
      ? h('div', { class: 'loc-status' }, h('span', { class: 'spinner' }), h('span', null, 'Localisation en cours…'))
      : state.pos
        ? h('div', { class: 'loc-status ok' }, icon('locate-fixed', 20),
            h('div', null, h('strong', null, state.source === 'gps' ? 'Ma position actuelle' : 'Emplacement choisi'),
              // Avec le GPS, on affiche la précision (± m) ; sinon les coordonnées.
              h('span', null, state.pos.accuracy ? `précision ± ${Math.round(state.pos.accuracy)} m` : `${state.pos.lat.toFixed(5)}, ${state.pos.lng.toFixed(5)}`)))
        : h('div', { class: 'loc-status err' }, icon('map-pin', 20), h('span', null, 'Position inconnue'));
    locCard.replaceChildren(status, h('div', { class: 'loc-actions' },
      // « locate » et « chooseOnMap » sont définies juste après : ça marche car
      // renderLoc() n'est appelée qu'une fois ces const déclarées.
      h('button', { type: 'button', class: 'btn btn-small btn-light', onclick: locate }, icon('locate-fixed', 16), 'Ma position'),
      h('button', { type: 'button', class: 'btn btn-small btn-light', onclick: chooseOnMap }, icon('crosshair', 16), 'Sur la carte'),
    ));
  };

  // locate() : demande la position GPS (12 s max), met à jour la carte « position ».
  const locate = async () => {
    state.locating = true;
    renderLoc();
    try {
      state.pos = await getPosition(12000);
      state.source = 'gps';
      // showMe (map.ts) affiche le point bleu « moi » sur la carte.
      showMe(state.pos);
    } catch (e) {
      // Refus d'autorisation, délai dépassé… : message expliqué par geo.ts.
      toast((e as Error).message, 'err', 4500);
    }
    state.locating = false;
    renderLoc();
  };

  // chooseOnMap() : on ferme la sheet, on laisse viser sur la carte, puis on
  // rouvre un formulaire tout neuf avec la position choisie.
  // Attention : le titre et la durée déjà saisis sont perdus à ce moment-là
  // (le nouvel appel repart des valeurs par défaut).
  const chooseOnMap = async () => {
    sheet.close();
    const pos = await pickLocation({ title: `Où est le ${meta.label.toLowerCase()} ?`, color: meta.color, initial: state.pos });
    // Si l'utilisateur annule (pos null), on garde la position précédente.
    openAlertForm(type, existing, pos ?? state.pos ?? undefined);
  };

  // Champ titre libre (on peut écrire autre chose que les propositions).
  const titleInput = h('input', { class: 'input', type: 'text', maxlength: '80', value: state.title, oninput: (e: Event) => (state.title = (e.target as HTMLInputElement).value) }) as HTMLInputElement;

  // Depuis le bouton Danger : choisir entre un danger « classique » et la présence de police / CRS.
  // Police / CRS n'existe que côté Mouvement.
  // Ce sélecteur n'apparaît qu'en création, pour danger/police, et seulement si
  // le type « police » existe dans l'espace courant (Mouvement).
  // Changer d'onglet rouvre un formulaire du nouveau type en gardant la position.
  const switchToPolice = !existing && (type === 'danger' || type === 'police') && typeInSpace('police', store.space) ? segmented<AlertType>([
    { value: 'danger', label: 'Danger', icon: 'siren' },
    { value: 'police', label: 'Police / CRS', icon: 'police' },
  ], type, (t) => { sheet.close(); openAlertForm(t, undefined, state.pos ?? undefined); }, `seg-alert seg-${type}`) : null;

  // Assemblage du formulaire d'alerte.
  clear(body,
    switchToPolice,
    locCard,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Quoi ?'),
      // Pastilles des problèmes prédéfinis (avec leur icône). Une pastille n'est
      // présélectionnée que si le titre actuel en fait partie. Choisir une pastille
      // remplit aussi le champ texte (titleInput.value = v).
      chips(alertPresets(type, store.space).map((p) => ({ value: p, label: p, icon: ALERT_ICONS[type][p] })), alertPresets(type, store.space).includes(state.title) ? state.title : null, (v) => { state.title = v; titleInput.value = v; }, meta.color),
      titleInput),
    // La durée ne se choisit qu'à la création (en modification, on ne prolonge
    // pas ici : il y a un bouton dédié dans la fiche du point).
    existing ? null : h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Visible pendant'),
      chips(ALERT_DURATIONS.map((m) => ({ value: m, label: durLabel(m) })), state.duration, (v) => { state.duration = v; setSubmitLabel(); }, meta.color)),
    // <details> : bloc repliable natif du navigateur. Ouvert d'office s'il y a déjà
    // une description ou une photo (en modification).
    h('details', { class: 'more', open: !!(state.description || state.photo.existing) },
      h('summary', null, 'Ajouter une photo ou des précisions'),
      h('div', { class: 'form' },
        photoPicker(state.photo, () => {}),
        h('textarea', { class: 'input', rows: '3', maxlength: '2000', placeholder: 'Précisions (facultatif)', oninput: (e: Event) => (state.description = (e.target as HTMLTextAreaElement).value) }, state.description),
      ),
    ),
  );

  // Envoi de l'alerte.
  submit.onclick = async () => {
    // Sans position, impossible de placer l'alerte : on refuse.
    if (!state.pos) return toast('Indique d\'abord où se trouve l\'alerte.', 'err');
    const input: PointInput = {
      mode: 'event', type, title: state.title.trim() || meta.label, description: state.description.trim() || null,
      // durationMinutes : seulement en création ; le serveur calcule expiresAt.
      lat: state.pos.lat, lng: state.pos.lng, durationMinutes: existing ? undefined : state.duration,
    };
    busy(submit, true, 'Envoi…');
    try {
      input.photo = await uploadIfNeeded(state.photo);
      const { point } = existing ? await api.updatePoint(existing.id, input) : await api.createPoint({ ...input, space: store.space });
      store.upsert(point);
      sheet.close();
      // Accord grammatical : « Police / CRS signalée », « Danger signalé ».
      toast(existing ? 'Alerte mise à jour' : `${meta.label} signalé${type === 'police' ? 'e' : ''} pour ${durLabel(state.duration)}`, 'ok');
      flyTo(point, 16);
    } catch (e) {
      toast((e as ApiError).message, 'err', 5000);
      // busy(submit, false) sans libellé, puis setSubmitLabel() remet le bon texte.
      busy(submit, false);
      setSubmitLabel();
    }
  };

  // Ouverture de la sheet, colorée selon le type d'alerte (classe sheet-warning…).
  const sheet = openSheet({ title: existing ? `Modifier · ${meta.label}` : `Signaler · ${meta.label}`, body, footer: submit, accent: meta.color });
  sheet.el.classList.add(`sheet-${type}`);
  sheet.el.style.setProperty('--accent', meta.color);
  setSubmitLabel();
  renderLoc();
  // Pas de position connue : on lance le GPS tout de suite (gain de temps).
  if (!state.pos) locate();
}

// durLabel() : minutes → texte court. 30 → « 30 min », 120 → « 2 h ».
// Attention : 90 donnerait « 1.5 h » (pas prévu, aucune durée proposée ne vaut 90).
export const durLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

// On réexporte closeSheet (de sheet.ts) pour les modules qui importent déjà forms.ts.
export { closeSheet };
