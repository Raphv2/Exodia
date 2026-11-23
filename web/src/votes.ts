// =============================================================================
// votes.ts : les votes d'AG (côté Mouvement), façon Kahoot.
// =============================================================================
// Principe : l'organisation lance un vote sur une AG ; le serveur génère un
// code à 5 chiffres ; on l'affiche en grand (écran « Kahoot ») ; les personnes
// présentes votent, avec l'app OU sans compte en tapant le code sur la page
// d'accueil. Un vote par appareil. Les résultats ne sont visibles par tous
// qu'à la clôture (l'organisation les voit en direct).
//
// Distance : à la création, on choisit un rayon (25 m … 500 m) autour du point
// de l'AG ; pour voter il faut envoyer sa position GPS, et le serveur vérifie.
// Rayon 0 = « peu importe » : pas de position demandée. Si en plus l'AG est
// annoncée publiquement, le vote s'affiche directement sur la page d'accueil,
// sans code (« openToAll »). Un vote sans compte est seulement INDICATIF : on
// peut revoter en changeant de navigateur.
//
// Ce fichier contient trois parties :
//   1. dans l'app : la section « Votes » de la fiche d'une AG, la création d'un
//      vote, l'écran Kahoot et le vote depuis l'app ;
//   2. la page publique « J'ai un code de vote » (sans compte) ;
//   3. resultBars(), les barres de résultats, réutilisées par archive.ts.
//
// Qui l'appelle ? detail.ts (votesSection), agenda.ts (openAppVote,
// openKahoot), main.ts (publicVotePage), archive.ts (resultBars).
// Notions : rafraîchissement en direct via l'événement 'votes' du store, que
// main.ts déclenche quand le serveur pousse une nouvelle (EventSource).
import { api, ApiError } from './api';
import { store } from './store';
import { openSheet } from './sheet';
import { getPosition, type Pos } from './geo';
import { h, icon, clear, toast, relative } from './ui';
import { chips } from './forms';
import { VOTE_RADII, DEFAULT_VOTE_RADIUS, voteRadiusLabel, type Point, type Vote } from '../../shared/model';

// Phrase affichée sous le code : r = rayon en mètres (0 = pas de condition).
/** Texte de la règle de distance d'un vote. */
const whereText = (r: number) => (r ? `Sur place uniquement, à moins de ${r} m.` : 'Depuis n\'importe où : pas de condition de distance.');

/*
 * Votes en AG, façon Kahoot : un code à 5 chiffres par vote, un vote par appareil,
 * seulement sur place (à moins de X m de l'AG, distance choisie au lancement). Le serveur vérifie tout.
 */

// Choix proposés par défaut à la création d'un vote (modifiables).
const DEFAULT_OPTIONS = ['Pour', 'Contre', 'Abstention'];

/** Barres de résultats (ou simple participation si les résultats ne sont pas encore visibles). */
// Entrées :
//   - options : les libellés des choix ;
//   - counts : nombre de voix par choix, ou null si les résultats sont encore
//     cachés (vote ouvert, et je ne suis pas de l'organisation) ;
//   - total : nombre total de votes ;
//   - mine : l'indice de mon choix (pour le marquer d'une coche), ou null.
// Sortie : un <ul> de barres, ou un simple <p> « N votes pour l'instant ».
export function resultBars(options: string[], counts: number[] | null, total: number, mine: number | null = null) {
  if (!counts) {
    return h('p', { class: 'vote-total' }, icon('users', 16), `${total} vote${total > 1 ? 's' : ''} pour l'instant`);
  }
  // Le plus grand score (au moins 1, pour ne jamais diviser par zéro).
  const max = Math.max(1, ...counts);
  // Somme des voix. reduce additionne tous les éléments en partant de 0.
  const sum = counts.reduce((a, b) => a + b, 0);
  return h('ul', { class: 'vote-bars' }, options.map((o, i) => {
    // Pourcentage arrondi ; 0 si personne n'a voté.
    // Attention : les arrondis peuvent donner un total de 99 % ou 101 %.
    const pct = sum ? Math.round((counts[i] / sum) * 100) : 0;
    // Classe « top » sur le(s) choix en tête (à égalité, plusieurs barres) ;
    // « mine » sur mon choix.
    return h('li', { class: `vote-bar${counts[i] === max && sum ? ' top' : ''}${mine === i ? ' mine' : ''}` },
      h('span', { class: 'vote-bar-label' }, mine === i ? icon('check', 14) : null, o),
      // La largeur de la barre colorée = le pourcentage (style CSS en ligne).
      h('span', { class: 'vote-bar-track' }, h('span', { class: 'vote-bar-fill', style: { width: `${pct}%` } })),
      h('span', { class: 'vote-bar-num' }, `${counts[i]} · ${pct} %`));
  }));
}

