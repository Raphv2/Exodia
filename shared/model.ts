// Modèle partagé entre le serveur et l'interface.

export type Role = 'admin' | 'relais' | 'membre';
export type Mode = 'fixe' | 'event';
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';
export type PanneauStatus = 'a_coller' | 'colle' | 'abime';

export const TYPE_KEYS = [
  'panneau', 'collage', 'ag', 'tractage', 'rassemblement', 'blocage', 'materiel', 'local', 'autre', 'warning', 'danger',
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
  blocage:  { label: 'Blocage', short: 'Blocage', color: '#8B1E3F', ink: '#fff', icon: 'construction', modes: ['event'], allDay: true, placeholder: 'Blocage rond-point nord' },
  materiel: { label: 'Matériel', short: 'Matériel', color: '#0098B6', ink: '#fff', icon: 'package', modes: ['fixe', 'event'], placeholder: 'Matos : colle, tracts, poubelles…' },
  local:    { label: 'Local', short: 'Local', color: '#00232C', ink: '#fff', icon: 'house', modes: ['fixe', 'event'], placeholder: 'Local du groupe' },
  autre:    { label: 'Autre', short: 'Autre', color: '#5B6770', ink: '#fff', icon: 'map-pin', modes: ['fixe', 'event'], placeholder: 'Titre du point' },
  warning:  { label: 'Warning', short: 'Warning', color: '#FFC400', ink: '#00232C', icon: 'triangle-alert', modes: ['event'], alert: true, placeholder: 'Attention' },
  danger:   { label: 'Danger', short: 'Danger', color: '#F53B3B', ink: '#fff', icon: 'siren', modes: ['event'], alert: true, placeholder: 'Danger' },
};

export const ALERT_DURATIONS = [15, 30, 60, 120] as const;

export const ALERT_PRESETS: Record<'warning' | 'danger', string[]> = {
  warning: ['Affiches arrachées', 'Panneau recouvert', 'Zone tendue', 'Passage difficile'],
  danger: ['Agression', 'Groupe hostile', 'Personne blessée', 'Zone à éviter'],
};

/** Problème signalé sur un point existant (sans créer d'alerte séparée). */
export const PROBLEM_DURATIONS = [30, 60, 120, 240] as const;
export const PROBLEM_PRESETS = ['Barricade enlevée', 'Des gens dans le bâtiment', 'Manque de monde', 'Besoin de matériel'];

export interface Problem {
  id: string;
  pointId: string;
  message: string;
  createdBy: string;
  creatorName: string | null;
  createdAt: number;
  expiresAt: number;
}

export const STATUS_LABEL: Record<PanneauStatus, string> = {
  a_coller: 'À coller',
  colle: 'Collé',
  abime: 'Abîmé / recouvert',
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
  '#7B13D6', '#E5007D', '#F53B3B', '#FF7A00', '#FFC400', '#00A86B', '#0098B6', '#00232C',
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
  status: PanneauStatus | null;
  createdBy: string;
  creatorName: string | null;
  createdAt: number;
  updatedAt: number;
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
  /** Pour warning / danger : durée de vie à partir de maintenant. */
  durationMinutes?: number;
  status?: PanneauStatus | null;
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
export const isAlert = (t: PointType) => !!TYPES[t].alert;
