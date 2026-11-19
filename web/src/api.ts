import type { CreatedInvite, Device, Invite, Point, PointInput, Role } from '../../shared/model';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function req<T>(method: string, url: string, body?: unknown, raw?: Blob): Promise<T> {
  const headers: Record<string, string> = { 'X-Terrain': '1' };
  let payload: BodyInit | undefined;
  if (raw) {
    headers['Content-Type'] = raw.type;
    payload = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${url}`, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Pas de connexion. Vérifie ton réseau.');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (!res.ok) {
    if (res.status === 401 && url !== '/me') onUnauthorized();
    throw new ApiError(res.status, data.error ?? `Erreur ${res.status}`);
  }
  return data as T;
}

export const api = {
  me: () => req<{ device: Device }>('GET', '/me'),
  rename: (name: string) => req('PATCH', '/me', { name }),
  claim: (token: string, name: string) => req<{ device: Device }>('POST', '/auth/claim', { token, name }),
  logout: () => req('POST', '/auth/logout', {}),

  points: () => req<{ points: Point[] }>('GET', '/points'),
  createPoint: (p: PointInput) => req<{ point: Point }>('POST', '/points', p),
  updatePoint: (id: string, p: PointInput) => req<{ point: Point }>('PUT', `/points/${id}`, p),
  setStatus: (id: string, status: Point['status']) => req<{ point: Point }>('PATCH', `/points/${id}/status`, { status }),
  setParent: (id: string, parentId: string | null) => req<{ point: Point }>('PATCH', `/points/${id}/parent`, { parentId }),
  participate: (id: string, on: boolean) => req<{ point: Point }>('POST', `/points/${id}/participate`, { on }),
  provide: (id: string, item: string, on: boolean) => req<{ point: Point }>('POST', `/points/${id}/provide`, { item, on }),
  extend: (id: string, minutes: number) => req<{ point: Point }>('POST', `/points/${id}/extend`, { minutes }),
  deletePoint: (id: string) => req('DELETE', `/points/${id}`),
  finish: (id: string) => req<{ point: Point }>('POST', `/points/${id}/finish`, {}),
  reportProblem: (id: string, message: string, durationMinutes: number) =>
    req<{ point: Point }>('POST', `/points/${id}/problems`, { message, durationMinutes }),
  resolveProblem: (problemId: string) => req<{ point: Point }>('POST', `/problems/${problemId}/resolve`, {}),
  extendProblem: (problemId: string, minutes: number) => req<{ point: Point }>('POST', `/problems/${problemId}/extend`, { minutes }),
  uploadPhoto: (blob: Blob) => req<{ photo: string }>('POST', '/photos', undefined, blob),

  createInvite: (o: { role: Role; ttlMinutes: number; maxUses: number; label?: string | null }) => req<CreatedInvite>('POST', '/invites', o),
  invites: () => req<{ invites: Invite[] }>('GET', '/invites'),
  revokeInvite: (id: string) => req('DELETE', `/invites/${id}`),
  devices: () => req<{ devices: Device[] }>('GET', '/devices'),
  updateDevice: (id: string, o: { role?: Role; name?: string }) => req('PATCH', `/devices/${id}`, o),
  revokeDevice: (id: string, cascade: boolean) => req<{ revoked: number }>('DELETE', `/devices/${id}${cascade ? '?cascade=1' : ''}`),
};

export const photoUrl = (name: string) => `/api/photos/${encodeURIComponent(name)}`;

/** Redimensionne et ré-encode en JPEG (retire aussi les données EXIF, dont la position GPS). */
export async function compressImage(file: File, max = 1600, quality = 0.82): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions).catch(() => null);
  const src: CanvasImageSource & { width: number; height: number } = bmp ?? (await loadImg(file));
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale);
  canvas.height = Math.round(src.height * scale);
  canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image illisible'))), 'image/jpeg', quality));
}

function loadImg(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = URL.createObjectURL(file);
  });
}
