/**
 * detail.ts : la « fiche » d'un point (panneau qui s'ouvre quand on touche une épingle).
 *
 * Qui l'appelle ? main.ts (openDetail, au clic sur une épingle, sur une notification ou dans l'agenda),
 * et ce fichier lui-même : après chaque action, la fiche est rouverte avec le point à jour.
 *
 * Ce qu'on y trouve, selon le type de point : photo, étiquettes, horaire, « à combien je suis ? »,
 * blocus parent, problèmes en cours, boutons de statut (ex. blocage tenu / vide), liste des blocages
 * d'un blocus, description, qui vient / qui fournit quoi, votes d'AG, et les actions
 * (y aller, trajet, prolonger, terminer, modifier, supprimer).
 *
 * Notions :
 * - openSheet (sheet.ts) ouvre un panneau modal ; n'en existe qu'un à la fois (ouvrir l'un ferme l'autre).
 * - Chaque action appelle l'API, met à jour le store (store.upsert) puis redessine la fiche.
 * - Le texte passe toujours par h(), donc il est échappé : pas d'innerHTML dans ce fichier.
 */
// photoUrl construit l'adresse d'une photo à partir de son identifiant.
import { api, photoUrl, ApiError } from './api';
import { store, paintOf } from './store';
import { openSheet, confirmSheet } from './sheet';
// Fonctions de formulaires réutilisées : modifier un point, libellé de durée, pastilles, création.
import { editPoint, durLabel, chips, newPointFlow } from './forms';
import { h, icon, clear, toast, rangeLabel, relative, dateLong, time, toTimeInput, toDateInput, fromInputs, addDays, startOfDay } from './ui';
// Constantes et types du modèle partagé : statuts possibles par type, libellés, problèmes prédéfinis…
import {
  TYPES, iconOf, canReportProblem, STATUS_LABEL, STATUS_HINT, STATUSES, RECURRENCE_LABEL, PROBLEM_PRESETS, PROBLEM_DURATIONS,
  type Point, type Problem,
} from '../../shared/model';
// Calculs de temps : prochaine occurrence, point actif ?, problèmes non expirés.
import { nextOccurrence, isActive, liveProblems } from '../../shared/time';
import { votesSection } from './votes';
// Géolocalisation : position fraîche, dernière connue, distance à vol d'oiseau, affichage « 850 m » / « 1,2 km ».
import { getPosition, lastPosition, distance, fmtDistance, type Pos } from './geo';

/**
 * Exécute une action serveur puis rafraîchit l'affichage.
 * Entrées : fn = l'appel API (qui renvoie le point modifié), msg = message de succès.
 * Effets : met le point à jour dans le store (donc la carte se redessine), affiche un toast,
 * et rouvre la fiche avec les nouvelles données. En cas d'erreur, affiche le message du serveur.
 */
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
// Entrées : classe de taille du bouton, taille d'icône, appel API, message de succès. Sortie : le bouton.
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
      // 429 = « Too Many Requests » : le serveur dit « trop tôt ». Toast d'info (avec minuteur) plutôt qu'une erreur rouge.
      if (err.status === 429) toast(err.message, 'info', 5000, 'timer');
      else toast(err.message, 'err');
    }
  } }, icon('timer', ico), 'Toujours là !');
}

// Carte d'un problème en cours. Entrées : le point et le problème. Sortie : un <div role="alert">
// (role="alert" : les lecteurs d'écran l'annoncent). Le paramètre p n'est pas utilisé ici.
function problemCard(p: Point, pr: Problem) {
  return h('div', { class: 'problem-card', role: 'alert' },
    h('div', { class: 'problem-head' }, icon('circle-alert', 20), h('strong', null, pr.message)),
    h('span', { class: 'problem-meta' },
      // relative() donne « il y a 5 min » / « dans 25 min ».
      `Signalé ${relative(pr.createdAt)}${pr.creatorName ? ` par ${pr.creatorName}` : ''} · expire ${relative(pr.expiresAt)}`),
    h('div', { class: 'problem-actions' },
      // « C'est réglé » : le problème est clos ; « Toujours là ! » le prolonge de 30 min.
      h('button', { class: 'btn btn-small btn-done', type: 'button', onclick: () => act(() => api.resolveProblem(pr.id), 'Problème marqué comme réglé') }, icon('check', 15), 'C\'est réglé'),
      confirmButton('btn-small', 15, () => api.extendProblem(pr.id, 30), 'Problème prolongé de 30 min'),
    ),
  );
}

