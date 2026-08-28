import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { findPrForBranch } from '../server/jobs.js';

// findPrForBranch needs a real git repo to get past its guards; everything
// about the ACCOUNT WALK is injected, so these never touch GitHub.
let REPO, REPO2;
// A token in the environment changes which account gh would pick, so the walk
// must be exercised without one. CI runners commonly export GITHUB_TOKEN.
const savedEnv = {};
beforeEach(() => {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  for (const set of [0, 1]) {
    const dir = mkdtempSync(join(tmpdir(), 'a007-prlookup-'));
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'x']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'x@x']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'i']);
    if (set === 0) REPO = dir; else REPO2 = dir;
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const PR = { url: 'https://gh/o/r/pull/7', number: 7, isDraft: false };

// Records every attempt so ordering and dedup are observable. `visible` names
// the one account that can see the repo; undefined means nobody can.
function ghFake({ accounts = ['active-acct', 'other-acct'], visible = null, noTokenFor = [] } = {}) {
  const calls = [];
  return {
    calls,
    listAccounts: async () => accounts,
    tokenFor: async (login) => (noTokenFor.includes(login) ? null : `token-for-${login}`),
    prList: async (_repo, _branch, token) => {
      // undefined token = whatever gh is signed in as, i.e. the active account.
      const who = token ? String(token).replace('token-for-', '') : accounts[0];
      calls.push(who);
      // visible: null means no account can see this repo.
      if (who !== visible) {
        return { error: `Could not resolve to a Repository with the name 'org/repo'` };
      }
      return { pr: PR };
    },
  };
}

describe('findPrForBranch across several gh accounts', () => {
  it('uses the signed-in account when it can see the repo', async () => {
    const gh = ghFake({ visible: 'active-acct' });
    const result = await findPrForBranch(REPO, 'feat/x', gh);
    expect(result.pr).toEqual(PR);
    expect(gh.calls).toEqual(['active-acct']);   // active account first, no walk
  });

  it('falls through to another account when the signed-in one cannot see the repo', async () => {
    // The real case: one machine, two accounts, and the repo belongs to an org
    // only the second one is a member of.
    const gh = ghFake({ visible: 'other-acct' });
    const result = await findPrForBranch(REPO, 'feat/x', gh);
    expect(result.pr).toEqual(PR);
    expect(result.error).toBeUndefined();
    expect(gh.calls).toEqual(['active-acct', 'other-acct']);
  });

  it('remembers which account worked, so the next check is one call', async () => {
    const first = ghFake({ visible: 'other-acct' });
    await findPrForBranch(REPO, 'feat/x', first);
    expect(first.calls).toHaveLength(2);

    const second = ghFake({ visible: 'other-acct' });
    await findPrForBranch(REPO, 'feat/x', second);
    expect(second.calls).toEqual(['other-acct']);   // straight to the winner
  });

  it('remembers per repo, not globally', async () => {
    await findPrForBranch(REPO, 'feat/x', ghFake({ visible: 'other-acct' }));
    const fresh = ghFake({ visible: 'active-acct' });
    await findPrForBranch(REPO2, 'feat/x', fresh);
    expect(fresh.calls[0]).toBe('active-acct');
  });

  it('re-walks if the remembered account stops working', async () => {
    await findPrForBranch(REPO, 'feat/x', ghFake({ visible: 'other-acct' }));
    // Access moves to the active account.
    const moved = ghFake({ visible: 'active-acct' });
    const result = await findPrForBranch(REPO, 'feat/x', moved);
    expect(result.pr).toEqual(PR);
    expect(moved.calls).toEqual(['other-acct', 'active-acct']);
  });

  it('reports failure only when EVERY account failed, naming what it tried', async () => {
    const gh = ghFake({ visible: null });
    const result = await findPrForBranch(REPO, 'feat/x', gh);
    expect(result.pr).toBeNull();
    expect(result.error).toMatch(/Could not resolve to a Repository/);
    // Named accounts first, then one last tokenless attempt.
    expect(result.error).toMatch(/tried 3 accounts: active-acct, other-acct, signed-in account/);
    // Named by login, not "signed-in account" — the user needs to know which
    // credentials to fix.
    // Named accounts first, then one last tokenless attempt.
    expect(result.error).toMatch(/tried 3 accounts: active-acct, other-acct, signed-in account/);
  });

  it('never attempts the same NAMED account twice', async () => {
    // The remembered account also appears in the account list; it must not get
    // a second turn on the walk. The final tokenless attempt is deliberately
    // separate — gh may resolve it to an account already tried, which is the
    // accepted cost of also covering env tokens and enterprise hosts.
    await findPrForBranch(REPO, 'feat/x', ghFake({ visible: 'other-acct' }));
    const gh = ghFake({ visible: null });
    await findPrForBranch(REPO, 'feat/x', gh);

    const named = gh.calls.slice(0, -1);   // drop the trailing tokenless attempt
    expect(named).toEqual([...new Set(named)]);
    expect(named).toContain('other-acct');
    expect(named).toContain('active-acct');
  });

  it('skips an account whose token cannot be read', async () => {
    const gh = ghFake({ visible: 'other-acct', noTokenFor: ['other-acct'] });
    const result = await findPrForBranch(REPO, 'feat/x', gh);
    expect(result.pr).toBeNull();
    expect(gh.calls).not.toContain('other-acct');
  });

  it('treats an empty result as no PR yet, not an error, and stops there', async () => {
    const calls = [];
    const result = await findPrForBranch(REPO, 'feat/x', {
      listAccounts: async () => ['a', 'b'],
      tokenFor: async (l) => `token-for-${l}`,
      prList: async (_r, _b, token) => { calls.push(token || 'ambient'); return { pr: null }; },
    });
    expect(result).toEqual({ pr: null });
    expect(result.error).toBeUndefined();
    expect(calls).toEqual(['token-for-a']);   // a successful query ends the walk
  });

  it('does not shell out at all for a path that is not a repo', async () => {
    const calls = [];
    const gh = { listAccounts: async () => ['a'], tokenFor: async () => 't', prList: async () => { calls.push(1); return { pr: PR }; } };
    expect(await findPrForBranch('/no/such/path', 'feat/x', gh)).toEqual({ pr: null });
    expect(await findPrForBranch(REPO, '', gh)).toEqual({ pr: null });
    expect(calls).toHaveLength(0);
  });
});
