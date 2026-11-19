export interface Pos {
  lat: number;
  lng: number;
  accuracy?: number;
}

let last: Pos | null = null;
export const lastPosition = () => last;

export function getPosition(timeout = 10000): Promise<Pos> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Ton appareil ne permet pas la géolocalisation.'));
    if (!window.isSecureContext) return reject(new Error('La géolocalisation demande une connexion sécurisée (https).'));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        last = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
        resolve(last);
      },
      (err) => {
        const msg = err.code === err.PERMISSION_DENIED
          ? 'Autorise la localisation pour cette app dans les réglages du navigateur.'
          : err.code === err.TIMEOUT ? 'Position introuvable (délai dépassé). Réessaie dehors ou place le point à la main.'
          : 'Position indisponible pour le moment.';
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distance à vol d'oiseau en mètres. */
export function distance(a: Pos, b: Pos) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const fmtDistance = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`);
