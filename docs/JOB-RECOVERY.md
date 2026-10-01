# Reconciling a gone schedule run

Billion's `reconcile_job(id, replacement_id, reason)` records an interruption,
not successful completion. Use it only after verifying that external work and
any exclusive producer guard have safely transferred to the replacement. This
control does not inspect, acquire, release, or remove external locks or processes.

The original must be a Billion-owned, In progress, no-PR schedule run with no
live session (including a re-adopted session) and no orphan record. Its schedule
must also belong to Billion. The replacement must be an already-running,
standalone, no-PR Billion card in the same repository and owner scope. Its
instructions must explicitly name the original card ID; unrelated cards,
self-links, and previously linked recovery cards are refused.

The call synchronously rechecks both cards and records the original in Review
with an interruption timestamp, actor session ID, reason, and replacement ID.
It preserves original instructions, partial summary, branch, worker reference,
and attachments. The replacement joins the original schedule and records the
reverse reference. Neither worker is stopped and no run is dispatched by this
operation. The original attempt cannot be requeued.

The schedule remains held while recovery runs, stalls, disappears, or reaches
Review (including a reported failure or skip). Billion must inspect the result
and accept it with `close_job`, or the owner can accept it on the board. Only a
Done recovery with a result summary and its worker reference retired releases
that hold. Rejecting the recovery for more work keeps the hold. Missing or
detached recovery cards fail closed. An archived To do recovery does not count
as accepted. Interrupted and recovery cards are retained rather than automatically
superseded or pruned.

After acceptance, inspect the schedule and its next firing. Reconciliation does
not replay missed firings, bypass pause/cap controls, or prove that external
production has finished. Deployment and a live reconciliation are separate from
preparing a code change.

| Original | Recovery | Schedule eligibility |
| --- | --- | --- |
| In progress, gone | Standalone, running | Existing original-run hold |
| Interrupted Review | In progress, running or stalled | Held |
| Interrupted Review | Worker gone / failed | Held |
| Interrupted Review | Review, success / failure / skip | Held pending reviewer acceptance |
| Interrupted Review | Requeued To do | Held |
| Interrupted Review | Done, retirement pending or failed | Held |
| Interrupted Review | Done, summary present, worker retired | Eligible under normal due/pause/cap rules |
| Interrupted Review | Missing / detached / archived without running | Held |

The authority is the authenticated Billion session controlling its own two cards
and schedule, with an exact replacement worker job/repository/owner match. The
original ID in replacement instructions corroborates intent; it does not grant
permission by itself. The server derives and persists both directions of the
binding after validation. The caller's reason is an auditable operator assertion
about external recovery, not PID verification. This adds one restricted Billion
control and does not give workers access or widen control over owner-posted cards.
