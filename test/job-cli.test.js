// The `agent-007-job` CLI's parsing layer — what an agent typing the command
// gets back. bin/agent-cli/agent-007-job is a thin shell around these.

import { describe, it, expect } from 'vitest';
import { parseArgs, endpointFromEnv, successLine, USAGE, CLI_NAME } from '../lib/job-cli.js';

describe('parseArgs', () => {
  it('takes a quoted title', () => {
    expect(parseArgs(['Add rate limiting'])).toMatchObject({ title: 'Add rate limiting', detail: null, repo: null });
  });

  it('joins an unquoted title rather than failing on stray words', () => {
    expect(parseArgs(['Add', 'rate', 'limiting']).title).toBe('Add rate limiting');
  });

  it('accepts both --detail x and --detail=x, long and short', () => {
    expect(parseArgs(['t', '--detail', 'body']).detail).toBe('body');
    expect(parseArgs(['t', '--detail=body']).detail).toBe('body');
    expect(parseArgs(['t', '-d', 'body']).detail).toBe('body');
    expect(parseArgs(['t', '--repo=/code/app']).repo).toBe('/code/app');
    expect(parseArgs(['t', '-r', 'app']).repo).toBe('app');
  });

  it('keeps flag values out of the title wherever they appear', () => {
    const parsed = parseArgs(['--repo', 'app', 'Fix', 'the', 'test', '--detail', 'why']);
    expect(parsed.title).toBe('Fix the test');
    expect(parsed.repo).toBe('app');
    expect(parsed.detail).toBe('why');
  });

  it('reports --help before anything else', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['t', '-h'])).toEqual({ help: true });
    expect(USAGE).toContain(CLI_NAME);
  });

  it('refuses a missing title, an unknown option, and a valueless flag', () => {
    expect(parseArgs([]).error).toMatch(/title/i);
    expect(parseArgs(['   ']).error).toMatch(/title/i);
    expect(parseArgs(['t', '--nope']).error).toMatch(/unknown option/i);
    expect(parseArgs(['t', '--nope=1']).error).toMatch(/unknown option/i);
    expect(parseArgs(['t', '--detail']).error).toMatch(/needs a value/i);
  });

  it('does not mistake a negative-looking title word for a flag value', () => {
    // "--" style typos should surface, but a bare dash is a legal title word.
    expect(parseArgs(['Support', '-', 'in', 'paths']).title).toBe('Support - in paths');
  });
});

describe('endpointFromEnv', () => {
  it('builds the jobs URL and carries the session token', () => {
    const e = endpointFromEnv({ AGENT007_URL: 'http://127.0.0.1:7007', AGENT007_TOKEN: 'a007a_x' });
    expect(e.url).toBe('http://127.0.0.1:7007/api/jobs');
    expect(e.token).toBe('a007a_x');
  });

  it('tolerates a trailing slash and a missing token', () => {
    const e = endpointFromEnv({ AGENT007_URL: 'http://127.0.0.1:7007/' });
    expect(e.url).toBe('http://127.0.0.1:7007/api/jobs');
    expect(e.token).toBeNull();
  });

  it('explains itself when run outside an agent terminal', () => {
    expect(endpointFromEnv({}).error).toMatch(/AGENT007_URL/);
  });
});

describe('successLine', () => {
  it('names the job and the repo it landed in', () => {
    const line = successLine({ title: 'Add rate limiting' }, { repoName: 'agent-007', dispatcherRunning: true });
    expect(line).toContain('Add rate limiting');
    expect(line).toContain('agent-007');
    expect(line).toContain('To do');
    expect(line).not.toMatch(/stopped/i);
  });

  it('says so when the board will not act on the card yet', () => {
    // Otherwise the agent reports "queued" and the user believes work started.
    expect(successLine({ title: 't' }, { dispatcherRunning: false })).toMatch(/dispatcher is stopped/i);
    // Unknown (an older server that does not report it) stays quiet.
    expect(successLine({ title: 't' }, {})).not.toMatch(/stopped/i);
  });
});