/** Signaler un problème sur ce point, sans créer d'alerte séparée. */
// Entrée : le point concerné. Ouvre un formulaire : message (prédéfini ou libre) + durée de visibilité.
export function openProblemForm(p: Point) {
  // Petit état local du formulaire ; `60 as number` pour que TypeScript accepte d'autres durées ensuite.
  const state = { message: PROBLEM_PRESETS[0], duration: 60 as number };
  // oninput se déclenche à chaque frappe : on garde le texte à jour dans state.
  const input = h('input', { class: 'input', type: 'text', maxlength: '200', value: state.message, placeholder: 'Que se passe-t-il ?', oninput: (e: Event) => (state.message = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  // Le <span> vide recevra le libellé « Signaler · 1 h » (mis à jour quand la durée change).
  const submit = h('button', { class: 'btn btn-danger btn-block', type: 'button' }, icon('circle-alert', 20), h('span', null, '')) as HTMLButtonElement;
  // querySelector('span') : le premier <span> du bouton (celui du texte ; l'icône est un <svg>).
  const label = () => (submit.querySelector('span')!.textContent = `Signaler · ${durLabel(state.duration)}`);
  // Gestionnaire du clic, affecté après coup (il a besoin de `s`, la fiche, déclarée plus bas).
  submit.onclick = async () => {
    if (!state.message.trim()) return toast('Décris le problème en quelques mots.', 'err');
    submit.disabled = true;
    try {
      const { point } = await api.reportProblem(p.id, state.message.trim(), state.duration);
      store.upsert(point);
      // On ferme le formulaire. `s` existe bien à ce moment : le clic arrive après l'ouverture.
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
        // Choisir une pastille prédéfinie remplit aussi le champ texte.
        chips(PROBLEM_PRESETS.map((x) => ({ value: x, label: x })), state.message, (v) => { state.message = v; input.value = v; }, '#F53B3B'),
        input),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Visible pendant'),
        chips(PROBLEM_DURATIONS.map((m) => ({ value: m, label: durLabel(m) })), state.duration, (v) => { state.duration = v; label(); }, '#F53B3B')),
    ),
    footer: submit,
  });
  // Premier calcul du libellé du bouton.
  label();
}

// Entrées : le blocage, et la fonction à appeler au clic. Sortie : un <li>.
/** Une ligne cliquable vers un blocage (dans la fiche d'un blocus). */
function blocageRow(b: Point, onOpen: () => void) {
  const problems = liveProblems(b);
  return h('li', null, h('button', { class: `link-row${problems.length ? ' has-problem' : ''}`, type: 'button', onclick: onOpen },
    // Pastille de couleur selon le statut (classes CSS st-tenu, st-vide…). `?? 'vide'` : sans statut = vide.
    h('span', { class: `link-dot st-${b.status ?? 'vide'}` }),
    h('span', { class: 'link-main' },
      h('strong', null, b.title),
      // Sous-titre : le premier problème s'il y en a, sinon le statut et depuis quand.
      h('span', null, problems.length ? problems[0].message : `${STATUS_LABEL[b.status ?? 'vide']}${b.statusAt ? ` · ${relative(b.statusAt)}` : ''}`)),
    problems.length ? icon('circle-alert', 18) : icon('chevron-right', 18),
  ));
}

