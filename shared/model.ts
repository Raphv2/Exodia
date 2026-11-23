/*
 * shared/model.ts — LE dictionnaire commun du projet.
 *
 * À quoi il sert : décrire la forme des données (points, appareils, invitations, votes, archive, chat)
 * et les règles « métier » simples (quels types existent dans quel espace, quelles couleurs, quels états…).
 *
 * Qui l'importe : à la fois le serveur (server/*.ts) et le client (web/src/*.ts). C'est ce qui garantit
 * que les deux parlent exactement la même langue : si on change un champ ici, TypeScript signale
 * immédiatement partout (serveur ET client) le code qui n'est plus d'accord.
 *
 * Notions à connaître :
 * - `type X = 'a' | 'b'` : une « union de littéraux » ; une variable de ce type ne peut valoir QUE 'a' ou 'b'.
 *   C'est l'équivalent TypeScript d'une énumération, mais qui reste une simple chaîne en JSON / en base.
 * - `interface` : la forme d'un objet (liste de champs et leurs types). N'existe qu'à la compilation,
 *   il n'en reste rien dans le JavaScript final.
 * - `Record<K, V>` : un objet dont les clés sont de type K et les valeurs de type V. Avec K = une union,
 *   TypeScript exige qu'AUCUNE clé ne manque (pratique pour ne pas oublier un libellé).
 * - `Partial<T>` : la même chose que T mais avec tous les champs facultatifs.
 * - `as const` : fige un tableau/objet littéral (lecture seule, valeurs gardées comme littéraux précis).
 * - Les dates sont partout des nombres : millisecondes depuis le 1er janvier 1970 (comme `Date.now()`).
 */
// Modèle partagé entre le serveur et l'interface.

// Rôle d'un appareil : admin (gère tout dans ses espaces), relais (peut inviter), membre (utilise la carte).
export type Role = 'admin' | 'relais' | 'membre';
// Mode d'un point : « fixe » = lieu permanent (panneau, local…), « event » = événement daté (AG, tractage…).
export type Mode = 'fixe' | 'event';
// Répétition d'un événement. Les codes sont en anglais car ils sont stockés tels quels en base.
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';
// États possibles d'un panneau électoral (à coller, collé, abîmé).
export type PanneauStatus = 'a_coller' | 'colle' | 'abime';
// États possibles d'un blocage (tenu par des gens, laissé vide, levé).
export type BlocageStatus = 'tenu' | 'vide' | 'leve';
// Union des deux : n'importe quel état de point. `A | B` sur deux unions = toutes les valeurs des deux.
export type PointStatus = PanneauStatus | BlocageStatus;

/**
 * Deux espaces vraiment séparés (le serveur l'impose) :
 * - « lfi » : le côté LFI (panneaux, collage, tractage…) ;
 * - « mvt » : le côté mouvement (blocus, blocages, police…).
 * Ce qui est commun (AG, rassemblement, local, matériel, flash, warning, danger…) existe des deux côtés,
 * mais chaque point appartient à un seul espace et n'est vu que par ceux qui y ont accès.
 */
export type Space = 'lfi' | 'mvt';
// Liste des espaces, utile pour boucler dessus (un type n'existe pas à l'exécution, ce tableau si).
export const SPACES: Space[] = ['lfi', 'mvt'];
// Nom affiché de chaque espace. `Record<Space, string>` oblige à donner un libellé pour CHAQUE espace.
export const SPACE_LABEL: Record<Space, string> = { lfi: 'Campagne', mvt: 'Mouvement' };

/*
 * Liste de tous les types de points. `as const` est indispensable ici : sans lui, TypeScript verrait
 * juste un `string[]` ; avec lui, il connaît chaque valeur exacte, ce qui permet d'en déduire
 * le type `PointType` juste en dessous (une seule source de vérité : on ajoute un type ici, et c'est tout).
 */
export const TYPE_KEYS = [
  'panneau', 'collage', 'ag', 'tractage', 'rassemblement', 'blocus', 'blocage', 'materiel', 'local', 'autre', 'warning', 'danger', 'police',
] as const;
/*
 * `typeof TYPE_KEYS` = le type du tableau ci-dessus ; `[number]` = « le type de n'importe quel élément
 * à un indice numérique ». Résultat : 'panneau' | 'collage' | … | 'police'.
 */
