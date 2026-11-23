/**
 * Tests unitaires (sans serveur) : calcul des répétitions et nettoyage des métadonnées.
 * Lancement : `npm test` (lanceur intégré à Node, `node --test`, aucune dépendance en plus).
 * `assert.equal(a, b)` échoue si a !== b ; `test(nom, fn)` déclare un test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences } from '../shared/time';
import { stripJpeg, stripPng, scrubPdf } from '../server/sanitize';
import type { Point } from '../shared/model';

/** Un événement minimal pour les tests (seuls les champs utiles aux dates comptent). */
const ev = (startsAt: number, endsAt: number, recurrence: Point['recurrence']): Point =>
  ({ id: 'x', mode: 'event', type: 'ag', title: 't', startsAt, endsAt, recurrence, recurrenceUntil: null, expiresAt: null } as unknown as Point);

test('répétition mensuelle : le 31 janvier donne le dernier jour de février, puis le 31 mars', () => {
  const s = new Date(2027, 0, 31, 18, 0).getTime();
  const occ = occurrences(ev(s, s + 3600_000, 'monthly'), s, new Date(2027, 3, 1).getTime());
  assert.deepEqual(occ.map((o) => new Date(o.start).getDate()), [31, 28, 31]);
});

test('répétition quotidienne : même heure locale de part et d\'autre du changement d\'heure', () => {
  const s = new Date(2027, 2, 26, 18, 0).getTime(); // le passage à l'heure d'été est le 28 mars 2027
  const occ = occurrences(ev(s, s + 3600_000, 'daily'), s, new Date(2027, 2, 31).getTime());
  assert.ok(occ.length >= 4);
  for (const o of occ) assert.equal(new Date(o.start).getHours(), 18);
});

test('saut direct vers la fenêtre : même résultat qu\'en partant du début', () => {
  const s = new Date(2025, 0, 1, 9, 0).getTime();
  const from = new Date(2027, 5, 10).getTime();
  const to = new Date(2027, 5, 20).getTime();
  const occ = occurrences(ev(s, s + 7200_000, 'daily'), from, to);
  assert.equal(occ.length, 10);
  assert.equal(new Date(occ[0].start).getDate(), 10);
});

test('JPEG : les segments EXIF (APP1) et commentaires sont retirés, l\'image reste', () => {
  const seg = (m: number, body: number[]) => [0xff, m, 0, body.length + 2, ...body];
  const jpg = Buffer.from([0xff, 0xd8, ...seg(0xe0, [1, 2]), ...seg(0xe1, [9, 9, 9]), ...seg(0xfe, [7]), 0xff, 0xda, 0, 2, 5, 5, 0xff, 0xd9]);
  const out = stripJpeg(jpg);
  assert.ok(!out.includes(Buffer.from([0xff, 0xe1])));
  assert.ok(!out.includes(Buffer.from([0xff, 0xfe])));
  assert.ok(out.includes(Buffer.from([0xff, 0xe0])));
  assert.ok(out.subarray(-4).equals(Buffer.from([5, 5, 0xff, 0xd9])));
});

test('PNG : les chunks de texte sont retirés', () => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Author\0Moi')), chunk('IEND', Buffer.alloc(0))]);
  const out = stripPng(png);
  assert.ok(!out.includes(Buffer.from('tEXt')));
  assert.ok(out.includes(Buffer.from('IHDR')) && out.includes(Buffer.from('IEND')));
});

test('PDF : auteur et logiciel effacés, taille identique (positions internes intactes)', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Author (Jean Dupont) /Producer (Word) /Title (Tract) >> endobj\n', 'latin1');
  const out = scrubPdf(pdf);
  assert.equal(out.length, pdf.length);
  const s = out.toString('latin1');
  assert.ok(!s.includes('Jean Dupont') && !s.includes('Word'));
  assert.ok(s.includes('/Title (Tract)'));
});