/** Rattacher au blocus des blocages déjà posés sur la carte (les barricades restent d'un jour à l'autre). */
// Entrée : le blocus. Ouvre une liste de tous les blocages, avec une coche pour (dé)rattacher chacun.
function openAttachSheet(blocus: Point) {
  const list = h('ul', { class: 'pick-list' });
  // render : (re)construit la liste ; appelée après chaque clic pour refléter le changement.
  const render = () => {
    // localeCompare : tri alphabétique qui respecte les accents français.
    const all = store.points.filter((x) => x.type === 'blocage').sort((a, b) => a.title.localeCompare(b.title));
    if (!all.length) return clear(list, h('p', { class: 'muted' }, 'Aucun blocage sur la carte pour l\'instant.'));
    clear(list, ...all.map((b) => {
      // on = déjà rattaché à CE blocus ; other = rattaché à un AUTRE blocus (on l'indique).
      const on = b.parentId === blocus.id;
      const other = b.parentId && !on ? store.points.find((x) => x.id === b.parentId) : null;
      return h('li', null, h('button', { class: `pick-row${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), onclick: async () => {
        try {
          // Clic : rattacher (parentId = ce blocus) ou détacher (null).
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
    // « Terminé » : on ferme et on rouvre la fiche du blocus, avec sa version à jour dans le store.
    footer: h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => { s.close(); openDetail(store.points.find((x) => x.id === blocus.id) ?? blocus); } }, 'Terminé'),
  });
}

// Liste de noms : jusqu'à 3 en clair, puis « +N » pour les autres.
const names = (people: { name: string }[]) =>
  people.length <= 3 ? people.map((x) => x.name).join(', ') : `${people.slice(0, 3).map((x) => x.name).join(', ')} +${people.length - 3}`;

/** Blocus : on vient dès le RDV, ou plus tard (avec une heure). */
// Entrée : le blocus. Deux choix : venir au RDV, ou indiquer une heure d'arrivée plus tardive.
function openArrivalSheet(p: Point) {
  // Heure du RDV : la prochaine occurrence, sinon le début prévu, sinon maintenant.
  const occ = nextOccurrence(p);
  const start = occ?.start ?? p.startsAt ?? Date.now();
  // Ma participation actuelle (undefined si je ne viens pas).
  const mine = p.participants.find((x) => x.id === store.me.id);
  // Heure proposée par défaut : celle déjà choisie, sinon RDV + 1 h (3 600 000 ms).
  const later = mine?.arriveAt ?? start + 3600_000;
  // Champ heure par pas de 5 min (step en secondes : 300).
  const input = h('input', { class: 'input', type: 'time', step: '300', value: toTimeInput(later) }) as HTMLInputElement;
  // send : ferme la fiche et enregistre (arriveAt = null signifie « au RDV »).
  const send = (arriveAt: number | null, msg: string) => { s.close(); act(() => api.participate(p.id, true, arriveAt), msg); };
  const s = openSheet({
    title: 'Tu viens quand ?',
    accent: paintOf(p).color,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, `« ${p.title} » · RDV à ${time(start)}`),
      // is-current : met en valeur le choix actuel.
      h('button', { class: `btn btn-primary btn-block${mine && mine.arriveAt == null ? ' is-current' : ''}`, type: 'button',
        onclick: () => send(null, `Noté : tu viens au RDV de ${time(start)}`) }, icon('clock', 18), `Au RDV · ${time(start)}`),
      h('div', { class: 'card-section arrive-later' },
        h('span', { class: 'field-label' }, 'Plus tard, vers'),
        h('div', { class: 'material-add' }, input,
          h('button', { class: 'btn btn-outline', type: 'button', onclick: () => {
            if (!input.value) return toast('Indique une heure.', 'err');
            // On combine la date du RDV et l'heure saisie (heure locale).
            let t = fromInputs(toDateInput(start), input.value);
            // Heure plus tôt que le RDV (ex. RDV à 23 h, arrivée à 1 h) : c'est le lendemain. On passe
            // par la DATE du lendemain plutôt que « + 24 h » : juste avant un changement d'heure, une
            // journée fait 23 ou 25 h et l'heure affichée aurait été décalée d'une heure.
            if (t < start) t = fromInputs(toDateInput(addDays(startOfDay(start), 1)), input.value);
            send(t, `Noté : tu arrives vers ${time(t)}`);
          } }, 'Valider')),
      ),
      mine ? h('button', { class: 'btn btn-light btn-text-danger btn-block', type: 'button',
        onclick: () => { s.close(); act(() => api.participate(p.id, false), 'Tu ne participes plus'); } }, 'Je ne viens plus') : null,
    ),
  });
}

/** Liste des participant·es ; pour un blocus, séparée entre RDV et arrivées plus tard. */
// Entrée : un point. Sortie : un texte résumant qui vient.
function participantsText(p: Point) {
  if (!p.participants.length) return 'Personne pour l\'instant';
  if (p.type !== 'blocus') return names(p.participants);
  const atRdv = p.participants.filter((x) => x.arriveAt == null);
  // Arrivées plus tard, triées par heure. Le « ! » affirme que arriveAt n'est pas null (on vient de filtrer).
  const later = p.participants.filter((x) => x.arriveAt != null).sort((a, b) => a.arriveAt! - b.arriveAt!);
  return [
    atRdv.length ? `Au RDV : ${names(atRdv)}` : null,
    later.length ? `Plus tard : ${later.map((x) => `${x.name} (${time(x.arriveAt!)})`).join(', ')}` : null,
  // filter(Boolean) retire les null, puis on joint les morceaux.
  ].filter(Boolean).join(' · ');
}

/** Qui vient, et qui fournit quoi. Fournir du matériel n'oblige pas à venir. */
// Entrée : un événement. Sortie : la section « Qui vient ? » + la liste du matériel.
function pledgeSection(p: Point) {
  const me = store.me.id;
  const mine = p.participants.find((x) => x.id === me);
  const going = !!mine;
  const blocus = p.type === 'blocus';
  // Libellé du bouton : pas inscrit, inscrit au RDV, inscrit avec une heure, ou simple inscription.
  const label = !going ? 'Je participe ?'
    : blocus ? (mine.arriveAt == null ? 'Je viens au RDV' : `J'arrive vers ${time(mine.arriveAt)}`)
    : 'Je participe';
  return h('div', { class: 'card-section pledges' },
    h('div', { class: 'pledge-head' },
      h('div', null,
        h('div', { class: 'section-title' }, icon('users', 18), `Qui vient ? (${p.participants.length})`),
        h('span', { class: 'field-hint' }, participantsText(p))),
      h('button', { class: `btn btn-small ${going ? 'btn-done' : 'btn-primary'}`, type: 'button',
        // Pour un blocus, on ouvre le choix de l'heure ; sinon, le bouton bascule l'inscription directement.
        onclick: () => blocus ? openArrivalSheet(p)
          : act(() => api.participate(p.id, !going), going ? 'Tu ne participes plus' : 'Noté : tu participes') },
        going ? icon('check', 15) : null, label),
      blocus && going ? h('span', { class: 'field-hint' }, 'Touche le bouton pour changer ton heure ou te désinscrire.') : null,
    ),
    // Matériel demandé : pour chaque objet, qui le fournit, et un bouton pour me (dés)inscrire.
    p.material.length ? h('div', { class: 'material' },
      h('div', { class: 'section-title' }, icon('package', 18), 'Matériel'),
      h('ul', { class: 'material-rows' }, p.material.map((m) => {
        // p.providers[m] : la liste des personnes qui fournissent l'objet m (peut ne pas exister).
        const who = p.providers[m] ?? [];
        // Ce `mine` est local à la boucle (il masque celui du dessus) : est-ce MOI qui fournis cet objet ?
        const mine = who.some((x) => x.id === me);
        // Classe « missing » : personne ne fournit encore cet objet (mis en évidence en CSS).
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

// Constantes d'estimation (approximatives, pas de calcul d'itinéraire réel).
/** Vitesses moyennes en ville (km/h) et détour des rues par rapport à la ligne droite. */
const WALK_KMH = 4.5;
const BIKE_KMH = 13;
const DETOUR = 1.3;
// mins(mètres, km/h) : durée en minutes (au moins 1), affichée « 12 min » ou « 1 h 05 ».
// mètres / 1000 = km ; km / (km/h) = heures ; × 60 = minutes.
const mins = (m: number, kmh: number) => {
  const t = Math.max(1, Math.round((m / 1000 / kmh) * 60));
  return t >= 60 ? `${Math.floor(t / 60)} h ${String(t % 60).padStart(2, '0')}` : `${t} min`;
};

/** « À combien je suis ? » : distance et temps estimés depuis ma position, à pied et à vélo. */
// Sortie : un bloc qui affiche soit un bouton, soit l'estimation, soit « Localisation… ».
function howFar(p: Point) {
  const wrap = h('div', { class: 'how-far' });
  // show : affiche l'estimation pour une position donnée.
  const show = (pos: Pos) => {
    const m = distance(pos, p) * DETOUR;
    clear(wrap,
      h('div', { class: 'how-far-res' },
        h('span', { class: 'how-far-item' }, icon('footprints', 16), h('strong', null, mins(m, WALK_KMH)), 'à pied'),
        h('span', { class: 'how-far-item' }, icon('bike', 16), h('strong', null, mins(m, BIKE_KMH)), 'à vélo'),
        h('span', { class: 'how-far-item muted' }, `≈ ${fmtDistance(m)}`),
      ),
      // « Actualiser » relance une localisation. ask est déclarée plus bas, mais n'est utilisée qu'au clic.
      h('button', { class: 'link-btn', type: 'button', onclick: ask }, 'Actualiser'),
    );
  };
  // ask : demande la position (délai max 12 s) avec un indicateur d'attente.
  const ask = async () => {
    clear(wrap, h('span', { class: 'how-far-wait' }, h('span', { class: 'spinner' }), 'Localisation…'));
    try {
      show(await getPosition(12000));
    } catch (e) {
      toast((e as Error).message, 'err', 4500);
      // En cas d'échec on revient au bouton initial.
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
// Entrée : le flash. Propose +15, +30 ou +60 min.
function openExtendFlash(p: Point) {
  const pick = (m: number) => { s.close(); act(() => api.extendFlash(p.id, m), `Flash prolongé de ${durLabel(m)}`); };
  const s = openSheet({
    title: 'Prolonger le flash',
    accent: paintOf(p).color,
    body: h('div', { class: 'form' },
      // p.endsAt! : un flash a toujours une heure de fin (le « ! » le promet à TypeScript).
      h('p', { class: 'muted' }, `« ${p.title} » se termine à ${time(p.endsAt!)}. Rajouter :`),
      h('div', { class: 'grid-3' }, [15, 30, 60].map((m) => h('button', { class: 'btn btn-outline', type: 'button', onclick: () => pick(m) }, `+ ${durLabel(m)}`))),
    ),
  });
}

// Lien Google Maps « itinéraire vers ces coordonnées ». Exportée mais utilisée seulement ici aujourd'hui.
export function directionsUrl(p: { lat: number; lng: number }) {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
}

// Texte d'horaire du point (ou null pour un point fixe). Exportée mais utilisée seulement ici aujourd'hui.
export function scheduleText(p: Point): string | null {
  if (TYPES[p.type].alert) {
    // Alerte : depuis quand, et quand elle expire (ou « Alerte expirée »).
    return p.expiresAt && p.expiresAt > Date.now() ? `Signalé ${relative(p.createdAt)} · expire ${relative(p.expiresAt)}` : 'Alerte expirée';
  }
  if (p.mode !== 'event') return null;
  // Événement : la prochaine occurrence ; aucune → « Terminé ».
  const occ = nextOccurrence(p);
  if (!occ) return 'Terminé';
  return rangeLabel(occ.start, occ.end);
}

/**
 * Ouvre la fiche d'un point. Entrée : le point. Pas de sortie.
 * Toute la fiche est reconstruite à chaque appel : c'est ainsi qu'on la « rafraîchit » après une action.
 */
export function openDetail(p: Point) {
  const meta = TYPES[p.type];
  const { color, ink } = paintOf(p);
  // Puis-je modifier ce point ? (admin de l'espace, ou auteur·rice.)
  const canEdit = store.canEdit(p);
  const sched = scheduleText(p);

  // Statuts possibles pour ce type (ex. blocage : tenu / vide) ; undefined si le type n'en a pas.
  const statuses = STATUSES[p.type];
  const statusRow = statuses ? h('div', { class: 'field' },
    p.type === 'blocage' ? h('span', { class: 'field-label' }, 'Sur place en ce moment') : null,
    h('div', { class: 'status-row' },
      statuses.map((s) => h('button', {
        class: `status-btn st-${s}${p.status === s ? ' on' : ''}`, type: 'button',
        // Clic sur un statut : on l'enregistre, puis on rouvre la fiche à jour.
        onclick: async () => {
          try {
            const { point } = await api.setStatus(p.id, s);
            store.upsert(point);
            toast(`${meta.short} : ${STATUS_LABEL[s].toLowerCase()}`, 'ok');
            openDetail(point);
          } catch (e) { toast((e as ApiError).message, 'err'); }
        },
      }, s === 'colle' ? icon('check', 16) : null,
      // Statut avec explication : deux lignes (titre en gras + aide en petit), sinon simple libellé.
      STATUS_HINT[s] ? h('span', { class: 'status-two' }, h('b', null, STATUS_LABEL[s]), h('small', null, STATUS_HINT[s])) : STATUS_LABEL[s])),
    ),
    p.statusAt ? h('span', { class: 'field-hint' }, `Mis à jour ${relative(p.statusAt)}`) : null,
  ) : null;

  // Pour un blocage rattaché : un lien vers son blocus parent.
  const parent = p.parentId ? store.points.find((x) => x.id === p.parentId) : null;
  const parentLine = parent ? h('button', { class: 'parent-line', type: 'button', onclick: () => openDetail(parent) },
    icon(TYPES[parent.type].icon, 16), h('span', null, 'Blocus : ', h('strong', null, parent.title)), icon('chevron-right', 16)) : null;

  // Pour un blocus : ses blocages, ceux qui ont des problèmes en premier, puis par ordre alphabétique.
  const children = p.type === 'blocus' ? store.points.filter((x) => x.parentId === p.id) : [];
  const blocusSection = p.type === 'blocus' ? h('div', { class: 'card-section' },
    h('div', { class: 'section-title' }, icon('construction', 18), `Blocages (${children.length})`),
    children.length
      ? h('ul', { class: 'link-list' }, children
          // Tri : différence du nombre de problèmes (décroissant), sinon (|| quand c'est 0) tri par titre.
          .sort((a, b) => liveProblems(b).length - liveProblems(a).length || a.title.localeCompare(b.title))
          .map((c) => blocageRow(c, () => openDetail(c))))
      : h('p', { class: 'field-hint' }, 'Aucun blocage rattaché pour l\'instant.'),
    h('div', { class: 'grid-2' },
      // `sheet` est déclarée tout en bas ; ça marche car le clic arrive après l'ouverture de la fiche.
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { sheet.close(); newPointFlow('fixe', { type: 'blocage', parentId: p.id }); } }, icon('plus', 15), 'Nouveau blocage'),
      h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => { sheet.close(); openAttachSheet(p); } }, icon('construction', 15), 'Rattacher'),
    ),
  ) : null;

  // Ce point est-il dans le trajet de collage ?
  const inRoute = store.routeSelection.has(p.id);
  const actions = h('div', { class: 'detail-actions' },
    h('a', { class: 'btn btn-primary', href: directionsUrl(p), target: '_blank', rel: 'noopener' }, icon('navigation', 18), 'Y aller'),
    // Ajout/retrait du trajet : on vide l'ordre calculé (il faudra le recalculer) et on prévient la carte.
    meta.routable ? h('button', { class: `btn ${inRoute ? 'btn-light' : 'btn-outline'}`, type: 'button', onclick: () => {
      if (inRoute) store.routeSelection.delete(p.id); else store.routeSelection.add(p.id);
      store.routeOrder = [];
      store.emit('route');
      toast(inRoute ? 'Retiré du trajet' : 'Ajouté au trajet de collage', 'ok');
      openDetail(p);
    } }, icon('route', 18), inRoute ? 'Retirer du trajet' : 'Ajouter au trajet') : null,
    // Alerte : « Toujours là ! » la prolonge de 30 min.
    meta.alert ? confirmButton('', 18, () => api.extend(p.id, 30), 'Alerte prolongée de 30 min') : null,
    // « Terminer maintenant » : seulement l'auteur·rice/admin, pour un événement (pas une alerte) déjà commencé.
    // `?? Infinity` : sans occurrence, la condition est fausse (Infinity n'est jamais <= maintenant).
    canEdit && p.mode === 'event' && !meta.alert && isActive(p) && (nextOccurrence(p)?.start ?? Infinity) <= Date.now() ? h('button', { class: 'btn btn-light', type: 'button', onclick: async () => {
      // Pour un blocus : combien de blocages sont encore « tenus » (ils passeront à vide).
      const held = p.type === 'blocus' ? store.points.filter((x) => x.parentId === p.id && x.status === 'tenu').length : 0;
      const more = held ? ` ${held > 1 ? `Les ${held} blocages encore tenus passeront` : 'Le blocage encore tenu passera'} à « sans personne ».` : '';
      // confirmSheet renvoie une Promise<boolean> : true si on confirme. Dernier argument false = bouton non rouge.
      if (!(await confirmSheet('Terminer maintenant ?', `« ${p.title} » disparaîtra de la carte, mais restera visible dans l'agenda.${more}`, 'Terminer', false))) return;
      act(() => api.finish(p.id), 'Événement terminé');
    } }, icon('flag', 18), 'Terminer maintenant') : null,
    // Flash : l'auteur·rice (ou un admin) peut rajouter du temps tant qu'il n'est pas fini.
    canEdit && p.flash && (p.endsAt ?? 0) > Date.now() ? h('button', { class: 'btn btn-light', type: 'button', onclick: () => openExtendFlash(p) },
      icon('timer', 18), 'Prolonger') : null,
    canEdit ? h('button', { class: 'btn btn-light', type: 'button', onclick: () => { sheet.close(); editPoint(p); } }, icon('pencil', 18), 'Modifier') : null,
    // Suppression, avec confirmation. Pas de openDetail ensuite : le point n'existe plus.
    canEdit ? h('button', { class: 'btn btn-light btn-text-danger', type: 'button', onclick: async () => {
      if (!(await confirmSheet('Supprimer ce point ?', `« ${p.title} » disparaîtra de la carte pour tout le monde.`, 'Supprimer'))) return;
      try {
        await api.deletePoint(p.id);
        store.remove(p.id);
        toast('Point supprimé', 'ok');
      } catch (e) { toast((e as ApiError).message, 'err'); }
    } }, icon('trash-2', 18), 'Supprimer') : null,
  );

  // Assemblage de la fiche, de haut en bas.
  const body = h('div', { class: 'detail' },
    // Photo cliquable (ouvre l'image en grand dans un nouvel onglet) ; loading: 'lazy' = chargée seulement si visible.
    p.photo ? h('a', { href: photoUrl(p.photo), target: '_blank', rel: 'noopener', class: 'detail-photo' }, h('img', { src: photoUrl(p.photo), alt: `Photo : ${p.title}`, loading: 'lazy' })) : null,
    // Étiquettes : type (aux couleurs du point), fixe, flash, publique, répétition.
    h('div', { class: 'detail-tags' },
      h('span', { class: 'tag', style: { background: color, color: ink } }, icon(iconOf(p), 15), meta.label),
      p.mode === 'fixe' ? h('span', { class: 'tag tag-outline' }, 'Point fixe') : null,
      p.flash ? h('span', { class: 'tag tag-flash' }, icon('zap', 14), 'Flash') : null,
      p.isPublic ? h('span', { class: 'tag tag-outline' }, icon('globe', 14), 'Annoncée publiquement') : null,
      p.recurrence !== 'none' ? h('span', { class: 'tag tag-outline' }, icon('repeat', 14), RECURRENCE_LABEL[p.recurrence]) : null,
    ),
    h('h3', { class: 'detail-title' }, p.title),
    sched ? h('p', { class: `detail-when${meta.alert ? ' alert' : ''}` }, icon(meta.alert ? 'timer' : 'clock', 17), sched) : null,
    // Estimation de distance/temps depuis ma position.
    howFar(p),
    p.recurrence !== 'none' && p.recurrenceUntil ? h('p', { class: 'detail-meta' }, `Jusqu'au ${dateLong(p.recurrenceUntil)}`) : null,
    parentLine,
    // Une carte par problème en cours (h() accepte un tableau d'enfants).
    liveProblems(p).map((pr) => problemCard(p, pr)),
    statusRow,
    blocusSection,
    p.description ? h('p', { class: 'detail-desc' }, p.description) : null,
    // Section participation : seulement pour les événements (pas les points fixes ni les alertes).
    p.mode === 'event' && !meta.alert ? pledgeSection(p) : null,
    // AG côté Mouvement : votes façon Kahoot (code à 5 chiffres, sur place).
    p.type === 'ag' && p.space === 'mvt' ? votesSection(p) : null,
    // Un problème n'a de sens que sur un lieu tenu (blocage) : ailleurs, il ne dit pas où aller.
    !canReportProblem(p.type) ? null : h('button', { class: 'btn btn-outline-danger btn-block', type: 'button', onclick: () => { sheet.close(); openProblemForm(p); } },
      icon('circle-alert', 18), 'Signaler un problème ici'),
    actions,
    h('p', { class: 'detail-meta' }, `Ajouté par ${p.creatorName ?? 'un appareil retiré'} · ${relative(p.createdAt)}`),
  );

  // Ouverture : l'en-tête de la fiche prend la couleur du point, ou le rouge s'il y a un problème.
  const sheet = openSheet({ title: meta.short, body, accent: liveProblems(p).length ? '#F53B3B' : color });
  // Variable CSS --accent sur la fiche : utilisée par le CSS pour colorer certains détails.
  sheet.el.style.setProperty('--accent', color);
}
