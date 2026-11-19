import { api } from './api';
import type { Device, Point } from '../../shared/model';

export type View = 'map' | 'agenda' | 'route' | 'team';
export type Group = 'fixe' | 'event' | 'alert';

type Listener = () => void;

class Store {
  me!: Device;
  points: Point[] = [];
  view: View = 'map';
  filters: Record<Group, boolean> = { fixe: true, event: true, alert: true };
  todayOnly = false;
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

  async refresh() {
    const { points } = await api.points();
    this.points = points;
    const ids = new Set(points.map((p) => p.id));
    for (const id of this.routeSelection) if (!ids.has(id)) this.routeSelection.delete(id);
    this.routeOrder = this.routeOrder.filter((id) => ids.has(id));
    this.emit('points');
  }

  upsert(p: Point) {
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
    return this.me.role === 'admin' || p.createdBy === this.me.id;
  }
}

export const store = new Store();
