/**
 * server/cli-invite.ts — Petit programme en ligne de commande, hors serveur web.
 *
 * À quoi sert-il ? À reprendre la main si l'on a perdu son appareil admin : il crée directement
 * en base une invitation admin valable 1 h, à usage unique, avec accès aux deux espaces, et
 * affiche le lien dans le terminal.
 *
 * Pourquoi c'est sûr ? Il faut pouvoir exécuter une commande SUR LE SERVEUR (accès SSH, etc.) :
 * aucune route HTTP ne permet de faire la même chose.
 *
 * Lancement : `npm run invite-admin -- https://ton-domaine.fr` (= `tsx server/cli-invite.ts …`).
 *
 * Notion : importer './auth' importe aussi './db', donc ouvre la base (même DATA_DIR que le serveur)
 * et vérifie le schéma. Le script peut tourner pendant que le serveur fonctionne.
 */
// Secours : crée une invitation propriétaire à usage unique, accès aux deux espaces
// (si tu as perdu ton appareil). Ne se lance que sur le serveur lui-même.
// Usage : npm run invite-admin -- https://ton-domaine.fr
import { createInvite } from './auth';
import { SPACES } from '../shared/model';

// Adresse du site, dans l'ordre : argument de la commande, sinon variable PUBLIC_URL, sinon
// l'adresse de dev. `.replace(/\/$/, '')` retire un éventuel « / » final (`$` = fin du texte) pour
// éviter un double « // » dans le lien.
const base = (process.argv[2] ?? process.env.PUBLIC_URL ?? 'http://localhost:5180').replace(/\/$/, '');
// label 'bootstrap' + createdBy null : c'est exactement ce que /auth/claim (routes-access.ts)
// reconnaît pour faire de l'appareil le PROPRIÉTAIRE (owner = 1), et pas un simple admin.
// ttlMinutes: 60 = valable une heure ; maxUses: 1 = un seul appareil pourra l'utiliser.
const { token } = createInvite({ role: 'admin', ttlMinutes: 60, maxUses: 1, label: 'bootstrap', createdBy: null, spaces: [...SPACES] });
// Le jeton est dans le fragment (#) de l'URL : il n'est pas envoyé au serveur dans l'adresse.
console.log(`\nInvitation admin (1 h, usage unique) :\n\n  ${base}/#/join/${token}\n`);
