import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, rmSync } from 'fs';

// USERS points at the hermetic per-file path from test/setup.js.
const USERS = process.env.AGENT007_USERS_PATH;

function run(args, expectOk = true) {
  try {
    const out = execFileSync('node', ['bin/adduser.js', ...args], {
      env: { ...process.env, AGENT007_USERS_PATH: USERS }, encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    if (expectOk) throw e;
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const users = () => JSON.parse(readFileSync(USERS, 'utf8'));

describe('adduser CLI', () => {
  afterEach(() => { try { rmSync(USERS, { force: true }); } catch {} });

  it('rejects an empty name', () => {
    const r = run([''], false);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Usage/);
  });

  it('creates the first user and warns login is now required', () => {
    const r = run(['Alice']);
    expect(r.out).toMatch(/first user/i);
    const u = users();
    expect(u).toHaveLength(1);
    expect(u[0].displayName).toBe('Alice');
    expect(u[0].color).toBe('#d4a847');   // USER_COLORS[0]
    expect(u[0].tokenHash).toHaveLength(64);
  });

  it('appends a second user with the next color and no first-user notice', () => {
    run(['Alice']);
    const r = run(['Bob']);
    expect(r.out).not.toMatch(/first user/i);
    const u = users();
    expect(u).toHaveLength(2);
    expect(u[1].color).toBe('#58a6ff');   // USER_COLORS[1]
  });

  it('rejects a duplicate display name without appending', () => {
    run(['Alice']);
    const r = run(['Alice'], false);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/already exists/);
    expect(users()).toHaveLength(1);
  });

  it('exits with an error when users.json is corrupt', () => {
    writeFileSync(USERS, '{ not json');
    const r = run(['Alice'], false);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Cannot read/);
  });
});
