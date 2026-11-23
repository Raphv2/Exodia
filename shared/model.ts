// Modèle partagé entre le serveur et l'interface.

export type Role = 'admin' | 'relais' | 'membre';
export type Mode = 'fixe' | 'event';
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';
export type PanneauStatus = 'a_coller' | 'colle' | 'abime';
export type BlocageStatus = 'tenu' | 'vide' | 'leve';
export type PointStatus = PanneauStatus | BlocageStatus;

/**
 * Deux espaces vraiment séparés (le serveur l'impose) :
 * - « lfi » : le côté LFI (panneaux, collage, tractage…) ;
 * - « mvt » : le côté mouvement (blocus, blocages, police…).
 * Ce qui est commun (AG, rassemblement, local, matériel, flash, warning, danger…) existe des deux côtés,
 * mais chaque point appartient à un seul espace et n'est vu que par ceux qui y ont accès.
 */
export type Space = 'lfi' | 'mvt';
export const SPACES: Space[] = ['lfi', 'mvt'];
export const SPACE_LABEL: Record<Space, string> = { lfi: 'Campagne', mvt: 'Mouvement' };

export const TYPE_KEYS = [
  'panneau', 'collage', 'ag', 'tractage', 'rassemblement', 'blocus', 'blocage', 'materiel', 'local', 'autre', 'warning', 'danger', 'police',
] as const;
export type PointType = (typeof TYPE_KEYS)[number];

export interface TypeMeta {
  label: string;
  short: string;
  color: string;
  /** Couleur du texte/icône posé sur `color`. */
  ink: string;
  icon: string;
  modes: Mode[];
  alert?: boolean;
  /** Peut faire partie d'un trajet de collage. */
  routable?: boolean;
  /** Proposé « toute la journée » par défaut. */
  allDay?: boolean;
  placeholder: string;
  /** Espaces où ce type existe (par défaut : les deux). */
  spaces?: Space[];
}

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
  warning:  { label: 'Warning', short: 'Warning', color: '#FFC400', ink: '#00232C', icon: 'triangle-alert', modes: ['event'], alert: true, placeholder: 'Attention' },
  danger:   { label: 'Danger', short: 'Danger', color: '#F53B3B', ink: '#fff', icon: 'siren', modes: ['event'], alert: true, placeholder: 'Danger' },
  police:   { label: 'Police / CRS', short: 'Police', color: '#1546E0', ink: '#fff', icon: 'police', modes: ['event'], alert: true, spaces: ['mvt'], placeholder: 'Police' },
};

export const ALERT_DURATIONS = [15, 30, 60, 120] as const;

export type AlertType = 'warning' | 'danger' | 'police';

/** Le type existe-t-il dans cet espace ? */
export const typeInSpace = (t: PointType, s: Space) => !TYPES[t].spaces || TYPES[t].spaces!.includes(s);

/** Alertes prédéfinies, propres à chaque espace (aucune référence croisée). */
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
export const alertPresets = (t: AlertType, s: Space) => ALERT_PRESETS_BY_SPACE[s][t] ?? [];

/** Flash : dans combien de temps ça commence (min) et combien de temps ça dure (min). */
export const FLASH_STARTS = [0, 15, 30, 60] as const;
export const FLASH_DURATIONS = [30, 60, 120, 180] as const;

/**
 * Matériel proposé à la création d'un événement, propre à chaque espace
 * (rien sur le collage côté Mouvement, rien sur les blocus côté LFI). On peut aussi en ajouter à la main.
 */
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
export const materialPresets = (t: PointType, s: Space) => MATERIAL_BY_SPACE[s][t] ?? MATERIAL_BY_SPACE[s].default;

/** Le signalement de problème n'a de sens que sur un lieu tenu : le blocage. */
export const canReportProblem = (t: PointType) => t === 'blocage';

/** Icône propre à chaque alerte prédéfinie : on comprend le problème d'un coup d'œil sur la carte. */
export const ALERT_ICONS: Record<AlertType, Record<string, string>> = {
  warning: { 'Affiches arrachées': 'file-x', 'Panneau recouvert': 'eye-off', 'Zone tendue': 'triangle-alert', 'Passage difficile': 'footprints' },
  danger: { 'Agression': 'swords', 'Groupe hostile': 'skull', 'Personne blessée': 'ambulance', 'Zone à éviter': 'ban' },
  police: { 'CRS': 'shield', 'Police': 'police', 'BAC': 'car', 'Contrôle d\'identité': 'id-card', 'Nasse': 'fence', 'Fourgons': 'bus' },
};

/** Icône à afficher pour un point (alerte : selon le problème choisi, sinon celle du type). */
export function iconOf(p: Pick<Point, 'type' | 'title'>): string {
  const meta = TYPES[p.type];
  return (meta.alert && ALERT_ICONS[p.type as AlertType]?.[p.title.trim()]) || meta.icon;
}

/**
 * « Toujours là » (alerte ou problème) : possible seulement 15 min après le signalement
 * ou la dernière confirmation, une fois par tranche de 15 min (on ne gonfle pas une alerte à l'infini).
 */
export const CONFIRM_LOCK_MIN = 15;
export const nextConfirmAt = (x: { createdAt: number; confirmedAt?: number | null }) =>
  Math.max(x.createdAt, x.confirmedAt ?? 0) + CONFIRM_LOCK_MIN * 60_000;

/** Problème signalé sur un point existant (sans créer d'alerte séparée). */
export const PROBLEM_DURATIONS = [30, 60, 120, 240] as const;
export const PROBLEM_PRESETS = ['Barricade enlevée', 'Des gens dans le bâtiment', 'Manque de monde', 'Besoin de matériel'];