export type PointType = (typeof TYPE_KEYS)[number];

/** Fiche descriptive d'un type de point (libellés, couleurs, icône, comportements). */
export interface TypeMeta {
  // Nom complet (formulaires, titres).
  label: string;
  // Nom court (légende, filtres, titre de la fiche).
  short: string;
  // Couleur de l'épingle sur la carte (code hexadécimal #RRGGBB).
  color: string;
  /** Couleur du texte/icône posé sur `color`. */
  ink: string;
  // Nom de l'icône (voir la table ICONS dans web/src/ui.ts).
  icon: string;
  // Modes autorisés pour ce type (un panneau est forcément fixe, une AG forcément un événement…).
  modes: Mode[];
  // `?` = champ facultatif. true pour les alertes (warning, danger, police) : durée de vie courte.
  alert?: boolean;
  /** Peut faire partie d'un trajet de collage. */
  routable?: boolean;
  /** Proposé « toute la journée » par défaut. */
  allDay?: boolean;
  // Exemple de titre affiché en gris dans le champ du formulaire.
  placeholder: string;
  /** Espaces où ce type existe (par défaut : les deux). */
  spaces?: Space[];
}

/*
 * Catalogue de tous les types. Grâce à `Record<PointType, TypeMeta>`, oublier un type de TYPE_KEYS
 * ou faire une faute de frappe dans une clé est une erreur de compilation.
 * Absence de `spaces` = le type existe dans les deux espaces (voir `typeInSpace`).
 */
export const TYPES: Record<PointType, TypeMeta> = {
  panneau:  { label: 'Panneau électoral', short: 'Panneau', color: '#7B13D6', ink: '#fff', icon: 'presentation', modes: ['fixe'], routable: true, spaces: ['lfi'], placeholder: 'Panneau n°12 – école Jean-Jaurès' },
  collage:  { label: 'Point de collage', short: 'Collage', color: '#00A86B', ink: '#fff', icon: 'paint-roller', modes: ['fixe', 'event'], routable: true, spaces: ['lfi'], placeholder: 'Collage quartier gare' },
  ag:       { label: 'Assemblée générale', short: 'AG', color: '#E5007D', ink: '#fff', icon: 'users', modes: ['event'], placeholder: 'AG du groupe d\'action' },
  tractage: { label: 'Tractage', short: 'Tractage', color: '#FF7A00', ink: '#fff', icon: 'newspaper', modes: ['event'], spaces: ['lfi'], placeholder: 'Tractage marché du dimanche' },
  rassemblement: { label: 'Rassemblement', short: 'Rassemblement', color: '#1F4FD1', ink: '#fff', icon: 'megaphone', modes: ['event'], placeholder: 'Rassemblement devant la mairie' },
  blocus:   { label: 'Blocus', short: 'Blocus', color: '#5C1033', ink: '#fff', icon: 'flame', modes: ['event'], spaces: ['mvt'], placeholder: 'Blocus fac – RDV quai 43' },
  blocage:  { label: 'Blocage', short: 'Blocage', color: '#8B1E3F', ink: '#fff', icon: 'construction', modes: ['fixe'], spaces: ['mvt'], placeholder: 'Bâtiment A – entrée principale' },
  materiel: { label: 'Matériel', short: 'Matériel', color: '#0098B6', ink: '#fff', icon: 'package', modes: ['fixe', 'event'], placeholder: 'Dépôt de matériel' },
  local:    { label: 'Local', short: 'Local', color: '#00232C', ink: '#fff', icon: 'house', modes: ['fixe', 'event'], placeholder: 'Local du groupe' },
  autre:    { label: 'Autre', short: 'Autre', color: '#5B6770', ink: '#fff', icon: 'map-pin', modes: ['fixe', 'event'], placeholder: 'Titre du point' },
  // Le jaune est clair : on écrit dessus en bleu nuit (#00232C) plutôt qu'en blanc, sinon illisible.
  warning:  { label: 'Warning', short: 'Warning', color: '#FFC400', ink: '#00232C', icon: 'triangle-alert', modes: ['event'], alert: true, placeholder: 'Attention' },
  danger:   { label: 'Danger', short: 'Danger', color: '#F53B3B', ink: '#fff', icon: 'siren', modes: ['event'], alert: true, placeholder: 'Danger' },
  police:   { label: 'Police / CRS', short: 'Police', color: '#1546E0', ink: '#fff', icon: 'police', modes: ['event'], alert: true, spaces: ['mvt'], placeholder: 'Police' },
};