// Sortie : la position, ou null (après avoir affiché pourquoi dans un toast).
// On attend jusqu'à 15 s : en intérieur, le GPS est lent.
/** Position GPS pour voter (le serveur vérifie la distance à l'AG). */
async function hereOrToast(): Promise<Pos | null> {
  try {
    return await getPosition(15000);
  } catch (e) {
    toast((e as Error).message, 'err', 6000);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dans l'app : section « Votes » d'une AG
// ---------------------------------------------------------------------------

// votesSection() : bloc « Votes » affiché dans la fiche d'une AG.
// Entrée : le point (l'AG). Sortie : un <div> qui se remplit tout seul
// (d'abord « Chargement… », puis la liste) et se recharge à chaque événement
// 'votes' du store.
export function votesSection(p: Point): HTMLElement {
  const wrap = h('div', { class: 'card-section votes' },
    h('div', { class: 'section-title' }, icon('vote', 18), 'Votes'),
    h('p', { class: 'field-hint' }, 'Chargement…'));
  // alive : passe à false quand le bloc n'est plus affiché, pour arrêter les rechargements.
  let alive = true;

  // load() : récupère les votes de l'AG et redessine le bloc.
  const load = async () => {
    if (!alive) return;
    // Nettoyage « paresseux » : si le bloc a déjà été affiché (mounted) mais n'est
    // plus dans la page (fiche fermée), on se désabonne (off) au lieu de
    // recharger. On ne le détecte qu'au prochain événement 'votes'.
    if (!wrap.isConnected && wrap.dataset.mounted) { alive = false; off(); return; }
    try {
      // canRun : le serveur dit si j'ai le droit de lancer / clore des votes ici.
      const { votes, canRun } = await api.votes(p.id);
      // dataset.mounted → attribut HTML data-mounted="1" : marque « déjà affiché une fois ».
      wrap.dataset.mounted = '1';
      clear(wrap,
        h('div', { class: 'section-title' }, icon('vote', 18), `Votes${votes.length ? ` (${votes.length})` : ''}`),
        votes.length ? h('ul', { class: 'vote-list' }, votes.map((v) => voteRow(v, canRun))) : h('p', { class: 'field-hint' }, 'Aucun vote pour l\'instant.'),
        canRun ? h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => openNewVote(p) }, icon('plus', 18), 'Lancer un vote') : null,
        h('p', { class: 'field-hint' }, 'Pour voter, il faut être sur place (distance choisie au lancement du vote), avec l\'app ou juste le code à 5 chiffres sur la page d\'accueil.'),
      );
    } catch (e) {
      clear(wrap, h('p', { class: 'field-hint' }, (e as ApiError).message));
    }
  };
  // store.on renvoie une fonction de désabonnement, gardée dans « off ».
  // « void » signale qu'on ignore volontairement la Promise renvoyée par load().
  const off = store.on('votes', () => void load());
  void load();
  return wrap;
}

// voteRow() : une ligne de la liste des votes d'une AG, avec ses boutons.
// canRun : afficher ou non « Afficher le code » (organisation seulement).
function voteRow(v: Vote, canRun: boolean) {
  const open = v.status === 'open';
  return h('li', { class: `vote-item${open ? ' open' : ''}` },
    h('div', { class: 'vote-head' },
      h('strong', null, v.question),
      h('span', { class: `vote-status ${v.status}` }, open ? 'En cours' : 'Clos')),
    // Ligne d'info : quand il a été lancé et la règle de distance, ou quand il a été clos.
    h('span', { class: 'field-hint' }, open ? `Lancé ${relative(v.createdAt)} · ${v.radius ? `sur place à moins de ${v.radius} m` : 'sans condition de distance'}` : `Clos ${relative(v.closedAt ?? v.createdAt)}`),
    resultBars(v.options, v.counts, v.total, v.myChoice),
    h('div', { class: 'vote-actions' },
      open && canRun ? h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => openKahoot(v.id) }, icon('qr-code', 15), 'Afficher le code') : null,
      // « Voter » si je n'ai pas encore voté ; « Tu as voté » sinon.
      // « == null » attrape à la fois null et undefined.
      open && v.myChoice == null ? h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => openAppVote(v) }, icon('vote', 15), 'Voter') : null,
      open && v.myChoice != null ? h('span', { class: 'vote-done' }, icon('check', 15), 'Tu as voté') : null,
    ),
  );
}

