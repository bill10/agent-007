// Which CLI a card is dispatched on: claude (the default) or codex. The value
// reaches the spawned argv, so it is allowlisted like the permission mode; a
// card an agent posts defaults to the poster's own CLI; and Codex, having no
// --permission-mode, gets the board's mode folded into its one flag.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, chmodSync, readdirSync, readFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config, sessions } from '../server/state.js';
import { addJob, updateJob, updateSettings, boardSettings, allJobs, postJobForAgent, dispatchOnce, listJobsForAgent, resumeCommandForOrphan, orphanResumePlan } from '../server/jobs.js';
import { parseCommand } from '../lib/helpers.js';
import { createJob, buildJobCommand, buildJobPrompt, jobAgentFromCommand, jobAgent, resumeCommand, sessionAgentFromCommand, permissionFlagsFromCommand, normalizePermissionFlags, JOB_AGENTS, PERMISSION_MODES, CODEX_MODE_FLAGS, PERMISSION_FLAGS } from '../lib/jobs.js';
import { execSync } from 'child_process';
import { agentFromTranscripts } from '../server/agent-transcripts.js';

const REPO = mkdtempSync(join(tmpdir(), 'a007-jobagent-'));
const noop = () => {};

function resetBoard() {
  config.repos = [{ path: REPO }];
  config.jobs = [];
  config.jobBoard = null;
  boardSettings();
  sessions.clear();
}

describe('createJob agent', () => {
  it('defaults to claude, accepts codex, refuses anything else', () => {
    expect(createJob({ title: 't', repoPath: REPO }).job.agent).toBe('claude');
    expect(createJob({ title: 't', repoPath: REPO, agent: '' }).job.agent).toBe('claude');
    expect(createJob({ title: 't', repoPath: REPO, agent: 'codex' }).job.agent).toBe('codex');
    for (const bad of ['gemini', 'codex --yolo', 'CODEX', 42, {}]) {
      expect(createJob({ title: 't', repoPath: REPO, agent: bad }).error).toMatch(/Unknown agent/);
    }
  });

  it('reads a card written before the field existed as claude', () => {
    expect(jobAgent({ title: 'old' })).toBe('claude');
    expect(JOB_AGENTS).toEqual(['claude', 'codex']);
  });
});

