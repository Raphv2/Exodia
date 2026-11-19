// Modèle partagé entre le serveur et l'interface.

export type Role = 'admin' | 'relais' | 'membre';
export type Mode = 'fixe' | 'event';
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';
export type PanneauStatus = 'a_coller' | 'colle' | 'abime';
export type BlocageStatus = 'tenu' | 'vide' | 'leve';
export type PointStatus = PanneauStatus | BlocageStatus;

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
}

export const TYPES: Record<PointType, TypeMeta> = {
  panneau:  { label: 'Panneau électoral', short: 'Panneau', color: '#7B13D6', ink: '#fff', icon: 'presentation', modes: ['fixe'], routable: true, placeholder: 'Panneau n°12 – école Jean-Jaurès' },
  collage:  { label: 'Point de collage', short: 'Collage', color: '#00A86B', ink: '#fff', icon: 'paint-roller', modes: ['fixe', 'event'], routable: true, placeholder: 'Collage quartier gare' },
  ag:       { label: 'Assemblée générale', short: 'AG', color: '#E5007D', ink: '#fff', icon: 'users', modes: ['event'], placeholder: 'AG du groupe d\'action' },
  tractage: { label: 'Tractage', short: 'Tractage', color: '#FF7A00', ink: '#fff', icon: 'newspaper', modes: ['event'], placeholder: 'Tractage marché du dimanche' },
  rassemblement: { label: 'Rassemblement', short: 'Rassemblement', color: '#1F4FD1', ink: '#fff', icon: 'megaphone', modes: ['event'], placeholder: 'Rassemblement devant la mairie' },
  blocus:   { label: 'Blocus', short: 'Blocus', color: '#5C1033', ink: '#fff', icon: 'flame', modes: ['event'], placeholder: 'Blocus fac – RDV quai 43' },
  blocage:  { label: 'Blocage', short: 'Blocage', color: '#8B1E3F', ink: '#fff', icon: 'construction', modes: ['fixe'], placeholder: 'Bâtiment A – entrée principale' },
  materiel: { label: 'Matériel', short: 'Matériel', color: '#0098B6', ink: '#fff', icon: 'package', modes: ['fixe', 'event'], placeholder: 'Matos : colle, tracts, poubelles…' },
  local:    { label: 'Local', short: 'Local', color: '#00232C', ink: '#fff', icon: 'house', modes: ['fixe', 'event'], placeholder: 'Local du groupe' },
  autre:    { label: 'Autre', short: 'Autre', color: '#5B6770', ink: '#fff', icon: 'map-pin', modes: ['fixe', 'event'], placeholder: 'Titre du point' },
  warning:  { label: 'Warning', short: 'Warning', color: '#FFC400', ink: '#00232C', icon: 'triangle-alert', modes: ['event'], alert: true, placeholder: 'Attention' },
  danger:   { label: 'Danger', short: 'Danger', color: '#F53B3B', ink: '#fff', icon: 'siren', modes: ['event'], alert: true, placeholder: 'Danger' },
  police:   { label: 'Police / CRS', short: 'Police', color: '#1546E0', ink: '#fff', icon: 'police', modes: ['event'], alert: true, placeholder: 'Police' },
};

export const ALERT_DURATIONS = [15, 30, 60, 120] as const;

export type AlertType = 'warning' | 'danger' | 'police';

export const ALERT_PRESETS: Record<AlertType, string[]> = {
  warning: ['Affiches arrachées', 'Panneau recouvert', 'Zone tendue', 'Passage difficile'],
  danger: ['Agression', 'Groupe hostile', 'Personne blessée', 'Zone à éviter'],
  police: ['CRS', 'Police', 'BAC', 'Contrôle d\'identité', 'Nasse', 'Fourgons'],
};

/** Flash : dans combien de temps ça commence (min) et combien de temps ça dure (min). */
export const FLASH_STARTS = [0, 15, 30, 60] as const;
export const FLASH_DURATIONS = [30, 60, 120, 180] as const;

/** Matériel proposé à la création d'un événement (on peut aussi en ajouter à la main). */
export const MATERIAL_PRESETS: Partial<Record<PointType, string[]>> = {
  tractage: ['Tracts', 'Affiches', 'Colle', 'Table', 'Chasubles', 'Mégaphone', 'Flyers'],
  collage: ['Affiches', 'Colle', 'Seaux', 'Balais', 'Gants'],
  rassemblement: ['Banderole', 'Affiches', 'Colle', 'Mégaphone', 'Drapeaux', 'Pancartes', 'Chasubles'],
  blocus: ['Poubelles', 'Palettes', 'Banderole', 'Affiches', 'Colle', 'Mégaphone', 'Scotch'],
  ag: ['Affiches', 'Colle', 'Chaises', 'Vidéoprojecteur', 'Rallonge', 'Paperboard'],
  materiel: ['Affiches', 'Colle', 'Voiture', 'Diable', 'Sacs'],
};
export const MATERIAL_DEFAULT = ['Tracts', 'Banderole', 'Mégaphone', 'Affiches', 'Colle'];

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
  /** Événement : qui a dit venir. */
  participants: Participant[];
  /** Événement : qui fournit quoi (clé = élément de `material`). Fournir n'oblige pas à venir. */
  providers: Record<string, Person[]>;
  /** Problèmes en cours (non réglés, non expirés). */
  problems: Problem[];
}

/** Données envoyées pour créer / modifier un point. */
export interface PointInput {
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
}

export interface Device {
  id: string;
  name: string;
  role: Role;
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

export const colorOf = (p: Pick<Point, 'type' | 'color'>) => p.color ?? TYPES[p.type].color;

/**
 * Couleurs attribuées automatiquement aux blocus (une différente par blocus en cours),
 * reprises par les blocages qui leur sont rattachés.
 */
export const BLOCUS_COLORS = ['#5C1033', '#0B6E4F', '#1E3A8A', '#B45309', '#7C2D92', '#0E7490', '#9D174D', '#3F6212'];
export const isAlert = (t: PointType) => !!TYPES[t].alert;