/** Lancer un vote : la question et les choix (Pour / Contre / Abstention par défaut). */
// Entrée : l'AG. À la validation, le vote est créé puis l'écran Kahoot s'ouvre.
export function openNewVote(p: Point) {
  // « as number » : DEFAULT_VOTE_RADIUS est une constante (type littéral 50) ;
  // on élargit pour pouvoir y mettre une autre distance.
  const state = { question: '', options: [...DEFAULT_OPTIONS], radius: DEFAULT_VOTE_RADIUS as number };
  const list = h('div', { class: 'vote-options-edit' });
  // renderOptions() : un champ texte par choix, avec une croix pour le retirer
  // (seulement s'il en reste plus de 2). Redessiner après une suppression est
  // nécessaire : les indices i des choix suivants changent.
  const renderOptions = () => clear(list, ...state.options.map((o, i) => h('div', { class: 'vote-option-edit' },
    // Taper dans un champ modifie directement state.options[i] (sans redessiner).
    h('input', { class: 'input', type: 'text', maxlength: '60', value: o, 'aria-label': `Choix ${i + 1}`, oninput: (e: Event) => (state.options[i] = (e.target as HTMLInputElement).value) }),
    state.options.length > 2 ? h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Retirer ce choix', onclick: () => { state.options.splice(i, 1); renderOptions(); } }, icon('x', 18)) : null,
  )));
  renderOptions();
  const question = h('input', { class: 'input', type: 'text', maxlength: '200', placeholder: 'Ex. : On reconduit le blocus demain ?', oninput: (e: Event) => (state.question = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('vote', 20), h('span', null, 'Lancer le vote')) as HTMLButtonElement;
  submit.onclick = async () => {
    // On nettoie les choix : espaces retirés, choix vides supprimés (filter(Boolean)
    // garde seulement les chaînes non vides).
    const options = state.options.map((o) => o.trim()).filter(Boolean);
    if (!state.question.trim()) return toast('Écris la question.', 'err');
    if (options.length < 2) return toast('Il faut au moins 2 choix.', 'err');
    // On désactive le bouton pendant l'envoi (anti double-clic).
    submit.disabled = true;
    try {
      const { vote } = await api.createVote(p.id, state.question.trim(), options, state.radius);
      // « s » (la sheet) est déclarée plus bas ; elle existe bien au moment du clic.
      s.close();
      // Prévenir les autres blocs (fiche de l'AG, archive…) qu'il y a du nouveau.
      store.emit('votes');
      openKahoot(vote.id);
    } catch (e) {
      toast((e as ApiError).message, 'err');
      submit.disabled = false;
    }
  };
  const s = openSheet({
    title: 'Nouveau vote',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, `Sur « ${p.title} ». Un code à 5 chiffres sera généré : les gens sur place le tapent pour voter, avec ou sans l'app.`),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Question'), question),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Choix'), list,
        // Maximum 8 choix ; un nouveau choix commence vide.
        h('button', { class: 'link-btn', type: 'button', onclick: () => { if (state.options.length < 8) { state.options.push(''); renderOptions(); } } }, '+ Ajouter un choix')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Pour voter, être à moins de'),
        // Pastilles de distance, construites depuis VOTE_RADII (0 = « Peu importe »).
        chips(VOTE_RADII.map((r) => ({ value: r as number, label: voteRadiusLabel(r) })), state.radius, (v) => (state.radius = v)),
        h('span', { class: 'field-hint' }, 'Autour du point de l\'AG. 50 m suffit pour une salle ou une cour ; plus large pour un amphi, une esplanade ou une manif. « Peu importe » : on peut voter de partout, sans donner sa position ; si l\'AG est annoncée publiquement, le vote apparaît même directement sur la page d\'accueil, sans code.'),
        h('p', { class: 'vote-indicatif' }, icon('circle-alert', 16), h('span', null, 'Vote sans compte = vote indicatif : un même appareil peut revoter en changeant de navigateur ou en navigation privée. Pour une vraie décision, garde une distance courte et vérifie le nombre de votes par rapport aux présent·es.'))),
    ),
    footer: submit,
  });
  // Focus sur la question après l'animation d'ouverture de la sheet.
  setTimeout(() => question.focus(), 250);
}