// Durées de vie proposées pour une alerte, en minutes. `as const` = valeurs figées (type 15 | 30 | 60 | 120).
export const ALERT_DURATIONS = [15, 30, 60, 120] as const;

// Les trois types qui sont des alertes (sous-ensemble de PointType).
export type AlertType = 'warning' | 'danger' | 'police';

/** Le type existe-t-il dans cet espace ? */
// Pas de liste `spaces` → existe partout ; sinon on regarde si l'espace est dedans.
// Le `!` après `spaces` dit à TypeScript « je sais que ce n'est pas undefined » (on vient de le tester).
export const typeInSpace = (t: PointType, s: Space) => !TYPES[t].spaces || TYPES[t].spaces!.includes(s);

/** Alertes prédéfinies, propres à chaque espace (aucune référence croisée). */
// Type imbriqué : pour chaque espace, un objet dont les clés (facultatives grâce à Partial) sont des types
// d'alerte et les valeurs des listes de messages. Ainsi « police » peut n'exister que côté Mouvement.
export const ALERT_PRESETS_BY_SPACE: Record<Space, Partial<Record<AlertType, string[]>>> = {
  lfi: {
    warning: ['Affiches arrachées', 'Panneau recouvert', 'Zone tendue', 'Passage difficile'],
    danger: ['Agression', 'Groupe hostile', 'Personne blessée', 'Zone à éviter'],
  },
  mvt: {
    warning: ['Zone tendue', 'Passage difficile', 'Accès bloqué', 'Personnes hostiles'],
    danger: ['Agression', 'Groupe hostile', 'Personne blessée', 'Zone à éviter'],
    police: ['CRS', 'Police', 'BAC', 'Contrôle d\'identité', 'Nasse', 'Fourgons'],
  },
};
// Messages proposés pour une alerte dans un espace. `??` (« coalescence des nuls ») : si la liste
// n'existe pas (undefined), on renvoie un tableau vide plutôt que de planter.
export const alertPresets = (t: AlertType, s: Space) => ALERT_PRESETS_BY_SPACE[s][t] ?? [];

/** Flash : dans combien de temps ça commence (min) et combien de temps ça dure (min). */
export const FLASH_STARTS = [0, 15, 30, 60] as const;
export const FLASH_DURATIONS = [30, 60, 120, 180] as const;

/**
 * Matériel proposé à la création d'un événement, propre à chaque espace
 * (rien sur le collage côté Mouvement, rien sur les blocus côté LFI). On peut aussi en ajouter à la main.
 */
// `A & B` = intersection : l'objet doit respecter les DEUX formes à la fois. Ici : des clés de type
// de point facultatives, PLUS une clé `default` obligatoire (la liste de secours).
// Pas d'`export` : on passe par la fonction `materialPresets` ci-dessous.
const MATERIAL_BY_SPACE: Record<Space, Partial<Record<PointType, string[]>> & { default: string[] }> = {
  lfi: {
    tractage: ['Tracts', 'Affiches', 'Colle', 'Table', 'Chasubles', 'Mégaphone', 'Flyers'],
    collage: ['Affiches', 'Colle', 'Seaux', 'Balais', 'Gants'],
    rassemblement: ['Banderole', 'Affiches', 'Colle', 'Mégaphone', 'Drapeaux', 'Pancartes', 'Chasubles'],
    ag: ['Affiches', 'Colle', 'Chaises', 'Vidéoprojecteur', 'Rallonge', 'Paperboard'],
    materiel: ['Affiches', 'Colle', 'Tracts', 'Voiture', 'Diable', 'Sacs'],
    default: ['Tracts', 'Affiches', 'Colle', 'Banderole', 'Mégaphone'],
  },
  mvt: {
    blocus: ['Poubelles', 'Palettes', 'Banderole', 'Mégaphone', 'Scotch', 'Cadenas'],
    rassemblement: ['Banderole', 'Mégaphone', 'Pancartes', 'Drapeaux', 'Trousse de secours', 'Eau'],
    ag: ['Chaises', 'Vidéoprojecteur', 'Rallonge', 'Paperboard'],
    materiel: ['Poubelles', 'Palettes', 'Banderoles', 'Voiture', 'Diable', 'Sacs'],
    default: ['Banderole', 'Mégaphone', 'Pancartes', 'Eau', 'Trousse de secours'],
  },
};
// Liste de matériel pour un type dans un espace ; à défaut, la liste `default` de l'espace.
export const materialPresets = (t: PointType, s: Space) => MATERIAL_BY_SPACE[s][t] ?? MATERIAL_BY_SPACE[s].default;

