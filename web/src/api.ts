import type { CreatedInvite, Device, Invite, Point, PointInput, Role, Space, Vote, VoteResult, ArchiveItem, RegistryEntry, PublicAg, ChatMember, ChatEpochKey, ChatMessage } from '../../shared/model';

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

  // Chat chiffré de bout en bout (le serveur ne voit que des clés publiques et des messages chiffrés)
  chatKey: (publicKey: unknown) => req('PUT', '/chat/key', { publicKey }),
  chatState: () => req<{ members: ChatMember[]; lastEpoch: { id: number; members: { id: string; key: string }[] } | null; keys: ChatEpochKey[] }>('GET', '/chat/state'),
  chatEpoch: (o: { wraps: { deviceId: string; wrapped: string; iv: string; recipientKey: string }[]; senderKey: string }) => req<{ epochId: number }>('POST', '/chat/epochs', o),
  chatMessages: (before?: number) => req<{ messages: ChatMessage[] }>('GET', `/chat/messages${before ? `?before=${before}` : ''}`),
  chatSend: (o: { epochId: number; iv: string; ciphertext: string }) => req<{ id: string; createdAt: number }>('POST', '/chat/messages', o),
  chatDelete: (id: string) => req('DELETE', `/chat/messages/${id}`),

  // Archive (côté Mouvement)
  archive: () => req<{ items: ArchiveItem[]; registry: RegistryEntry[] }>('GET', '/archive'),
  uploadArchiveFile: (blob: Blob) => req<{ file: string; fileType: string }>('POST', '/archive/files', undefined, blob),
  createArchive: (o: { kind: ArchiveItem['kind']; title: string; date: number; body?: string | null; file?: string | null; fileName?: string | null; visibility: ArchiveItem['visibility'] }) =>
    req<{ item: ArchiveItem }>('POST', '/archive', o),
  updateArchive: (id: string, o: { visibility?: ArchiveItem['visibility']; title?: string }) => req<{ item: ArchiveItem }>('PATCH', `/archive/${id}`, o),
  deleteArchive: (id: string) => req('DELETE', `/archive/${id}`),
  // Sans compte : archive publique et AG annoncées
  publicArchive: () => req<{ items: ArchiveItem[] }>('GET', '/public/archive'),
  publicAgs: () => req<{ ags: PublicAg[] }>('GET', '/public/ags'),

  // Votes en AG
  votes: (pointId: string) => req<{ votes: Vote[]; canRun: boolean }>('GET', `/points/${pointId}/votes`),
  createVote: (pointId: string, question: string, options: string[], radius: number) => req<{ vote: Vote }>('POST', `/points/${pointId}/votes`, { question, options, radius }),
  vote: (id: string) => req<{ vote: Vote }>('GET', `/votes/${id}`),
  closeVote: (id: string) => req<{ vote: Vote }>('POST', `/votes/${id}/close`, {}),
  ballot: (id: string, choice: number, pos: { lat: number; lng: number; accuracy?: number } | null) => req<{ vote: Vote }>('POST', `/votes/${id}/ballot`, { choice, ...(pos ?? {}) }),
  // Vote public (sans l'app)
  lookupVote: (code: string, pos: { lat: number; lng: number; accuracy?: number } | null) => req<{ vote: Vote; agTitle: string }>('POST', '/public/votes/lookup', { code, ...(pos ?? {}) }),
  publicBallot: (code: string, choice: number, pos: { lat: number; lng: number; accuracy?: number } | null) => req<{ vote: Vote }>('POST', '/public/votes/ballot', { code, choice, ...(pos ?? {}) }),
  voteResult: (id: string) => req<{ result: VoteResult }>('GET', `/public/votes/${id}/result`),
  openVotes: () => req<{ votes: { vote: Vote; agTitle: string }[] }>('GET', '/public/votes/open'),
  openBallot: (id: string, choice: number) => req<{ vote: Vote }>('POST', `/public/votes/${id}/open-ballot`, { choice }),

  points: () => req<{ points: Point[] }>('GET', '/points'),
  createPoint: (p: PointInput) => req<{ point: Point }>('POST', '/points', p),
  updatePoint: (id: string, p: PointInput) => req<{ point: Point }>('PUT', `/points/${id}`, p),
  setStatus: (id: string, status: Point['status']) => req<{ point: Point }>('PATCH', `/points/${id}/status`, { status }),
  setParent: (id: string, parentId: string | null) => req<{ point: Point }>('PATCH', `/points/${id}/parent`, { parentId }),
  participate: (id: string, on: boolean, arriveAt: number | null = null) => req<{ point: Point }>('POST', `/points/${id}/participate`, { on, arriveAt }),
  provide: (id: string, item: string, on: boolean) => req<{ point: Point }>('POST', `/points/${id}/provide`, { item, on }),
  extend: (id: string, minutes: number) => req<{ point: Point }>('POST', `/points/${id}/extend`, { minutes }),
  extendFlash: (id: string, minutes: number) => req<{ point: Point }>('POST', `/points/${id}/extend-flash`, { minutes }),
  deletePoint: (id: string) => req('DELETE', `/points/${id}`),
  finish: (id: string) => req<{ point: Point }>('POST', `/points/${id}/finish`, {}),
  reportProblem: (id: string, message: string, durationMinutes: number) =>
    req<{ point: Point }>('POST', `/points/${id}/problems`, { message, durationMinutes }),
  resolveProblem: (problemId: string) => req<{ point: Point }>('POST', `/problems/${problemId}/resolve`, {}),
  extendProblem: (problemId: string, minutes: number) => req<{ point: Point }>('POST', `/problems/${problemId}/extend`, { minutes }),
  uploadPhoto: (blob: Blob) => req<{ photo: string }>('POST', '/photos', undefined, blob),

  createInvite: (o: { role: Role; ttlMinutes: number; maxUses: number; label?: string | null; spaces: Space[] }) => req<CreatedInvite>('POST', '/invites', o),
  invites: () => req<{ invites: Invite[] }>('GET', '/invites'),
  revokeInvite: (id: string) => req('DELETE', `/invites/${id}`),
  devices: () => req<{ devices: (Device & { manageable: boolean })[] }>('GET', '/devices'),
  updateDevice: (id: string, o: { role?: Role; name?: string; spaces?: Space[] }) => req('PATCH', `/devices/${id}`, o),
  revokeDevice: (id: string, cascade: boolean) => req<{ revoked: number }>('DELETE', `/devices/${id}${cascade ? '?cascade=1' : ''}`),
};

export const photoUrl = (name: string) => `/api/photos/${encodeURIComponent(name)}`;
/** Fichier d'archive (public pour tous, privé seulement pour le côté Mouvement : le serveur vérifie). */
export const archiveFileUrl = (name: string) => `/api/public/archive/files/${encodeURIComponent(name)}`;

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
