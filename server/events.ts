import type { Request, Response } from 'express';

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

export function broadcast(event: string, data: unknown = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.keys()) res.write(payload);
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