/** Le signalement de problème n'a de sens que sur un lieu tenu : le blocage. */
export const canReportProblem = (t: PointType) => t === 'blocage';

/** Icône propre à chaque alerte prédéfinie : on comprend le problème d'un coup d'œil sur la carte. */
// Clé 1 = type d'alerte, clé 2 = texte exact du message prédéfini, valeur = nom d'icône.
export const ALERT_ICONS: Record<AlertType, Record<string, string>> = {
  warning: { 'Affiches arrachées': 'file-x', 'Panneau recouvert': 'eye-off', 'Zone tendue': 'triangle-alert', 'Passage difficile': 'footprints' },
  danger: { 'Agression': 'swords', 'Groupe hostile': 'skull', 'Personne blessée': 'ambulance', 'Zone à éviter': 'ban' },
  police: { 'CRS': 'shield', 'Police': 'police', 'BAC': 'car', 'Contrôle d\'identité': 'id-card', 'Nasse': 'fence', 'Fourgons': 'bus' },
};

/** Icône à afficher pour un point (alerte : selon le problème choisi, sinon celle du type). */
// `Pick<Point, 'type' | 'title'>` : on n'exige que ces deux champs d'un Point, ce qui permet
// d'appeler la fonction avec un point incomplet (par ex. un formulaire en cours de saisie).
export function iconOf(p: Pick<Point, 'type' | 'title'>): string {
  const meta = TYPES[p.type];
  // Si c'est une alerte ET que son titre correspond à un message prédéfini → icône spécifique.
  // `?.` (chaînage optionnel) : si ALERT_ICONS[...] n'existe pas, on obtient undefined au lieu d'une erreur.
  // `as AlertType` : on affirme à TypeScript que le type est une alerte (vérifié juste avant par `meta.alert`).
  // `||` : si rien n'a été trouvé (undefined ou false), on prend l'icône générale du type.
  return (meta.alert && ALERT_ICONS[p.type as AlertType]?.[p.title.trim()]) || meta.icon;
}

/**
 * « Toujours là » (alerte ou problème) : possible seulement 15 min après le signalement
 * ou la dernière confirmation, une fois par tranche de 15 min (on ne gonfle pas une alerte à l'infini).
 */
export const CONFIRM_LOCK_MIN = 15;
// Moment (en ms) à partir duquel on peut de nouveau confirmer : la plus récente des deux dates
// (création ou dernière confirmation) + 15 minutes. `60_000` = 60000 ms = 1 minute (le `_` sert juste
// à la lisibilité). `confirmedAt ?? 0` : si jamais confirmé (null/undefined), on prend 0.
export const nextConfirmAt = (x: { createdAt: number; confirmedAt?: number | null }) =>
  Math.max(x.createdAt, x.confirmedAt ?? 0) + CONFIRM_LOCK_MIN * 60_000;

/** Problème signalé sur un point existant (sans créer d'alerte séparée). */
// Durées proposées pour un problème (minutes) et messages prédéfinis.
export const PROBLEM_DURATIONS = [30, 60, 120, 240] as const;
export const PROBLEM_PRESETS = ['Barricade enlevée', 'Des gens dans le bâtiment', 'Manque de monde', 'Besoin de matériel'];

// Une personne (un appareil, en fait) réduite à son identifiant et son nom affiché.
export interface Person { id: string; name: string }
/** Blocus : `arriveAt` = heure d'arrivée prévue si on ne vient pas dès le RDV (null = au RDV). */
// `extends Person` : un Participant a tous les champs de Person, plus `arriveAt`.
export interface Participant extends Person { arriveAt: number | null }

