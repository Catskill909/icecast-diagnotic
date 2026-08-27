#!/usr/bin/env node
/**
 * Generates an ADMIN_PASSWORD_HASH for the hosting panel.
 *
 *   node scripts/hash-password.js 'my secret'
 *   node scripts/hash-password.js            (prompts, so it stays out of shell history)
 *
 * Storing the hash rather than the password means anyone who reads the env var
 * — on a screenshare, in a support ticket, via `docker inspect` — learns nothing
 * usable, and a password reused elsewhere is not burned along with it.
 */
const { hashPassword } = require('../auth');

function emit(password) {
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  console.log('\nAdd this to your hosting panel environment:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}\n`);
  console.log('Then remove ADMIN_PASSWORD if it is set.\n');
}

const fromArgs = process.argv.slice(2).join(' ').trim();
if (fromArgs) { emit(fromArgs); process.exit(0); }

process.stdout.write('Password: ');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => emit(buf.trim()));
