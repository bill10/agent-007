# Agent 007 — Multiplayer (Centralized, Per-User) Design

Status: **Draft spec.** Not yet implemented. Supersedes the "Future: Multiplayer"
paragraphs in `product-design.md` (which assumed a *federated* model). This spec
adopts the **centralized** model implied by hosting on an always-on Mac mini.

## Decisions (locked)

1. **Centralized server, per-user identity.** One agent-007 server runs on the
   Mac mini. Everyone connects to it as an authenticated client. All PTYs run on
   the mini. Each connected client is a distinct, named **user**.
2. **Ownership per agent.** Every agent (session) has an `ownerId` — the user who
   spawned it. A user has full control of their own agents.
3. **Read-only for non-owners.** You can *watch* a colleague's agent (live
   terminal stream, office tile), but you cannot type into it, resize it, kill
   it, or upload to it. This is the boundary set in the original design review.
4. **Remote reach via Tailscale**, not router port-forwarding (home connection is
   almost certainly behind CGNAT). See "Networking" below.

## Trust model (read this first)

This is the load-bearing security section. Be honest about what it does and does
not give you.

- **Every authenticated user can spawn their own agent, which is a shell on the
  mini.** Read-only-for-others is a *collaboration* boundary, not a *security*
  sandbox. Any user who can log in effectively has shell access to the Mac mini
  with the mini's filesystem and credentials. **Only issue tokens to people you'd
  give an SSH login.** For a trusted two-person team this is fine; it is not a
  model for untrusted users.
- **Terminal output is shared.** Because read-only viewing streams a colleague's
  PTY output to their screen, secrets printed in any terminal are visible to all
  logged-in users. Acceptable for a trusted team; state it plainly.
- **Transport is encrypted and access is gated by Tailscale** (WireGuard + device
  ACLs). The app's own token auth is the second factor and the source of *identity*
  (which user is which). Do not expose the server on the public internet without
  Tailscale/Cloudflare Access in front — the app's token auth alone is not
  hardened against internet-scale abuse.

## Networking (reaching the mini behind home NAT)

Home ISPs typically use CGNAT, so there is no forwardable public IP and classic
router port-forwarding silently fails. Use an outbound mesh instead:

- **Tailscale (recommended).** Install on the mini and each client. SSH via
  Tailscale SSH; reach the web app with `tailscale serve 7007` (gives HTTPS on a
  tailnet hostname) or by binding the server to the tailscale interface. Invite
  your colleague to the tailnet for multiplayer. Tailscale ACLs are the outer
  trust boundary.
- **Cloudflare Tunnel** as an alternative when you want a shareable `https://`
  URL without adding people to a tailnet; gate it with Cloudflare Access.

Check for CGNAT: router WAN IP vs. whatsmyip — if they differ, port-forwarding is
out and Tailscale is the answer.

## Data model changes

### Users (new)
Persisted in `~/.agent-007/config.json` under a new `users` array:
```js
{ id, displayName, color, tokenHash }   // token stored hashed, never plaintext
```
- `id` — stable short id (e.g. `u_ab12`).
- `color` — per-user accent for office labels/tiles (distinct from per-agent color).
- Tokens minted by a small admin CLI (`npm run adduser -- "Alice"`) that prints
  the plaintext token once and stores only its hash. Rotating = re-mint.

### Session (extended)
Add to the in-memory session object and to `saveActiveSession()`
(`server/config.js:51`):
```js
session.ownerId          // user id of spawner
```
`sessionPayload()` (`server/ws.js`) gains `ownerId`, `ownerName`, `ownerColor`
so clients can render ownership and enforce read-only in the UI.

### Presence (new, in-memory only)
Derived from connected WebSocket clients: `[{ userId, displayName, color }]`,
broadcast on connect/disconnect as `{ type: 'presence', users: [...] }`.

## Auth flow

1. **Login page** served before the app. User pastes their token (or opens a
   `?token=...` link once, which is stored in `localStorage` and stripped from
   the URL). No passwords.
2. **WebSocket handshake** carries the token (subprotocol or first `auth`
   message). `verifyClient` / the connection handler resolves token → user, or
   closes with a 4401 code. Unauthenticated sockets are rejected.
3. **HTTP** `/api/*` routes require the same token (Authorization header or
   cookie). Static assets for the login page stay public; the app shell requires
   auth.
4. `ws.user` is attached to the connection for the rest of its lifetime and used
   for every authorization check.

## Authorization matrix (WS message router, `server/ws.js`)

Enforced server-side. The UI *also* hides disallowed actions, but the server is
the source of truth — never trust the client.