/** Problème en cours sur un point (par ex. « Manque de monde » sur un blocage). */
export interface Problem {
  id: string;
  // Point concerné.
  pointId: string;
  message: string;
  // Identifiant de l'appareil qui a signalé, et son nom (null si l'appareil a été supprimé).
  createdBy: string;
  creatorName: string | null;
  createdAt: number;
  // Après cette date, le problème est considéré comme fini (voir `liveProblems` dans time.ts).
  expiresAt: number;
  /** Dernier « Toujours là ». */
  confirmedAt: number | null;
}

// Libellé affiché pour chaque état. Record sur l'union complète : aucun état ne peut être oublié.
export const STATUS_LABEL: Record<PointStatus, string> = {
  a_coller: 'À coller',
  colle: 'Collé',
  abime: 'Abîmé / recouvert',
  tenu: 'Tenu',
  vide: 'Sans personne',
  leve: 'Levé',
};

/** États possibles selon le type (tout le monde peut les changer sur le terrain). */
// Partial : seuls les types qui ONT des états sont listés ; pour les autres, STATUSES[type] vaut undefined.
export const STATUSES: Partial<Record<PointType, PointStatus[]>> = {
  panneau: ['a_coller', 'colle', 'abime'],
  blocage: ['tenu', 'vide', 'leve'],
};
// Petite explication sous certains états (seulement ceux des blocages).
export const STATUS_HINT: Partial<Record<PointStatus, string>> = {
  tenu: 'Du monde sur place',
  vide: 'Barricade seule',
  leve: 'Barricade enlevée',
};

// Libellés français des rôles et des répétitions (codes techniques → texte affiché).
export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  relais: 'Relais',
  membre: 'Membre',
};

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  none: 'Une seule fois',
  daily: 'Chaque jour',
  weekly: 'Chaque semaine',
  monthly: 'Chaque mois',
};

// Palette proposée quand on choisit une couleur personnalisée pour un point.
export const COLOR_CHOICES = [
  '#7B13D6', '#A855F7', '#E5007D', '#F472B6', '#F53B3B', '#8B1E3F', '#FF7A00', '#B45309',
  '#FFC400', '#84CC16', '#00A86B', '#0B6E4F', '#0098B6', '#1F4FD1', '#1E3A8A', '#5B6770',
  '#00232C', '#000000',
];

/**
 * Un point de la carte, tel que le serveur l'envoie au client (format JSON de l'API).
 * Les champs `| null` peuvent être absents de la base (colonne vide) : il faut toujours prévoir le cas null.
 */
export interface Point {
  id: string;
  /** Espace auquel appartient le point. */
  space: Space;
  mode: Mode;
  type: PointType;
  title: string;
  description: string | null;
  // Coordonnées GPS en degrés décimaux (latitude nord-sud, longitude est-ouest).
  lat: number;
  lng: number;
  // Couleur choisie à la main ; null = couleur du type (voir `colorOf`).
  color: string | null;
  // Nom du fichier photo sur le serveur (voir `photoUrl` dans web/src/api.ts).
  photo: string | null;
  // Début / fin de l'événement (ms). Pour une répétition : ceux de la PREMIÈRE occurrence.
  startsAt: number | null;
  endsAt: number | null;
  recurrence: Recurrence;
  // Dernière date à laquelle une répétition peut commencer (null = sans fin).
  recurrenceUntil: number | null;
  // Date d'expiration (alertes, flash, événement terminé à la main…) ; null = pas d'expiration.
  expiresAt: number | null;
  status: PointStatus | null;
  /** Dernier changement d'état (panneau, blocage). */
  statusAt: number | null;
  /** Alerte : dernier « Toujours là ». */
  confirmedAt: number | null;
  createdBy: string;
  creatorName: string | null;
  createdAt: number;
  updatedAt: number;
  /** Blocage : le blocus auquel il est rattaché. */
  parentId: string | null;
  /** Événement : matériel à prévoir. */
  material: string[];
  /** Flash : événement improvisé, qui commence dans les minutes qui viennent (notification à tout le monde). */
  flash: boolean;
  /** AG côté Mouvement annoncée publiquement : visible sans compte. */
  isPublic: boolean;
  /** Événement : qui a dit venir. */
  participants: Participant[];
  /** Événement : qui fournit quoi (clé = élément de `material`). Fournir n'oblige pas à venir. */
  providers: Record<string, Person[]>;
  /** Problèmes en cours (non réglés, non expirés). */
  problems: Problem[];
}

