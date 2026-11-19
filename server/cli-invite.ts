// Secours : crée une invitation admin à usage unique (si tu as perdu ton appareil admin).
// Usage : npm run invite-admin -- https://ton-domaine.fr
import { createInvite } from './auth';

const base = (process.argv[2] ?? process.env.PUBLIC_URL ?? 'http://localhost:5180').replace(/\/$/, '');
const { token } = createInvite({ role: 'admin', ttlMinutes: 60, maxUses: 1, label: 'secours CLI', createdBy: null });
console.log(`\nInvitation admin (1 h, usage unique) :\n\n  ${base}/#/join/${token}\n`);
