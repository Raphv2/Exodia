/**
 * Tests de bout en bout de l'API : on lance un VRAI serveur sur une base vide (dossier temporaire),
 * puis on l'interroge comme le ferait le navigateur. Couvre les règles de sécurité les plus
 * importantes : propriétaire, espaces étanches, fichiers non réutilisables, votes, limites.
 * Lancement : `npm test`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3290 + Math.floor(Math.random() * 50);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terrain-test-'));
let server: ChildProcess;
let bootstrapToken = '';

/** Un « appareil » de test : garde son cookie comme un navigateur. */
class Device {
  cookie = '';
  async call(method: string, url: string, body?: unknown, raw?: { data: Buffer; type: string }) {
    const res = await fetch(`${BASE}/api${url}`, {
      method,
      headers: {
        'X-Terrain': '1',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: raw ? new Uint8Array(raw.data) : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
    return { status: res.status, data: data as Record<string, any> };
  }
  async join(token: string, name: string) {
    const r = await this.call('POST', '/auth/claim', { token, name });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.device;
  }
}

/** Invitation créée par `by` pour `role` dans `spaces`, renvoie le jeton. */
async function invite(by: Device, role: string, spaces: string[]) {
  const r = await by.call('POST', '/invites', { role, ttlMinutes: 60, maxUses: 5, spaces });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return (r.data.url as string).split('/#/join/')[1];
}

// Une petite image JPEG valide (en-tête FF D8 FF + segment APP1 « Exif » à retirer).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 6, 0x45, 0x78, 0x69, 0x66, 0xff, 0xda, 0, 2, 1, 2, 3, 4, 0xff, 0xd9]);

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, DATA_DIR: dataDir, API_PORT: String(PORT), PUBLIC_URL: 'http://test', TZ: 'Europe/Paris' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Le serveur affiche le lien propriétaire au premier démarrage : on y lit le jeton.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('serveur trop lent')), 20_000);
    server.stdout!.on('data', (b: Buffer) => {
      const m = /#\/join\/([A-Za-z0-9_-]+)/.exec(b.toString());
      if (m) { bootstrapToken = m[1]; clearTimeout(t); resolve(); }
    });
  });
});

after(async () => {
  // On attend que le serveur soit vraiment arrêté (sous Windows, la base reste verrouillée sinon).
  await new Promise<void>((resolve) => { server.once('exit', () => resolve()); server.kill(); });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* dossier temporaire : tant pis */ }
});

const owner = new Device();
const adminLfi = new Device();
const memberMvt = new Device();
const memberMvt2 = new Device();

test('santé et route inconnue', async () => {
  assert.equal((await owner.call('GET', '/health')).status, 200);
  await owner.join(bootstrapToken, 'Propriétaire');
  assert.equal((await owner.call('GET', '/nimporte-quoi')).status, 404);
});

test('le propriétaire ne peut pas se déconnecter', async () => {
  const r = await owner.call('POST', '/auth/logout');
  assert.equal(r.status, 400);
});

test('espaces étanches : un admin Campagne ne voit rien du Mouvement', async () => {
  await adminLfi.join(await invite(owner, 'admin', ['lfi']), 'Admin campagne');
  await memberMvt.join(await invite(owner, 'membre', ['mvt']), 'Militante');
  const blocus = await memberMvt.call('POST', '/points', { mode: 'event', type: 'blocus', title: 'Blocus A', lat: 45.7, lng: 4.8, startsAt: Date.now(), endsAt: Date.now() + 3600_000, space: 'mvt' });
  assert.equal(blocus.status, 201, JSON.stringify(blocus.data));
  const list = await adminLfi.call('GET', '/points');
  assert.ok(!list.data.points.some((p: { id: string }) => p.id === blocus.data.point.id));
  assert.equal((await adminLfi.call('GET', `/points/${blocus.data.point.id}`)).status, 404);
  assert.equal((await adminLfi.call('POST', '/points', { mode: 'fixe', type: 'blocage', title: 'X', lat: 1, lng: 1, space: 'mvt' })).status, 403);
});

test('photo : métadonnées retirées, et impossible de réutiliser celle d\'un autre', async () => {
  await memberMvt2.join(await invite(owner, 'membre', ['mvt']), 'Autre');
  const up = await memberMvt.call('POST', '/photos', undefined, { data: JPEG, type: 'image/jpeg' });
  assert.equal(up.status, 201);
  const name = up.data.photo as string;
  // L'aperçu d'une photo non rattachée : visible par qui l'a envoyée, pas par les autres.
  assert.equal((await memberMvt2.call('GET', `/photos/${name}`)).status, 404);
  // Un autre appareil ne peut pas la rattacher à son point.
  const steal = await memberMvt2.call('POST', '/points', { mode: 'fixe', type: 'local', title: 'Vol', lat: 1, lng: 1, photo: name, space: 'mvt' });
  assert.equal(steal.status, 400);
  const mine = await memberMvt.call('POST', '/points', { mode: 'fixe', type: 'local', title: 'Ok', lat: 1, lng: 1, photo: name, space: 'mvt' });
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  // Le fichier enregistré ne contient plus le segment EXIF.
  const saved = fs.readFileSync(path.join(dataDir, 'uploads', name));
  assert.ok(!saved.includes(Buffer.from('Exif')));
  // Et elle ne peut pas être rattachée une seconde fois, même par son auteur.
  const twice = await memberMvt.call('POST', '/points', { mode: 'fixe', type: 'local', title: 'Bis', lat: 1, lng: 1, photo: name, space: 'mvt' });
  assert.equal(twice.status, 400);
});

test('vote : un seul bulletin, résultat public refusé à qui n\'a pas voté, limite des codes faux', async () => {
  const ag = await owner.call('POST', '/points', { mode: 'event', type: 'ag', title: 'AG interne', lat: 45.75, lng: 4.85, startsAt: Date.now(), endsAt: Date.now() + 3600_000, space: 'mvt' });
  assert.equal(ag.status, 201, JSON.stringify(ag.data));
  const v = await owner.call('POST', `/points/${ag.data.point.id}/votes`, { question: 'On continue ?', options: ['Pour', 'Contre'], radius: 0 });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  const voteId = v.data.vote.id as string;
  assert.equal((await memberMvt.call('POST', `/votes/${voteId}/ballot`, { choice: 0 })).status, 200);
  assert.equal((await memberMvt.call('POST', `/votes/${voteId}/ballot`, { choice: 1 })).status, 409);
  // Quelqu'un sans compte qui n'a pas voté ne voit pas la question d'une AG interne.
  const stranger = new Device();
  assert.equal((await stranger.call('GET', `/public/votes/${voteId}/result`)).status, 404);
  // Codes faux : bloqué après 20 erreurs (429) ; un bon code n'aurait rien consommé.
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await stranger.call('POST', '/public/votes/lookup', { code: String(10000 + i) })).status;
  assert.equal(last, 429);
});

test('le dernier admin ne peut pas perdre son rôle', async () => {
  const devices = await owner.call('GET', '/devices');
  const me = devices.data.devices.find((d: { name: string }) => d.name === 'Propriétaire');
  assert.equal((await owner.call('PATCH', `/devices/${me.id}`, { role: 'membre' })).status, 403);
});