/** Données envoyées pour créer / modifier un point. */
// Différence avec `Point` : pas d'id ni de champs calculés par le serveur (dates de création,
// participants…), et beaucoup de champs facultatifs (`?`) car le serveur met des valeurs par défaut.
export interface PointInput {
  /** Espace du point (création ; ignoré en modification). */
  space?: Space;
  mode: Mode;
  type: PointType;
  title: string;
  description?: string | null;
  lat: number;
  lng: number;
  color?: string | null;
  photo?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
  recurrence?: Recurrence;
  recurrenceUntil?: number | null;
  /** Pour les alertes (warning, danger, police) : durée de vie à partir de maintenant. */
  durationMinutes?: number;
  status?: PointStatus | null;
  /** Blocage : blocus auquel il est rattaché. À la fin du blocus, un blocage « tenu » passe à « sans personne ». */
  parentId?: string | null;
  /** Événement : matériel à prévoir. */
  material?: string[];
  /** Flash : événement improvisé. */
  flash?: boolean;
  /** AG côté Mouvement : l'annoncer publiquement (visible sans compte). */
  isPublic?: boolean;
}

/**
 * Un appareil connecté (il n'y a pas de comptes avec mot de passe : chaque téléphone/ordinateur
 * est invité via un lien ou un QR code et devient un « appareil »).
 */
export interface Device {
  id: string;
  name: string;
  role: Role;
  /** Espaces auxquels l'appareil a accès. */
  spaces: Space[];
  /** Propriétaire : accès à tout, seul à nommer des admins et à leur donner des espaces. */
  owner: boolean;
  // Qui a invité cet appareil (id et nom), null pour le tout premier (créé en ligne de commande).
  invitedBy: string | null;
  invitedByName: string | null;
  createdAt: number;
  // Dernière activité connue ; null = jamais vu depuis l'inscription.
  lastSeen: number | null;
  // Date de révocation (accès retiré) ; null = toujours actif.
  revokedAt: number | null;
  // Navigateur/système déclaré, pour reconnaître l'appareil dans la liste.
  userAgent: string | null;
}

/** Une invitation : un lien utilisable `maxUses` fois avant `expiresAt`, qui donne un rôle et des espaces. */
export interface Invite {
  id: string;
  role: Role;
  spaces: Space[];
  // Étiquette libre (« Groupe fac », « Comité nord »…).
  label: string | null;
  maxUses: number;
  // Nombre d'utilisations déjà faites.
  uses: number;
  expiresAt: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  revokedAt: number | null;
}

/** Réponse du serveur juste après la création d'une invitation : l'invitation, son lien et son QR code (SVG en texte). */
export interface CreatedInvite {
  invite: Invite;
  url: string;
  qrSvg: string;
}

/** Distances proposées pour voter (m autour de l'AG) ; 50 m par défaut ; 0 = peu importe la distance. */
export const VOTE_RADII = [25, 50, 100, 200, 500, 0] as const;
// 0 est « faux » en JavaScript : `r ? … : …` affiche donc « Peu importe » pour 0, sinon « 25 m », etc.
export const voteRadiusLabel = (r: number) => (r ? `${r} m` : 'Peu importe');
export const DEFAULT_VOTE_RADIUS = 50;

