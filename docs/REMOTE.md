# Running Agent 007 remotely

By default the server binds to `127.0.0.1` and is reachable only from the machine
it runs on. This is the safe default: **the app spawns real shells, so anyone who
can reach it effectively has terminal access to the host.** Follow this guide to
reach it from another machine *without* exposing it to the public internet.

> This guide enables *you* to reach *your own* server remotely. Per-user login
> now exists (`npm run adduser` — see the README "Multiplayer & login" section),
> but it establishes **identity, not isolation**: every logged-in user can still
> spawn shells on the host, and read-only sharing of others' agents is a later
> phase (`docs/designs/multiplayer.md`). Keep the server behind Tailscale and
> only issue tokens to people you'd give an SSH login.

## Recommended: Tailscale

A home connection is almost always behind **CGNAT**, so forwarding a port on your
router usually won't work at all, and exposing SSH/HTTP to the internet is a
brute-force magnet. Tailscale sidesteps both: the host dials *out* and joins a
private WireGuard mesh, so nothing on the router needs changing.

**Quick CGNAT check:** compare the WAN IP shown in your router admin against
[whatismyip.com](https://whatismyip.com). If they differ, you're behind CGNAT and
port-forwarding can't work — use Tailscale.

### Setup (Mac mini host)

1. Install Tailscale on the **host** (the Mac mini) and on each **client** (your
   laptop). Sign both into the same tailnet.
2. Note the host's tailnet name, e.g. `mac-mini.tailXXXX.ts.net`.
3. Start the server so it accepts connections from the tailnet, and tell it which
   remote origin the browser will use:

   ```bash
   HOST=0.0.0.0 \
   ALLOWED_ORIGINS=mac-mini.tailXXXX.ts.net \
   npm start
   ```

   `HOST=0.0.0.0` binds all interfaces (Tailscale is the access boundary).
   `ALLOWED_ORIGINS` whitelists the hostname your browser reports — without it,
   the cross-origin check rejects the remote browser.
4. From the client, open `http://mac-mini.tailXXXX.ts.net:7007`.

### Nicer: `tailscale serve` (HTTPS, no open port)

Keep the server localhost-only and let Tailscale terminate TLS and proxy it:

```bash
# terminal 1 — default localhost bind is fine
npm start

# terminal 2
tailscale serve 7007
```

Tailscale serves it at `https://mac-mini.tailXXXX.ts.net` (port 443). Because the
proxied request arrives from localhost, the default origin check passes — but if
the browser's `Origin` is the tailnet hostname you may still need
`ALLOWED_ORIGINS=mac-mini.tailXXXX.ts.net`. This is the most secure option: no
extra port is open and traffic is encrypted end to end.

### SSH into the host too

Enable **Tailscale SSH** and reach the mini with `ssh you@mac-mini` — key-free and
gated by tailnet ACLs. Useful for starting/restarting the server.

## Alternative: Cloudflare Tunnel

If you'd rather share a real `https://` URL without adding people to a tailnet,
run `cloudflared` on the host (it dials out — no open ports) and gate the app with
**Cloudflare Access** (email/SSO allowlist). Set
`ALLOWED_ORIGINS=<your-cloudflare-hostname>`.

## Not recommended: router port-forwarding

Only works if you have a real public IP (not CGNAT), and exposes the host to the
internet. If you must, put it behind an authenticating reverse proxy — never
expose the raw server.

## Environment variables

| Variable          | Default     | Purpose |
|-------------------|-------------|---------|
| `PORT`            | `7007`      | Listen port |
| `HOST`            | `127.0.0.1` | Bind interface. `0.0.0.0` = all interfaces (use only behind Tailscale/trusted network) |
| `ALLOWED_ORIGINS` | *(none)*    | Comma-separated extra origins allowed by the cross-origin check. Bare hostnames (`mac-mini.tailXXXX.ts.net`), `host:port` (`mac-mini:7007`), or full origins (`https://mac-mini:7007`); only the hostname is used. `*` disables the check for **any** origin — avoid it: even on the default localhost bind, `*` lets any website you visit drive this server through your browser (drive-by command execution) |

Loopback origins (`localhost`, `127.0.0.1`, `[::1]`) are always allowed regardless of `ALLOWED_ORIGINS`.

The origin check only blocks cross-origin **browser** requests — it is not access control. Non-browser clients (curl, native WebSocket) send no `Origin` and always pass. When `HOST` is remote, the network boundary (Tailscale / a trusted LAN) is what actually gates who can reach the server.
