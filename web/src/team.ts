import { api, ApiError } from './api';
import { store, spaceColor } from './store';
import { openSheet, confirmSheet } from './sheet';
import { chips, field } from './forms';
import { h, icon, clear, toast, relative } from './ui';
import { ROLE_LABEL, SPACE_LABEL, SPACES, type CreatedInvite, type Device, type Invite, type Role, type Space } from '../../shared/model';

let root: HTMLElement;
let devices: (Device & { manageable: boolean })[] = [];
let invites: Invite[] = [];
/** Recherche et filtre de la liste des appareils (gardés d'un affichage à l'autre). */
let devQuery = '';
let devRole: Role | 'all' = 'all';

export function mountTeam(el: HTMLElement) {
  root = el;
  store.on('view', () => store.view === 'team' && load());
  render();
}

async function load() {
  if (store.me.role !== 'admin') return render();
  try {
    [{ devices }, { invites }] = await Promise.all([api.devices(), api.invites()]);
  } catch (e) {
    toast((e as ApiError).message, 'err');
  }
  render();
}

const TTL = [
  { value: 15, label: '15 min' },
  { value: 60, label: '1 h' },
  { value: 24 * 60, label: '24 h' },
  { value: 7 * 24 * 60, label: '7 jours' },
];
const USES = [1, 5, 20, 50].map((v) => ({ value: v, label: v === 1 ? '1 personne' : `${v} pers.` }));

function deviceLabel(ua: string | null) {
  if (!ua) return 'Appareil';
  if (/iPhone|iPad/.test(ua)) return 'iPhone / iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'PC Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Appareil';
}

function render() {
  if (!root) return;
  const me = store.me;
  const canInvite = me.role === 'admin' || me.role === 'relais';

  clear(root,
    h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title' }, canInvite ? 'Équipe' : 'Mon accès')),

    canInvite ? inviteCard() : null,

    me.role === 'admin' ? h('section', { class: 'card-section' },
      h('div', { class: 'section-title' }, icon('qr-code', 18), `Invitations actives (${invites.length})`),
      invites.length ? h('ul', { class: 'rows' }, invites.map((i) => h('li', { class: 'row' },
        h('div', { class: 'row-main' },
          h('strong', null, i.label || `Invitation ${ROLE_LABEL[i.role].toLowerCase()}`),
          h('span', null, `${ROLE_LABEL[i.role]} · ${i.uses}/${i.maxUses} utilisée${i.uses > 1 ? 's' : ''} · expire ${relative(i.expiresAt)}${i.createdByName ? ` · par ${i.createdByName}` : ''}`)),
        h('button', { class: 'btn btn-small btn-light btn-text-danger', onclick: async () => {
          await api.revokeInvite(i.id).catch((e) => toast(e.message, 'err'));
          load();
        } }, 'Annuler'),
      ))) : h('p', { class: 'muted' }, 'Aucune invitation en cours.'),
    ) : null,

    me.role === 'admin' ? devicesSection() : null,

    h('section', { class: 'card-section' },
      h('div', { class: 'section-title' }, icon('smartphone', 18), 'Cet appareil'),
      h('div', { class: 'me-card' },
        h('div', { class: 'avatar' }, me.name.slice(0, 1).toUpperCase()),
        h('div', { class: 'row-main' }, h('strong', null, me.name), h('span', null, `${ROLE_LABEL[me.role]} · autorisé ${relative(me.createdAt)}`)),
        h('button', { class: 'btn btn-small btn-light', onclick: renameMe }, icon('pencil', 14), 'Renommer'),
      ),
      h('button', { class: 'btn btn-light btn-text-danger btn-block', onclick: async () => {
        if (!(await confirmSheet('Déconnecter cet appareil ?', 'Il faudra une nouvelle invitation (QR code) pour revenir.', 'Me déconnecter'))) return;
        await api.logout().catch(() => {});
        location.reload();
      } }, icon('log-out', 18), 'Déconnecter cet appareil'),
    ),

    h('section', { class: 'card-section security-note' },
      h('div', { class: 'section-title' }, icon('shield-check', 18), 'Comment l\'accès est protégé'),
      h('ul', { class: 'bullets' },
        h('li', null, 'On entre uniquement par une invitation : lien ou QR code, à durée limitée et à nombre d\'usages limité.'),
        h('li', null, 'Chaque appareil reçoit sa propre clé secrète, stockée dans un cookie protégé (inaccessible aux scripts).'),
        h('li', null, 'Un admin voit qui a invité qui, et peut couper un appareil — et tous ceux qu\'il a fait entrer — en un clic.'),
        h('li', null, 'Le mieux : montrer le QR code en face à face (validité 15 min, 1 personne) plutôt que d\'envoyer un lien.'),
      ),
    ),
  );
}

