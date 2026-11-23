/*
 * web/src/sheet.ts — les fenêtres modales (« feuilles ») de l'application.
 *
 * Une « sheet » (feuille) est le panneau qui s'ouvre par-dessus la carte : fiche d'un point,
 * formulaire, confirmation… Sur téléphone elle glisse depuis le bas de l'écran (on peut la
 * refermer en la tirant vers le bas) ; sur ordinateur c'est une fenêtre centrée (géré par le CSS).
 *
 * Règle importante : UNE seule feuille à la fois. En ouvrir une referme la précédente.
 *
 * Qui l'utilise : detail.ts, forms.ts, votes.ts, team.ts, archive.ts, chat.ts, home.ts, main.ts.
 */
import { h, icon } from './ui';

/** Ce que renvoie `openSheet` : de quoi manipuler la feuille ouverte. */
export interface SheetHandle {
  // L'élément de la feuille elle-même.
  el: HTMLElement;
  // La zone de contenu (pour la remplir / la redessiner après coup).
  body: HTMLElement;
  // Ferme la feuille (sans effet si elle est déjà fermée).
  close: () => void;
  // Change le titre affiché.
  setTitle: (t: string) => void;
}

// La feuille actuellement ouverte (null si aucune). Variable du module, partagée par toutes les fonctions du fichier.
let current: SheetHandle | null = null;

/**
 * Panneau modal : glisse depuis le bas sur mobile, fenêtre centrée sur ordinateur.
 */
// Options : `title` (titre), `body` (un ou plusieurs éléments), `footer` (zone de boutons en bas),
// `accent` (couleur du liseré en haut, ex. la couleur du point), `onClose` (appelé à la fermeture),
// `wide` (fenêtre plus large sur ordinateur).
export function openSheet(opts: {
  title: string;
  body: HTMLElement | HTMLElement[];
  footer?: HTMLElement | null;
  accent?: string;
  onClose?: () => void;
  wide?: boolean;
}): SheetHandle {
  // Une seule feuille à la fois : on ferme l'éventuelle précédente (`?.` : seulement s'il y en a une).
  current?.close();

  // Construction de la structure HTML avec h() :
  // <div backdrop> <div sheet role=dialog> poignée / en-tête (titre + bouton ×) / contenu / pied </div> </div>
  const titleEl = h('h2', { class: 'sheet-title' }, opts.title);
  const body = h('div', { class: 'sheet-body' }, opts.body);
  // `role: 'dialog'` et `aria-modal` : indiquent aux lecteurs d'écran qu'il s'agit d'une fenêtre modale.
  const sheet = h('div', { class: `sheet${opts.wide ? ' sheet-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    h('div', { class: 'sheet-grab' }, h('span')),
    h('header', { class: 'sheet-head', style: opts.accent ? { borderTopColor: opts.accent } : undefined },
      titleEl,
      // `handle` n'est déclaré que plus bas : ça marche car la fonction fléchée n'est exécutée qu'au clic,
      // bien après que `handle` a été créé.
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => handle.close() }, icon('x', 22)),
    ),
    body,
    opts.footer ? h('footer', { class: 'sheet-foot' }, opts.footer) : null,
  );
  // Le fond assombri autour de la feuille. Un clic DESSUS (et pas sur la feuille, d'où le test
  // `e.target === backdrop`) ferme la feuille. Même astuce : `backdrop` est utilisé dans sa propre
  // définition, mais seulement au moment du clic.
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e: Event) => e.target === backdrop && handle.close() }, sheet);

  // Protège contre une double fermeture (bouton × puis touche Échap, par exemple).
  let closed = false;
  // La touche Échap ferme la feuille (ordinateur).
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && handle.close();
  const handle: SheetHandle = {
    el: sheet,
    body,
    setTitle: (t) => (titleEl.textContent = t),
    close: () => {
      if (closed) return;
      closed = true;
      // On retire l'écouteur clavier, sinon il resterait actif pour toujours.
      document.removeEventListener('keydown', onKey);
      // Retirer `open` lance l'animation de sortie (CSS) ; on supprime l'élément 250 ms plus tard,
      // une fois l'animation finie (cette durée doit correspondre à celle du CSS).
      backdrop.classList.remove('open');
      setTimeout(() => backdrop.remove(), 250);
      // On ne remet `current` à null que si c'est bien NOUS la feuille courante (une autre a pu s'ouvrir).
      if (current === handle) current = null;
      opts.onClose?.();
    },
  };

  // Glisser vers le bas pour fermer (mobile).
  // startY : position du doigt au début ; dy : distance parcourue vers le bas ; dragging : geste en cours.
  let startY = 0, dy = 0, dragging = false;
  // `as HTMLElement` : querySelector renvoie un type générique (Element | null) ; on sait que ces
  // éléments existent puisqu'on vient de les créer.
  const grab = sheet.querySelector('.sheet-grab') as HTMLElement;
  const head = sheet.querySelector('.sheet-head') as HTMLElement;
  // Le geste ne peut COMMENCER que sur la poignée ou l'en-tête (pas sur le contenu, qui doit pouvoir défiler).
  for (const zone of [grab, head]) {
    // `passive: true` : on promet de ne pas bloquer le défilement, ce qui rend le geste plus fluide.
    // On coupe la transition CSS pendant le glissé pour que la feuille suive le doigt sans retard.
    zone.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; dragging = true; dy = 0; sheet.style.transition = 'none'; }, { passive: true });
  }
  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    // Seulement vers le bas : `Math.max(0, …)` empêche de remonter la feuille au-delà de sa position.
    dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    // On rend la main au CSS (transition et position normales) : la feuille revient en place en douceur…
    sheet.style.transition = '';
    sheet.style.transform = '';
    // … sauf si on l'a tirée de plus de 110 px : dans ce cas on la ferme.
    if (dy > 110) handle.close();
  });

  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  // Ajout de `open` à l'image suivante, pour que l'animation d'entrée se joue (même astuce que les toasts).
  requestAnimationFrame(() => backdrop.classList.add('open'));
  current = handle;
  return handle;
}

// Ferme la feuille ouverte, s'il y en a une (utile depuis n'importe quel fichier, sans garder le handle).
export const closeSheet = () => current?.close();

/**
 * Demande de confirmation (« Supprimer ce point ? »). Renvoie une promesse : true si l'utilisateur
 * confirme, false s'il annule OU ferme la feuille autrement (×, Échap, clic à côté, glissé).
 * `danger` : bouton rouge (action destructrice) plutôt que bouton normal.
 * Utilisation : `if (await confirmSheet('Supprimer ?', '…', 'Supprimer')) { … }`
 */
export function confirmSheet(title: string, message: string, okLabel: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    // Vrai dès qu'un des deux boutons a été cliqué (pour ne pas répondre deux fois).
    let answered = false;
    // Bouton cliqué : on répond, puis on ferme. `s` est défini juste après, utilisé seulement au clic.
    const done = (v: boolean) => { answered = true; resolve(v); s.close(); };
    const s = openSheet({
      title,
      body: h('p', { class: 'confirm-text' }, message),
      footer: h('div', { class: 'row-end' },
        h('button', { class: 'btn btn-ghost', onclick: () => done(false) }, 'Annuler'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => done(true) }, okLabel),
      ),
      // Fermeture sans réponse (×, Échap…) : on considère que c'est « non ».
      onClose: () => !answered && resolve(false),
    });
  });
}