/** Écran façon Kahoot : le code en grand, la participation et les résultats en direct. */
// Entrée : l'id du vote. L'écran se recharge à chaque événement 'votes' (ex.
// quelqu'un vient de voter) jusqu'à sa fermeture.
export function openKahoot(voteId: string) {
  const body = h('div', { class: 'kahoot' });
  const footer = h('div', { class: 'kahoot-footer' });
  // alive passe à false à la fermeture : un rechargement en cours ne redessine plus rien.
  let alive = true;
  // render() : recharge le vote depuis le serveur et redessine tout.
  const render = async () => {
    if (!alive) return;
    try {
      const { vote: v } = await api.vote(voteId);
      const open = v.status === 'open';
      clear(body,
        h('p', { class: 'kahoot-question' }, v.question),
        // Vote déjà sur la page d'accueil : on le dit en grand, le code devient secondaire (facultatif).
        open && v.openToAll ? h('div', { class: 'kahoot-open' }, icon('globe', 22),
          h('div', null, h('strong', null, 'Ce vote est sur la page d\'accueil'), h('span', null, 'Pas besoin de code : il suffit d\'ouvrir le site et de voter. Vote indicatif.'))) : null,
        open && v.code && v.openToAll ? h('span', { class: 'kahoot-code-label' }, 'Code (facultatif)') : null,
        // Le code est affiché chiffre par chiffre (un <span> chacun, pour le style).
        // aria-label avec des espaces : un lecteur d'écran lit « 1 2 3 4 5 » et non
        // « douze mille trois cent… ».
        open && v.code ? h('div', { class: `kahoot-code${v.openToAll ? ' small' : ''}`, 'aria-label': `Code ${v.code.split('').join(' ')}` }, v.code.split('').map((d) => h('span', null, d))) : null,
        // Consignes, seulement quand un code est nécessaire.
        open && !v.openToAll ? h('p', { class: 'kahoot-hint' }, `Tape ce code sur la page d'accueil de l'app (sans compte) ou dans la fiche de l'AG. ${whereText(v.radius)}${v.radius ? '' : ' Vote indicatif : sans compte, on peut revoter avec un autre navigateur.'}`) : null,
        !open ? h('p', { class: 'kahoot-hint' }, 'Vote clos : voici les résultats.') : null,
        h('p', { class: 'kahoot-total' }, h('strong', null, String(v.total)), ` vote${v.total > 1 ? 's' : ''}`),
        resultBars(v.options, v.counts, v.total),
      );
      // Pied de l'écran : « Clore le vote » tant qu'il est ouvert, « Fermer » ensuite.
      clear(footer, open
        ? h('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: async () => {
            // Après clôture, on prévient les autres blocs et on redessine (résultats).
            try { await api.closeVote(voteId); store.emit('votes'); void render(); } catch (e) { toast((e as ApiError).message, 'err'); }
          } }, icon('flag', 18), 'Clore le vote')
        : h('button', { class: 'btn btn-light btn-block', type: 'button', onclick: () => s.close() }, 'Fermer'));
    } catch (e) {
      clear(body, h('p', { class: 'muted' }, (e as ApiError).message));
    }
  };
  // On s'abonne aux nouvelles ; à la fermeture de la sheet, on se désabonne.
  const off = store.on('votes', () => void render());
  // wide: true → fenêtre plus large sur ordinateur (pour projeter le code).
  const s = openSheet({ title: 'Vote', body, footer, wide: true, onClose: () => { alive = false; off(); } });
  void render();
}

