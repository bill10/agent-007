// merge_check: does merging this pull request deploy something? Billion merges
// with `gh pr merge` from its own terminal and treats a merge as reversible,
// which a revert is — but a deploy the merge set off is not (issue #192). So
// before each merge it asks this, and asks the owner when the answer says to.
//
// Read-only: GitHub API GETs through the same per-repo account walk the board
// uses (ghAccountFor), never a write and never a workflow run. Split in two so
// the rules are testable without GitHub: analyzeWorkflows is pure, mergeCheck
// fetches and hands it the files.
//
// Errs towards "it deploys": a workflow it cannot read, or a filter it cannot
// evaluate, lands in `unknown`, and an unknown asks the owner like a deploy
// does. "Can't tell" must never come out as "no deploy".

import { parse } from 'yaml';
import { allJobs, ghAccountFor, runGh, parseGithubRemote } from './jobs.js';
import { config } from './state.js';
import { gitExec } from './git.js';

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

// GitHub's filter patterns (branches, tags, paths): * stops at /, ** does not,
// ? and + quantify the character before them as in a regex, [] is a class, and
// a leading ! negates. '**/x' also matches x at the root.
function globRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
    } else if (c === '*') re += '[^/]*';
    else if ('?+[]'.includes(c)) re += c;
    else re += c.replace(/[.(){}^$|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// The last pattern that matches decides, so '!' can carve out of an earlier one.
export function matchesFilters(patterns, value) {
  let hit = false;
  for (const p of patterns) {
    const neg = p.startsWith('!');
    try { if (globRegex(neg ? p.slice(1) : p).test(value)) hit = !neg; } catch { hit = true; }   // an unparseable pattern counts as a match: err towards running
  }
  return hit;
}

function branchRuns(cfg, branch) {
  if (cfg.branches) return matchesFilters(arr(cfg.branches), branch);
  if (cfg['branches-ignore']) return !matchesFilters(arr(cfg['branches-ignore']), branch);
  // A push filter that names only tags leaves branch pushes out.
  return !(cfg.tags || cfg['tags-ignore']);
}

// files null = the changed-file list could not be read: assume the filter matches.
function pathsRun(cfg, files) {
  if (!files) return true;
  if (cfg.paths) return files.some(f => matchesFilters(arr(cfg.paths), f));
  if (cfg['paths-ignore']) return files.some(f => !matchesFilters(arr(cfg['paths-ignore']), f));
  return true;
}

function triggersOf(on) {
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map(e => [String(e), {}]));
  if (on && typeof on === 'object') return Object.fromEntries(Object.entries(on).map(([k, v]) => [k, v && typeof v === 'object' ? v : {}]));
  return null;
}

const DEPLOY_NAME = /deploy|release|publish/i;
const DEPLOY_USES = [
  /^aws-actions\//i, /^google-github-actions\/deploy-/i, /^azure\/[^@]*deploy/i,
  /^amondnet\/vercel-action/i, /^nwtgck\/actions-netlify/i, /^netlify\//i, /^superfly\/flyctl-actions/i,
  /^js-devtools\/npm-publish/i, /^softprops\/action-gh-release/i, /^actions\/create-release/i,
  /^actions\/deploy-pages/i, /^peaceiris\/actions-gh-pages/i, /^cloudflare\/wrangler-action/i,
];
const DEPLOY_RUN = [
  /\bdocker\s+push\b/, /\b(?:npm|pnpm|yarn(?:\s+npm)?)\s+publish\b/, /\bvercel\b/, /\bnetlify\b/,
  /\bfly(?:ctl)?\s+deploy\b/, /\bgh\s+release\s+create\b/, /\bwrangler\s+(?:deploy|publish)\b/,
];
const TAGS = [/\bgit\s+tag\b/, /\bgh\s+release\s+create\b/, /^softprops\/action-gh-release/i, /^actions\/create-release/i];

// Why a job counts as a deploy (empty: it does not), and whether it makes a tag.
function jobSignals(id, job) {
  const why = [];
  let environment = null;
  let tags = false;
  if (job.environment) {
    environment = String(typeof job.environment === 'object' ? job.environment.name ?? '' : job.environment);
    why.push(`environment: ${environment}`);
  }
  if (DEPLOY_NAME.test(id)) why.push(`job id "${id}"`);
  if (typeof job.name === 'string' && DEPLOY_NAME.test(job.name)) why.push(`job name "${job.name}"`);
  for (const step of Array.isArray(job.steps) ? job.steps : []) {
    if (!step || typeof step !== 'object') continue;
    const uses = typeof step.uses === 'string' ? step.uses : '';
    const run = step.run == null ? '' : String(step.run);
    if (DEPLOY_USES.some(r => r.test(uses))) why.push(`uses ${uses}`);
    if (/^docker\/build-push-action/i.test(uses) && String(step.with?.push) === 'true') why.push(`uses ${uses} with push: true`);
    const hit = DEPLOY_RUN.find(r => r.test(run));
    if (hit) why.push(`runs "${run.match(hit)[0]}"`);
    if (TAGS.some(r => r.test(uses) || r.test(run))) tags = true;
  }
  return { why, environment, tags };
}

/**
 * Which workflows a merge into `base` sets off, and which of their jobs deploy.
 *
 * @param workflows [{ path, text } | { path, error }] — .github/workflows at the base
 * @param base      the PR's base branch
 * @param files     the PR's changed files, or null when they could not be read
 * @returns { triggered: [{ workflow, trigger }], matches: [{ workflow, job, trigger, why, environment }], unknown: [string], notes: [string] }
 */
export function analyzeWorkflows({ workflows, base, files }) {
  const unknown = [];
  const notes = [];
  const parsed = [];
  for (const wf of workflows) {
    if (wf.error) { unknown.push(`${wf.path}: could not read it (${wf.error})`); continue; }
    let doc;
    try { doc = parse(wf.text, { merge: true }); } catch (err) {
      unknown.push(`${wf.path}: not valid YAML (${String(err.message).split('\n')[0]})`); continue;
    }
    const on = triggersOf(doc?.on);
    if (!on || !doc.jobs || typeof doc.jobs !== 'object') { unknown.push(`${wf.path}: no readable on: or jobs:`); continue; }
    parsed.push({ path: wf.path, name: typeof doc.name === 'string' ? doc.name : wf.path, on, jobs: doc.jobs });
  }
  const byPath = new Map(parsed.map(wf => [wf.path, wf]));

  const triggered = new Map();   // path -> trigger text
  for (const wf of parsed) {
    const push = wf.on.push;
    if (push && branchRuns(push, base) && pathsRun(push, files)) {
      triggered.set(wf.path, `push to ${base}`);
      continue;
    }
    // The other common "deploy on merge": a pull_request that listens for closed.
    for (const event of ['pull_request', 'pull_request_target']) {
      const cfg = wf.on[event];
      if (cfg && arr(cfg.types).includes('closed') && branchRuns(cfg, base) && pathsRun(cfg, files)) {
        triggered.set(wf.path, `${event} closed (merged) into ${base}`);
        break;
      }
    }
  }

  // workflow_run chains, until nothing new joins.
  for (let grew = true; grew;) {
    grew = false;
    for (const wf of parsed) {
      const cfg = wf.on.workflow_run;
      if (!cfg || triggered.has(wf.path)) continue;
      if ((cfg.branches || cfg['branches-ignore']) && !branchRuns(cfg, base)) continue;
      const after = parsed.find(o => triggered.has(o.path) && arr(cfg.workflows).some(n => n === o.name || n === o.path));
      if (after) { triggered.set(wf.path, `workflow_run after "${after.name}"`); grew = true; }
    }
  }

  const matches = [];
  let tagMaker = null;
  // Each triggered job, plus the jobs of a local reusable workflow it calls.
  const visit = (wf, trigger, seen = new Set()) => {
    if (seen.has(wf.path)) return;
    seen.add(wf.path);
    for (const [id, job] of Object.entries(wf.jobs)) {
      if (!job || typeof job !== 'object') continue;
      const s = jobSignals(id, job);
      if (s.tags && !tagMaker) tagMaker = wf.path;
      if (s.why.length) matches.push({ workflow: wf.path, job: id, trigger, why: s.why, environment: s.environment });
      if (typeof job.uses === 'string') {
        const local = job.uses.startsWith('./') ? byPath.get(job.uses.slice(2).replace(/@.*$/, '')) : null;
        if (local) visit(local, `${trigger}, called from ${wf.path} job ${id}`, seen);
        else if (!s.why.length) unknown.push(`${wf.path} job ${id}: calls ${job.uses}, which merge_check cannot see inside`);
      }
    }
  };
  for (const [path, trigger] of triggered) visit(byPath.get(path), trigger);

  // Release and tag-push workflows run only when something makes a tag.
  const onTag = parsed.filter(wf => !triggered.has(wf.path)
    && (wf.on.release || wf.on.create || (wf.on.push && (wf.on.push.tags || wf.on.push['tags-ignore']))));
  if (onTag.length && tagMaker) {
    for (const wf of onTag) {
      triggered.set(wf.path, `tag/release made by ${tagMaker} (runs only if that tag is pushed with a token other than GITHUB_TOKEN)`);
      visit(wf, triggered.get(wf.path));
    }
  } else if (onTag.length) {
    notes.push(`Not counted: ${onTag.map(wf => wf.path).join(', ')} run on a tag or release, and nothing this merge runs makes one.`);
  }

  return {
    triggered: [...triggered].map(([workflow, trigger]) => ({ workflow, trigger })),
    matches, unknown, notes,
  };
}

const PR_URL = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
const errLine = (err) => String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 200);

