// The saved worktree is the restart-resume resource. A retirement receipt
// survives removal of its job card and prevents rediscovery under another id.
import { createHash } from 'crypto';
import { resolve } from 'path';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function savedAttemptToken(record) {
  return createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');
}

export function sameAttemptResource(a, b) {
  return !!a && !!b && (
    (a.jobId && a.jobId === b.jobId)
    || (a.worktreePath && b.worktreePath && resolve(a.worktreePath) === resolve(b.worktreePath))
    || (a.repoPath && b.repoPath && resolve(a.repoPath) === resolve(b.repoPath)
      && a.branchName && a.branchName === b.branchName)
  );
}

export function savedAttemptRetirement(config, entry) {
  return (config.retiredSavedAttempts || []).find(receipt => sameAttemptResource(receipt.record, entry)) || null;
}
