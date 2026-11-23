/*
 * shared/time.ts — calculs de dates des événements (répétitions, « est-ce encore actif ? »).
 *
 * Partagé entre le serveur (server/routes-points.ts, pour savoir si un blocus est fini) et le client
 * (agenda, carte, fiches) : les deux doivent faire EXACTEMENT le même calcul.
 *
 * Notions :
 * - Un événement répété n'est stocké qu'une fois (dates de la 1re occurrence + règle de répétition) ;
 *   les occurrences suivantes sont recalculées à la volée par `occurrences`.
 * - Les calculs utilisent `Date` en heure LOCALE de la machine qui exécute le code (téléphone ou serveur).
 * - Toutes les dates sont des nombres de millisecondes (timestamps).
 */
// `import type` : on n'importe qu'un type, rien n'est chargé à l'exécution.
import type { Point } from './model';

/** Une occurrence concrète d'un événement : le point, et le début/fin de CETTE séance-là. */
export interface Occurrence {
  point: Point;
  start: number;
  end: number;
}

// Garde-fou : jamais plus de 5000 occurrences calculées (évite une boucle quasi infinie).
const MAX_OCCURRENCES = 5000;

/**
 * Décale la date `t` de `i` périodes selon la fréquence.
 * On passe par un objet `Date` et ses méthodes setDate/setMonth plutôt que d'ajouter des millisecondes :
 * ainsi « chaque jour à 18 h » reste à 18 h même lors du passage heure d'été / heure d'hiver
 * (un jour ne fait pas toujours 24 h). `setDate(31 + 1)` gère tout seul le passage au mois suivant.
 */
// `Point['recurrence']` = le type du champ recurrence de Point ('none' | 'daily' | …).
function shift(t: number, freq: Point['recurrence'], i: number): number {
  const d = new Date(t);
  if (freq === 'daily') d.setDate(d.getDate() + i);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7 * i);
  else if (freq === 'monthly') {
    // Mensuel : même jour du mois, mais ramené au dernier jour si le mois est plus court.
    // Sans ça, « le 31 de chaque mois » donnait le 3 mars après le 31 janvier (Date « déborde »).
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + i);
    // new Date(année, mois + 1, 0) = le dernier jour du mois (le « jour 0 » du mois suivant).
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  // 'none' : aucun décalage, on renvoie la date telle quelle.
  return d.getTime();
}

/** Toutes les occurrences d'un point qui chevauchent [from, to]. */
// Entrées : le point, et une fenêtre de temps [from, to] en ms. Sortie : la liste des séances qui
// touchent cette fenêtre (même partiellement), dans l'ordre chronologique.
export function occurrences(p: Point, from: number, to: number): Occurrence[] {
  // Un point sans dates (lieu fixe) n'a pas d'occurrences. `== null` attrape null ET undefined.
  if (p.startsAt == null || p.endsAt == null) return [];
  // Durée d'une séance, identique pour toutes les répétitions.
  const dur = p.endsAt - p.startsAt;
  if (p.recurrence === 'none') {
    // Deux intervalles se chevauchent si chacun commence avant la fin de l'autre.
    return p.endsAt >= from && p.startsAt <= to ? [{ point: p, start: p.startsAt, end: p.endsAt }] : [];
  }
  // Pas de date de fin de répétition → Infinity (aucune limite).
  const until = p.recurrenceUntil ?? Infinity;
  const out: Occurrence[] = [];
  // On saute directement près de la fenêtre au lieu de repartir de la 1re occurrence (avant : un
  // événement quotidien créé il y a deux ans recalculait ~700 dates à chaque affichage).
  const i0 = firstIndex(p.startsAt, p.recurrence, from - dur);
  for (let i = i0; i < i0 + MAX_OCCURRENCES; i++) {
    const s = shift(p.startsAt, p.recurrence, i);
    // Les occurrences sont croissantes : dès qu'on dépasse la fenêtre ou la fin de répétition, on arrête.
    if (s > to || s > until) break;
    // On ne garde que celles qui ne sont pas déjà finies avant le début de la fenêtre.
    if (s + dur >= from) out.push({ point: p, start: s, end: s + dur });
  }
  return out;
}

/**
 * Indice approximatif de la première occurrence qui peut commencer après `t`, un peu sous-estimé
 * (marge de 2 périodes pour les changements d'heure et les mois de longueurs différentes). La boucle
 * de `occurrences` repart de là et vérifie elle-même chaque date : l'estimation n'a pas besoin
 * d'être exacte, seulement de ne jamais dépasser la bonne valeur.
 */
function firstIndex(start: number, freq: Point['recurrence'], t: number): number {
  if (t <= start) return 0;
  if (freq === 'daily') return Math.max(0, Math.floor((t - start) / 86_400_000) - 2);
  if (freq === 'weekly') return Math.max(0, Math.floor((t - start) / (7 * 86_400_000)) - 2);
  if (freq === 'monthly') {
    const a = new Date(start), b = new Date(t);
    return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - 2);
  }
  return 0;
}

/** Prochaine occurrence en cours ou à venir. */
// On cherche dans les 400 prochains jours (86 400 000 ms = 24 h), un peu plus d'un an pour couvrir
// une répétition mensuelle. `[0]` = la première trouvée ; `?? null` si la liste est vide.
// `now = Date.now()` : paramètre par défaut, modifiable pour les tests ou pour un calcul « à telle date ».
export function nextOccurrence(p: Point, now = Date.now()): Occurrence | null {
  return occurrences(p, now, now + 400 * 86400000)[0] ?? null;
}

/** Problèmes encore en cours sur un point (non réglés et non expirés). */
// `p.problems ?? []` : protège contre un point ancien/incomplet sans liste de problèmes.
export const liveProblems = (p: Point, now = Date.now()) => (p.problems ?? []).filter((x) => x.expiresAt > now);

/** Le point doit-il encore apparaître sur la carte ? */
export function isActive(p: Point, now = Date.now()): boolean {
  // Un lieu fixe (panneau, local, blocage…) reste toujours affiché.
  if (p.mode === 'fixe') return true;
  // Un événement expiré (alerte périmée, événement terminé à la main…) disparaît.
  if (p.expiresAt != null && p.expiresAt <= now) return false;
  // Sinon, il est actif s'il a une séance en cours ou à venir.
  return nextOccurrence(p, now) != null;
}