/** Vote en AG (façon Kahoot : un code à 5 chiffres, un vote par appareil, sur place). */
export interface Vote {
  id: string;
  // L'AG (point de type 'ag') à laquelle le vote est rattaché.
  pointId: string;
  question: string;
  // Les choix possibles ; un bulletin = l'indice (0, 1, 2…) du choix dans ce tableau.
  options: string[];
  // Union de littéraux écrite directement dans le champ (pas besoin de type nommé).
  status: 'open' | 'closed';
  /** Rayon (m) autour de l'AG pour pouvoir voter ; 0 = peu importe la distance (pas de position demandée). */
  radius: number;
  /** Code à 5 chiffres : seulement pour l'organisation, tant que le vote est ouvert. */
  code: string | null;
  // Nombre total de bulletins.
  total: number;
  /** Résultats par choix : pour l'organisation en direct, pour tous une fois clos. */
  counts: number[] | null;
  /** Mon choix, si j'ai déjà voté. */
  myChoice: number | null;
  createdAt: number;
  closedAt: number | null;
  /** Sur la page d'accueil publique : on vote sans code (vote « peu importe la distance » d'une AG annoncée). */
  openToAll: boolean;
}
/** Archive (côté Mouvement) : document daté, privé (membres) ou public (visible sans compte). */
export interface ArchiveItem {
  id: string;
  // Nature de l'élément : fichier, image, copie de mail ou simple note texte.
  kind: 'document' | 'image' | 'mail' | 'note';
  title: string;
  /** Date du document (pas la date d'ajout). */
  date: number;
  // Texte (note, mail) ; null pour un simple fichier.
  body: string | null;
  // Nom du fichier stocké sur le serveur, nom d'origine, type MIME (ex. 'application/pdf').
  file: string | null;
  fileName: string | null;
  fileType: string | null;
  visibility: 'private' | 'public';
  /** Masqués dans l'archive publique. */
  createdBy: string | null;
  creatorName: string | null;
  createdAt: number;
}
// `ArchiveItem['kind']` = « le type du champ kind de ArchiveItem » (type indexé) : on réutilise
// l'union déjà écrite plus haut au lieu de la recopier.
export const ARCHIVE_KIND_LABEL: Record<ArchiveItem['kind'], string> = { document: 'Document', image: 'Image', mail: 'Copie de mail', note: 'Note' };

/** Registre automatique : événements passés et votes clos (jamais les blocages ni les alertes). */
/*
 * « Union discriminée » : une entrée est SOIT un événement, SOIT un vote. Le champ commun `kind`
 * sert d'étiquette : après `if (e.kind === 'vote')`, TypeScript sait que `e.options` existe.
 */
export type RegistryEntry =
  | { kind: 'event'; id: string; date: number; end: number; title: string; type: string }
  | { kind: 'vote'; id: string; date: number; title: string; ag: string; options: string[]; counts: number[] };

/** AG annoncée publiquement (vue sans compte). */
// Version réduite d'un Point : seulement ce qu'on peut montrer à quelqu'un sans compte.
export interface PublicAg { id: string; title: string; description: string | null; lat: number; lng: number; startsAt: number; endsAt: number }

/** Chat chiffré (côté Mouvement) : le serveur ne transporte que des clés publiques et des messages chiffrés. */
// Membre du chat : son appareil et sa clé publique (sert à lui chiffrer la clé de conversation).
export interface ChatMember { id: string; name: string; publicKey: string }
/*
 * « Époque » = une période pendant laquelle tout le monde partage la même clé secrète de conversation.
 * On en change quand la liste des membres change. Cette clé est « emballée » (`wrapped`, chiffrée)
 * séparément pour chaque destinataire ; `iv` = vecteur d'initialisation, un nombre aléatoire
 * obligatoire pour le chiffrement AES-GCM.
 */
export interface ChatEpochKey { epochId: number; senderId: string; senderKey: string; recipientKey: string; wrapped: string; iv: string }
// Message chiffré : seul `ciphertext` contient le texte, illisible sans la clé de l'époque `epochId`.
export interface ChatMessage { id: string; epochId: number; senderId: string; senderName: string | null; iv: string; ciphertext: string; createdAt: number }

// Résultat d'un vote tel qu'on le montre publiquement (sans code, sans « mon choix »).
export interface VoteResult { id: string; status: 'open' | 'closed'; question: string; options: string[]; counts: number[] | null }

// Couleur effective d'un point : sa couleur personnalisée, sinon celle de son type.
export const colorOf = (p: Pick<Point, 'type' | 'color'>) => p.color ?? TYPES[p.type].color;

/**
 * Couleurs attribuées automatiquement aux blocus (une différente par blocus en cours),
 * reprises par les blocages qui leur sont rattachés.
 */
export const BLOCUS_COLORS = ['#5C1033', '#0B6E4F', '#1E3A8A', '#B45309', '#7C2D92', '#0E7490', '#9D174D', '#3F6212'];
// Ce type est-il une alerte ? `!!` convertit en vrai booléen (undefined → false).
export const isAlert = (t: PointType) => !!TYPES[t].alert;
