// =============================================================================
// team.ts : l'onglet « Équipe » (ou « Mon accès » pour un simple membre).
// =============================================================================
// Terrain n'a pas de comptes avec mot de passe : chaque APPAREIL (téléphone,
// ordinateur) est autorisé par une invitation (lien ou QR code). Ce fichier
// affiche et gère :
//   - la création d'invitations (QR code avec compte à rebours) ;
//   - la liste des invitations en cours (admins) ;
//   - la liste des appareils autorisés, avec recherche et filtre (admins) ;
//   - la gestion d'un appareil : rôle, espaces, retrait d'accès (en cascade) ;
//   - l'appareil courant : renommer, se déconnecter.
//
// Les droits (vérifiés pour de vrai par le serveur, l'interface ne fait que
// cacher ce qui est interdit) :
//   - propriétaire (owner) : accès à tout, seul à nommer des admins ;
//   - admin : gère les appareils et invitations de ses espaces ;
//   - relais : peut inviter des membres (QR 15 min, 1 personne, son espace) ;
//   - membre : voit seulement son propre appareil.
// Espaces : 'lfi' (Campagne) et 'mvt' (Mouvement). On ne peut donner que les
// espaces qu'on a soi-même.
//
// Qui l'appelle ? main.ts appelle mountTeam(el) une fois au démarrage.
// Notions : variables de module (let en haut du fichier = état partagé par
// toutes les fonctions du fichier), Promise.all, setInterval / clearInterval.
import { api, ApiError } from './api';
import { store, spaceColor } from './store';
import { openSheet, confirmSheet } from './sheet';
import { chips, field } from './forms';
import { h, icon, clear, toast, relative } from './ui';
import { ROLE_LABEL, SPACE_LABEL, SPACES, type CreatedInvite, type Device, type Invite, type Role, type Space } from '../../shared/model';

// État du module : l'élément racine de l'onglet, puis les données chargées du
// serveur (seulement pour les admins).
let root: HTMLElement;
// « manageable » est calculé par le serveur : ai-je le droit de gérer cet appareil ?
let devices: (Device & { manageable: boolean })[] = [];
let invites: Invite[] = [];
/** Recherche et filtre de la liste des appareils (gardés d'un affichage à l'autre). */
let devQuery = '';
let devRole: Role | 'all' = 'all';

// mountTeam() : branche l'onglet sur son conteneur HTML.
// On recharge les données chaque fois qu'on ouvre l'onglet (événement 'view'
// du store), pour avoir des listes à jour sans rafraîchissement permanent.
export function mountTeam(el: HTMLElement) {
  root = el;
  // « && » ici sert de « if » raccourci : load() n'est appelée que si la vue est 'team'.
  store.on('view', () => store.view === 'team' && load());
  render();
}

// load() : récupère appareils et invitations, puis redessine.
// Un non-admin n'a pas accès à ces listes (le serveur refuserait) : on
// redessine directement.
async function load() {
  if (store.me.role !== 'admin') return render();
  try {
    // Promise.all lance les deux requêtes EN MÊME TEMPS et attend les deux.
    // La déstructuration [{ devices }, { invites }] range chaque résultat
    // directement dans les variables du module (d'où les parenthèses absentes :
    // ce sont des affectations, pas des déclarations).
    [{ devices }, { invites }] = await Promise.all([api.devices(), api.invites()]);
  } catch (e) {
    toast((e as ApiError).message, 'err');
  }
  // On redessine même en cas d'erreur (avec les anciennes données).
  render();
}

// Durées de validité proposées pour une invitation, en minutes.
const TTL = [
  { value: 15, label: '15 min' },
  { value: 60, label: '1 h' },
  { value: 24 * 60, label: '24 h' },
  { value: 7 * 24 * 60, label: '7 jours' },
];
// Nombre de personnes pouvant utiliser la même invitation.
const USES = [1, 5, 20, 50].map((v) => ({ value: v, label: v === 1 ? '1 personne' : `${v} pers.` }));

// deviceLabel() : devine le type d'appareil à partir du « User-Agent »
// (la chaîne que le navigateur envoie pour se décrire). Approximatif mais
// suffisant pour reconnaître « le téléphone de Paul » dans la liste.
// L'ordre compte : un iPhone mentionne aussi « Mac OS X », et Android « Linux ».
function deviceLabel(ua: string | null) {
  if (!ua) return 'Appareil';
  if (/iPhone|iPad/.test(ua)) return 'iPhone / iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'PC Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Appareil';
}