/** Choix d'espaces proposés : seulement ceux de l'appareil qui choisit. */
type SpaceChoice = Space | 'both';
const spaceChoices = (mine: Space[]): { value: SpaceChoice; label: string }[] => [
  ...mine.map((s) => ({ value: s as SpaceChoice, label: SPACE_LABEL[s] })),
  ...(mine.length > 1 ? [{ value: 'both' as SpaceChoice, label: 'Les deux' }] : []),
];
const toSpaces = (c: SpaceChoice): Space[] => (c === 'both' ? [...SPACES] : [c]);
const fromSpaces = (list: Space[]): SpaceChoice => (list.length > 1 ? 'both' : list[0]);
const spaceTags = (list: Space[]) => list.map((s) => h('span', { class: `space-tag space-${s}` }, SPACE_LABEL[s]));

function inviteCard() {
  const me = store.me;
  const isAdmin = me.role === 'admin';
  const state = { role: 'membre' as Role, ttl: 15, uses: 1, label: '', space: store.space as SpaceChoice };
  // Seul le propriétaire peut faire entrer un admin.
  const roles: { value: Role; label: string }[] = [
    { value: 'membre', label: 'Membre' }, { value: 'relais', label: 'Relais (peut inviter)' },
    ...(me.owner ? [{ value: 'admin' as Role, label: 'Admin' }] : []),
  ];
  return h('section', { class: 'card-section invite-card' },
    h('div', { class: 'section-title' }, icon('user-plus', 18), 'Faire entrer quelqu\'un'),
    h('p', { class: 'muted' }, isAdmin
      ? 'Génère un QR code à faire scanner. Pour la sécurité, préfère 15 min et 1 personne, en face à face.'
      : 'Montre ce QR code à la personne, en face à face. Il marche une seule fois, pendant 15 minutes.'),
    isAdmin ? h('div', { class: 'form' },
      me.spaces.length > 1 ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Espace'),
        chips<SpaceChoice>(spaceChoices(me.spaces), state.space, (v) => (state.space = v)),
        h('span', { class: 'field-hint' }, 'La personne ne verra que cet espace (ou les deux).')) : null,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Rôle'),
        chips<Role>(roles, state.role, (v) => (state.role = v))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Valable'), chips(TTL, state.ttl, (v) => (state.ttl = v))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Pour'), chips(USES, state.uses, (v) => (state.uses = v))),
      field('Note', h('input', { class: 'input', type: 'text', maxlength: '60', placeholder: 'Ex. : groupe d\'action Nord', oninput: (e: Event) => (state.label = (e.target as HTMLInputElement).value) }), undefined, true),
    ) : null,
    h('button', { class: 'btn btn-primary btn-block btn-big', onclick: async () => {
      try {
        const spaces = isAdmin ? toSpaces(state.space) : [store.space];
        const res = await api.createInvite({ role: state.role, ttlMinutes: state.ttl, maxUses: state.uses, label: state.label || null, spaces });
        showInvite(res);
        if (isAdmin) load();
      } catch (e) {
        toast((e as ApiError).message, 'err');
      }
    } }, icon('qr-code', 20), 'Générer le QR code'),
  );
}

