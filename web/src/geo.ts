/*
 * web/src/geo.ts — géolocalisation et distances.
 *
 * À quoi il sert : obtenir la position GPS du téléphone (avec des messages d'erreur clairs),
 * la mémoriser, calculer des distances entre deux points et des temps de marche.
 *
 * Qui l'utilise : la carte (bouton « me localiser »), les formulaires (placer un point ici), le trajet
 * de collage (optimize.ts, route.ts), les votes (vérifier qu'on est près de l'AG), les notifications.
 *
 * Notions :
 * - Latitude / longitude en degrés décimaux (Paris ≈ 48.85, 2.35).
 * - La géolocalisation du navigateur n'est disponible qu'en HTTPS et après accord de l'utilisateur.
 * - `accuracy` = rayon d'incertitude en mètres fourni par le téléphone.
 */
/** Une position : latitude, longitude, et précision (mètres) quand on la connaît. */
export interface Pos {
  lat: number;
  lng: number;
  accuracy?: number;
}

// Dernière position obtenue et le moment où on l'a obtenue (ms). Mémorisées pour éviter de
// redemander le GPS (lent et gourmand en batterie) à chaque fois.
let last: Pos | null = null;
let lastAt = 0;
// Accès en lecture seule à la dernière position (les autres fichiers ne peuvent pas la modifier).
export const lastPosition = () => last;

/** Temps de marche estimé (minutes) : ligne droite × 1,3 pour les rues, à 4,5 km/h. */
// 4,5 km/h = 4500 m par heure ; distance / 4500 = heures ; × 60 = minutes.
export const walkMinutes = (a: Pos, b: Pos) => (distance(a, b) * 1.3) / 4500 * 60;

/**
 * Position pour décider d'une notification, sans jamais déranger :
 * la dernière connue si elle a moins de 5 min, sinon une nouvelle lecture
 * seulement si la localisation est déjà autorisée (pas de demande d'autorisation). Sinon null.
 */
export async function quietPosition(): Promise<Pos | null> {
  // 5 * 60_000 ms = 5 minutes.
  if (last && Date.now() - lastAt < 5 * 60_000) return last;
  try {
    // L'API Permissions permet de savoir si la localisation est autorisée SANS afficher de demande.
    // `?.` : certains navigateurs n'ont pas `navigator.permissions` → perm vaut undefined.
    // `as PermissionName` : contourne une définition TypeScript trop stricte du nom 'geolocation'.
    const perm = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    // Pas autorisé (ou inconnu) : on ne demande rien, on rend la dernière position connue (souvent null).
    if (perm?.state !== 'granted') return last;
    // Autorisé : nouvelle lecture, avec un délai plus court (6 s) car ce n'est pas une action de l'utilisateur.
    return await getPosition(6000);
  } catch {
    return last;
  }
}

/**
 * Demande la position actuelle (peut afficher la demande d'autorisation du navigateur).
 * `timeout` : délai max en ms. Renvoie une promesse de Pos, ou échoue avec un message lisible en français.
 */
export function getPosition(timeout = 10000): Promise<Pos> {
  // L'API du navigateur fonctionne avec deux fonctions de rappel (succès / erreur) ; on l'enveloppe
  // dans une Promise pour pouvoir écrire `await getPosition()`.
  return new Promise((resolve, reject) => {
    // `'geolocation' in navigator` : la fonctionnalité existe-t-elle sur cet appareil ?
    if (!('geolocation' in navigator)) return reject(new Error('Ton appareil ne permet pas la géolocalisation.'));
    // Les navigateurs refusent la géolocalisation hors HTTPS (sauf localhost).
    if (!window.isSecureContext) return reject(new Error('La géolocalisation demande une connexion sécurisée (https).'));
    navigator.geolocation.getCurrentPosition(
      // Succès : on convertit au format Pos, on mémorise, et on répond.
      (p) => {
        last = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
        lastAt = Date.now();
        resolve(last);
      },
      // Échec : on traduit le code d'erreur technique en conseil compréhensible.
      (err) => {
        const msg = err.code === err.PERMISSION_DENIED
          ? 'Autorise la localisation pour cette app dans les réglages du navigateur.'
          : err.code === err.TIMEOUT ? 'Position introuvable (délai dépassé). Réessaie dehors ou place le point à la main.'
          : 'Position indisponible pour le moment.';
        reject(new Error(msg));
      },
      // enableHighAccuracy : utiliser le vrai GPS (plus précis, plus lent) ; maximumAge : le téléphone
      // peut renvoyer une position mise en cache il y a moins de 30 s.
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

// Rayon moyen de la Terre, en mètres.
const R = 6371000;
// Conversion degrés → radians (les fonctions trigonométriques de JavaScript travaillent en radians).
const rad = (d: number) => (d * Math.PI) / 180;

/** Distance à vol d'oiseau en mètres. */
/*
 * Formule de « haversine » : distance la plus courte entre deux points À LA SURFACE d'une sphère
 * (on ne peut pas faire Pythagore sur des degrés : un degré de longitude rétrécit vers les pôles).
 * - dLat, dLng : écarts de latitude et longitude, en radians ;
 * - x : « demi-corde » au carré, combinaison de l'écart nord-sud et de l'écart est-ouest
 *   (ce dernier pondéré par cos(latitude), qui traduit le rétrécissement des longitudes) ;
 * - 2 · R · asin(√x) : transforme cette corde en longueur d'arc sur la Terre.
 * Précision de l'ordre de 0,5 % (la Terre n'est pas une sphère parfaite) : largement suffisant ici.
 */
export function distance(a: Pos, b: Pos) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  // `** 2` = au carré.
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Distance lisible : sous 1 km, arrondie à 10 m (« 340 m ») ; au-delà, en km avec une décimale
// sous 10 km (« 2,4 km ») et sans au-dessus (« 12 km ») ; virgule française au lieu du point.
// Les seuils sont testés sur la valeur ARRONDIE : 995 m donnait « 1000 m » et 9,96 km « 10,0 km ».
export const fmtDistance = (m: number) => {
  const r10 = Math.round(m / 10) * 10;
  if (r10 < 1000) return `${r10} m`;
  const km1 = Math.round(m / 100) / 10;
  return km1 < 10 ? `${km1.toFixed(1).replace('.', ',')} km` : `${Math.round(m / 1000)} km`;
};
