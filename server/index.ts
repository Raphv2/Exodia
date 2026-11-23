/**
 * server/index.ts — Point d'entrée du serveur : c'est le fichier que l'on lance.
 *
 * À quoi sert ce fichier ?
 *   - Crée l'application Express et pose les en-têtes de sécurité sur toutes les réponses.
 *   - Monte toutes les routes de l'API sous le préfixe /api, dans un ordre précis (l'ordre compte !).
 *   - En production, sert aussi l'interface web compilée (dossier dist/web).
 *   - Programme les tâches de ménage périodiques.
 *   - Démarre l'écoute réseau et, si besoin, affiche le lien d'invitation du premier admin.
 *
 * Qui l'appelle ?
 *   - `npm start` (= `tsx server/index.ts`) en production.
 *   - `npm run dev` (= `tsx watch server/index.ts --dev` + Vite) en développement. `tsx` exécute
 *     directement le TypeScript, sans étape de compilation.
 *
 * Notions à connaître :
 *   - Express traite chaque requête en la faisant passer dans une CHAÎNE de middlewares, dans
 *     l'ordre où ils ont été déclarés avec `app.use` / `app.get`… Le premier qui répond arrête la chaîne.
 *   - Un `Router` est une mini-application Express qu'on peut brancher sur un préfixe d'URL.
 *   - En développement, deux serveurs tournent : Vite (port 5180, l'interface, avec rechargement à
 *     chaud) et cette API (port 3180). Vite redirige les appels /api vers 3180 (vite.config.ts).
 *     En production, un seul serveur : celui-ci sert à la fois l'API et les fichiers de l'interface.
 *   - Variables d'environnement lues ici : API_PORT, PORT, TRUST_PROXY, PUBLIC_URL, HOST
 *     (et DATA_DIR, lue dans db.ts).
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
// Importer './auth' importe aussi './db' : la base est ouverte et le schéma vérifié dès ici.
import { csrf, ensureBootstrapAdmin, requireDevice } from './auth';
// Chaque fichier routes-*.ts exporte un ou plusieurs Router (et parfois des fonctions de ménage).
import { access } from './routes-access';
import { points, cleanup, releaseBlocages } from './routes-points';
import { votes, publicVotes } from './routes-votes';
import { archive, publicArchive, cleanupArchive } from './routes-archive';
import { chat, cleanupChat } from './routes-chat';
import { stream } from './events';

// Dossier de l'interface compilée par `npm run build` (vite build).
const WEB_DIR = path.resolve('dist/web');
// `process.argv` = la liste des arguments de la ligne de commande ; `--dev` est passé par `npm run dev`.
const DEV = process.argv.includes('--dev');
// On ne sert l'interface que hors mode dev ET si le build existe (index.html présent).
const hasBuild = !DEV && fs.existsSync(path.join(WEB_DIR, 'index.html'));
// En production (interface compilée), on suit la variable PORT standard des hébergeurs.
// En développement, Vite occupe PORT : l'API écoute sur API_PORT (3180 par défaut).
// Lecture de la chaîne de `??` (on prend la première valeur qui n'est pas null/undefined) :
//   1. API_PORT si elle est définie ;
//   2. sinon PORT, mais seulement si on sert le build (sinon `undefined`, on passe au suivant) ;
//   3. sinon 3180.
// `Number(...)` convertit le texte de la variable d'environnement en nombre.
const PORT = Number(process.env.API_PORT ?? (hasBuild ? process.env.PORT : undefined) ?? 3180);

const app = express();
// Retire l'en-tête « X-Powered-By: Express » : inutile de dire aux curieux quel logiciel tourne.
app.disable('x-powered-by');
// Derrière un reverse-proxy HTTPS (Caddy, Nginx, Render…) : TRUST_PROXY=1
// « trust proxy » dit à Express de croire les en-têtes X-Forwarded-* posés par le proxy : req.ip
// devient la vraie IP du visiteur (indispensable pour rateLimit) et req.secure reflète le HTTPS.
// `Number(...) || valeur` : si TRUST_PROXY est un nombre (ex. 1 = « un proxy devant moi »), on le
// passe en nombre ; sinon (ex. 'loopback' ou une IP), Number donne NaN (faux) et on garde le texte.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// Middleware global : en-têtes de sécurité ajoutés à TOUTES les réponses (API et fichiers).
// `_req` : le `_` signale un paramètre volontairement inutilisé.
app.use((_req, res, next) => {
  res.set({
    // Interdit au navigateur de « deviner » le type d'un fichier (ex. exécuter une image comme script).
    'X-Content-Type-Options': 'nosniff',
    // Quand on suit un lien externe, n'envoyer que l'origine (https://domaine) et jamais le chemin.
    'Referrer-Policy': 'strict-origin',
    // Interdit d'afficher le site dans une <iframe> d'un autre site (anti « clickjacking »).
    'X-Frame-Options': 'DENY',
    // Fonctions sensibles du navigateur : géolocalisation et caméra autorisées pour notre site
    // seulement (`self`), micro interdit à tout le monde (`()` = liste vide).
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
    // Content-Security-Policy (CSP) : liste blanche de ce que la page a le droit de charger.
    // C'est la principale défense contre l'injection de script (XSS). Le tableau est joint par '; '.
    'Content-Security-Policy': [
      // Par défaut, uniquement depuis notre propre origine.
      "default-src 'self'",
      // Scripts : seulement nos fichiers (pas de script inline, pas de CDN).
      "script-src 'self'",
      // Styles : nos fichiers + les attributs style="" (nécessaires à Leaflet, qui positionne en inline).
      "style-src 'self' 'unsafe-inline'",
      // Images : nos fichiers, les images encodées (data:), les aperçus locaux (blob:, ex. photo
      // avant envoi) et les tuiles de carte OpenStreetMap.
      "img-src 'self' data: blob: https://tile.openstreetmap.org",
      "font-src 'self' data:",
      // Fond de carte vectoriel OpenFreeMap (tuiles, style, polices des noms de rues).
      // connect-src = adresses joignables par fetch / XMLHttpRequest / EventSource.
      "connect-src 'self' https://tiles.openfreemap.org",
      // MapLibre calcule la carte dans un « worker » servi par l'app elle-même.
      "worker-src 'self' blob:",
      // Équivalent moderne de X-Frame-Options: DENY.
      "frame-ancestors 'none'",
      // Interdit la balise <base>, qui permettrait de détourner les liens relatifs.
      "base-uri 'none'",
      // Les formulaires ne peuvent être envoyés que vers notre site.
      "form-action 'self'",
    ].join('; '),
  });
  next();
});

// Routeur de l'API. Tout ce qui est déclaré dessus sera accessible sous /api (voir app.use plus bas).
const api = express.Router();
// Lit le corps des requêtes JSON et le place dans `req.body`. Limite à 100 Ko : au-delà, Express
// refuse (erreur 413) — protège contre l'envoi d'énormes requêtes. (Les photos passent par
// d'autres routes, qui lisent le corps elles-mêmes.)
api.use(express.json({ limit: '100kb' }));
// Vérifie l'en-tête X-Terrain sur toute requête qui modifie quelque chose (voir auth.ts).
api.use(csrf);
// Routes d'accès : /auth/claim (rejoindre), /me, /invites, /devices… Elles sont montées SANS
// requireDevice global car /auth/claim doit marcher avant d'avoir un cookie ; chaque route
// privée de ce routeur ajoute elle-même requireDevice.
api.use(access);
// Accès public (sans l'app) : uniquement le vote avec un code, sur place.
api.use('/public', publicVotes);
// Sans compte : l'archive publique et les AG annoncées publiquement (rien d'autre).
api.use('/public', publicArchive);
// Flux temps réel : réservé aux appareils connectés.
api.get('/stream', requireDevice, stream);
// Toutes les autres routes exigent un appareil. `api.use(requireDevice, points)` = pour chaque
// requête qui arrive ici, d'abord requireDevice, puis le routeur `points`.
// Conséquence : une URL inconnue sous /api (sans cookie) reçoit un 401 plutôt qu'un 404.
api.use(requireDevice, points);
api.use(requireDevice, votes);
api.use(requireDevice, archive);
api.use(requireDevice, chat);
// Gestionnaire d'erreurs : Express le reconnaît parce qu'il a QUATRE paramètres (err en premier).
// Il reçoit toute exception levée dans une route (ex. le `throw e` après ROLLBACK).
// L'erreur détaillée est écrite dans la console du serveur, mais le client ne reçoit qu'un message
// générique (on ne divulgue pas de détails internes). Si l'erreur porte un code HTTP (`status`,
// ex. 413 posé par express.json), on le réutilise ; sinon 500.
// `(err as { status?: number })` : on dit à TypeScript que l'erreur PEUT avoir un champ status.
api.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status((err as { status?: number }).status ?? 500).json({ error: 'Erreur serveur' });
});
// Branche tout le routeur sous /api : la route '/me' du routeur devient '/api/me'.
app.use('/api', api);

// Production uniquement : servir l'interface web compilée.
if (hasBuild) {
  // express.static sert les fichiers du dossier tels quels.
  //   - index: false : ne pas servir index.html automatiquement pour '/' (géré par le app.get('*') plus bas).
  //   - maxAge '7d' : le navigateur peut garder les fichiers 7 jours en cache. C'est sans risque car
  //     Vite met une empreinte dans le nom des fichiers JS/CSS (ils changent de nom à chaque build).
  //   - setHeaders : exception pour .html et .webmanifest, dont le nom ne change pas : 'no-cache'
  //     oblige le navigateur à revérifier, pour récupérer la nouvelle version après une mise à jour.
  app.use(express.static(WEB_DIR, { index: false, maxAge: '7d', setHeaders: (res, file) => {
    if (file.endsWith('.html') || file.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache');
  } }));
  // « Fallback » d'application monopage (SPA) : toute autre URL renvoie index.html, et c'est le code
  // client qui affiche le bon écran (les routes du client sont après le #, ex. /#/join/…).
  app.get('*', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(WEB_DIR, 'index.html')));
}

// Ménage au démarrage : supprime alertes expirées, photos orphelines, vieux messages, etc.
cleanup();
cleanupArchive();
cleanupChat();
// Puis toutes les heures (3600_000 ms). `.unref()` : ces minuteurs n'empêchent pas Node de quitter.
setInterval(() => { cleanup(); cleanupArchive(); cleanupChat(); }, 3600_000).unref();
// Toutes les minutes : les blocages « tenus » d'un blocus terminé passent à « sans personne ».
setInterval(releaseBlocages, 60_000).unref();

// HOST=127.0.0.1 en production : seul le reverse proxy (Caddy) peut joindre l'app.
// onListen est appelée une fois que le serveur écoute réellement sur le port.
const onListen = () => {
  // Adresse publique utilisée pour fabriquer le lien d'invitation affiché dans la console.
  // En dev, on pointe vers Vite (5180) car c'est lui qui sert l'interface.
  const base = process.env.PUBLIC_URL ?? (hasBuild ? `http://localhost:${PORT}` : 'http://localhost:5180');
  console.log(`Terrain API sur http://localhost:${PORT}${hasBuild ? '' : '  (interface : npm run dev → http://localhost:5180)'}`);
  // Sur une base sans admin : affiche le lien d'invitation du tout premier appareil (auth.ts).
  ensureBootstrapAdmin(base);
};
// Sans HOST, Node écoute sur toutes les interfaces réseau (accessible depuis l'extérieur).
if (process.env.HOST) app.listen(PORT, process.env.HOST, onListen);
else app.listen(PORT, onListen);
