// A small five-field cron parser, for the board's scheduled jobs.
//
// Written here rather than pulled in as a dependency: the app ships with four
// runtime dependencies and this is the whole of what the board needs — parse an
// expression, say whether it is valid, and answer "when does this next fire?".
// Pure and side-effect free, like the rest of lib/, so it is testable on its own.
//
// Times are the SERVER's local time. A schedule is written by the person
// sitting in front of the machine the agents run on, so local is the reading
// they mean; there is no per-user timezone anywhere else in the app either.

const FIELDS = [
  { key: 'minute', label: 'minute', min: 0, max: 59 },
  { key: 'hour', label: 'hour', min: 0, max: 23 },
  { key: 'dom', label: 'day of month', min: 1, max: 31 },
  { key: 'month', label: 'month', min: 1, max: 12 },
  // 7 is Sunday as well as 0, which is what every crontab accepts.
  { key: 'dow', label: 'day of week', min: 0, max: 7 },
];

// The shorthands people actually type. Expanded before parsing so everything
// downstream only ever deals with the five-field form.
export const CRON_MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// Bounds the stored text, for the same reason MAX_TITLE_LEN exists: this string
// is persisted in config.json and rendered on a card.
export const MAX_SCHEDULE_LEN = 120;

function parseField(text, spec) {
  const values = new Set();
  for (const part of String(text).split(',')) {
    const piece = part.trim();
    if (!piece) return { error: `Empty ${spec.label} in the schedule` };
    // `*/15` and `1-30/5` share a step suffix; `*` and `a-b` are the same rule
    // with different bounds, so normalise both into a from/to pair.
    const [rangeText, stepText, ...extra] = piece.split('/');
    if (extra.length > 0) return { error: `"${piece}" is not a valid ${spec.label}` };
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText.trim())) return { error: `"${piece}" has an invalid step for the ${spec.label}` };
      step = parseInt(stepText.trim(), 10);
      if (step < 1) return { error: `The step in "${piece}" must be 1 or more` };
    }
    let from, to;
    const range = rangeText.trim();
    if (range === '*') {
      from = spec.min;
      to = spec.max;
    } else if (/^\d+$/.test(range)) {
      from = parseInt(range, 10);
      // A bare number with a step means "from here to the end of the field",
      // which is how crontab reads `5/10`.
      to = stepText === undefined ? from : spec.max;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (!m) return { error: `"${piece}" is not a valid ${spec.label}` };
      from = parseInt(m[1], 10);
      to = parseInt(m[2], 10);
      if (from > to) return { error: `The range "${range}" runs backwards for the ${spec.label}` };
    }
    if (from < spec.min || to > spec.max) {
      return { error: `The ${spec.label} must be between ${spec.min} and ${spec.max} (got "${piece}")` };
    }
    for (let v = from; v <= to; v += step) values.add(v === 7 && spec.key === 'dow' ? 0 : v);
  }
  return { values };
}

/**
 * Parse a cron expression.
 *
 * @returns { minute, hour, dom, month, dow, domStar, dowStar, expr } — sets of
 *          the matching values — or { error } with a message written for the
 *          person who typed it.
 */
export function parseCron(expr) {
  const raw = String(expr || '').trim();
  if (!raw) return { error: 'A scheduled job needs a cron schedule (for example "0 9 * * 1-5")' };
  if (raw.length > MAX_SCHEDULE_LEN) return { error: 'That schedule is too long to be a cron expression' };
  const expanded = raw.startsWith('@') ? CRON_MACROS[raw.toLowerCase()] : raw;
  if (!expanded) return { error: `Unknown schedule shorthand "${raw}" — try ${Object.keys(CRON_MACROS).join(', ')}` };
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    return { error: `A cron schedule has five fields (minute hour day-of-month month day-of-week) — got ${parts.length}` };
  }
  const parsed = { expr: raw };
  for (let i = 0; i < FIELDS.length; i++) {
    const spec = FIELDS[i];
    const result = parseField(parts[i], spec);
    if (result.error) return { error: result.error };
    parsed[spec.key] = result.values;
  }
  // Which of the two day fields were left unrestricted, because that decides
  // how they combine — see matchesDay.
  parsed.domStar = parts[2].trim() === '*';
  parsed.dowStar = parts[4].trim() === '*';
  return parsed;
}

export function isValidCron(expr) {
  return !parseCron(expr).error;
}

// The one genuinely surprising cron rule: when BOTH day fields are restricted,
// a day matches if EITHER does (so `0 0 13 * 5` is the 13th *or* any Friday).
// When only one is restricted the other is `*` and contributes nothing.
function matchesDay(parsed, date) {
  const domHit = parsed.dom.has(date.getDate());
  const dowHit = parsed.dow.has(date.getDay());
  if (parsed.domStar) return dowHit;
  if (parsed.dowStar) return domHit;
  return domHit || dowHit;
}

// Four years covers the one expression that legitimately takes years to come
// round (Feb 29), and bounds the walk for one that never fires at all — "0 0 30
// 2 *" is syntactically fine and matches no date that will ever exist.
const SEARCH_LIMIT_MS = 4 * 366 * 24 * 60 * 60 * 1000;

/**
 * The next time the expression fires, strictly after `from`.
 *
 * @returns epoch milliseconds, or null when the expression is invalid or can
 *          never match. Walks whole months/days/hours at a time rather than
 *          minute by minute, so a yearly schedule costs a few hundred steps.
 */
export function nextCronTime(expr, from = Date.now()) {
  const parsed = parseCron(expr);
  if (parsed.error) return null;
  const limit = from + SEARCH_LIMIT_MS;
  // Strictly after: a job that just ran at 09:00 must not immediately match
  // 09:00 again and loop.
  const at = new Date(from);
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  let previous = -1;
  while (at.getTime() <= limit) {
    // Every branch below moves `at` forward, and the limit bounds the walk —
    // but all of them move it by setting LOCAL fields, and a daylight-saving
    // transition is exactly where local arithmetic can fail to advance. This
    // loop runs inside the dispatcher's scan, so it gets a belt as well as
    // braces: if a step ever fails to move the clock on, give up rather than
    // spin. (A DST skip is normal cron behaviour: an hour that does not exist
    // that day simply does not fire.)
    if (at.getTime() <= previous) return null;
    previous = at.getTime();
    if (!parsed.month.has(at.getMonth() + 1)) {
      // setMonth(m + 1, 1) rolls the year over on its own.
      at.setMonth(at.getMonth() + 1, 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(parsed, at)) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hour.has(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minute.has(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1, 0, 0);
      continue;
    }
    return at.getTime();
  }
  return null;
}

// ISO form, for storing on a job. Null when the expression will never fire
// again, so a card can say so instead of showing a date that is a lie.
export function nextCronIso(expr, from = Date.now()) {
  const at = nextCronTime(expr, from);
  return at === null ? null : new Date(at).toISOString();
}
