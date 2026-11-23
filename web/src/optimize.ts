/*
 * web/src/optimize.ts — calcul du meilleur ordre de passage pour un trajet de collage.
 *
 * Utilisé par route.ts : l'utilisateur sélectionne des panneaux / points de collage, et on lui
 * propose l'ordre de visite qui minimise la distance totale à parcourir.
 *
 * Notions :
 * - C'est le « problème du voyageur de commerce » : trouver l'ordre PARFAIT est extrêmement long
 *   dès qu'il y a beaucoup de points (le nombre d'ordres possibles explose). On utilise donc deux
 *   méthodes approchées, rapides et qui donnent un très bon résultat en pratique :
 *   1. « plus proche voisin » : depuis le point courant, aller toujours au point non visité le plus proche ;
 *   2. « 2-opt » : regarder chaque paire de segments du trajet et, si les « décroiser » (inverser
 *      le morceau entre les deux) raccourcit le trajet, le faire ; recommencer tant qu'on gagne.
 * - Les distances sont à vol d'oiseau (geo.ts), pas le long des rues.
 */
import { distance, type Pos } from './geo';

/**
 * Ordre de visite le plus court possible (problème du voyageur de commerce) :
 * plus proche voisin, puis amélioration 2-opt. Largement suffisant jusqu'à quelques centaines de points.
 *
 * @returns l'ordre des indices de `pts`.
 */
// Entrées : `pts` les points à visiter ; `start` la position de départ (ma position) ou null ;
// `loop` true si on doit revenir au point de départ (boucle). Sortie : ex. [2, 0, 1] = visiter
// pts[2], puis pts[0], puis pts[1]. Le point `start` n'apparaît jamais dans le résultat.
export function optimizeOrder(pts: Pos[], start: Pos | null, loop: boolean): number[] {
  // 0 ou 1 point : rien à optimiser. `(_, i) => i` : on ignore l'élément (`_`) et on garde son indice.
  if (pts.length <= 1) return pts.map((_, i) => i);
  // Liste de travail : si on a un départ, on le met en tête (indice 0) et les points sont décalés de 1.
  // `pts.slice()` : copie du tableau (on ne modifie jamais celui de l'appelant).
  const nodes = start ? [start, ...pts] : pts.slice();
  const n = nodes.length;
  // Matrice des distances, calculée une seule fois : D[i][j] = distance entre nodes[i] et nodes[j].
  // Float64Array : tableau de nombres à virgule, plus compact et plus rapide qu'un tableau ordinaire.
  // `Float64Array.from(nodes, fn)` construit une ligne en appliquant fn à chaque élément.
  const D: Float64Array[] = nodes.map((a) => Float64Array.from(nodes, (b) => distance(a, b)));

  // Point de départ : la position donnée, sinon le point le plus excentré (on part d'un bout).
  // (Avec un départ donné, `first` reste 0 : c'est l'indice de `start` dans `nodes`.)
  let first = 0;
  if (!start) {
    // Centre géographique approximatif : moyenne des latitudes et des longitudes.
    const c = { lat: avg(pts.map((p) => p.lat)), lng: avg(pts.map((p) => p.lng)) };
    let best = -1;
    // On garde l'indice du point le plus éloigné du centre.
    pts.forEach((p, i) => { const d = distance(c, p); if (d > best) { best = d; first = i; } });
  }

  // Plus proche voisin.
  // `tour` : l'ordre en construction (indices dans `nodes`).
  const tour = [first];
  // `used[j] = 1` si le point j est déjà dans le tour. Uint8Array : tableau d'octets initialisé à 0.
  const used = new Uint8Array(n);
  used[first] = 1;
  // À chaque étape, on ajoute un point : il en faut n - 1 de plus.
  for (let step = 1; step < n; step++) {
    const last = tour[tour.length - 1];
    // `next` : meilleur candidat trouvé ; `bd` : sa distance (« best distance »), Infinity au départ.
    let next = -1, bd = Infinity;
    for (let j = 0; j < n; j++) if (!used[j] && D[last][j] < bd) { bd = D[last][j]; next = j; }
    tour.push(next);
    used[next] = 1;
  }

  // 2-opt : on inverse des segments tant que ça raccourcit.
  // Le premier point est-il imposé ? Oui si on part de ma position, ou si c'est une boucle
  // (dans une boucle, le point de départ n'a pas d'importance : autant le garder fixe).
  const fixedFirst = !!start || loop;
  let improved = true;
  // Garde-fou : au plus 200 passes complètes, même si on trouve encore des améliorations.
  for (let iter = 0; improved && iter < 200; iter++) {
    improved = false;
    // On essaie d'inverser chaque morceau tour[i..k].
    for (let i = fixedFirst ? 1 : 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        /*
         * Avant inversion, le trajet contient les liaisons a→b (entrée du morceau) et c→d (sortie) :
         *   … a → [b … c] → d …
         * Après inversion du morceau, il devient :
         *   … a → [c … b] → d …
         * Seules ces deux liaisons changent (l'intérieur du morceau est le même, parcouru à l'envers) ;
         * il suffit donc de comparer a→b + c→d avec a→c + b→d.
         * `-1` = « pas de voisin » : début du trajet (i = 0) ou fin d'un trajet ouvert ;
         * dans une boucle, le voisin après le dernier point est le premier (`tour[0]`).
         */
        const a = i > 0 ? tour[i - 1] : -1;
        const b = tour[i];
        const c = tour[k];
        const d = k < n - 1 ? tour[k + 1] : loop ? tour[0] : -1;
        const before = (a >= 0 ? D[a][b] : 0) + (d >= 0 ? D[c][d] : 0);
        const after = (a >= 0 ? D[a][c] : 0) + (d >= 0 ? D[b][d] : 0);
        // `1e-6` (un millionième de mètre) : marge pour ignorer les gains infimes dus aux arrondis
        // des nombres à virgule, qui feraient tourner la boucle pour rien.
        if (after + 1e-6 < before) {
          reverse(tour, i, k);
          improved = true;
        }
      }
    }
  }

  // Avec un départ, on retire l'indice 0 (le départ lui-même) et on enlève 1 aux autres pour
  // revenir aux indices de `pts`. Sans départ, les indices de `nodes` sont déjà ceux de `pts`.
  return start ? tour.filter((x) => x !== 0).map((x) => x - 1) : tour;
}

/** Inverse sur place la portion a[i..k] (bornes incluses), en échangeant les extrémités vers le centre. */
function reverse(a: number[], i: number, k: number) {
  // `[x, y] = [y, x]` : échange de deux valeurs par déstructuration.
  while (i < k) { [a[i], a[k]] = [a[k], a[i]]; i++; k--; }
}

// Moyenne d'une liste de nombres (`reduce` fait la somme, en partant de 0).
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Longueur totale (m, à vol d'oiseau) d'un trajet qui passe par `path` dans l'ordre ; + le retour au début si `loop`. */
export function pathLength(path: Pos[], loop: boolean) {
  let m = 0;
  // Somme des distances entre chaque point et le précédent.
  for (let i = 1; i < path.length; i++) m += distance(path[i - 1], path[i]);
  // Retour au départ (seulement à partir de 3 points : avec 2, ce serait compter l'aller deux fois).
  if (loop && path.length > 2) m += distance(path[path.length - 1], path[0]);
  return m;
}