export interface Person { id: string; name: string }
/** Blocus : `arriveAt` = heure d'arrivée prévue si on ne vient pas dès le RDV (null = au RDV). */
export interface Participant extends Person { arriveAt: number | null }

export interface Problem {
  id: string;
  pointId: string;
  message: string;
  createdBy: string;
  creatorName: string | null;
  createdAt: number;
  expiresAt: number;
  /** Dernier « Toujours là ». */
  confirmedAt: number | null;
}

export const STATUS_LABEL: Record<PointStatus, string> = {
  a_coller: 'À coller',
  colle: 'Collé',
  abime: 'Abîmé / recouvert',
  tenu: 'Tenu',
  vide: 'Sans personne',
  leve: 'Levé',
};

/** États possibles selon le type (tout le monde peut les changer sur le terrain). */
export const STATUSES: Partial<Record<PointType, PointStatus[]>> = {
  panneau: ['a_coller', 'colle', 'abime'],
  blocage: ['tenu', 'vide', 'leve'],
};
export const STATUS_HINT: Partial<Record<PointStatus, string>> = {
  tenu: 'Du monde sur place',
  vide: 'Barricade seule',
  leve: 'Barricade enlevée',
};

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

export const COLOR_CHOICES = [
  '#7B13D6', '#A855F7', '#E5007D', '#F472B6', '#F53B3B', '#8B1E3F', '#FF7A00', '#B45309',
  '#FFC400', '#84CC16', '#00A86B', '#0B6E4F', '#0098B6', '#1F4FD1', '#1E3A8A', '#5B6770',
  '#00232C', '#000000',
];

export interface Point {
  id: string;
  /** Espace auquel appartient le point. */
  space: Space;
  mode: Mode;
  type: PointType;
  title: string;
  description: string | null;
  lat: number;
  lng: number;
  color: string | null;
  photo: string | null;
  startsAt: number | null;
  endsAt: number | null;
  recurrence: Recurrence;
  recurrenceUntil: number | null;
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

export interface Device {
  id: string;
  name: string;
  role: Role;
  /** Espaces auxquels l'appareil a accès. */
  spaces: Space[];
  /** Propriétaire : accès à tout, seul à nommer des admins et à leur donner des espaces. */
  owner: boolean;
  invitedBy: string | null;
  invitedByName: string | null;
  createdAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
  userAgent: string | null;
}

export interface Invite {
  id: string;
  role: Role;
  spaces: Space[];
  label: string | null;
  maxUses: number;
  uses: number;
  expiresAt: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface CreatedInvite {
  invite: Invite;
  url: string;
  qrSvg: string;
}

/** Vote en AG (façon Kahoot : un code à 5 chiffres, un vote par appareil, sur place). */
export interface Vote {
  id: string;
  pointId: string;
  question: string;
  options: string[];
  status: 'open' | 'closed';
  /** Rayon (m) autour de l'AG pour pouvoir voter. */
  radius: number;
  /** Code à 5 chiffres : seulement pour l'organisation, tant que le vote est ouvert. */
  code: string | null;
  total: number;
  /** Résultats par choix : pour l'organisation en direct, pour tous une fois clos. */
  counts: number[] | null;
  /** Mon choix, si j'ai déjà voté. */
  myChoice: number | null;
  createdAt: number;
  closedAt: number | null;
}
/** Archive (côté Mouvement) : document daté, privé (membres) ou public (visible sans compte). */
export interface ArchiveItem {
  id: string;
  kind: 'document' | 'image' | 'mail' | 'note';
  title: string;
  /** Date du document (pas la date d'ajout). */
  date: number;
  body: string | null;
  file: string | null;
  fileName: string | null;
  fileType: string | null;
  visibility: 'private' | 'public';
  /** Masqués dans l'archive publique. */
  createdBy: string | null;
  creatorName: string | null;
  createdAt: number;
}
export const ARCHIVE_KIND_LABEL: Record<ArchiveItem['kind'], string> = { document: 'Document', image: 'Image', mail: 'Copie de mail', note: 'Note' };

/** Registre automatique : événements passés et votes clos (jamais les blocages ni les alertes). */
export type RegistryEntry =
  | { kind: 'event'; id: string; date: number; end: number; title: string; type: string }
  | { kind: 'vote'; id: string; date: number; title: string; ag: string; options: string[]; counts: number[] };

/** AG annoncée publiquement (vue sans compte). */
export interface PublicAg { id: string; title: string; description: string | null; lat: number; lng: number; startsAt: number; endsAt: number }

/** Chat chiffré (côté Mouvement) : le serveur ne transporte que des clés publiques et des messages chiffrés. */
export interface ChatMember { id: string; name: string; publicKey: string }
export interface ChatEpochKey { epochId: number; senderId: string; senderKey: string; recipientKey: string; wrapped: string; iv: string }
export interface ChatMessage { id: string; epochId: number; senderId: string; senderName: string | null; iv: string; ciphertext: string; createdAt: number }

export interface VoteResult { id: string; status: 'open' | 'closed'; question: string; options: string[]; counts: number[] | null }

export const colorOf = (p: Pick<Point, 'type' | 'color'>) => p.color ?? TYPES[p.type].color;

/**
 * Couleurs attribuées automatiquement aux blocus (une différente par blocus en cours),
 * reprises par les blocages qui leur sont rattachés.
 */
export const BLOCUS_COLORS = ['#5C1033', '#0B6E4F', '#1E3A8A', '#B45309', '#7C2D92', '#0E7490', '#9D174D', '#3F6212'];
export const isAlert = (t: PointType) => !!TYPES[t].alert;
