import type { Point } from './model';

export interface Occurrence {
  point: Point;
  start: number;
  end: number;
}

const MAX_OCCURRENCES = 5000;

function shift(t: number, freq: Point['recurrence'], i: number): number {
  const d = new Date(t);
  if (freq === 'daily') d.setDate(d.getDate() + i);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7 * i);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + i);
  return d.getTime();
}

/** Toutes les occurrences d'un point qui chevauchent [from, to]. */
export function occurrences(p: Point, from: number, to: number): Occurrence[] {
  if (p.startsAt == null || p.endsAt == null) return [];
  const dur = p.endsAt - p.startsAt;
  if (p.recurrence === 'none') {
    return p.endsAt >= from && p.startsAt <= to ? [{ point: p, start: p.startsAt, end: p.endsAt }] : [];
  }
  const until = p.recurrenceUntil ?? Infinity;
  const out: Occurrence[] = [];
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const s = shift(p.startsAt, p.recurrence, i);
    if (s > to || s > until) break;
    if (s + dur >= from) out.push({ point: p, start: s, end: s + dur });
  }
  return out;
}

/** Prochaine occurrence en cours ou à venir. */
export function nextOccurrence(p: Point, now = Date.now()): Occurrence | null {
  return occurrences(p, now, now + 400 * 86400000)[0] ?? null;
}

/** Problèmes encore en cours sur un point (non réglés et non expirés). */
export const liveProblems = (p: Point, now = Date.now()) => (p.problems ?? []).filter((x) => x.expiresAt > now);

/** Le point doit-il encore apparaître sur la carte ? */
export function isActive(p: Point, now = Date.now()): boolean {
  if (p.mode === 'fixe') return true;
  if (p.expiresAt != null && p.expiresAt <= now) return false;
  return nextOccurrence(p, now) != null;
}