// render() : redessine tout l'onglet. Ce qu'on voit dépend du rôle.
function render() {
  if (!root) return;
  const me = store.me;
  // Admins et relais peuvent faire entrer quelqu'un.
  const canInvite = me.role === 'admin' || me.role === 'relais';

  clear(root,
    h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title' }, canInvite ? 'Équipe' : 'Mon accès')),

    canInvite ? inviteCard() : null,

    // Section « Invitations actives » : réservée aux admins.
    me.role === 'admin' ? h('section', { class: 'card-section' },
      h('div', { class: 'section-title' }, icon('qr-code', 18), `Invitations actives (${invites.length})`),
      // Une ligne par invitation : libellé (ou « Invitation membre »), puis détails.
      invites.length ? h('ul', { class: 'rows' }, invites.map((i) => h('li', { class: 'row' },
        h('div', { class: 'row-main' },
          h('strong', null, i.label || `Invitation ${ROLE_LABEL[i.role].toLowerCase()}`),
          // « utilisée » s'accorde au pluriel au-delà de 1 ; relative() donne « dans 12 min ».
          h('span', null, `${ROLE_LABEL[i.role]} · ${i.uses}/${i.maxUses} utilisée${i.uses > 1 ? 's' : ''} · expire ${relative(i.expiresAt)}${i.createdByName ? ` · par ${i.createdByName}` : ''}`)),
        // Annuler une invitation : le QR code ne marche plus. Les erreurs sont
        // affichées en toast, puis on recharge la liste dans tous les cas.
        h('button', { class: 'btn btn-small btn-light btn-text-danger', onclick: async () => {
          await api.revokeInvite(i.id).catch((e) => toast(e.message, 'err'));
          load();
        } }, 'Annuler'),
      ))) : h('p', { class: 'muted' }, 'Aucune invitation en cours.'),
    ) : null,

    // Liste des appareils (admins seulement).
    me.role === 'admin' ? devicesSection() : null,

    // Section « Cet appareil » : visible par tout le monde.
    h('section', { class: 'card-section' },
      h('div', { class: 'section-title' }, icon('smartphone', 18), 'Cet appareil'),
      h('div', { class: 'me-card' },
        // Avatar = première lettre du nom, en majuscule.
        h('div', { class: 'avatar' }, me.name.slice(0, 1).toUpperCase()),
        h('div', { class: 'row-main' }, h('strong', null, me.name), h('span', null, `${ROLE_LABEL[me.role]} · autorisé ${relative(me.createdAt)}`)),
        h('button', { class: 'btn btn-small btn-light', onclick: renameMe }, icon('pencil', 14), 'Renommer'),
      ),
      // Déconnexion : on demande confirmation (confirmSheet renvoie une Promise de
      // booléen), on prévient le serveur (en ignorant une éventuelle erreur), puis
      // on recharge la page, qui affichera l'écran d'accès.
      h('button', { class: 'btn btn-light btn-text-danger btn-block', onclick: async () => {
        if (!(await confirmSheet('Déconnecter cet appareil ?', 'Il faudra une nouvelle invitation (QR code) pour revenir.', 'Me déconnecter'))) return;
        await api.logout().catch(() => {});
        location.reload();
      } }, icon('log-out', 18), 'Déconnecter cet appareil'),
    ),

    // Explication de la sécurité, pour rassurer et donner les bons réflexes.
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
// SpaceChoice : un espace, ou 'both' (« Les deux »). Dans l'interface, on
// choisit une pastille unique ; le serveur, lui, attend une liste d'espaces.
// Les petites fonctions ci-dessous font la conversion dans les deux sens.
type SpaceChoice = Space | 'both';
// spaceChoices() : les pastilles proposées. « Les deux » n'apparaît que si
// j'ai moi-même accès aux deux espaces.
const spaceChoices = (mine: Space[]): { value: SpaceChoice; label: string }[] => [
  ...mine.map((s) => ({ value: s as SpaceChoice, label: SPACE_LABEL[s] })),
  ...(mine.length > 1 ? [{ value: 'both' as SpaceChoice, label: 'Les deux' }] : []),
];
// Pastille → liste pour le serveur. [...SPACES] = copie de ['lfi', 'mvt'].
const toSpaces = (c: SpaceChoice): Space[] => (c === 'both' ? [...SPACES] : [c]);
// Liste du serveur → pastille (pour pré-sélectionner l'état actuel).
const fromSpaces = (list: Space[]): SpaceChoice => (list.length > 1 ? 'both' : list[0]);
// Petites étiquettes colorées « Campagne » / « Mouvement » d'un appareil.
const spaceTags = (list: Space[]) => list.map((s) => h('span', { class: `space-tag space-${s}` }, SPACE_LABEL[s]));

// inviteCard() : la carte « Faire entrer quelqu'un ».
// Un admin règle tout (espace, rôle, durée, nombre, note) ; un relais n'a
// qu'un bouton, avec des valeurs imposées (membre, 15 min, 1 personne,
// espace courant) : le serveur applique de toute façon ces limites.
function inviteCard() {
  const me = store.me;
  const isAdmin = me.role === 'admin';
  // État du formulaire, avec des valeurs par défaut prudentes.
  // « as Role » / « as SpaceChoice » élargissent le type : sinon TypeScript
  // croirait que role ne peut valoir que 'membre'.
  const state = { role: 'membre' as Role, ttl: 15, uses: 1, label: '', space: store.space as SpaceChoice };
  // Seul le propriétaire peut faire entrer un admin.
  // Le « ...(condition ? [x] : []) » ajoute un élément au tableau seulement si
  // la condition est vraie.
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
      // Choix de l'espace seulement si l'admin a accès aux deux.
      me.spaces.length > 1 ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Espace'),
        chips<SpaceChoice>(spaceChoices(me.spaces), state.space, (v) => (state.space = v)),
        h('span', { class: 'field-hint' }, 'La personne ne verra que cet espace (ou les deux).')) : null,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Rôle'),
        chips<Role>(roles, state.role, (v) => (state.role = v))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Valable'), chips(TTL, state.ttl, (v) => (state.ttl = v))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Pour'), chips(USES, state.uses, (v) => (state.uses = v))),
      field('Note', h('input', { class: 'input', type: 'text', maxlength: '60', placeholder: 'Ex. : groupe d\'action Nord', oninput: (e: Event) => (state.label = (e.target as HTMLInputElement).value) }), undefined, true),
    ) : null,
    // Création de l'invitation : le serveur renvoie l'invitation, le lien et le
    // QR code (déjà dessiné en SVG).
    h('button', { class: 'btn btn-primary btn-block btn-big', onclick: async () => {
      try {
        // Un relais invite toujours dans l'espace où il se trouve.
        const spaces = isAdmin ? toSpaces(state.space) : [store.space];
        const res = await api.createInvite({ role: state.role, ttlMinutes: state.ttl, maxUses: state.uses, label: state.label || null, spaces });
        // Affiche le QR code en grand.
        showInvite(res);
        // Pour un admin, on recharge la liste des invitations actives.
        if (isAdmin) load();
      } catch (e) {
        toast((e as ApiError).message, 'err');
      }
    } }, icon('qr-code', 20), 'Générer le QR code'),
  );
}