// The configured repo whose origin is this slug, for its policy and account.
async function repoForSlug(slug) {
  for (const repo of config.repos || []) {
    try {
      const r = parseGithubRemote(await gitExec(['-C', repo.path, 'remote', 'get-url', 'origin']));
      if (r && `${r.owner}/${r.name}`.toLowerCase() === slug.toLowerCase()) return repo.path;
    } catch { /* not a repo any more */ }
  }
  return null;
}

/**
 * The whole check for a card id or PR URL.
 *
 * @returns { pr, repo, deploys, triggered, matches, unknown, environments, notes } or { error }
 */
export async function mergeCheck(ref, {
  jobs = allJobs(), findRepo = repoForSlug, accountFor = ghAccountFor,
  gh = (args, token) => runGh(args, { token, timeout: 20_000 }),
} = {}) {
  const text = String(ref || '').trim();
  let url = text;
  let repoPath = null;
  if (!PR_URL.test(text)) {
    const job = jobs.find(j => j.id === text);
    if (!job) return { error: `"${text}" is neither a pull request URL nor a card id on the board.` };
    if (!job.prUrl) return { error: `Card "${job.title}" has no pull request yet.` };
    url = job.prUrl;
    repoPath = job.repoPath || null;
  }
  const [, owner, name, number] = PR_URL.exec(url);
  const slug = `${owner}/${name}`;
  repoPath = repoPath || await findRepo(slug);
  let token;
  try { token = (await accountFor(repoPath || slug, { remoteUrl: async () => `https://github.com/${slug}` }))?.token; } catch { /* gh picks */ }
  const api = (args) => gh(['api', ...args], token);

  let pr;
  try { pr = JSON.parse(await api([`repos/${slug}/pulls/${number}`])); } catch (err) {
    return { error: `Could not read ${slug}#${number} (${errLine(err)}), so whether merging it deploys is unknown.` };
  }
  const base = pr.base?.ref;
  const ref_ = encodeURIComponent(base);
  const unknown = [];
  const notes = [];

  let files = null;
  try {
    files = String(await api(['--paginate', `repos/${slug}/pulls/${number}/files?per_page=100`, '--jq', '.[].filename'])).split('\n').filter(Boolean);
    if (Number.isFinite(pr.changed_files) && files.length < pr.changed_files) {
      notes.push(`GitHub listed ${files.length} of ${pr.changed_files} changed files; path filters were taken as matching.`);
      files = null;
    }
  } catch (err) { unknown.push(`changed files: ${errLine(err)}`); }

  const workflows = [];
  try {
    const listing = JSON.parse(await api([`repos/${slug}/contents/.github/workflows?ref=${ref_}`]));
    for (const item of Array.isArray(listing) ? listing : []) {
      if (item.type !== 'file' || !/\.ya?ml$/i.test(item.name)) continue;
      try {
        const path = item.path.split('/').map(encodeURIComponent).join('/');
        workflows.push({ path: item.path, text: String(await api(['-H', 'Accept: application/vnd.github.raw', `repos/${slug}/contents/${path}?ref=${ref_}`])) });
      } catch (err) { workflows.push({ path: item.path, error: errLine(err) }); }
    }
  } catch (err) {
    if (/HTTP 404/.test(String(err?.stderr || err?.message))) notes.push(`${base} has no .github/workflows.`);
    else unknown.push(`.github/workflows: ${errLine(err)}`);
  }

  let environments = [];
  try { environments = String(await api([`repos/${slug}/environments`, '--jq', '.environments[].name'])).split('\n').filter(Boolean); } catch (err) {
    notes.push(`Could not list the repo's environments (${errLine(err)}).`);
  }

  const found = analyzeWorkflows({ workflows, base, files });
  return {
    pr: { url: pr.html_url || url, number: Number(number), title: pr.title || '', base, state: pr.merged ? 'merged' : pr.state },
    repo: slug,
    deploys: found.matches.length > 0,
    triggered: found.triggered,
    matches: found.matches,
    unknown: [...unknown, ...found.unknown],
    environments,
    notes: [...notes, ...found.notes],
  };
}
