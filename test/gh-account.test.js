// Which gh account a spawned agent gets for its repo (server/jobs.js,
// ghAccountFor / ghAgentEnv). No real gh: every collaborator is a stub.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { parseGithubRemote, ghAccountFor, ghAgentEnv, ghEnvForRepo } from '../server/jobs.js';

let n = 0;
// A fresh repo path per call: the per-repo memory is module state.
function setup({ remote = 'git@github.com:bill10/agent-007.git', accounts = ['bill-slung', 'bill10'], sees = {} } = {}) {
  const repo = `/repos/r${++n}`;
  const visible = vi.fn(async (slug, token) => (sees[token] || []).includes(slug));
  const opts = {
    remoteUrl: async () => remote,
    listAccounts: vi.fn(async () => accounts),
    tokenFor: async (login) => `tok-${login}`,
    visible,
  };
  return { repo, opts, visible };
}

describe('parseGithubRemote', () => {
  it('reads owner/name from https and ssh remotes, and nothing else', () => {
    expect(parseGithubRemote('https://github.com/Slung-AI-code/milo.git')).toEqual({ owner: 'Slung-AI-code', name: 'milo' });
    expect(parseGithubRemote('git@github.com:bill10/agent-007.git\n')).toEqual({ owner: 'bill10', name: 'agent-007' });
    expect(parseGithubRemote('https://gitlab.com/a/b.git')).toBeNull();
    expect(parseGithubRemote(null)).toBeNull();
  });
});

describe('ghAccountFor', () => {
  it('picks the account named like the repo owner, without probing', async () => {
    const { repo, opts, visible } = setup();
    expect(await ghAccountFor(repo, opts)).toEqual({ login: 'bill10', token: 'tok-bill10' });
    expect(visible).not.toHaveBeenCalled();
  });

  it('otherwise the first account that can see the repo', async () => {
    const { repo, opts } = setup({ remote: 'https://github.com/Slung-AI-code/milo', sees: { 'tok-bill-slung': ['Slung-AI-code/milo'] } });
    expect((await ghAccountFor(repo, opts)).login).toBe('bill-slung');
  });

  it('is null when no account can see it, or the repo is not on github.com', async () => {
    const unseen = setup({ remote: 'https://github.com/x/y' });
    expect(await ghAccountFor(unseen.repo, unseen.opts)).toBeNull();
    const local = setup({ remote: null });
    expect(await ghAccountFor(local.repo, local.opts)).toBeNull();
    expect(local.opts.listAccounts).not.toHaveBeenCalled();
  });

  it('remembers the answer per repo, re-checking it with one probe', async () => {
    const sees = { 'tok-bill-slung': ['Slung-AI-code/milo'] };
    const { repo, opts, visible } = setup({ remote: 'https://github.com/Slung-AI-code/milo', sees });
    await ghAccountFor(repo, opts);
    opts.listAccounts.mockClear(); visible.mockClear();
    expect((await ghAccountFor(repo, opts)).login).toBe('bill-slung');
    expect(opts.listAccounts).not.toHaveBeenCalled();
    expect(visible).toHaveBeenCalledTimes(1);
  });

  it('chooses again when the remembered account gets a 404', async () => {
    const sees = { 'tok-bill-slung': ['Slung-AI-code/milo'] };
    const { repo, opts } = setup({ remote: 'https://github.com/Slung-AI-code/milo', accounts: ['bill-slung', 'bill10', 'other'], sees });
    await ghAccountFor(repo, opts);
    sees['tok-bill-slung'] = [];
    sees['tok-other'] = ['Slung-AI-code/milo'];
    expect((await ghAccountFor(repo, opts)).login).toBe('other');
  });
});

describe('ghAgentEnv', () => {
  it('sets GH_TOKEN and points git at gh for github.com credentials', () => {
    const env = ghAgentEnv('tok', {});
    expect(env).toEqual({
      GH_TOKEN: 'tok', GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    });
  });

  it("appends after the owner's own GIT_CONFIG_* entries", () => {
    const env = ghAgentEnv('tok', { GIT_CONFIG_COUNT: '1' });
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env).not.toHaveProperty('GIT_CONFIG_KEY_0');
  });

  it('is empty without a token, so the agent keeps whatever gh is signed in as', async () => {
    expect(ghAgentEnv(null)).toEqual({});
    const { repo, opts } = setup({ remote: 'https://github.com/x/y' });
    expect(await ghEnvForRepo(repo, opts)).toEqual({});
    expect(await ghEnvForRepo(repo, { ...opts, remoteUrl: async () => { throw new Error('boom'); } })).toEqual({});
  });

  it('never runs gh auth switch or writes hosts.yml', () => {
    const src = readFileSync('server/jobs.js', 'utf8');
    expect(src).not.toMatch(/'auth',\s*'(switch|login|logout)'/);
    expect(src).not.toMatch(/hosts\.yml['"`]/);
  });
});