// showInvite() : affiche le QR code d'une invitation avec un compte à rebours.
// Entrée : la réponse du serveur (invitation + lien + SVG du QR).
function showInvite(res: CreatedInvite) {
  const qr = h('div', { class: 'qr' });
  // innerHTML insère du HTML brut : à éviter en général (risque d'injection),
  // acceptable ici car le SVG vient de notre propre serveur.
  qr.innerHTML = res.qrSvg; // SVG produit par le serveur à partir de notre propre lien
  const countdown = h('strong', { class: 'countdown' });
  // tick() : met à jour le compte à rebours ; appelée chaque seconde.
  const tick = () => {
    const left = res.invite.expiresAt - Date.now();
    // Expiré : on grise le QR et on arrête le minuteur.
    // « timer » est déclaré plus bas, mais tick() ne s'exécute qu'après sa déclaration.
    if (left <= 0) {
      countdown.textContent = 'Expiré';
      qr.classList.add('expired');
      clearInterval(timer);
      return;
    }
    // Minutes et secondes restantes (60000 ms = 1 min).
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    // Plus d'une heure : texte relatif (« dans 2 h ») ; sinon « 14:05 » minutes:secondes.
    countdown.textContent = m >= 60 ? `expire ${relative(res.invite.expiresAt)}` : `expire dans ${m}:${String(s).padStart(2, '0')}`;
  };
  // setInterval répète tick toutes les 1000 ms ; on l'appelle aussi tout de
  // suite pour ne pas attendre une seconde avant le premier affichage.
  const timer = setInterval(tick, 1000);
  tick();

  openSheet({
    title: 'Invitation',
    accent: spaceColor(),
    // À la fermeture, on arrête le minuteur (sinon il tournerait pour rien).
    onClose: () => clearInterval(timer),
    body: h('div', { class: 'invite-show' },
      h('p', { class: 'invite-who' }, `${ROLE_LABEL[res.invite.role]} · ${res.invite.maxUses === 1 ? '1 personne' : `${res.invite.maxUses} personnes`}`),
      qr,
      countdown,
      h('p', { class: 'muted center' }, 'La personne scanne avec l\'appareil photo de son téléphone, puis indique son prénom.'),
      h('div', { class: 'grid-2' },
        // Copie du lien dans le presse-papier. « ?. » : clipboard peut être absent
        // (hors https par exemple) ; le toast s'affiche quand même dans ce cas.
        h('button', { class: 'btn btn-outline', onclick: async () => { await navigator.clipboard?.writeText(res.url); toast('Lien copié', 'ok'); } }, icon('copy', 18), 'Copier le lien'),
        // Bouton « Envoyer » (partage natif du téléphone), seulement si le navigateur
        // le permet. .catch(() => {}) : annuler le partage n'est pas une erreur.
        'share' in navigator ? h('button', { class: 'btn btn-outline', onclick: () => navigator.share({ title: 'Invitation Terrain', url: res.url }).catch(() => {}) }, icon('share-2', 18), 'Envoyer') : null,
      ),
      h('p', { class: 'field-hint center' }, 'Un lien envoyé par message peut être transféré : le QR montré en direct est plus sûr.'),
    ),
  });
}

