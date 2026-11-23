import { api } from './api';
import { TYPES, colorOf, type Device, type Point, type Space } from '../../shared/model';
import { inkFor } from './ui';

export type View = 'map' | 'agenda' | 'route' | 'archive' | 'team';
export type Group = 'fixe' | 'event' | 'flash' | 'alert';

type Listener = () => void;

const SPACE_KEY = 'terrain:space';

class Store {
  me!: Device;
  /** Espace affiché. On ne garde en mémoire que ses points : l'autre espace n'apparaît nulle part. */
  space: Space = 'lfi';
  points: Point[] = [];
  view: View = 'map';
  filters: Record<Group, boolean> = { fixe: true, event: true, flash: true, alert: true };
  todayOnly = false;
  /** Vue « Blocus » : seulement les blocus et les blocages. */
  blocusOnly = false;
  /** Points sélectionnés pour le trajet de collage. */
  routeSelection = new Set<string>();
  /** Ordre optimisé courant (ids). */
  routeOrder: string[] = [];

  private listeners = new Map<string, Set<Listener>>();

  on(evt: string, fn: Listener) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
    return () => this.listeners.get(evt)!.delete(fn);
  }
  emit(evt: string) {
    this.listeners.get(evt)?.forEach((fn) => fn());
  }

  /** Choisit l'espace au démarrage : le dernier utilisé, s'il est encore autorisé. */
  initSpace() {
    let saved: string | null = null;
    try { saved = localStorage.getItem(SPACE_KEY); } catch { /* ignore */ }
    this.space = this.me.spaces.includes(saved as Space) ? (saved as Space) : this.me.spaces[0] ?? 'lfi';
    document.documentElement.dataset.space = this.space;
    // Couleur de la barre du navigateur : celle de l'espace (l'écran d'accès, lui, reste neutre).
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.space === 'mvt' ? '#1b1b1b' : '#7B13D6');
  }

  /** Changer d'espace : tout l'affichage change (thème, types, onglets), on recharge proprement. */
  switchSpace(s: Space) {
    if (!this.me.spaces.includes(s) || s === this.space) return;
    try { localStorage.setItem(SPACE_KEY, s); } catch { /* ignore */ }
    location.reload();
  }

  async refresh() {
    const { points } = await api.points();
    this.points = points.filter((p) => p.space === this.space);
    const ids = new Set(points.map((p) => p.id));
    for (const id of this.routeSelection) if (!ids.has(id)) this.routeSelection.delete(id);
    this.routeOrder = this.routeOrder.filter((id) => ids.has(id));
    this.emit('points');
  }

  upsert(p: Point) {
    if (p.space !== this.space) return this.remove(p.id);
    const i = this.points.findIndex((x) => x.id === p.id);
    if (i >= 0) this.points[i] = p;
    else this.points.push(p);
    this.emit('points');
  }

  remove(id: string) {
    this.points = this.points.filter((p) => p.id !== id);
    this.routeSelection.delete(id);
    this.routeOrder = this.routeOrder.filter((x) => x !== id);
    this.emit('points');
  }

  get(id: string) {
    return this.points.find((p) => p.id === id);
  }

  setView(v: View) {
    this.view = v;
    this.emit('view');
  }

  canEdit(p: Point) {
    return (this.me.role === 'admin' && this.me.spaces.includes(p.space)) || p.createdBy === this.me.id;
  }
}

export const store = new Store();

/** Couleur d'un point et de son icône. Un blocage rattaché prend la couleur de son blocus. */
export function paintOf(p: Point): { color: string; ink: string } {
  const src = p.type === 'blocage' && p.parentId ? store.points.find((x) => x.id === p.parentId) ?? p : p;
  const color = colorOf(src);
  return { color, ink: src.color ? inkFor(color) : TYPES[src.type].ink };
}
