import { h, icon } from './ui';

export interface SheetHandle {
  el: HTMLElement;
  body: HTMLElement;
  close: () => void;
  setTitle: (t: string) => void;
}

let current: SheetHandle | null = null;

/**
 * Panneau modal : glisse depuis le bas sur mobile, fenêtre centrée sur ordinateur.
 */
export function openSheet(opts: {
  title: string;
  body: HTMLElement | HTMLElement[];
  footer?: HTMLElement | null;
  accent?: string;
  onClose?: () => void;
  wide?: boolean;
}): SheetHandle {
  current?.close();

  const titleEl = h('h2', { class: 'sheet-title' }, opts.title);
  const body = h('div', { class: 'sheet-body' }, opts.body);
  const sheet = h('div', { class: `sheet${opts.wide ? ' sheet-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    h('div', { class: 'sheet-grab' }, h('span')),
    h('header', { class: 'sheet-head', style: opts.accent ? { borderTopColor: opts.accent } : undefined },
      titleEl,
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => handle.close() }, icon('x', 22)),
    ),
    body,
    opts.footer ? h('footer', { class: 'sheet-foot' }, opts.footer) : null,
  );
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e: Event) => e.target === backdrop && handle.close() }, sheet);

  let closed = false;
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && handle.close();
  const handle: SheetHandle = {
    el: sheet,
    body,
    setTitle: (t) => (titleEl.textContent = t),
    close: () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.classList.remove('open');
      setTimeout(() => backdrop.remove(), 250);
      if (current === handle) current = null;
      opts.onClose?.();
    },
  };

  // Glisser vers le bas pour fermer (mobile).
  let startY = 0, dy = 0, dragging = false;
  const grab = sheet.querySelector('.sheet-grab') as HTMLElement;
  const head = sheet.querySelector('.sheet-head') as HTMLElement;
  for (const zone of [grab, head]) {
    zone.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; dragging = true; dy = 0; sheet.style.transition = 'none'; }, { passive: true });
  }
  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 110) handle.close();
  });

  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  current = handle;
  return handle;
}

export const closeSheet = () => current?.close();

export function confirmSheet(title: string, message: string, okLabel: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v: boolean) => { answered = true; resolve(v); s.close(); };
    const s = openSheet({
      title,
      body: h('p', { class: 'confirm-text' }, message),
      footer: h('div', { class: 'row-end' },
        h('button', { class: 'btn btn-ghost', onclick: () => done(false) }, 'Annuler'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => done(true) }, okLabel),
      ),
      onClose: () => !answered && resolve(false),
    });
  });
}