describe('buildJobCommand for codex', () => {
  const codex = (over = {}) => createJob({ title: 'Fix "it"', repoPath: REPO, agent: 'codex', ...over }).job;

  it('runs codex with no flag in auto, and the whole prompt as one argv', () => {
    const parsed = parseCommand(buildJobCommand(codex({ permissionMode: 'auto' })));
    expect(parsed.file).toBe('codex');
    expect(parsed.args).toEqual([buildJobPrompt(codex())]);
  });

  it('maps bypassPermissions onto the bypass flag, from the card or the board', () => {
    const own = parseCommand(buildJobCommand(codex({ permissionMode: 'bypassPermissions' })));
    expect(own.args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(own.args).toHaveLength(2);
    const board = parseCommand(buildJobCommand(codex(), { permissionMode: 'bypassPermissions' }));
    expect(board.args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
  });

  it('maps every Claude mode onto a Codex flag, and never --add-dir', () => {
    const job = codex({ attachments: [{ name: 'a.png', path: '/cfg/attachments/j1/a.png' }] });
    // Every allowlisted mode has an entry, so a strict board can never fall
    // through to Codex's default by omission.
    expect(Object.keys(CODEX_MODE_FLAGS).sort()).toEqual([...PERMISSION_MODES].sort());
    const want = {
      auto: [], acceptEdits: [],
      plan: ['--sandbox', 'read-only'],
      manual: ['--ask-for-approval', 'on-request', '--sandbox', 'read-only'],
      dontAsk: ['--ask-for-approval', 'never'],
      bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
    };
    for (const mode of PERMISSION_MODES) {
      // From the board, and from the card itself (a ws edit can store one).
      for (const cmd of [buildJobCommand(job, { permissionMode: mode }), buildJobCommand({ ...job, permissionMode: mode })]) {
        const { args } = parseCommand(cmd);
        expect(args.slice(0, -1)).toEqual(want[mode]);
        expect(args.at(-1)).toBe(buildJobPrompt(job));
        expect(cmd).not.toContain('--add-dir');
      }
    }
  });

  it('binds a read-only board to a codex card, whoever posted it', () => {
    resetBoard();
    updateSettings({ permissionMode: 'plan' }, noop);
    const { job } = postJobForAgent({ title: 'x', repo: REPO, agent: 'codex', session: { name: 'Onyx', command: 'claude', repoPath: REPO } }, noop);
    expect(buildJobCommand(job, { permissionMode: boardSettings().permissionMode })).toMatch(/^codex --sandbox read-only "/);
  });

  it('tells codex to run $ship, not /ship', () => {
    const prompt = buildJobPrompt(codex());
    expect(prompt).toMatch(/run \$ship\./);
    expect(prompt).not.toContain('/ship');
    expect(buildJobPrompt(createJob({ title: 't', repoPath: REPO }).job)).toContain('/ship');
  });
});

describe('a card posted by an agent', () => {
  beforeEach(resetBoard);

  it('defaults to the CLI of the agent posting it', () => {
    expect(jobAgentFromCommand('codex --model o3')).toBe('codex');
    expect(jobAgentFromCommand('claude --continue')).toBe('claude');
    expect(jobAgentFromCommand('gemini')).toBe('claude');
    expect(jobAgentFromCommand(undefined)).toBe('claude');
    const session = { name: 'Onyx', command: 'codex', repoPath: REPO };
    expect(postJobForAgent({ title: 'x', session }, noop).job.agent).toBe('codex');
    expect(postJobForAgent({ title: 'x', agent: 'claude', session }, noop).job.agent).toBe('claude');
    expect(postJobForAgent({ title: 'x', repo: REPO }, noop).job.agent).toBe('claude');
    expect(postJobForAgent({ title: 'x', repo: REPO, agent: 7 }, noop).error).toMatch(/agent must be a string/);
  });
});

// The mapping is only as good as the CLI it targets: `untrusted` was a valid
// approval policy once and is not in codex-cli 0.153, and a flag the parser
// rejects kills the agent before it prints a prompt. With a real codex on
// PATH, every entry is run through its parser, on both the spawn form and the
// resume form; --help makes the CLI parse and exit without starting anything.
const codexOnPath = (() => { try { execSync('codex --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!codexOnPath)('CODEX_MODE_FLAGS against the installed codex', () => {
  // Every form once: the mode table and the flag allowlist overlap, and each
  // --help run is a subprocess.
  const forms = new Set();
  for (const flags of Object.values(CODEX_MODE_FLAGS)) {
    forms.add(`codex ${flags} --help`);
    forms.add(`codex resume --last ${flags} --help`);
  }
  // And every flag a hand-spawned agent could carry back onto its resume.
  for (const [flag, values] of Object.entries(PERMISSION_FLAGS.codex)) {
    expect(values === null || values.length > 0, `${flag} allows nothing`).toBe(true);
    for (const value of values === null ? [null] : values) {
      forms.add(`codex resume --last ${value === null ? flag : `${flag} ${value}`} --help`);
    }
  }
  for (const form of forms) {
    it(`${form.replace(/ --help$/, '')} parses`, () => {
      expect(() => execSync(form, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 }), form).not.toThrow();
    });
  }
  // The runs above prove nothing unless --help comes AFTER the parse: a value
  // the allowlist refuses must be one the CLI refuses too, or the list is
  // stricter than the CLI for no reason — and a value it accepts that the CLI
  // does not would kill the resumed agent on the spot.
  it('rejects a value the allowlist rejects, so the --help runs are a real parse', () => {
    for (const form of ['codex resume --last --sandbox nope --help', 'codex resume --last --approve-for-me=yes --help']) {
      expect(() => execSync(form, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 }), form).toThrow();
    }
  });
});

// Same for Claude Code: its --permission-mode choices are PERMISSION_MODES,
// which a hand-spawned agent carries back verbatim onto `claude --continue`.
const claudeOnPath = (() => { try { execSync('claude --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!claudeOnPath)('PERMISSION_FLAGS.claude against the installed claude', () => {
  for (const [flag, values] of Object.entries(PERMISSION_FLAGS.claude)) {
    for (const value of values || [null]) {
      const flags = value === null ? flag : `${flag} ${value}`;
      it(`spawn flag ${flags} parses on claude --continue`, () => {
        const form = `claude --continue ${flags} --help`;
        expect(() => execSync(form, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 }), form).not.toThrow();
      });
    }
  }
  it('rejects a mode the allowlist rejects, so the --help runs are a real parse', () => {
    const form = 'claude --continue --permission-mode nope --help';
    expect(() => execSync(form, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 }), form).toThrow();
  });
});

describe('re-adopting an orphan', () => {
  beforeEach(resetBoard);

  it('resumes with the CLI the session ran, not always claude', () => {
    // `claude --continue` on a Codex worktree finds no Claude transcript there
    // and exits with "No conversation found to continue" — the session is
    // gone before anyone can type into it.
    expect(resumeCommand('codex')).toBe('codex resume --last');
    expect(resumeCommand('claude')).toBe('claude --continue');
    expect(resumeCommand(undefined)).toBe('claude --continue');
    expect(resumeCommand(null)).toBe('claude --continue');
    // Both are commands the PTY treats as a TUI agent.
    expect(parseCommand(resumeCommand('codex'))).toEqual({ file: 'codex', args: ['resume', '--last'] });
  });

  it('carries the permission mode the session was dispatched with', () => {
    // Neither CLI remembers its mode: a read-only Codex card resumed bare
    // comes back with workspace-write, and an unattended one comes back
    // asking. Same flag mapping as dispatch, validated the same way.
    expect(resumeCommand('codex', 'plan')).toBe('codex resume --last --sandbox read-only');
    expect(resumeCommand('codex', 'dontAsk')).toBe('codex resume --last --ask-for-approval never');
    expect(resumeCommand('codex', 'bypassPermissions')).toBe('codex resume --last --dangerously-bypass-approvals-and-sandbox');
    expect(resumeCommand('codex', 'auto')).toBe('codex resume --last');   // Codex's own default
    expect(resumeCommand('claude', 'plan')).toBe('claude --continue --permission-mode plan');
    expect(resumeCommand('claude', 'bypassPermissions')).toBe('claude --continue --permission-mode bypassPermissions');
    // No card, or a mode that is not one of ours: nothing is smuggled onto the argv.
    expect(resumeCommand('codex', null)).toBe('codex resume --last');
    expect(resumeCommand('claude', 'plan --add-dir /')).toBe('claude --continue');
    expect(parseCommand(resumeCommand('codex', 'plan')).args).toEqual(['resume', '--last', '--sandbox', 'read-only']);
  });

  it('resumes a job agent under its card\'s mode, and a manual agent under the CLI default', async () => {
    updateSettings({ permissionMode: 'plan', maxPerRepo: 2 }, noop);
    addJob({ title: 'read only codex', repoPath: REPO, agent: 'codex' }, noop);
    addJob({ title: 'unattended codex', repoPath: REPO, agent: 'codex', permissionMode: 'bypassPermissions' }, noop);
    let n = 0;
    await dispatchOnce(async (command, name, repoPath, branch) => {
      const session = { id: `s${++n}`, name: `A${n}`, command, repoPath, branchName: branch, exited: false };
      sessions.set(session.id, session);
      return { session };
    }, noop);
    const [inherits, own] = allJobs();
    expect(inherits.state).toBe('in-progress');
    expect(own.state).toBe('in-progress');
    sessions.clear();
    inherits.agentSessionId = null;
    own.agentSessionId = null;
    const homes = { claude: join(REPO, 'no-claude'), codex: join(REPO, 'no-codex') };
    // The board mode applies when the card inherits it...
    expect(orphanResumePlan({ repoPath: REPO, branchName: inherits.branchName, worktreePath: '/wt/x', agent: 'codex' }, homes))
      .toEqual({ agent: 'codex', mode: 'plan', flags: [], command: 'codex resume --last --sandbox read-only' });
    // ...and the card's own mode when it has one.
    expect(orphanResumePlan({ repoPath: REPO, branchName: own.branchName, worktreePath: '/wt/y', agent: 'codex' }, homes).command)
      .toBe('codex resume --last --dangerously-bypass-approvals-and-sandbox');
    // A manual agent has no card: no flag, and the resolved agent is reported for noting.
    expect(orphanResumePlan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x', agent: 'codex' }, homes)).toEqual({ agent: 'codex', mode: null, flags: [], command: 'codex resume --last' });
    expect(orphanResumePlan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x' }, homes)).toEqual({ agent: null, mode: null, flags: [], command: 'claude --continue' });
  });

  it('names Codex modes only with flags the allowlist accepts, so the two tables cannot drift apart', () => {
    // CODEX_MODE_FLAGS spells out the mode → flags mapping; PERMISSION_FLAGS
    // spells out what a permission flag is. A rename or a dropped value (as
    // `untrusted` was) fixed in one and missed in the other would send a card
    // agent out with a flag the resume path throws away, or vice versa.
    for (const [mode, flags] of Object.entries(CODEX_MODE_FLAGS)) {
      const tokens = flags ? flags.split(' ') : [];
      expect(normalizePermissionFlags('codex', tokens), mode).toEqual(tokens);
    }
    for (const mode of PERMISSION_MODES) {
      expect(normalizePermissionFlags('claude', ['--permission-mode', mode])).toEqual(['--permission-mode', mode]);
    }
  });

  it('never reads a value out of the -- slot, or any option, for a flag that wants one', () => {
    // Both CLIs refuse `--sandbox --` at parse time; a scanner that consumed
    // the `--` as the value would then read what follows as flags again.
    expect(permissionFlagsFromCommand('codex --sandbox -- --yolo')).toEqual([]);
    expect(permissionFlagsFromCommand('codex -a -- -s danger-full-access')).toEqual([]);
    expect(permissionFlagsFromCommand('claude --permission-mode -- --dangerously-skip-permissions')).toEqual([]);
    // A value flag left without a value drops itself, never the switch after it.
    expect(permissionFlagsFromCommand('codex --sandbox --approve-for-me')).toEqual(['--approve-for-me']);
    expect(permissionFlagsFromCommand('codex --approve-for-me -- --sandbox read-only')).toEqual(['--approve-for-me']);
  });

  it('resumes a board agent whose card is gone under the board\'s current mode', () => {
    const homes = { claude: join(REPO, 'no-claude'), codex: join(REPO, 'no-codex') };
    updateSettings({ permissionMode: 'plan' }, noop);
    // No card on the branch (done, or deleted), but the record says the board
    // dispatched it: the board's mode of TODAY, not the CLI's default, and not
    // whatever it was dispatched with.
    const board = { repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x', agent: 'codex', origin: 'board', permissionFlags: ['--dangerously-bypass-approvals-and-sandbox'] };
    expect(orphanResumePlan(board, homes)).toEqual({ agent: 'codex', mode: 'plan', flags: ['--dangerously-bypass-approvals-and-sandbox'], command: 'codex resume --last --sandbox read-only' });
    updateSettings({ permissionMode: 'bypassPermissions' }, noop);
    expect(orphanResumePlan(board, homes).command).toBe('codex resume --last --dangerously-bypass-approvals-and-sandbox');
    // A hand-spawned one is not the board's to govern.
    expect(orphanResumePlan({ ...board, origin: 'user' }, homes).command).toBe('codex resume --last --dangerously-bypass-approvals-and-sandbox');
    updateSettings({ permissionMode: 'plan' }, noop);
    expect(orphanResumePlan({ ...board, origin: 'user' }, homes).command).toBe('codex resume --last --dangerously-bypass-approvals-and-sandbox');
    expect(orphanResumePlan({ ...board, origin: undefined, permissionFlags: [] }, homes).command).toBe('codex resume --last');
  });

  it('reads the permission flags a hand-spawned agent was started with, and nothing else', () => {
    expect(permissionFlagsFromCommand('codex')).toEqual([]);
    expect(permissionFlagsFromCommand('codex --dangerously-bypass-approvals-and-sandbox')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(permissionFlagsFromCommand('/opt/homebrew/bin/codex --model o3 -s read-only -a never "do it"')).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'never']);
    expect(permissionFlagsFromCommand('codex --sandbox=workspace-write --approve-for-me')).toEqual(['--sandbox', 'workspace-write', '--approve-for-me']);
    expect(permissionFlagsFromCommand('claude --permission-mode bypassPermissions --add-dir /x')).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(permissionFlagsFromCommand('claude --dangerously-skip-permissions')).toEqual(['--dangerously-skip-permissions']);
    // A value the CLI would reject, a flag that is not a permission, a switch
    // handed a value, a CLI that is neither: none of it comes through.
    expect(permissionFlagsFromCommand('codex --ask-for-approval untrusted --sandbox nope')).toEqual([]);
    expect(permissionFlagsFromCommand('codex --dangerously-bypass-approvals-and-sandbox=yes')).toEqual([]);
    expect(permissionFlagsFromCommand('claude --permission-mode "plan --add-dir /"')).toEqual([]);
    expect(permissionFlagsFromCommand('bash -lc "codex --sandbox read-only"')).toEqual([]);
    expect(permissionFlagsFromCommand('gemini --yolo')).toEqual([]);
    expect(permissionFlagsFromCommand(undefined)).toEqual([]);
    // A stored record goes through the same allowlist.
    expect(normalizePermissionFlags('codex', ['--sandbox', 'read-only', '--rm', '-rf', '/'])).toEqual(['--sandbox', 'read-only']);
    expect(normalizePermissionFlags('claude', 'not an array')).toEqual([]);
    expect(normalizePermissionFlags('gemini', ['--yolo'])).toEqual([]);
  });

  it('resumes a hand-spawned agent under the flags it was started with, unless a card knows better', () => {
    expect(resumeCommand('codex', null, ['--dangerously-bypass-approvals-and-sandbox'])).toBe('codex resume --last --dangerously-bypass-approvals-and-sandbox');
    expect(resumeCommand('codex', null, ['--sandbox', 'read-only', '--ask-for-approval', 'never'])).toBe('codex resume --last --sandbox read-only --ask-for-approval never');
    expect(resumeCommand('claude', null, ['--permission-mode', 'plan'])).toBe('claude --continue --permission-mode plan');
    expect(resumeCommand('claude', null, ['--dangerously-skip-permissions'])).toBe('claude --continue --dangerously-skip-permissions');
    // The card's mode is the board's current word and wins over the old flags.
    expect(resumeCommand('codex', 'plan', ['--dangerously-bypass-approvals-and-sandbox'])).toBe('codex resume --last --sandbox read-only');
    // Junk in a stored record never reaches the argv.
    expect(resumeCommand('codex', null, ['--sandbox', 'read-only; rm -rf /'])).toBe('codex resume --last');
    expect(resumeCommand('codex', null, ['--permission-mode', 'plan'])).toBe('codex resume --last');   // a Claude flag on a Codex agent
    expect(resumeCommand('codex', null, undefined)).toBe('codex resume --last');
    expect(parseCommand(resumeCommand('codex', null, ['--sandbox', 'read-only'])).args).toEqual(['resume', '--last', '--sandbox', 'read-only']);
  });

  it('carries a hand-spawned orphan\'s flags through the plan, but only with a recorded CLI', () => {
    const homes = { claude: join(REPO, 'no-claude'), codex: join(REPO, 'no-codex') };
    const bypass = ['--dangerously-bypass-approvals-and-sandbox'];
    expect(orphanResumePlan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x', agent: 'codex', permissionFlags: bypass }, homes))
      .toEqual({ agent: 'codex', mode: null, flags: bypass, command: 'codex resume --last --dangerously-bypass-approvals-and-sandbox' });
    expect(orphanResumePlan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x', agent: 'claude', permissionFlags: ['--permission-mode', 'acceptEdits'] }, homes).command)
      .toBe('claude --continue --permission-mode acceptEdits');
    // No note (a record from before, or a discovered worktree): the flags on
    // it have no CLI to belong to, so the resolved CLI runs under its default.
    expect(orphanResumePlan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x', permissionFlags: bypass }, homes).command).toBe('claude --continue');
    // A stored record's flags pass the allowlist again.
    expect(orphanResumePlan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x', agent: 'codex', permissionFlags: ['--sandbox', 'nope', '--approve-for-me'] }, homes).command)
      .toBe('codex resume --last --approve-for-me');
  });

  it('normalises every spelling of a permission flag, and keeps nothing that is not one whole', () => {
    // Each CLI's own spellings come back in the long form, in the order given.
    expect(normalizePermissionFlags('codex', ['-s=read-only', '-a=never'])).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'never']);
    expect(normalizePermissionFlags('codex', ['-a', 'never', '-s', 'read-only'])).toEqual(['--ask-for-approval', 'never', '--sandbox', 'read-only']);
    expect(normalizePermissionFlags('claude', ['--permission-mode=plan'])).toEqual(['--permission-mode', 'plan']);
    // The short forms are Codex's: on a Claude agent -s is not a permission.
    expect(normalizePermissionFlags('claude', ['-s', 'read-only'])).toEqual([]);
    // A value flag at the end of the argv has no value, and is dropped whole.
    expect(normalizePermissionFlags('codex', ['--approve-for-me', '--sandbox'])).toEqual(['--approve-for-me']);
    expect(normalizePermissionFlags('claude', ['--permission-mode'])).toEqual([]);
    // An empty inline value is no value; a bare switch keeps only itself, and
    // a word after it is not its value.
    expect(normalizePermissionFlags('codex', ['--sandbox=', '--approve-for-me='])).toEqual([]);
    expect(normalizePermissionFlags('codex', ['--approve-for-me', 'yes'])).toEqual(['--approve-for-me']);
    expect(normalizePermissionFlags('claude', ['--dangerously-skip-permissions', 'plan'])).toEqual(['--dangerously-skip-permissions']);
    // A record that is not strings (hand-edited config.json) is skipped, not
    // stringified into something the table might match.
    expect(normalizePermissionFlags('codex', [42, null, undefined, {}, ['--approve-for-me'], '--approve-for-me'])).toEqual(['--approve-for-me']);
    expect(normalizePermissionFlags('codex', ['--sandbox', 42])).toEqual([]);
    // Names the allowlist object inherits are not in it.
    expect(normalizePermissionFlags('codex', ['constructor', '__proto__', 'toString', 'hasOwnProperty'])).toEqual([]);
    expect(normalizePermissionFlags('codex', [])).toEqual([]);
    expect(normalizePermissionFlags(undefined, ['--approve-for-me'])).toEqual([]);
  });

  it('keeps one value per flag, stops at --, and unpacks a short option with its value attached', () => {
    // Each CLI refuses a repeated flag outright, so a record that carries one
    // twice (hand-edited, or two spellings of the same flag) comes back with
    // the last value only — the one the CLI would have taken had it accepted.
    expect(normalizePermissionFlags('codex', ['--sandbox', 'read-only', '-s', 'workspace-write'])).toEqual(['--sandbox', 'workspace-write']);
    expect(normalizePermissionFlags('codex', ['--yolo', '--dangerously-bypass-approvals-and-sandbox'])).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(normalizePermissionFlags('claude', ['--permission-mode', 'plan', '--permission-mode=auto'])).toEqual(['--permission-mode', 'auto']);
    // First appearance fixes the order; the last value fills it.
    expect(normalizePermissionFlags('codex', ['-s', 'read-only', '-a', 'never', '-s', 'danger-full-access'])).toEqual(['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
    // Past `--` is the prompt, however flag-shaped.
    expect(normalizePermissionFlags('codex', ['--approve-for-me', '--', '--sandbox', 'read-only'])).toEqual(['--approve-for-me']);
    expect(permissionFlagsFromCommand('claude -- --permission-mode plan')).toEqual([]);
    // Codex short options take their value attached; Claude has no short forms.
    expect(normalizePermissionFlags('codex', ['-sread-only', '-anever'])).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'never']);
    expect(normalizePermissionFlags('codex', ['-snope', '-x=read-only'])).toEqual([]);
    expect(normalizePermissionFlags('claude', ['-pplan'])).toEqual([]);
    // The agent lookup is an own-property one too: a record naming a
    // prototype key finds no table.
    expect(normalizePermissionFlags('constructor', ['--approve-for-me'])).toEqual([]);
    expect(normalizePermissionFlags('__proto__', ['--approve-for-me'])).toEqual([]);
  });

  it('reads the flags off every form a session command takes', () => {
    // The resume commands themselves: a re-adopted agent records what its own
    // next re-adopt needs, so the flags survive any number of round trips.
    expect(permissionFlagsFromCommand('codex resume --last --sandbox read-only --ask-for-approval never')).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'never']);
    expect(permissionFlagsFromCommand('claude --continue --permission-mode plan')).toEqual(['--permission-mode', 'plan']);
    expect(permissionFlagsFromCommand(resumeCommand('codex', null, permissionFlagsFromCommand('codex -s read-only "do it"')))).toEqual(['--sandbox', 'read-only']);
    // A Windows binary, a path, and a prompt whose text mentions a flag.
    expect(permissionFlagsFromCommand('codex.exe -s read-only')).toEqual(['--sandbox', 'read-only']);
    expect(permissionFlagsFromCommand('claude.cmd --dangerously-skip-permissions')).toEqual(['--dangerously-skip-permissions']);
    expect(permissionFlagsFromCommand('codex "run it with --sandbox read-only"')).toEqual([]);
    expect(permissionFlagsFromCommand("claude 'use --permission-mode plan'")).toEqual([]);
    expect(permissionFlagsFromCommand('')).toEqual([]);
    expect(permissionFlagsFromCommand(null)).toEqual([]);
  });

  it('lets a card mode that is not one of ours fall through to the flags, and a real one shadow them', () => {
    // A mode outside the allowlist is no card at all, so the agent's own
    // flags apply — not the CLI default.
    expect(resumeCommand('codex', 'yolo', ['--approve-for-me'])).toBe('codex resume --last --approve-for-me');
    expect(resumeCommand('claude', 'plan --add-dir /', ['--permission-mode', 'plan'])).toBe('claude --continue --permission-mode plan');
    // A card on the board default is still the board's word: auto and
    // acceptEdits are Codex's own default, so a bypass agent whose card says
    // so comes back under that default, not its old flag.
    expect(resumeCommand('codex', 'auto', ['--dangerously-bypass-approvals-and-sandbox'])).toBe('codex resume --last');
    expect(resumeCommand('codex', 'acceptEdits', ['--dangerously-bypass-approvals-and-sandbox'])).toBe('codex resume --last');
    expect(resumeCommand('claude', 'auto', ['--dangerously-skip-permissions'])).toBe('claude --continue --permission-mode auto');
    // Flags are read as the resolved CLI's: Codex flags on a Claude resume,
    // and the other way round, are dropped; with no CLI resolved the default
    // is Claude, so only Claude's flags survive.
    expect(resumeCommand('claude', null, ['--sandbox', 'read-only'])).toBe('claude --continue');
    expect(resumeCommand('claude', null, ['--permission-mode', 'plan --dangerously-skip-permissions'])).toBe('claude --continue');
    expect(resumeCommand('claude', null, 'not an array')).toBe('claude --continue');
    expect(resumeCommand(null, null, ['--permission-mode', 'plan'])).toBe('claude --continue --permission-mode plan');
    expect(resumeCommand(undefined, null, ['--sandbox', 'read-only'])).toBe('claude --continue');
    expect(parseCommand(resumeCommand('claude', null, ['--permission-mode', 'plan'])).args).toEqual(['--continue', '--permission-mode', 'plan']);
  });

  it('reports a hand-spawned orphan\'s flags on the plan even when its card\'s mode wins', async () => {
    // A tab spawned by hand can still land on a card's branch (the card was
    // posted for work already under way, or the agent was re-adopted and
    // relinked). The card's mode is the board's current word and goes on the
    // command; the flags are still reported, so the caller can see what was
    // overruled.
    updateSettings({ permissionMode: 'auto', maxPerRepo: 2 }, noop);
    addJob({ title: 'board default codex', repoPath: REPO, agent: 'codex' }, noop);
    addJob({ title: 'read only claude', repoPath: REPO, permissionMode: 'plan' }, noop);
    let n = 0;
    await dispatchOnce(async (command, name, repoPath, branch) => {
      const session = { id: `s${++n}`, name: `A${n}`, command, repoPath, branchName: branch, exited: false };
      sessions.set(session.id, session);
      return { session };
    }, noop);
    const [inherits, own] = allJobs();
    sessions.clear();
    inherits.agentSessionId = null;
    own.agentSessionId = null;
    const homes = { claude: join(REPO, 'no-claude'), codex: join(REPO, 'no-codex') };
    const bypass = ['--dangerously-bypass-approvals-and-sandbox'];
    // The board's auto is Codex's default: the bypass flag does not come back.
    expect(orphanResumePlan({ repoPath: REPO, branchName: inherits.branchName, worktreePath: '/wt/x', agent: 'codex', permissionFlags: bypass }, homes))
      .toEqual({ agent: 'codex', mode: 'auto', flags: bypass, command: 'codex resume --last' });
    expect(orphanResumePlan({ repoPath: REPO, branchName: own.branchName, worktreePath: '/wt/y', agent: 'claude', permissionFlags: ['--dangerously-skip-permissions'] }, homes))
      .toEqual({ agent: 'claude', mode: 'plan', flags: ['--dangerously-skip-permissions'], command: 'claude --continue --permission-mode plan' });
    // The record's flags belong to the record's CLI: Codex flags noted on a
    // Claude agent, or a record that is not a list, are nothing to pass on.
    expect(orphanResumePlan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x', agent: 'claude', permissionFlags: ['--sandbox', 'read-only'] }, homes))
      .toEqual({ agent: 'claude', mode: null, flags: [], command: 'claude --continue' });
    expect(orphanResumePlan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x', agent: 'codex', permissionFlags: '--approve-for-me' }, homes))
      .toEqual({ agent: 'codex', mode: null, flags: [], command: 'codex resume --last' });
  });

  it('records a CLI only when the command is literally one of them', () => {
    // Unlike jobAgentFromCommand, no default: the record outranks the card and
    // the transcripts, so a guess here would silence both.
    expect(sessionAgentFromCommand('codex')).toBe('codex');
    expect(sessionAgentFromCommand('/opt/homebrew/bin/codex --model o3')).toBe('codex');
    expect(sessionAgentFromCommand('claude --continue')).toBe('claude');
    expect(sessionAgentFromCommand('claude.exe --continue')).toBe('claude');
    expect(sessionAgentFromCommand('bash -lc codex')).toBeNull();
    expect(sessionAgentFromCommand('gemini')).toBeNull();
    expect(sessionAgentFromCommand(undefined)).toBeNull();
    expect(sessionAgentFromCommand('')).toBeNull();
  });

  it('reads the CLI off the orphan record when a restart or a close recorded it', () => {
    expect(resumeCommandForOrphan({ agent: 'codex', repoPath: REPO, branchName: 'b/x' })).toBe('codex resume --last');
    expect(resumeCommandForOrphan({ agent: 'claude', repoPath: REPO, branchName: 'b/x' })).toBe('claude --continue');
    // A value outside the allowlist (config.json is hand-editable) is no note
    // at all: the fallbacks run, and the junk is not stamped onto the session.
    const homes = { claude: join(REPO, 'no-claude'), codex: join(REPO, 'no-codex') };
    expect(orphanResumePlan({ agent: 'gemini', repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x' }, homes))
      .toEqual({ agent: null, mode: null, flags: [], command: 'claude --continue' });
  });

  it('falls back to the job card on the branch for an orphan discovered on disk', async () => {
    // scanForOrphanedWorktrees only knows the directory and the branch; the
    // card that dispatched a Codex agent onto that branch knows the rest.
    addJob({ title: 'codex work', repoPath: REPO, agent: 'codex' }, noop);
    const calls = [];
    await dispatchOnce(async (command, name, repoPath, branch) => {
      calls.push({ command, branch });
      const session = { id: 's1', name: 'Onyx', command, repoPath, branchName: branch, exited: false };
      sessions.set(session.id, session);
      return { session };
    }, noop);
    const job = allJobs()[0];
    expect(job.agent).toBe('codex');
    // After a restart the link is gone, as loadConfig leaves it.
    sessions.clear();
    job.agentSessionId = null;

    // Empty CLI homes, so the transcript probe below cannot answer instead.
    const homes = { claude: join(REPO, 'no-claude'), codex: join(REPO, 'no-codex') };
    const discovered = { repoPath: REPO, branchName: job.branchName, worktreePath: '/wt/x', reason: 'discovered' };
    expect(resumeCommandForOrphan(discovered, homes)).toBe('codex resume --last');
    // A card the orphan record contradicts loses: the record saw the command.
    // The card's mode (the board's, here) still rides along.
    expect(resumeCommandForOrphan({ ...discovered, agent: 'claude' }, homes)).toBe('claude --continue --permission-mode auto');
    // No card on that branch, no note, no transcript: Claude Code, the default.
    expect(resumeCommandForOrphan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/x' }, homes)).toBe('claude --continue');
    // A card that already has a live agent is not this orphan's card.
    job.agentSessionId = 'someone-else';
    expect(resumeCommandForOrphan(discovered, homes)).toBe('claude --continue');
  });

  // A manually spawned agent has no card, and an orphan record written before
  // the CLI was noted has no note: the transcripts each CLI leaves under its
  // home are the only thing left that knows.
  // Every temp root is removed after each test: the FIFO test leaves pipes
  // behind that would hang any later reader of the temp dir (unlink does not
  // open them, so the cleanup itself is safe).
  const tempRoots = [];
  const tempRoot = (prefix) => { const r = mkdtempSync(join(tmpdir(), prefix)); tempRoots.push(r); return r; };
  afterEach(() => { for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  function fakeHomes() {
    const root = tempRoot('a007-homes-');
    const claude = join(root, 'claude');
    const codex = join(root, 'codex');
    // Claude Code: ~/.claude/projects/<path, non-alphanumerics dashed>/<uuid>.jsonl
    const claudeFor = (wt, at, { name = 'f5fe539b.jsonl' } = {}) => {
      const dir = join(claude, 'projects', wt.replace(/[^A-Za-z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      const f = join(dir, name);
      writeFileSync(f, '{"type":"user"}\n');
      utimesSync(f, at, at);
    };
    // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, first line session_meta with cwd
    let n = 0;
    const codexFor = (wt, at, { meta = true, source = 'cli', thread = 'user' } = {}) => {
      const dir = join(codex, 'sessions', '2026', '09', '15');
      mkdirSync(dir, { recursive: true });
      const f = join(dir, `rollout-2026-09-15T00-00-0${n++}.jsonl`);
      // The real session_meta line carries Codex's base instructions and runs
      // past 20 KB; a reader that stops at a fixed head misses the cwd.
      const first = meta
        ? JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: wt, originator: 'codex-tui', source, thread_source: thread, base_instructions: { text: 'You are Codex. '.repeat(2000) } } })
        : JSON.stringify({ type: 'other' });
      writeFileSync(f, first + '\n' + JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(50000) } }) + '\n');
      utimesSync(f, at, at);
    };
    return { homes: { claude, codex }, claudeFor, codexFor };
  }

  it('reads the CLI off the transcripts on disk when nothing else knows', () => {
    const { homes, claudeFor, codexFor } = fakeHomes();
    const t = 1_700_000_000;
    codexFor('/wt/video/Vid Gen', t);                   // a space in the path, as a renamed agent leaves
    claudeFor('/wt/video/Ghost', t);
    codexFor('/wt/video/Phantom', t, { meta: false });   // a rollout with no readable cwd says nothing
    expect(agentFromTranscripts('/wt/video/Vid Gen', homes)).toBe('codex');
    expect(agentFromTranscripts('/wt/video/Ghost', homes)).toBe('claude');
    expect(agentFromTranscripts('/wt/video/Phantom', homes)).toBeNull();
    expect(agentFromTranscripts('/wt/video/Nobody', homes)).toBeNull();
    expect(agentFromTranscripts(undefined, homes)).toBeNull();
    // Homes that do not exist at all are simply empty.
    expect(agentFromTranscripts('/wt/video/Ghost', { claude: '/nope/claude', codex: '/nope/codex' })).toBeNull();

    const orphan = { repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/video/Vid Gen', reason: 'server-restart' };
    expect(resumeCommandForOrphan(orphan, homes)).toBe('codex resume --last');
    expect(resumeCommandForOrphan({ ...orphan, worktreePath: '/wt/video/Ghost' }, homes)).toBe('claude --continue');
    // The record and the card still come first.
    expect(resumeCommandForOrphan({ ...orphan, agent: 'claude' }, homes)).toBe('claude --continue');
  });

  it('counts only a real, non-empty transcript, and never opens a FIFO', () => {
    const { homes, claudeFor, codexFor } = fakeHomes();
    const t = 1_700_000_000;
    // A newer empty Claude file must not outvote the Codex session next to it,
    // nor may a directory named like a transcript.
    codexFor('/wt/a', t);
    claudeFor('/wt/a', t + 100, { name: 'empty.jsonl' });
    writeFileSync(join(homes.claude, 'projects', '-wt-a', 'empty.jsonl'), '');
    mkdirSync(join(homes.claude, 'projects', '-wt-a', 'dir.jsonl'));
    expect(agentFromTranscripts('/wt/a', homes)).toBe('codex');
    // An empty Codex rollout says nothing either.
    codexFor('/wt/b', t);
    const day = join(homes.codex, 'sessions', '2026', '09', '15');
    for (const name of readdirSync(day)) if (readFileSync(join(day, name), 'utf8').includes('/wt/b')) writeFileSync(join(day, name), '');
    expect(agentFromTranscripts('/wt/b', homes)).toBeNull();
    if (process.platform !== 'win32') {
      // A FIFO with no writer would block a synchronous open for ever — and the
      // whole server with it. It is not a regular file, so it is never opened.
      execSync(`mkfifo "${join(day, 'rollout-fifo.jsonl')}"`);
      execSync(`mkfifo "${join(homes.claude, 'projects', '-wt-a', 'fifo.jsonl')}"`);
      expect(agentFromTranscripts('/wt/a', homes)).toBe('codex');
      expect(agentFromTranscripts('/wt/nobody', homes)).toBeNull();
    }
  });

  it('counts only interactive, top-level Codex sessions, the ones resume --last can reach', () => {
    const { homes, claudeFor, codexFor } = fakeHomes();
    const t = 1_700_000_000;
    // A Claude agent that shelled out to `codex exec` in its own worktree, and
    // a Codex subagent thread that finished last: both newer than the Claude
    // transcript, neither resumable, so the worktree is still Claude's.
    claudeFor('/wt/c', t);
    codexFor('/wt/c', t + 10, { source: 'exec' });
    codexFor('/wt/c', t + 20, { source: { subagent: { depth: 1 } }, thread: 'subagent' });
    expect(agentFromTranscripts('/wt/c', homes)).toBe('claude');
    // With nothing else there, they are not evidence of Codex either.
    codexFor('/wt/d', t, { source: 'exec' });
    expect(agentFromTranscripts('/wt/d', homes)).toBeNull();
    // An older rollout with neither field is read as interactive.
    codexFor('/wt/e', t, { source: undefined, thread: undefined });
    expect(agentFromTranscripts('/wt/e', homes)).toBe('codex');
  });

  it('finds a worktree reached through a symlink under the path the CLI recorded', () => {
    if (process.platform === 'win32') return;
    const { homes, claudeFor, codexFor } = fakeHomes();
    const real = tempRoot('a007-real-');
    const link = join(tempRoot('a007-link-'), 'wt');
    symlinkSync(real, link);
    // Both CLIs file the session under getcwd(), the resolved path.
    const resolved = realpathSync.native(real);
    codexFor(resolved, 1_700_000_000);
    expect(agentFromTranscripts(link, homes)).toBe('codex');
    claudeFor(resolved, 1_700_000_100);
    expect(agentFromTranscripts(link, homes)).toBe('claude');
    // A path that does not exist at all is still looked up as given.
    expect(agentFromTranscripts('/wt/gone', homes)).toBeNull();
  });

  it('stops scanning rollouts after the newest few hundred', () => {
    // A miss is bounded by the cap, not by months of history: a session older
    // than 500 later ones is a stale worktree, and it gets the default.
    const { homes, codexFor } = fakeHomes();
    const t = 1_700_000_000;
    const day = join(homes.codex, 'sessions', '2026', '09', '15');
    mkdirSync(day, { recursive: true });
    const meta = (cwd) => JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd } }) + '\n';
    const old = join(day, 'rollout-old.jsonl');
    writeFileSync(old, meta('/wt/stale')); utimesSync(old, t, t);
    for (let i = 0; i < 500; i++) {
      const f = join(day, `rollout-newer-${String(i).padStart(3, '0')}.jsonl`);
      writeFileSync(f, meta('/wt/other')); utimesSync(f, t + 1 + i, t + 1 + i);
    }
    expect(agentFromTranscripts('/wt/stale', homes)).toBeNull();
    expect(agentFromTranscripts('/wt/other', homes)).toBe('codex');
    // One fewer newer session and the old one is within reach again.
    rmSync(join(day, 'rollout-newer-000.jsonl'));
    expect(agentFromTranscripts('/wt/stale', homes)).toBe('codex');
  });

  it('prefers the newer transcript when both CLIs worked in the worktree', () => {
    const { homes, claudeFor, codexFor } = fakeHomes();
    claudeFor('/wt/both', 1_700_000_000);
    codexFor('/wt/both', 1_700_000_100);
    expect(agentFromTranscripts('/wt/both', homes)).toBe('codex');
    claudeFor('/wt/both', 1_700_000_200);
    expect(agentFromTranscripts('/wt/both', homes)).toBe('claude');
  });

  it('looks under CLAUDE_CONFIG_DIR and CODEX_HOME when no homes are given', () => {
    // Each CLI honours its own home override, so an agent that ran with one
    // left its transcript there and not under ~/.claude or ~/.codex.
    const { homes, claudeFor, codexFor } = fakeHomes();
    claudeFor('/wt/env/Ghost', 1_700_000_000);
    codexFor('/wt/env/Vid Gen', 1_700_000_000);
    const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
    process.env.CLAUDE_CONFIG_DIR = homes.claude;
    process.env.CODEX_HOME = homes.codex;
    try {
      expect(agentFromTranscripts('/wt/env/Ghost')).toBe('claude');
      expect(agentFromTranscripts('/wt/env/Vid Gen')).toBe('codex');
      // What the ws handler calls: no homes argument at all.
      expect(resumeCommandForOrphan({ repoPath: REPO, branchName: 'nobody/here', worktreePath: '/wt/env/Vid Gen' })).toBe('codex resume --last');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('judges each CLI by its newest transcript, and a tie goes to claude', () => {
    const { homes, claudeFor, codexFor } = fakeHomes();
    // Two sessions per CLI in one worktree: the newest of the four decides,
    // wherever the listing happens to put it.
    claudeFor('/wt/many', 1_700_000_300, { name: 'a.jsonl' });
    claudeFor('/wt/many', 1_700_000_000, { name: 'b.jsonl' });
    codexFor('/wt/many', 1_700_000_200);
    codexFor('/wt/many', 1_700_000_100);
    expect(agentFromTranscripts('/wt/many', homes)).toBe('claude');
    codexFor('/wt/many', 1_700_000_400);
    expect(agentFromTranscripts('/wt/many', homes)).toBe('codex');
    // The same instant: claude, the board's default, as before the probe existed.
    claudeFor('/wt/tie', 1_700_000_000);
    codexFor('/wt/tie', 1_700_000_000);
    expect(agentFromTranscripts('/wt/tie', homes)).toBe('claude');
  });

  it('skips what is not a transcript: other files, a rollout nested too deep, entries it cannot stat', () => {
    const { homes, codexFor } = fakeHomes();
    const claudeDir = join(homes.claude, 'projects', '-wt-junk');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'notes.txt'), 'x');
    if (process.platform !== 'win32') symlinkSync('/nope/gone.jsonl', join(claudeDir, 'dangling.jsonl'));   // stat fails, readdir does not
    const day = join(homes.codex, 'sessions', '2026', '09', '15');
    mkdirSync(join(day, 'extra'), { recursive: true });
    writeFileSync(join(day, 'notes.txt'), 'x');
    if (process.platform !== 'win32') symlinkSync('/nope/gone.jsonl', join(day, 'rollout-dangling.jsonl'));
    // sessions/YYYY/MM/DD is as deep as Codex goes; the walk does not follow further.
    writeFileSync(join(day, 'extra', 'rollout-deep.jsonl'), '{"type":"session_meta","payload":{"cwd":"/wt/junk"}}\n');
    expect(agentFromTranscripts('/wt/junk', homes)).toBeNull();
    // None of it stopped the walk: a real rollout beside the junk is still found.
    codexFor('/wt/junk', 1_700_000_000);
    expect(agentFromTranscripts('/wt/junk', homes)).toBe('codex');
  });

  it('says nothing for a rollout whose first line yields no cwd', () => {
    const { homes } = fakeHomes();
    const day = join(homes.codex, 'sessions', '2026', '09', '15');
    mkdirSync(day, { recursive: true });
    const rollout = (name, body) => writeFileSync(join(day, name), body);
    rollout('rollout-empty.jsonl', '');
    rollout('rollout-garbage.jsonl', 'not json\n');
    rollout('rollout-null.jsonl', 'null\n');
    rollout('rollout-no-payload.jsonl', '{"type":"session_meta"}\n');
    // A first line that never ends: the reader gives up at its cap rather than
    // swallowing a whole multi-megabyte file.
    rollout('rollout-endless.jsonl', '{"type":"session_meta","payload":{"cwd":"/wt/bad"' + ' '.repeat(1024 * 1024 + 1));
    if (process.getuid && process.getuid() !== 0) {   // root can read anything
      rollout('rollout-locked.jsonl', '{"type":"session_meta","payload":{"cwd":"/wt/bad"}}\n');
      chmodSync(join(day, 'rollout-locked.jsonl'), 0o000);
    }
    expect(agentFromTranscripts('/wt/bad', homes)).toBeNull();
    // A rollout that is one line with no newline at all still yields its cwd.
    rollout('rollout-eof.jsonl', '{"type":"session_meta","payload":{"cwd":"/wt/bad"}}');
    expect(agentFromTranscripts('/wt/bad', homes)).toBe('codex');
  });

  it('trusts the card over the transcripts, whichever CLI the card names', () => {
    const { homes, codexFor } = fakeHomes();
    // A claude card whose worktree also holds a Codex transcript (someone ran
    // codex there by hand): the card dispatched the agent, so it knows better.
    // The card is in review with its link gone, as a restart leaves one whose
    // PR was found before its agent came back — still this orphan's card.
    addJob({ title: 'claude work', repoPath: REPO }, noop);
    const job = allJobs()[0];
    Object.assign(job, { state: 'review', branchName: 'b/claude-work', agentSessionId: null });
    codexFor('/wt/claude-work', 1_700_000_000);
    expect(agentFromTranscripts('/wt/claude-work', homes)).toBe('codex');
    expect(resumeCommandForOrphan({ repoPath: REPO, branchName: 'b/claude-work', worktreePath: '/wt/claude-work' }, homes)).toBe('claude --continue --permission-mode auto');
    // An orphan record with no worktree path cannot be probed at all: the default.
    expect(resumeCommandForOrphan({ repoPath: REPO, branchName: 'nobody/here' }, homes)).toBe('claude --continue');
  });
});

describe('the board', () => {
  beforeEach(resetBoard);

  it('edits the agent on a To do card and dispatches with it', async () => {
    const { job } = addJob({ title: 'x', repoPath: REPO }, noop);
    expect(updateJob(job.id, { agent: 'codex' }, noop).error).toBeUndefined();
    expect(allJobs()[0].agent).toBe('codex');
    expect(updateJob(job.id, { agent: 'nope' }, noop).error).toMatch(/Unknown agent/);
    updateSettings({ running: true, permissionMode: 'bypassPermissions' }, noop);
    const calls = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      calls.push(command);
      const session = { id: 's1', name: 'A', command, repoPath, state: 'WORKING', exited: false, lastOutputAt: Date.now(), spawnedBy: meta?.spawnedBy, jobId: meta?.jobId };
      sessions.set(session.id, session);
      return { session };
    }, noop, {});
    expect(calls).toHaveLength(1);
    expect(parseCommand(calls[0]).file).toBe('codex');
    expect(parseCommand(calls[0]).args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('reading the agent off a card', () => {
  it('falls back to claude for anything hand-edited into config.json, and for no card at all', () => {
    // The stored value is re-checked against the allowlist on every read, so a
    // card holding a value that is not a CLI never reaches the argv as one.
    expect(jobAgent({ agent: 'gemini' })).toBe('claude');
    expect(jobAgent({ agent: 'codex --yolo' })).toBe('claude');
    expect(jobAgent(null)).toBe('claude');
    expect(createJob({ title: 't', repoPath: REPO, agent: null }).job.agent).toBe('claude');
  });

  it('judges the executable the way the MCP-config gate does: basename, extension stripped', () => {
    expect(jobAgentFromCommand('codexy --flag')).toBe('claude');
    expect(jobAgentFromCommand('codex-foo')).toBe('claude');
    expect(jobAgentFromCommand('  codex')).toBe('codex');
    expect(jobAgentFromCommand(42)).toBe('claude');
    expect(jobAgentFromCommand('/usr/local/bin/codex --model o3')).toBe('codex');
    expect(jobAgentFromCommand('"codex" --model o3')).toBe('codex');
    expect(jobAgentFromCommand('codex.cmd')).toBe('codex');
    // npx is the executable; what it runs is not the board's business.
    expect(jobAgentFromCommand('npx codex')).toBe('claude');
  });

  it('refuses a non-string agent without echoing it, and bounds a long one', () => {
    expect(createJob({ title: 't', repoPath: REPO, agent: { x: 1 } }).error).toMatch(/Unknown agent a object/);
    const long = 'x'.repeat(500);
    const err = createJob({ title: 't', repoPath: REPO, agent: long }).error;
    expect(err).toContain('x'.repeat(40));
    expect(err.length).toBeLessThan(120);
  });

  it('gives a scheduled codex card the scheduled suffix, which names no ship skill', () => {
    // scheduledPromptSuffix ignores the agent: a scheduled run opens no PR, so
    // neither spelling belongs there.
    const prompt = buildJobPrompt(createJob({ title: 't', repoPath: REPO, agent: 'codex', type: 'scheduled', schedule: '@daily' }).job);
    expect(prompt).toContain('scheduled run');
    expect(prompt).not.toMatch(/[$/]ship/);
  });
});

describe('the summary an agent reads', () => {
  beforeEach(resetBoard);

  it('names the CLI each card runs on', () => {
    addJob({ title: 'c', repoPath: REPO, agent: 'codex' }, noop);
    addJob({ title: 'old', repoPath: REPO }, noop);
    delete allJobs()[1].agent;   // a card written before the field existed
    expect(listJobsForAgent().jobs.map(j => j.agent)).toEqual(['codex', 'claude']);
  });
});

describe('postJobForAgent edges', () => {
  beforeEach(resetBoard);

  it('treats a session with no command, and an empty agent, as the poster CLI or claude', () => {
    expect(postJobForAgent({ title: 'x', session: { name: 'A', repoPath: REPO } }, noop).job.agent).toBe('claude');
    // '' is "unnamed", so it still follows the poster rather than forcing claude.
    expect(postJobForAgent({ title: 'x', agent: '', session: { name: 'A', command: 'codex', repoPath: REPO } }, noop).job.agent).toBe('codex');
  });

  it('refuses an agent outside the allowlist as a plain error', () => {
    expect(postJobForAgent({ title: 'x', repo: REPO, agent: 'gemini' }, noop).error).toMatch(/Unknown agent/);
    expect(allJobs()).toHaveLength(0);
  });
});

describe('updateJob and the agent field', () => {
  beforeEach(resetBoard);

  it('leaves the agent alone when the edit does not mention it', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO, agent: 'codex' }, noop);
    updateJob(job.id, { title: 'renamed' }, noop);
    expect(allJobs()[0].agent).toBe('codex');
    expect(allJobs()[0].title).toBe('renamed');
  });

  it('refuses a bad agent before touching anything else on the card', () => {
    const { job } = addJob({ title: 'x', repoPath: REPO }, noop);
    expect(updateJob(job.id, { title: 'renamed', agent: 'gemini' }, noop).error).toMatch(/Unknown agent/);
    expect(allJobs()[0].title).toBe('x');
    expect(allJobs()[0].agent).toBe('claude');
  });
});

describe('an agent retuned while the card is spawning', () => {
  beforeEach(resetBoard);

  // Same hazard as a permission mode changed mid-spawn: the argv was built
  // before the await in createSession, so a card switched to codex while its
  // claude process was starting would run claude with the board saying codex.
  it('does not claim the card, kills the spawn, and leaves it in To do with the new agent', async () => {
    const { job } = addJob({ title: 'switched', repoPath: REPO }, noop);
    updateSettings({ running: true }, noop);
    const calls = [];
    const killed = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      calls.push(command);
      const session = { id: 's1', name: 'A', command, repoPath, state: 'WORKING', exited: false, lastOutputAt: Date.now(), spawnedBy: meta?.spawnedBy, jobId: meta?.jobId };
      sessions.set(session.id, session);
      updateJob(job.id, { agent: 'codex' }, noop);   // stands in for the WS handler
      return { session };
    }, noop, { killSession: async (id) => { killed.push(id); } });
    expect(parseCommand(calls[0]).file).toBe('claude');
    expect(killed).toEqual(['s1']);
    expect(allJobs()[0].state).toBe('todo');
    expect(allJobs()[0].agentSessionId).toBeNull();
    expect(allJobs()[0].agent).toBe('codex');
  });

  // The recheck compares the argv itself, so an edit to anything the prompt
  // is built from — here the title — abandons the spawn too, and the next
  // tick sends the card out as it now reads rather than as it was.
  it('does not claim a card whose text was edited mid-spawn either', async () => {
    const { job } = addJob({ title: 'before', repoPath: REPO }, noop);
    updateSettings({ running: true }, noop);
    const killed = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      const session = { id: 's1', name: 'A', command, repoPath, state: 'WORKING', exited: false, lastOutputAt: Date.now(), spawnedBy: meta?.spawnedBy, jobId: meta?.jobId };
      sessions.set(session.id, session);
      updateJob(job.id, { title: 'after' }, noop);
      return { session };
    }, noop, { killSession: async (id) => { killed.push(id); } });
    expect(killed).toEqual(['s1']);
    expect(allJobs()[0].state).toBe('todo');
    expect(allJobs()[0].title).toBe('after');
  });

  it('does not claim a card repointed at another repo mid-spawn', async () => {
    const other = mkdtempSync(join(tmpdir(), 'a007-jobagent-other-'));
    config.repos.push({ path: other });
    const { job } = addJob({ title: 'moving', repoPath: REPO }, noop);
    updateSettings({ running: true }, noop);
    const killed = [];
    await dispatchOnce(async (command, name, repoPath, branch, ownerId, meta) => {
      const session = { id: 's1', name: 'A', command, repoPath, state: 'WORKING', exited: false, lastOutputAt: Date.now(), spawnedBy: meta?.spawnedBy, jobId: meta?.jobId };
      sessions.set(session.id, session);
      updateJob(job.id, { repoPath: other }, noop);
      return { session };
    }, noop, { killSession: async (id) => { killed.push(id); } });
    expect(killed).toEqual(['s1']);
    expect(allJobs()[0].state).toBe('todo');
    expect(allJobs()[0].worktreePath ?? null).toBeNull();
  });
});