/** Voter depuis l'app (même règle de distance). */
// Entrée : le vote. Un bouton par choix ; cliquer = voter immédiatement
// (pas de confirmation).
export function openAppVote(v: Vote) {
  const s = openSheet({
    title: 'Voter',
    body: h('div', { class: 'form' },
      h('p', { class: 'kahoot-question' }, v.question),
      h('div', { class: 'vote-choices' }, v.options.map((o, i) => h('button', { class: 'btn btn-outline btn-block vote-choice', type: 'button', onclick: async (e: Event) => {
        // currentTarget = le bouton cliqué (et pas un éventuel enfant du bouton).
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        // Position seulement si le vote a une condition de distance.
        const pos = v.radius ? await hereOrToast() : null;
        // Si une position est requise mais introuvable, on réactive le bouton et on s'arrête.
        if (v.radius && !pos) { b.disabled = false; return; }
        try {
          // i = indice du choix. Le serveur refuse si trop loin ou si déjà voté.
          await api.ballot(v.id, i, pos);
          s.close();
          store.emit('votes');
          // Le 4e argument de toast est l'icône affichée.
          toast('A voté !', 'ok', 3500, 'vote');
        } catch (err) {
          toast((err as ApiError).message, 'err', 6000);
          b.disabled = false;
        }
      } }, o))),
      h('p', { class: 'field-hint' }, v.radius ? `Ta position est vérifiée une seule fois pour ce vote (à moins de ${v.radius} m de l'AG). Un vote par appareil.` : 'Pas de condition de distance pour ce vote. Un vote par appareil.'),
    ),
  });
}

// ---------------------------------------------------------------------------
// Page publique : voter avec le code, sans compte
// ---------------------------------------------------------------------------

