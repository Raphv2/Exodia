import { api, ApiError } from './api';
import { store } from './store';
import { openSheet } from './sheet';
import { getPosition, type Pos } from './geo';
import { h, icon, clear, toast, relative } from './ui';
import { chips } from './forms';
import { VOTE_RADII, DEFAULT_VOTE_RADIUS, voteRadiusLabel, type Point, type Vote } from '../../shared/model';

/** Texte de la règle de distance d'un vote. */
const whereText = (r: number) => (r ? `Sur place uniquement, à moins de ${r} m.` : 'Depuis n\'importe où : pas de condition de distance.');

/*
 * Votes en AG, façon Kahoot : un code à 5 chiffres par vote, un vote par appareil,
 * seulement sur place (à moins de X m de l'AG, distance choisie au lancement). Le serveur vérifie tout.
 */

const DEFAULT_OPTIONS = ['Pour', 'Contre', 'Abstention'];

/** Barres de résultats (ou simple participation si les résultats ne sont pas encore visibles). */
export function resultBars(options: string[], counts: number[] | null, total: number, mine: number | null = null) {
  if (!counts) {
    return h('p', { class: 'vote-total' }, icon('users', 16), `${total} vote${total > 1 ? 's' : ''} pour l'instant`);
  }
  const max = Math.max(1, ...counts);
  const sum = counts.reduce((a, b) => a + b, 0);
  return h('ul', { class: 'vote-bars' }, options.map((o, i) => {
    const pct = sum ? Math.round((counts[i] / sum) * 100) : 0;
    return h('li', { class: `vote-bar${counts[i] === max && sum ? ' top' : ''}${mine === i ? ' mine' : ''}` },
      h('span', { class: 'vote-bar-label' }, mine === i ? icon('check', 14) : null, o),
      h('span', { class: 'vote-bar-track' }, h('span', { class: 'vote-bar-fill', style: { width: `${pct}%` } })),
      h('span', { class: 'vote-bar-num' }, `${counts[i]} · ${pct} %`));
  }));
}

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

export function votesSection(p: Point): HTMLElement {
  const wrap = h('div', { class: 'card-section votes' },
    h('div', { class: 'section-title' }, icon('vote', 18), 'Votes'),
    h('p', { class: 'field-hint' }, 'Chargement…'));
  let alive = true;

  const load = async () => {
    if (!alive) return;
    if (!wrap.isConnected && wrap.dataset.mounted) { alive = false; off(); return; }
    try {
      const { votes, canRun } = await api.votes(p.id);
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
  const off = store.on('votes', () => void load());
  void load();
  return wrap;
}

function voteRow(v: Vote, canRun: boolean) {
  const open = v.status === 'open';
  return h('li', { class: `vote-item${open ? ' open' : ''}` },
    h('div', { class: 'vote-head' },
      h('strong', null, v.question),
      h('span', { class: `vote-status ${v.status}` }, open ? 'En cours' : 'Clos')),
    h('span', { class: 'field-hint' }, open ? `Lancé ${relative(v.createdAt)} · ${v.radius ? `sur place à moins de ${v.radius} m` : 'sans condition de distance'}` : `Clos ${relative(v.closedAt ?? v.createdAt)}`),
    resultBars(v.options, v.counts, v.total, v.myChoice),
    h('div', { class: 'vote-actions' },
      open && canRun ? h('button', { class: 'btn btn-small btn-light', type: 'button', onclick: () => openKahoot(v.id) }, icon('qr-code', 15), 'Afficher le code') : null,
      open && v.myChoice == null ? h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => openAppVote(v) }, icon('vote', 15), 'Voter') : null,
      open && v.myChoice != null ? h('span', { class: 'vote-done' }, icon('check', 15), 'Tu as voté') : null,
    ),
  );
}