function showInvite(res: CreatedInvite) {
  const qr = h('div', { class: 'qr' });
  qr.innerHTML = res.qrSvg; // SVG produit par le serveur à partir de notre propre lien
  const countdown = h('strong', { class: 'countdown' });
  const tick = () => {
    const left = res.invite.expiresAt - Date.now();
    if (left <= 0) {
      countdown.textContent = 'Expiré';
      qr.classList.add('expired');
      clearInterval(timer);
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    countdown.textContent = m >= 60 ? `expire ${relative(res.invite.expiresAt)}` : `expire dans ${m}:${String(s).padStart(2, '0')}`;
  };
  const timer = setInterval(tick, 1000);
  tick();

  openSheet({
    title: 'Invitation',
    accent: spaceColor(),
    onClose: () => clearInterval(timer),
    body: h('div', { class: 'invite-show' },
      h('p', { class: 'invite-who' }, `${ROLE_LABEL[res.invite.role]} · ${res.invite.maxUses === 1 ? '1 personne' : `${res.invite.maxUses} personnes`}`),
      qr,
      countdown,
      h('p', { class: 'muted center' }, 'La personne scanne avec l\'appareil photo de son téléphone, puis indique son prénom.'),
      h('div', { class: 'grid-2' },
        h('button', { class: 'btn btn-outline', onclick: async () => { await navigator.clipboard?.writeText(res.url); toast('Lien copié', 'ok'); } }, icon('copy', 18), 'Copier le lien'),
        'share' in navigator ? h('button', { class: 'btn btn-outline', onclick: () => navigator.share({ title: 'Invitation Terrain', url: res.url }).catch(() => {}) }, icon('share-2', 18), 'Envoyer') : null,
      ),
      h('p', { class: 'field-hint center' }, 'Un lien envoyé par message peut être transféré : le QR montré en direct est plus sûr.'),
    ),
  });
}

const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Liste des appareils, avec recherche (nom, ou nom de la personne qui a invité) et filtre par rôle. */
function devicesSection() {
  const list = h('ul', { class: 'rows' });
  const count = h('span', { class: 'field-hint' });
  const count0 = (r: Role) => devices.filter((d) => d.role === r).length;
  const renderList = () => {
    const q = norm(devQuery.trim());
    const shown = devices.filter((d) => (devRole === 'all' || d.role === devRole)
      && (!q || norm(d.name).includes(q) || norm(d.invitedByName ?? '').includes(q)));
    clear(list, ...(shown.length ? shown.map(deviceRow) : [h('p', { class: 'muted' }, 'Personne ne correspond.')]));
    count.textContent = shown.length === devices.length ? '' : `${shown.length} sur ${devices.length}`;
  };
  const search = h('input', {
    class: 'input', type: 'search', value: devQuery, placeholder: 'Chercher un prénom…', autocomplete: 'off',
    oninput: (e: Event) => { devQuery = (e.target as HTMLInputElement).value; renderList(); },
  });
  const filter = chips<Role | 'all'>([
    { value: 'all', label: `Tous (${devices.length})` },
    { value: 'admin', label: `Admins (${count0('admin')})` },
    { value: 'relais', label: `Relais (${count0('relais')})` },
    { value: 'membre', label: `Membres (${count0('membre')})` },
  ], devRole, (v) => { devRole = v; renderList(); });
  renderList();
  return h('section', { class: 'card-section' },
    h('div', { class: 'section-title' }, icon('users', 18), `Appareils autorisés (${devices.length})`),
    devices.length > 5 ? h('div', { class: 'dev-tools' }, search, filter, count) : null,
    list,
  );
}

function deviceRow(d: Device & { manageable: boolean }) {
  const isMe = d.id === store.me.id;
  return h('li', { class: 'row' },
    h('div', { class: 'avatar small' }, d.name.slice(0, 1).toUpperCase()),
    h('div', { class: 'row-main' },
      h('strong', null, d.name, isMe ? h('em', null, ' (moi)') : null),
      h('span', { class: 'row-tags' }, d.owner ? h('span', { class: 'space-tag owner-tag' }, 'Propriétaire') : null, ...spaceTags(d.spaces)),
      h('span', null, `${d.owner ? 'Propriétaire' : ROLE_LABEL[d.role]} · ${deviceLabel(d.userAgent)} · vu ${d.lastSeen ? relative(d.lastSeen) : 'jamais'}${d.invitedByName ? ` · invité·e par ${d.invitedByName}` : ''}`)),
    // On ne propose « Gérer » que si on a vraiment le droit (le serveur le vérifie aussi).
    d.manageable ? h('button', { class: 'btn btn-small btn-light', onclick: () => manageDevice(d) }, 'Gérer') : null,
  );
}

function manageDevice(d: Device) {
  const me = store.me;
  let role = d.role;
  let space = fromSpaces(d.spaces);
  let cascade = false;
  const children = devices.filter((x) => x.invitedBy === d.id).length;
  // Seul le propriétaire nomme des admins ; chacun ne donne que ses propres espaces.
  const roles: { value: Role; label: string }[] = [
    { value: 'membre', label: 'Membre' }, { value: 'relais', label: 'Relais' },
    ...(me.owner ? [{ value: 'admin' as Role, label: 'Admin' }] : []),
  ];
  const s = openSheet({
    title: d.name,
    body: h('div', { class: 'form' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Rôle'),
        chips<Role>(roles, role, (v) => (role = v))),
      me.spaces.length > 1 ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Espaces'),
        chips<SpaceChoice>(spaceChoices(me.spaces), space, (v) => (space = v)),
        h('span', { class: 'field-hint' }, me.owner
          ? 'Un admin ne gère que les espaces que tu lui donnes, et ne peut pas nommer d\'autres admins.'
          : 'Tu ne peux donner que tes propres espaces.')) : null,
      h('button', { class: 'btn btn-primary btn-block', onclick: async () => {
        try {
          await api.updateDevice(d.id, { role, ...(me.spaces.length > 1 ? { spaces: toSpaces(space) } : {}) });
          toast('Droits mis à jour', 'ok'); s.close(); load();
        } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, 'Enregistrer'),
      h('hr'),
      h('label', { class: 'toggle-line' },
        h('input', { type: 'checkbox', onchange: (e: Event) => (cascade = (e.target as HTMLInputElement).checked) }),
        h('span', { class: 'switch' }), `Retirer aussi les appareils qu'il a fait entrer${children ? ` (${children} direct${children > 1 ? 's' : ''}, et leurs invités)` : ''}`),
      h('button', { class: 'btn btn-danger btn-block', onclick: async () => {
        if (!(await confirmSheet('Retirer l\'accès ?', `${d.name} ne pourra plus ouvrir l'app${cascade ? ', ainsi que toutes les personnes invitées par sa chaîne' : ''}.`, 'Retirer l\'accès'))) return;
        try {
          const r = await api.revokeDevice(d.id, cascade);
          toast(`${r.revoked} appareil${r.revoked > 1 ? 's' : ''} retiré${r.revoked > 1 ? 's' : ''}`, 'ok');
          if (d.id === store.me.id) return location.reload();
          load();
        } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, icon('trash-2', 18), 'Retirer l\'accès'),
    ),
  });
}

function renameMe() {
  const input = h('input', { class: 'input', type: 'text', maxlength: '40', value: store.me.name }) as HTMLInputElement;
  const s = openSheet({
    title: 'Mon nom',
    body: field('Prénom ou pseudo', input, 'Visible par l\'équipe sur les points que tu ajoutes.'),
    footer: h('button', { class: 'btn btn-primary btn-block', onclick: async () => {
      try {
        await api.rename(input.value);
        store.me.name = input.value.trim();
        s.close();
        render();
        store.emit('me');
      } catch (e) { toast((e as ApiError).message, 'err'); }
    } }, 'Enregistrer'),
  });
  setTimeout(() => input.focus(), 300);
}
