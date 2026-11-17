// Adds a dashboard login, or changes its password, from the VPS command line:
//   sudo -u deploy env DATA_DIR=/var/lib/kt-dashboard node /opt/kt-dashboard/server/add-user.js you@example.com
// Remove one with --remove.
'use strict';
const crypto = require('node:crypto');
const readline = require('node:readline');
const store = require('./store');

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Usage: add-user.js <email> [--remove]'); process.exit(1); }

if (process.argv.includes('--remove')) {
  store.write('users', store.read('users', []).filter((u) => u.email !== email));
  console.log('Removed', email);
  process.exit(0);
}

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const pw = process.env.KT_PASSWORD || await ask('Password (min 10 characters): ');
  if (pw.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
  if (!process.env.KT_PASSWORD && (await ask('Repeat password: ')) !== pw) { console.error('Passwords do not match.'); process.exit(1); }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
  const users = store.read('users', []).filter((u) => u.email !== email);
  users.push({ email, hash });
  store.write('users', users);
  console.log('Saved login for', email);
})();