/** Lancer un vote : la question et les choix (Pour / Contre / Abstention par défaut). */
export function openNewVote(p: Point) {
  const state = { question: '', options: [...DEFAULT_OPTIONS], radius: DEFAULT_VOTE_RADIUS as number };
  const list = h('div', { class: 'vote-options-edit' });
  const renderOptions = () => clear(list, ...state.options.map((o, i) => h('div', { class: 'vote-option-edit' },
    h('input', { class: 'input', type: 'text', maxlength: '60', value: o, 'aria-label': `Choix ${i + 1}`, oninput: (e: Event) => (state.options[i] = (e.target as HTMLInputElement).value) }),
    state.options.length > 2 ? h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Retirer ce choix', onclick: () => { state.options.splice(i, 1); renderOptions(); } }, icon('x', 18)) : null,
  )));
  renderOptions();
  const question = h('input', { class: 'input', type: 'text', maxlength: '200', placeholder: 'Ex. : On reconduit le blocus demain ?', oninput: (e: Event) => (state.question = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('vote', 20), h('span', null, 'Lancer le vote')) as HTMLButtonElement;
  submit.onclick = async () => {
    const options = state.options.map((o) => o.trim()).filter(Boolean);
    if (!state.question.trim()) return toast('Écris la question.', 'err');
    if (options.length < 2) return toast('Il faut au moins 2 choix.', 'err');
    submit.disabled = true;
    try {
      const { vote } = await api.createVote(p.id, state.question.trim(), options, state.radius);
      s.close();
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
        h('button', { class: 'link-btn', type: 'button', onclick: () => { if (state.options.length < 8) { state.options.push(''); renderOptions(); } } }, '+ Ajouter un choix')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Pour voter, être à moins de'),
        chips(VOTE_RADII.map((r) => ({ value: r as number, label: voteRadiusLabel(r) })), state.radius, (v) => (state.radius = v)),
        h('span', { class: 'field-hint' }, 'Autour du point de l\'AG. 50 m suffit pour une salle ou une cour ; plus large pour un amphi, une esplanade ou une manif. « Peu importe » : on peut voter de partout, sans donner sa position ; si l\'AG est annoncée publiquement, le vote apparaît même directement sur la page d\'accueil, sans code.'),
        h('p', { class: 'vote-indicatif' }, icon('circle-alert', 16), h('span', null, 'Vote sans compte = vote indicatif : un même appareil peut revoter en changeant de navigateur ou en navigation privée. Pour une vraie décision, garde une distance courte et vérifie le nombre de votes par rapport aux présent·es.'))),
    ),
    footer: submit,
  });
  setTimeout(() => question.focus(), 250);
}

/** Écran façon Kahoot : le code en grand, la participation et les résultats en direct. */
export function openKahoot(voteId: string) {
  const body = h('div', { class: 'kahoot' });
  const footer = h('div', { class: 'kahoot-footer' });
  let alive = true;
  const render = async () => {
    if (!alive) return;
    try {
      const { vote: v } = await api.vote(voteId);
      const open = v.status === 'open';
      clear(body,
        h('p', { class: 'kahoot-question' }, v.question),
        open && v.code ? h('div', { class: 'kahoot-code', 'aria-label': `Code ${v.code.split('').join(' ')}` }, v.code.split('').map((d) => h('span', null, d))) : null,
        open ? h('p', { class: 'kahoot-hint' }, `Tape ce code sur la page d'accueil de l'app (sans compte) ou dans la fiche de l'AG. ${whereText(v.radius)}${v.radius ? '' : ' Vote indicatif : sans compte, on peut revoter avec un autre navigateur.'}`) : h('p', { class: 'kahoot-hint' }, 'Vote clos : voici les résultats.'),
        h('p', { class: 'kahoot-total' }, h('strong', null, String(v.total)), ` vote${v.total > 1 ? 's' : ''}`),
        resultBars(v.options, v.counts, v.total),
      );
      clear(footer, open
        ? h('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: async () => {
            try { await api.closeVote(voteId); store.emit('votes'); void render(); } catch (e) { toast((e as ApiError).message, 'err'); }
          } }, icon('flag', 18), 'Clore le vote')
        : h('button', { class: 'btn btn-light btn-block', type: 'button', onclick: () => s.close() }, 'Fermer'));
    } catch (e) {
      clear(body, h('p', { class: 'muted' }, (e as ApiError).message));
    }
  };
  const off = store.on('votes', () => void render());
  const s = openSheet({ title: 'Vote', body, footer, wide: true, onClose: () => { alive = false; off(); } });
  void render();
}