// norm() : met un texte en minuscules et retire les accents, pour que
// « helene » trouve « Hélène ».
// normalize('NFD') sépare chaque lettre de son accent (é → e + ´), puis la
// regex retire tous les accents (plage Unicode ̀-ͯ).
const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Sortie : la <section> complète. Seule la liste se redessine quand on tape :
// le champ de recherche garde ainsi le focus.
/** Liste des appareils, avec recherche (nom, ou nom de la personne qui a invité) et filtre par rôle. */
function devicesSection() {
  const list = h('ul', { class: 'rows' });
  const count = h('span', { class: 'field-hint' });
  // count0() : nombre d'appareils d'un rôle donné (pour les compteurs des filtres).
  const count0 = (r: Role) => devices.filter((d) => d.role === r).length;
  // renderList() : filtre puis affiche les lignes.
  const renderList = () => {
    const q = norm(devQuery.trim());
    // On garde l'appareil s'il correspond au rôle ET (pas de recherche, ou le nom,
    // ou le nom de la personne qui l'a invité, contient le texte cherché).
    const shown = devices.filter((d) => (devRole === 'all' || d.role === devRole)
      && (!q || norm(d.name).includes(q) || norm(d.invitedByName ?? '').includes(q)));
    // Liste vide après filtre : petit message plutôt qu'un blanc.
    clear(list, ...(shown.length ? shown.map(deviceRow) : [h('p', { class: 'muted' }, 'Personne ne correspond.')]));
    // « 3 sur 12 » seulement quand un filtre cache des appareils.
    count.textContent = shown.length === devices.length ? '' : `${shown.length} sur ${devices.length}`;
  };
  // devQuery et devRole sont des variables du MODULE : la recherche est gardée
  // quand l'onglet se redessine.
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
    // Les outils de recherche n'apparaissent qu'au-delà de 5 appareils.
    devices.length > 5 ? h('div', { class: 'dev-tools' }, search, filter, count) : null,
    list,
  );
}

// deviceRow() : une ligne de la liste des appareils.
function deviceRow(d: Device & { manageable: boolean }) {
  const isMe = d.id === store.me.id;
  return h('li', { class: 'row' },
    h('div', { class: 'avatar small' }, d.name.slice(0, 1).toUpperCase()),
    h('div', { class: 'row-main' },
      h('strong', null, d.name, isMe ? h('em', null, ' (moi)') : null),
      h('span', { class: 'row-tags' }, d.owner ? h('span', { class: 'space-tag owner-tag' }, 'Propriétaire') : null, ...spaceTags(d.spaces)),
      // Résumé : rôle · type d'appareil · dernière activité · qui l'a invité.
      h('span', null, `${d.owner ? 'Propriétaire' : ROLE_LABEL[d.role]} · ${deviceLabel(d.userAgent)} · vu ${d.lastSeen ? relative(d.lastSeen) : 'jamais'}${d.invitedByName ? ` · invité·e par ${d.invitedByName}` : ''}`)),
    // On ne propose « Gérer » que si on a vraiment le droit (le serveur le vérifie aussi).
    d.manageable ? h('button', { class: 'btn btn-small btn-light', onclick: () => manageDevice(d) }, 'Gérer') : null,
  );
}

