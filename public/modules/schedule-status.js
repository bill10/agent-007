// Render the server's passive snapshot. Do not advance its clock in the browser:
// browser/server clocks and timezones can differ, and this is observed evidence.
export function renderScheduleStatus(status, openRun, { expanded = false, onToggle = () => {} } = {}) {
  if (!status) return null;
  const box = document.createElement('div');
  box.className = `job-schedule-status${status.attention ? ' job-schedule-attention' : ''}`;
  const title = document.createElement('strong');
  title.textContent = status.label;
  box.appendChild(title);
  const note = document.createElement('div');
  note.textContent = [status.reason, status.action].filter(Boolean).join(' ');
  box.appendChild(note);
  if (status.blocker) {
    const link = document.createElement('button');
    link.className = 'job-card-lastrun';
    link.textContent = `Inspect blocker: ${status.blocker.agentName || status.blocker.id} (${status.blocker.status || status.blocker.state})`;
    link.onclick = e => { e.stopPropagation(); openRun(status.blocker.id); };
    box.appendChild(link);
  }
  const details = document.createElement('details');
  details.open = expanded;
  details.ontoggle = () => onToggle(details.open);
  const summary = document.createElement('summary');
  summary.textContent = 'Firing evidence';
  details.appendChild(summary);
  const evidence = document.createElement('div');
  evidence.className = 'job-schedule-evidence';
  const run = status.lastRun;
  evidence.textContent = [
    `Last expected (saved due): ${status.lastExpectedAt || 'not recorded'}`,
    `Observed: ${status.observedAt || 'not recorded'}${status.outcome ? ` (${status.outcome})` : ''}`,
    `Last run posted: ${status.lastRunAt || 'not recorded'}${run ? ` · ${run.id} (${run.status || run.state})` : ''}`,
    ...(run?.startedAt ? [`Worker started: ${run.startedAt}`] : []),
    ...(run?.doneAt ? [`Run finished: ${run.doneAt}`] : []),
    `Next saved due: ${status.nextDueAt || 'none'}`,
    `Server timezone: ${status.timeZone} · scan interval ${status.graceMs / 1000}s`,
    `Snapshot: ${status.checkedAt}`,
  ].join('\n');
  details.appendChild(evidence);
  box.appendChild(details);
  return box;
}