/** Voter depuis l'app (même règle de distance). */
function openAppVote(v: Vote) {
  const s = openSheet({
    title: 'Voter',
    body: h('div', { class: 'form' },
      h('p', { class: 'kahoot-question' }, v.question),
      h('div', { class: 'vote-choices' }, v.options.map((o, i) => h('button', { class: 'btn btn-outline btn-block vote-choice', type: 'button', onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        // Position seulement si le vote a une condition de distance.
        const pos = v.radius ? await hereOrToast() : null;
        if (v.radius && !pos) { b.disabled = false; return; }
        try {
          await api.ballot(v.id, i, pos);
          s.close();
          store.emit('votes');
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
export function publicVotePage(back: () => void): HTMLElement {
  const root = h('div', { class: 'pv' });
  let code = '';
  let pos: Pos | null = null;

  const askCode = (msg?: string) => {
    const input = h('input', {
      class: 'input input-big pv-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      maxlength: '5', pattern: '[0-9]*', placeholder: '_ _ _ _ _', 'aria-label': 'Code à 5 chiffres', value: code,
      oninput: (e: Event) => { const t = e.target as HTMLInputElement; t.value = t.value.replace(/\D/g, '').slice(0, 5); },
    }) as HTMLInputElement;
    const btn = h('button', { class: 'btn btn-yellow btn-big btn-block', type: 'submit' }, h('span', null, 'Voter'), icon('arrow-right', 22)) as HTMLButtonElement;
    clear(root,
      h('h1', { class: 'splash-title' }, 'Code de vote'),
      h('p', { class: 'splash-text' }, 'Tape le code à 5 chiffres affiché pendant l\'AG. Si le vote demande d\'être sur place, ta position est vérifiée, puis oubliée.'),
      msg ? h('p', { class: 'pv-error', role: 'alert' }, icon('circle-alert', 18), msg) : null,
      h('form', { class: 'join-form', onsubmit: async (e: Event) => {
        e.preventDefault();
        code = input.value;
        if (!/^\d{5}$/.test(code)) return askCode('Le code fait 5 chiffres.');
        btn.disabled = true;
        btn.querySelector('span')!.textContent = 'Recherche…';
        try {
          // D'abord avec le code seul : on ne demande la position que si ce vote en a besoin.
          const { vote, agTitle } = await api.lookupVote(code, pos);
          showVote(vote, agTitle);
        } catch (err) {
          if ((err as ApiError).status !== 428) return askCode((err as ApiError).message);
          btn.querySelector('span')!.textContent = 'Localisation…';
          try {
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
    setTimeout(() => input.focus(), 100);
  };

  const showVote = (v: Vote, agTitle: string) => {
    if (v.myChoice != null) return showDone(v, 'Tu as déjà voté avec cet appareil.');
    clear(root,
      h('p', { class: 'pv-ag' }, agTitle),
      h('h1', { class: 'splash-title pv-question' }, v.question),
      h('div', { class: 'pv-choices' }, v.options.map((o, i) => h('button', { class: 'btn btn-yellow btn-big btn-block', type: 'button', onclick: async (e: Event) => {
        (e.currentTarget as HTMLButtonElement).disabled = true;
        try {
          const { vote } = await api.publicBallot(code, i, pos);
          showDone(vote, 'A voté !');
        } catch (err) {
          askCode((err as ApiError).message);
        }
      } }, o))),
      h('p', { class: 'splash-fine' }, 'Un seul vote par appareil. Ton choix est anonyme.'),
    );
  };

  /** Après le vote : on attend la clôture pour afficher les résultats. */
  const showDone = (v: Vote, title: string) => {
    const res = h('div', { class: 'pv-result' }, h('p', { class: 'splash-text' }, 'Les résultats s\'afficheront ici quand le vote sera clos.'));
    clear(root,
      h('h1', { class: 'splash-title' }, title),
      h('p', { class: 'splash-text pv-question-small' }, v.question),
      res,
      h('button', { class: 'link-btn pv-back', type: 'button', onclick: back }, 'Retour à l\'accueil'),
    );
    const poll = async () => {
      if (!res.isConnected) return;
      try {
        const { result } = await api.voteResult(v.id);
        if (result.status === 'closed' && result.counts) {
          clear(res, resultBars(result.options, result.counts, result.counts.reduce((a, b) => a + b, 0), v.myChoice));
          return;
        }
      } catch { /* on réessaie */ }
      setTimeout(poll, 5000);
    };
    void poll();
  };

  askCode();
  return root;
}