/** Contenu de la page « J'ai un code de vote » (dans l'écran d'accès neutre). */
// Entrée : back = fonction pour revenir à l'écran d'accès.
// Sortie : un <div> dont le contenu change selon l'étape :
//   askCode (saisir le code) → showVote (choisir) → showDone (attendre les résultats).
export function publicVotePage(back: () => void): HTMLElement {
  const root = h('div', { class: 'pv' });
  // Le code et la position sont gardés entre les étapes (variables de la closure).
  let code = '';
  let pos: Pos | null = null;

  // askCode() : étape 1. msg = message d'erreur à afficher (facultatif).
  const askCode = (msg?: string) => {
    const input = h('input', {
      // inputmode numeric : clavier à chiffres sur mobile.
      // autocomplete one-time-code : iOS peut proposer un code reçu par SMS (sans
      // effet ici, mais sans gêne).
      class: 'input input-big pv-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      maxlength: '5', pattern: '[0-9]*', placeholder: '_ _ _ _ _', 'aria-label': 'Code à 5 chiffres', value: code,
      // À chaque frappe, on retire tout ce qui n'est pas un chiffre et on coupe à 5.
      oninput: (e: Event) => { const t = e.target as HTMLInputElement; t.value = t.value.replace(/\D/g, '').slice(0, 5); },
    }) as HTMLInputElement;
    // type submit : le bouton soumet le <form> (Entrée au clavier marche aussi).
    const btn = h('button', { class: 'btn btn-yellow btn-big btn-block', type: 'submit' }, h('span', null, 'Voter'), icon('arrow-right', 22)) as HTMLButtonElement;
    clear(root,
      h('h1', { class: 'splash-title' }, 'Code de vote'),
      h('p', { class: 'splash-text' }, 'Tape le code à 5 chiffres affiché pendant l\'AG. Si le vote demande d\'être sur place, ta position est vérifiée, puis oubliée.'),
      msg ? h('p', { class: 'pv-error', role: 'alert' }, icon('circle-alert', 18), msg) : null,
      // Soumission du formulaire. preventDefault empêche le rechargement de la page
      // (comportement par défaut d'un <form>).
      h('form', { class: 'join-form', onsubmit: async (e: Event) => {
        e.preventDefault();
        code = input.value;
        // Vérification locale : exactement 5 chiffres (regex ^\d{5}$).
        if (!/^\d{5}$/.test(code)) return askCode('Le code fait 5 chiffres.');
        btn.disabled = true;
        btn.querySelector('span')!.textContent = 'Recherche…';
        try {
          // D'abord avec le code seul : on ne demande la position que si ce vote en a besoin.
          const { vote, agTitle } = await api.lookupVote(code, pos);
          showVote(vote, agTitle);
        } catch (err) {
          // 428 (« Precondition Required ») : le serveur répond ainsi quand ce vote
          // exige une position. Toute autre erreur : on la montre et on redemande le code.
          if ((err as ApiError).status !== 428) return askCode((err as ApiError).message);
          btn.querySelector('span')!.textContent = 'Localisation…';
          try {
            // On demande la position, puis on recommence la recherche avec.
            pos = await getPosition(15000);
          } catch (e2) {
            return askCode((e2 as Error).message);
          }
          try {
            const { vote, agTitle } = await api.lookupVote(code, pos);
            showVote(vote, agTitle);
          } catch (e3) {
            askCode((e3 as ApiError).message);
          }
        }
      } }, input, btn),
      h('button', { class: 'link-btn pv-back', type: 'button', onclick: back }, 'Retour'),
    );
    // Focus sur le champ du code après l'affichage.
    setTimeout(() => input.focus(), 100);
  };

  // showVote() : étape 2, les boutons de choix.
  const showVote = (v: Vote, agTitle: string) => {
    // Si cet appareil a déjà voté (le serveur le reconnaît grâce au cookie
    // « votant » ou à l'appareil de l'app),
    // on passe directement à l'attente des résultats.
    if (v.myChoice != null) return showDone(v, 'Tu as déjà voté avec cet appareil.');
    clear(root,
      h('p', { class: 'pv-ag' }, agTitle),
      h('h1', { class: 'splash-title pv-question' }, v.question),
      h('div', { class: 'pv-choices' }, v.options.map((o, i) => h('button', { class: 'btn btn-yellow btn-big btn-block', type: 'button', onclick: async (e: Event) => {
        // Désactiver le bouton cliqué (pas les autres) évite un double envoi.
        (e.currentTarget as HTMLButtonElement).disabled = true;
        try {
          // On renvoie le code (et la position éventuelle) avec le choix.
          const { vote } = await api.publicBallot(code, i, pos);
          showDone(vote, 'A voté !');
        } catch (err) {
          // En cas d'erreur (vote clos entre-temps, trop loin…), retour à l'étape 1 avec le message.
          askCode((err as ApiError).message);
        }
      } }, o))),
      h('p', { class: 'splash-fine' }, 'Un seul vote par appareil. Ton choix est anonyme.'),
    );
  };

  /** Après le vote : on attend la clôture pour afficher les résultats. */
  // showDone() : étape 3, avec v = le vote (pour la question) et title = le
  // grand titre à afficher.
  const showDone = (v: Vote, title: string) => {
    const res = h('div', { class: 'pv-result' }, h('p', { class: 'splash-text' }, 'Les résultats s\'afficheront ici quand le vote sera clos.'));
    clear(root,
      h('h1', { class: 'splash-title' }, title),
      h('p', { class: 'splash-text pv-question-small' }, v.question),
      res,
      h('button', { class: 'link-btn pv-back', type: 'button', onclick: back }, 'Retour à l\'accueil'),
    );
    // poll() : interroge le serveur toutes les 5 s jusqu'à la clôture (« polling »).
    // Il s'arrête tout seul quand le bloc n'est plus affiché (isConnected).
    const poll = async () => {
      if (!res.isConnected) return;
      try {
        const { result } = await api.voteResult(v.id);
        // Vote clos et résultats publiés : on affiche les barres et on arrête.
        if (result.status === 'closed' && result.counts) {
          // v.myChoice : mon choix tel que le serveur l'a renvoyé (réponse au vote, ou
          // recherche du code si j'avais déjà voté) ; il sert à cocher ma barre.
          clear(res, resultBars(result.options, result.counts, result.counts.reduce((a, b) => a + b, 0), v.myChoice));
          return;
        }
      } catch { /* on réessaie */ }
      // Pas encore clos (ou erreur réseau) : on réessaie dans 5 s.
      setTimeout(poll, 5000);
    };
    void poll();
  };

  // Au départ : étape 1.
  askCode();
  return root;
}
