import { describe, it, expect } from 'vitest';
import { gitEnv, GIT_SAFE_ARGS } from '../server/git.js';
import { SERVER_ONLY_ENV } from '../lib/helpers.js';

describe('server git exec', () => {
  it('strips server-only env and disables repo hooks/fsmonitor', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'secret';
    expect(SERVER_ONLY_ENV).toContain('TELEGRAM_BOT_TOKEN');
    expect(gitEnv().TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(gitEnv().GIT_TERMINAL_PROMPT).toBe('0');
    expect(GIT_SAFE_ARGS.join(' ')).toMatch(/core\.hooksPath=\S+ -c core\.fsmonitor=false/);
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
});
