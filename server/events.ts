import type { Request, Response } from 'express';
import { db } from './db';
import { parseSpaces } from './auth';

/** Diffusion temps réel (Server-Sent Events) : prévient les appareils qu'un point a changé. */
const clients = new Map<Response, string>();

export function stream(req: Request, res: Response) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  clients.set(res, req.device!.id);
  req.on('close', () => clients.delete(res));
}

const spacesOfDevice = db.prepare('SELECT spaces FROM devices WHERE id = ? AND revoked_at IS NULL');

/**
 * Diffuse un événement. Avec `space`, seuls les appareils qui ont accès à cet espace le reçoivent :
 * rien ne fuit d'un espace à l'autre, pas même un titre dans une notification.
 */
export function broadcast(event: string, data: Record<string, unknown> = {}, space?: string) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(space ? { ...data, space } : data)}\n\n`;
  for (const [res, deviceId] of clients) {
    if (space) {
      const row = spacesOfDevice.get(deviceId) as { spaces: string } | undefined;
      if (!row || !parseSpaces(row.spaces).includes(space as never)) continue;
    }
    res.write(payload);
  }
}

/** Coupe le flux des appareils révoqués. */
export function disconnect(deviceIds: string[]) {
  for (const [res, id] of clients) {
    if (deviceIds.includes(id)) {
      res.write('event: revoked\ndata: {}\n\n');
      res.end();
      clients.delete(res);
    }
  }
}

setInterval(() => {
  for (const res of clients.keys()) res.write(': ping\n\n');
}, 25_000).unref();