| Message            | Owner | Non-owner | Notes |
|--------------------|:-----:|:---------:|-------|
| `spawn`            |  n/a  |    n/a    | Any authed user; new session owned by them |
| `pty-input`        |  ✅   |    ❌     | **The core read-only gate** |
| `pty-resize`       |  ✅   |    ❌     | Only the owner drives PTY dimensions (see below) |
| `kill`             |  ✅   |    ❌     | |
| `upload-file`      |  ✅   |    ❌     | |
| `refresh-tree`     |  ✅   |    ❌     | Mutates scan state; owner only |
| `re-adopt-orphan`  |  ✅*  |    ❌     | *Owner of the orphan (persist ownerId on orphans too) |
| `delete-orphan`    |  ✅*  |    ❌     | |
| `add-repo`/`remove-repo` | — | — | Shared resource; any authed user (log the actor) |
| `get-diff`         |  ✅   |    ✅     | Read-only; allowed for all |
| `get-full-tree`    |  ✅   |    ✅     | Read-only; allowed for all |
| `pty-output` (recv)|  ✅   |    ✅     | Broadcast to all — this is how viewing works |

Rejected mutations get a `{ type: 'notification', level: 'error', message:
'Read-only — owned by <name>' }` back to the sender, not silent drops.

## The read-only terminal (trickiest bit)

Output already broadcasts to every client (`server/pty.js:28`), so viewers
receive the stream for free. The hard part is **sizing**: today every browser
calls `pty-resize`, but a PTY has one set of dimensions. Rule:

- **Only the owner's active client drives `pty-resize`.** Viewers never send it.
- Viewer terminals render the owner's stream **display-only**: `xterm` with input
  disabled, no resize emitted, content wrapped/letterboxed to fit. Minor visual
  imperfection when viewer and owner window sizes differ is acceptable for
  view-only.
- Viewer UI: a "view-only — owned by <name>" banner and a disabled input line.

## Office UI changes (`public/modules/office.js`)

- Client learns `currentUserId` at login and `ownerId` per session.
- **Your** agents render as today. **Others'** agents render **dimmed** with the
  owner's name label and owner color accent (matches the original design's
  "colleague agents appear dimmed with name labels").
- Clicking your agent → full terminal. Clicking someone else's → read-only
  terminal (above).
- Presence strip: small avatars/initials of who's online.

## Phased plan

Each phase is independently shippable and leaves the app working.

- **Phase 0 — Remote-access foundation (no multiplayer yet).** ✅ **Shipped** (#3).
  Make `HOST` bind and an **allowed-origins allowlist** env-configurable,
  replacing the hardcoded `127.0.0.1` checks in `server.js`, `server/http.js`,
  and `server/ws.js`. Write the Tailscale setup doc. Ships "reach my own server
  remotely" and de-risks networking before any multiplayer logic.
  Effort: **S** (CC ~20 min).

- **Phase 1 — Identity & auth.** ✅ **Shipped.**
  Users in a separate `~/.agent-007/users.json` + `adduser` CLI, login overlay,
  token-gated WS + HTTP (`server/auth.js`), `ws.user`, presence broadcast. Auth
  stays **off until the first user is created**, preserving zero-config localhost.
  Still single-owner behavior (everyone can do everything) — this phase only
  *establishes who is who*. Effort: **M**.

- **Phase 2 — Ownership & authorization.** ✅ **Shipped.**
  `ownerId` on sessions + orphans + persistence; `sessionPayload` carries
  `ownerId`/`ownerName`/`ownerColor`; the authorization matrix is enforced
  server-side (`owns()` in `server/ws.js`) with rejection notifications — input/
  resize are silently dropped for non-owners, discrete actions (kill, upload,
  refresh, orphan re-adopt/delete) get a read-only notice; read paths stay open.
  A minimal client guard blocks typing into terminals you don't own. Read-only is
  now *enforced* even if the UI lies. (Enforcement only when auth is enabled.)
  Effort: **M**.

- **Phase 3 — Multiplayer office UI.**
  Dimmed colleague tiles + name/color labels, read-only terminal (input disabled,
  no viewer resize), presence strip. Effort: **M–L**.

- **Phase 4 — Polish & safety.**
  Per-user spawn caps/rate limiting, an audit log of spawn/kill/repo actions,
  and the trust-model doc surfaced in README. Effort: **S–M**.

## Open questions

1. **Repo/worktree ownership.** Repos are a shared resource today. Do colleague
   agents spawn into the *same* repo list, and should worktree branches be
   namespaced per user (`alice/martini` vs `bill/martini`)? Current branch naming
   already uses `{git-username}/` — may need per-user git identity on the mini.
2. **Orphan ownership.** Orphans currently have no owner; Phase 2 must add
   `ownerId` to the orphan record so re-adopt/delete authorization works.
3. **Admin role?** Is there a "host" user who can kill/adopt anyone's agent
   (useful when a colleague leaves an agent stuck), or is ownership absolute?
4. **Token delivery** — share via the tailnet, or a one-time `?token=` link?