// manageDevice() : sheet de gestion d'un appareil (rôle, espaces, retrait).
// Les valeurs choisies sont dans des « let » locales, lues au clic.
function manageDevice(d: Device) {
  const me = store.me;
  let role = d.role;
  let space = fromSpaces(d.spaces);
  let cascade = false;
  // Nombre d'appareils invités DIRECTEMENT par celui-ci (pour l'avertissement de cascade).
  const children = devices.filter((x) => x.invitedBy === d.id).length;
  // Seul le propriétaire nomme des admins ; chacun ne donne que ses propres espaces.
  const roles: { value: Role; label: string }[] = [
    { value: 'membre', label: 'Membre' }, { value: 'relais', label: 'Relais' },
    ...(me.owner ? [{ value: 'admin' as Role, label: 'Admin' }] : []),
  ];
  // On garde la poignée de la sheet (s) pour la fermer après l'enregistrement.
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
          // On n'envoie « spaces » que si le choix était proposé (sinon on ne touche pas
          // aux espaces de l'appareil). L'objet vide {} étalé n'ajoute rien.
          await api.updateDevice(d.id, { role, ...(me.spaces.length > 1 ? { spaces: toSpaces(space) } : {}) });
          toast('Droits mis à jour', 'ok'); s.close(); load();
        } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, 'Enregistrer'),
      h('hr'),
      // Case « cascade » : retirer aussi toute la chaîne de personnes invitées par
      // cet appareil (utile si un téléphone est perdu ou compromis).
      h('label', { class: 'toggle-line' },
        h('input', { type: 'checkbox', onchange: (e: Event) => (cascade = (e.target as HTMLInputElement).checked) }),
        h('span', { class: 'switch' }), `Retirer aussi les appareils qu'il a fait entrer${children ? ` (${children} direct${children > 1 ? 's' : ''}, et leurs invités)` : ''}`),
      // Retrait d'accès, après confirmation.
      h('button', { class: 'btn btn-danger btn-block', onclick: async () => {
        if (!(await confirmSheet('Retirer l\'accès ?', `${d.name} ne pourra plus ouvrir l'app${cascade ? ', ainsi que toutes les personnes invitées par sa chaîne' : ''}.`, 'Retirer l\'accès'))) return;
        try {
          // Le serveur renvoie combien d'appareils ont été retirés au total.
          const r = await api.revokeDevice(d.id, cascade);
          toast(`${r.revoked} appareil${r.revoked > 1 ? 's' : ''} retiré${r.revoked > 1 ? 's' : ''}`, 'ok');
          // Si je me suis retiré moi-même, je n'ai plus accès : on recharge la page.
          if (d.id === store.me.id) return location.reload();
          load();
        } catch (e) { toast((e as ApiError).message, 'err'); }
      } }, icon('trash-2', 18), 'Retirer l\'accès'),
    ),
  });
}

// renameMe() : changer le nom affiché de cet appareil.
function renameMe() {
  const input = h('input', { class: 'input', type: 'text', maxlength: '40', value: store.me.name }) as HTMLInputElement;
  const s = openSheet({
    title: 'Mon nom',
    body: field('Prénom ou pseudo', input, 'Visible par l\'équipe sur les points que tu ajoutes.'),
    footer: h('button', { class: 'btn btn-primary btn-block', onclick: async () => {
      try {
        await api.rename(input.value);
        // On met à jour localement (sans recharger depuis le serveur) puis on
        // prévient le reste de l'app (événement 'me') que le nom a changé.
        // Attention : si le serveur modifie le nom (coupe, nettoie), l'affichage peut
        // différer légèrement de ce qui est enregistré.
        store.me.name = input.value.trim();
        s.close();
        render();
        store.emit('me');
      } catch (e) { toast((e as ApiError).message, 'err'); }
    } }, 'Enregistrer'),
  });
  // Petit délai avant le focus : on laisse la sheet finir son animation
  // d'ouverture (sinon le clavier mobile peut mal se placer).
  setTimeout(() => input.focus(), 300);
}
