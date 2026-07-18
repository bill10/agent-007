#!/usr/bin/env node
// adduser — create an Agent 007 user and print a one-time login token.
//
// Usage: npm run adduser -- "Display Name"
//
// Writes ~/.agent-007/users.json (override with AGENT007_USERS_PATH). The token
// is shown ONCE and only its hash is stored — if it's lost, re-run to mint a new
// one. Creating the first user switches the server into authenticated mode.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  USERS_PATH, USER_COLORS, hashToken, generateToken, newUserId,
} from '../server/auth.js';

const displayName = process.argv.slice(2).join(' ').trim();
if (!displayName) {
  console.error('Usage: npm run adduser -- "Display Name"');
  process.exit(1);
}

let users = [];
if (existsSync(USERS_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(USERS_PATH, 'utf8'));
    users = Array.isArray(raw) ? raw : (Array.isArray(raw.users) ? raw.users : []);
  } catch (err) {
    console.error(`Cannot read ${USERS_PATH}: ${err.message}`);
    process.exit(1);
  }
}

if (users.some(u => u.displayName === displayName)) {
  console.error(`A user named "${displayName}" already exists. Pick another name or remove it first.`);
  process.exit(1);
}

const token = generateToken();
const user = {
  id: newUserId(),
  displayName,
  color: USER_COLORS[users.length % USER_COLORS.length],
  tokenHash: hashToken(token),
  createdAt: new Date().toISOString(),
};
users.push(user);

try {
  mkdirSync(dirname(USERS_PATH), { recursive: true });
  writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
} catch (err) {
  console.error(`Cannot write ${USERS_PATH}: ${err.message}`);
  process.exit(1);
}

const first = users.length === 1;
console.log(`\n  Created user "${displayName}" (${user.id}, ${user.color})`);
console.log(`\n  Login token (shown once — copy it now):\n`);
console.log(`      ${token}\n`);
console.log('  Log in by opening the app and pasting the token, or visit:');
console.log(`      http://localhost:${process.env.PORT || 7007}/?token=${token}\n`);
if (first) {
  console.log('  This is the first user — the server now REQUIRES login.');
  console.log('  Restart is not required (users are re-read live), but open sessions');
  console.log('  already connected stay connected until they reconnect.\n');
}
