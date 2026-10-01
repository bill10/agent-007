# Retiring a stale saved attempt

A worker can be absent from live sessions and the orphan registry while its
`activeSessions` record remains saved. At restart that record becomes a
`server-restart` orphan and its unfinished card can automatically resume. Retiring
the parent schedule alone does not prevent that adoption.

`retire_saved_attempt` addresses this exact case. It retires the persisted restart
intent, **not the work**. It never stops a process, completes/requeues the original
card, changes the recovery worker, deletes a worktree, or posts another run.

## Authority and evidence

The board is shared, not tenant-scoped. Only the actual registered, sole live
Billion session with `ownerId: null` can call the tool, and user accounts must be
disabled at call time. The original must remain an In progress no-PR run; it and
its parent schedule must have `postedBy: null` and `postedByBillion: true`.

1. Independently verify original/recovery processes, exclusive producer lock,
   accepted recovery results and durable publish/send/tracker state. An absent
   board session or PID alone does not prove all external work is stopped.
2. Call `read_job` for the original and obtain `saved_attempt_token`. This digest
   binds the operation to the entire saved record, including its saved timestamp,
   rather than trusting a name or card-body assertion.
3. Call `retire_saved_attempt` with `id`, `attempt_token`, a factual `reason`, and
   `external_work_verified: true`. This is an explicit operator attestation;
   the server does not verify external PIDs, locks, provider jobs or send receipts.

The server requires exactly one matching saved attempt with identical job ID,
repository, branch, worktree, agent/name, null owner and board origin. It rejects
stale tokens, another card sharing the resource, matching live **or exited/parked**
sessions, in-memory or persisted orphans, and any adoption in flight (including
one whose orphan record has disappeared). Validation and persistence have no
asynchronous gap. Other sessions and saved records are left unchanged.

## Audit and recovery behavior

One atomic config replacement moves the complete saved record from active restart
intent to `retiredSavedAttempts`, with its digest, actor session ID, timestamp,
reason and external-verification assertion. A write failure reports failure and
rolls back the in-memory transition. The receipt is independent of the card and
survives even if a card is subsequently deleted; ordinary card-history pruning
does not remove receipts. There is no tool to erase or reverse retirement.

Startup conversion ignores a retired resource even if a stale active record is
replayed. Worktree discovery also ignores it. Automatic and manual orphan
adoption check the receipt, including immediately before spawning after awaited
preparation. Requeue/move of the retired original is refused, dispatch skips it,
and relinking cannot reactivate it. The preserved worktree retains its codename.
The suppression also matches the normalized worktree path or repository/branch,
so discovery without the original job ID cannot bypass it. Intentional reuse of
that preserved resource is refused; use a separate worktree/card for follow-up.

The original stays In progress (gone) with a visible “Saved attempt retired; work
not completed” note. Its instructions, partial summary, branch and history stay
intact. Its existing schedule remains held. This operation alone does **not**
repair schedule eligibility.

## Follow-on schedule replacement after approved deployment

Do not deploy, restart or invoke this authority without the required security and
owner approval. This procedure is separate from preparing the PR.

After verified retirement, reread the original and confirm its retirement note,
and check there are no queued/active Producer runs or other eligible orphan
attempts. Use existing `retire_job` on the old **To do schedule only**, with a
reason identifying the recovery and replacement intent. Read it back archived;
retirement does not cancel already queued child runs. Then post exactly one new
recurring schedule using its full current body, repository, agent/model, cadence,
no-PR setting and recurring (`once: false`) setting. Preserve the external single
producer guard, daily budget ledger and send deduplication rules.

Read back the new card and its next firing, confirm only one active Producer
schedule, and observe actual due-run eligibility before claiming repair. Creation
arms the next cron match strictly after now, not a missed-run replay. If posting
fails, check whether a card was created before retrying. MCP posting inherits board
permission defaults and does not clone attachments; check parity before retirement
if either matters (retired schedule attachments may later be cleaned up).

The new schedule has a separate ID and run counter. Old runs keep their original
schedule ID/history; new runs cannot auto-supersede them. Existing cleanup still
operates within each old schedule's Review/Done group, never on the gone original.
No Falcon reopening, retrospective completion receipt, raw config edit or fake
original success is needed.
