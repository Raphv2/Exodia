/*
 * web/src/store.ts — l'état global de l'application côté navigateur (le « store »).
 *
 * À quoi il sert : garder en mémoire, à un seul endroit, tout ce que plusieurs écrans partagent :
 * l'appareil connecté, l'espace affiché, les points de la carte, les filtres, la vue courante,
 * la sélection du trajet… Un seul objet `store` existe pour toute l'appli (on l'importe partout).
 *
 * Petit système d'événements (motif « publier / s'abonner ») :
 * - un écran s'abonne : `store.on('points', render)` → « appelle render quand les points changent » ;
 * - quand quelque chose change, on prévient : `store.emit('points')` → tous les abonnés sont appelés.
 * Les écrans n'ont donc pas besoin de se connaître entre eux : ils écoutent juste le store.
 * Événements utilisés dans l'appli : 'points', 'view', 'filters', 'route', 'open-votes', 'votes',
 * 'archive', 'chat', 'me' (ce sont de simples chaînes, rien ne vérifie l'orthographe).
 *
 * Qui l'utilise : main.ts (démarrage, temps réel), map.ts, agenda.ts, route.ts, detail.ts, forms.ts…
 */
import { api } from './api';
// `type Device` dans les accolades : import de type seulement (effacé à la compilation).
import { TYPES, colorOf, type Device, type Point, type Space, type Vote } from '../../shared/model';
import { inkFor } from './ui';

// Les différents écrans (onglets) de l'appli.
export type View = 'map' | 'agenda' | 'route' | 'archive' | 'chat' | 'team';
// Les familles de points qu'on peut masquer/afficher avec les filtres de la carte.
export type Group = 'fixe' | 'event' | 'flash' | 'alert';

// Un abonné : une fonction sans paramètre et sans valeur de retour.
type Listener = () => void;

// Clé sous laquelle on mémorise, dans le navigateur (localStorage), le dernier espace utilisé.
const SPACE_KEY = 'terrain:space';

/*
 * La classe Store. On n'en crée qu'UNE instance (`store`, en bas du fichier) : c'est un « singleton ».
 * Les champs ci-dessous sont publics : n'importe quel module peut les lire ET les modifier directement,
 * mais doit alors penser à appeler `emit(...)` pour prévenir les écrans.
 */
class Store {
  // `!` (« assertion d'affectation définie ») : on promet à TypeScript que `me` sera rempli avant
  // usage (main.ts le fait juste après l'appel à /api/me), même s'il n'a pas de valeur initiale.
  me!: Device;
  /** Espace affiché. On ne garde en mémoire que ses points : l'autre espace n'apparaît nulle part. */
  space: Space = 'lfi';
  // Points de l'espace courant (déjà filtrés).
  points: Point[] = [];
  /** Votes ouverts (côté Mouvement) : bandeau de l'Agenda et badge sur l'épingle de l'AG. */
  // Tableau d'objets anonymes : le vote, le titre de son AG, et si je peux le piloter (clore, voir le code).
  openVotes: { vote: Vote; agTitle: string; canRun: boolean }[] = [];
  // Écran affiché.
  view: View = 'map';
  // Filtres de la carte : pour chaque famille, affichée (true) ou masquée (false).
  filters: Record<Group, boolean> = { fixe: true, event: true, flash: true, alert: true };
  // Ne montrer que les événements du jour.
  todayOnly = false;
  /** Vue « Blocus » : seulement les blocus et les blocages. */
  blocusOnly = false;
  /** Points sélectionnés pour le trajet de collage. */
  // Un Set (ensemble) plutôt qu'un tableau : pas de doublons, et test « est-il sélectionné ? » instantané.
  routeSelection = new Set<string>();
  /** Ordre optimisé courant (ids). */
  routeOrder: string[] = [];

  // Les abonnés, rangés par nom d'événement : 'points' → {fonction1, fonction2…}.
  // `private` : seul le code de la classe y a accès.
  private listeners = new Map<string, Set<Listener>>();

  /**
   * S'abonner à un événement. Renvoie une fonction de désabonnement : on l'appelle quand l'écran
   * est fermé, pour ne pas garder un abonné « fantôme » (voir votes.ts : `const off = store.on(...)`).
   */
  on(evt: string, fn: Listener) {
    // Première fois qu'on entend parler de cet événement : on crée son ensemble d'abonnés.
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    // `!` : on sait que l'entrée existe (créée juste au-dessus).
    this.listeners.get(evt)!.add(fn);
    return () => this.listeners.get(evt)!.delete(fn);
  }
  /** Prévenir tous les abonnés d'un événement. `?.` : s'il n'y a aucun abonné, on ne fait rien. */
  emit(evt: string) {
    this.listeners.get(evt)?.forEach((fn) => fn());
  }

