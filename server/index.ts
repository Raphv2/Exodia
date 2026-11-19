import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { csrf, ensureBootstrapAdmin, requireDevice } from './auth';
import { access } from './routes-access';
import { points, cleanup } from './routes-points';
import { stream } from './events';

const WEB_DIR = path.resolve('dist/web');
const DEV = process.argv.includes('--dev');
const hasBuild = !DEV && fs.existsSync(path.join(WEB_DIR, 'index.html'));
// En production (interface compilée), on suit la variable PORT standard des hébergeurs.
// En développement, Vite occupe PORT : l'API écoute sur API_PORT (3180 par défaut).
const PORT = Number(process.env.API_PORT ?? (hasBuild ? process.env.PORT : undefined) ?? 3180);

const app = express();
app.disable('x-powered-by');
// Derrière un reverse-proxy HTTPS (Caddy, Nginx, Render…) : TRUST_PROXY=1
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://tile.openstreetmap.org",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
});

const api = express.Router();
api.use(express.json({ limit: '100kb' }));
api.use(csrf);
api.use(access);
api.get('/stream', requireDevice, stream);
api.use(requireDevice, points);
api.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status((err as { status?: number }).status ?? 500).json({ error: 'Erreur serveur' });
});
app.use('/api', api);

if (hasBuild) {
  app.use(express.static(WEB_DIR, { index: false, maxAge: '7d', setHeaders: (res, file) => {
    if (file.endsWith('.html') || file.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache');
  } }));
  app.get('*', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(WEB_DIR, 'index.html')));
}

cleanup();
setInterval(cleanup, 3600_000).unref();

// HOST=127.0.0.1 en production : seul le reverse proxy (Caddy) peut joindre l'app.
const onListen = () => {
  const base = process.env.PUBLIC_URL ?? (hasBuild ? `http://localhost:${PORT}` : 'http://localhost:5180');
  console.log(`Terrain API sur http://localhost:${PORT}${hasBuild ? '' : '  (interface : npm run dev → http://localhost:5180)'}`);
  ensureBootstrapAdmin(base);
};
if (process.env.HOST) app.listen(PORT, process.env.HOST, onListen);
else app.listen(PORT, onListen);
