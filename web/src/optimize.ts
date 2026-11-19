import { distance, type Pos } from './geo';

/**
 * Ordre de visite le plus court possible (problème du voyageur de commerce) :
 * plus proche voisin, puis amélioration 2-opt. Largement suffisant jusqu'à quelques centaines de points.
 *
 * @returns l'ordre des indices de `pts`.
 */
export function optimizeOrder(pts: Pos[], start: Pos | null, loop: boolean): number[] {
  if (pts.length <= 1) return pts.map((_, i) => i);
  const nodes = start ? [start, ...pts] : pts.slice();
  const n = nodes.length;
  const D: Float64Array[] = nodes.map((a) => Float64Array.from(nodes, (b) => distance(a, b)));

  // Point de départ : la position donnée, sinon le point le plus excentré (on part d'un bout).
  let first = 0;
  if (!start) {
    const c = { lat: avg(pts.map((p) => p.lat)), lng: avg(pts.map((p) => p.lng)) };
    let best = -1;
    pts.forEach((p, i) => { const d = distance(c, p); if (d > best) { best = d; first = i; } });
  }

  // Plus proche voisin.
  const tour = [first];
  const used = new Uint8Array(n);
  used[first] = 1;
  for (let step = 1; step < n; step++) {
    const last = tour[tour.length - 1];
    let next = -1, bd = Infinity;
    for (let j = 0; j < n; j++) if (!used[j] && D[last][j] < bd) { bd = D[last][j]; next = j; }
    tour.push(next);
    used[next] = 1;
  }

  // 2-opt : on inverse des segments tant que ça raccourcit.
  const fixedFirst = !!start || loop;
  let improved = true;
  for (let iter = 0; improved && iter < 200; iter++) {
    improved = false;
    for (let i = fixedFirst ? 1 : 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const a = i > 0 ? tour[i - 1] : -1;
        const b = tour[i];
        const c = tour[k];
        const d = k < n - 1 ? tour[k + 1] : loop ? tour[0] : -1;
        const before = (a >= 0 ? D[a][b] : 0) + (d >= 0 ? D[c][d] : 0);
        const after = (a >= 0 ? D[a][c] : 0) + (d >= 0 ? D[b][d] : 0);
        if (after + 1e-6 < before) {
          reverse(tour, i, k);
          improved = true;
        }
      }
    }
  }

  return start ? tour.filter((x) => x !== 0).map((x) => x - 1) : tour;
}

function reverse(a: number[], i: number, k: number) {
  while (i < k) { [a[i], a[k]] = [a[k], a[i]]; i++; k--; }
}

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function pathLength(path: Pos[], loop: boolean) {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += distance(path[i - 1], path[i]);
  if (loop && path.length > 2) m += distance(path[path.length - 1], path[0]);
  return m;
}