  /** Choisit l'espace au démarrage : le dernier utilisé, s'il est encore autorisé. */
  initSpace() {
    let saved: string | null = null;
    // localStorage peut lever une erreur (navigation privée, stockage bloqué) : on l'ignore.
    try { saved = localStorage.getItem(SPACE_KEY); } catch { /* ignore */ }
    // Si l'espace mémorisé fait partie de mes droits on le reprend, sinon mon premier espace,
    // et en tout dernier recours 'lfi'. `as Space` : on « force » le type, vérifié par `includes`.
    this.space = this.me.spaces.includes(saved as Space) ? (saved as Space) : this.me.spaces[0] ?? 'lfi';
    // Pose `data-space="lfi"` ou `"mvt"` sur la balise <html> : le CSS s'en sert pour changer tout le thème.
    document.documentElement.dataset.space = this.space;
    // Couleur de la barre du navigateur : celle de l'espace (l'écran d'accès, lui, reste neutre).
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.space === 'mvt' ? '#1b1b1b' : '#7B13D6');
  }

  /** Changer d'espace : tout l'affichage change (thème, types, onglets), on recharge proprement. */
  switchSpace(s: Space) {
    // Espace interdit ou déjà affiché : rien à faire.
    if (!this.me.spaces.includes(s) || s === this.space) return;
    try { localStorage.setItem(SPACE_KEY, s); } catch { /* ignore */ }
    // Recharger la page entière est le moyen le plus sûr de ne rien garder de l'ancien espace.
    location.reload();
  }

  /** Recharge les votes ouverts (seulement côté Mouvement, le seul où l'on vote). */
  async refreshVotes() {
    if (this.space !== 'mvt') { this.openVotes = []; return; }
    try {
      // On ne garde que les votes dont l'AG fait partie des points que je vois.
      this.openVotes = (await api.openAppVotes()).votes.filter((x) => this.points.some((p) => p.id === x.vote.pointId));
    } catch { /* on garde la liste précédente */ }
    this.emit('open-votes');
  }

  /** AG qui ont au moins un vote ouvert. */
  // `get` : « accesseur » ; on l'utilise comme un champ (`store.votingAgs`), mais il est recalculé à chaque lecture.
  get votingAgs(): Set<string> {
    return new Set(this.openVotes.map((x) => x.vote.pointId));
  }

  /** Recharge tous les points depuis le serveur et nettoie la sélection du trajet. */
  async refresh() {
    // Déstructuration : on récupère directement le champ `points` de la réponse { points: [...] }.
    const { points } = await api.points();
    this.points = points.filter((p) => p.space === this.space);
    // Ensemble des ids encore existants, pour retirer du trajet les points supprimés entre-temps.
    const ids = new Set(points.map((p) => p.id));
    for (const id of this.routeSelection) if (!ids.has(id)) this.routeSelection.delete(id);
    this.routeOrder = this.routeOrder.filter((id) => ids.has(id));
    this.emit('points');
  }

  /** « Upsert » = update + insert : remplace le point s'il existe déjà, sinon l'ajoute. */
  upsert(p: Point) {
    // Un point qui n'est pas (ou plus) dans mon espace : on le retire de la mémoire.
    if (p.space !== this.space) return this.remove(p.id);
    // findIndex renvoie -1 si aucun point n'a cet id.
    const i = this.points.findIndex((x) => x.id === p.id);
    if (i >= 0) this.points[i] = p;
    else this.points.push(p);
    this.emit('points');
  }

  /** Retire un point de la mémoire (et du trajet). */
  remove(id: string) {
    this.points = this.points.filter((p) => p.id !== id);
    this.routeSelection.delete(id);
    this.routeOrder = this.routeOrder.filter((x) => x !== id);
    this.emit('points');
  }

  /** Trouve un point par son id (undefined s'il n'est pas chargé). */
  get(id: string) {
    return this.points.find((p) => p.id === id);
  }

  /** Change d'écran et prévient les abonnés à 'view'. */
  setView(v: View) {
    this.view = v;
    this.emit('view');
  }

  /**
   * Puis-je modifier ce point ? Oui si je suis admin de son espace, ou si c'est moi qui l'ai créé.
   * (Simple confort d'affichage : le serveur refait la vérification de son côté.)
   */
  canEdit(p: Point) {
    return (this.me.role === 'admin' && this.me.spaces.includes(p.space)) || p.createdBy === this.me.id;
  }
}

// L'unique instance partagée par toute l'application.
export const store = new Store();

/** Couleur principale de l'espace en cours (violet LFI, rouge Mouvement). */
export const spaceColor = () => (store.space === 'mvt' ? '#a30006' : '#7B13D6');

/** Couleur d'un point et de son icône. Un blocage rattaché prend la couleur de son blocus. */
export function paintOf(p: Point): { color: string; ink: string } {
  // `src` = le point dont on prend la couleur : le blocus parent pour un blocage rattaché
  // (s'il est bien chargé, sinon `?? p` revient au point lui-même), le point dans tous les autres cas.
  const src = p.type === 'blocage' && p.parentId ? store.points.find((x) => x.id === p.parentId) ?? p : p;
  const color = colorOf(src);
  // Couleur choisie à la main → on calcule si le texte doit être clair ou foncé (inkFor) ;
  // couleur du type → on prend l'encre prévue dans TYPES.
  return { color, ink: src.color ? inkFor(color) : TYPES[src.type].ink };
}
