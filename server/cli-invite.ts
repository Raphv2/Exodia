// Secours : crée une invitation propriétaire à usage unique, accès aux deux espaces
// (si tu as perdu ton appareil). Ne se lance que sur le serveur lui-même.
// Usage : npm run invite-admin -- https://ton-domaine.fr
import { createInvite } from './auth';
import { SPACES } from '../shared/model';

const base = (process.argv[2] ?? process.env.PUBLIC_URL ?? 'http://localhost:5180').replace(/\/$/, '');
const { token } = createInvite({ role: 'admin', ttlMinutes: 60, maxUses: 1, label: 'bootstrap', createdBy: null, spaces: [...SPACES] });
console.log(`\nInvitation admin (1 h, usage unique) :\n\n  ${base}/#/join/${token}\n`);
