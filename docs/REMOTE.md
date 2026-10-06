# Running Agent 007 remotely

By default the server binds to `127.0.0.1` and is reachable only from the machine
it runs on. This is the safe default: **the app spawns real shells, so anyone who
can reach it effectively has terminal access to the host.** Follow this guide to
reach it from another machine *without* exposing it to the public internet.

> This guide enables *you* to reach *your own* server remotely. Per-user login
> now exists (`npm run adduser` — see the README "Multiplayer & login" section),
> but it establishes **identity, not isolation**: every logged-in user can still
> spawn shells on the host, and read-only sharing of others' agents is a later
> phase (`docs/designs/multiplayer.md`). Keep the server behind Tailscale or an
> authenticating proxy (see below) and only issue tokens to people you'd give
> an SSH login.

Three ways in, all of which leave the server on `127.0.0.1`:

- **(a) [Tailscale](#recommended-tailscale)**: `agent007 install --remote`. Your
  devices join a private network; nothing is public.
- **(b) [Cloudflare Tunnel + Access](#cloudflare-tunnel--access)**: a real
  `https://agent.example.com` that Cloudflare signs people into (email code or
  Google) before any request reaches the machine. Good for a VM with a fixed
  address, or for people you would rather not add to a tailnet.
- **(c) [WireGuard + a local certificate](#wireguard--a-local-certificate)**:
  your own WireGuard network, with caddy or nginx terminating https on the
  WireGuard address.

(b) and (c) put a reverse proxy in front: `agent007 install --public-url <url>`
sets that up (see [Behind a reverse proxy](#behind-a-reverse-proxy-public_url)).

### Security notes

- **Never expose port 7007 directly**, to the internet or to a LAN you do not
  trust. Keep `HOST=127.0.0.1` (or the WireGuard address) and let the proxy or
  Tailscale be the only way in.
- **The app assumes whatever is in front of it authenticates.** With user
  accounts off (the default), anyone the proxy lets through gets a terminal on
  the host. Cloudflare Access, a tailnet or a WireGuard peer list is the lock;
  Agent 007 adds none of its own.
- The origin check (`ALLOWED_ORIGINS`, `PUBLIC_URL`) only stops other websites
  driving your browser; it is not access control.

## One command: `agent007 install --remote`

With [Tailscale](https://tailscale.com/download) installed and logged in on the
host and on your phone or laptop (same tailnet):

```bash
agent007 install --remote          # npm start -- install --remote in a clone
```

Then open `https://<host>.<tailnet>.ts.net` on any device in your tailnet. It:

1. finds the `tailscale` CLI (on `PATH`, else inside `/Applications/Tailscale.app`
   on macOS) and checks it is running and logged in. If not, it says what to do
   (install it, or `tailscale up`) and changes nothing;
2. reads `tailscale serve status`: a port already served is kept, and another
   site on the HTTPS port (443) is never replaced: Agent 007 takes the next free
   HTTPS port (8443, then 10000) and you open `https://<name>:8443`. If all
   three are taken it says what uses them and stops;
3. runs `tailscale serve --bg [--https=<port>] <port>`, which tailscaled keeps across reboots. If
   Serve is not enabled on your tailnet, it prints the link Tailscale gives to
   enable it;
4. adds the host's ts.net name to `ALLOWED_ORIGINS` in `~/.agent-007/.env`,
   keeping any entries already there;
5. restarts Agent 007 if it is running, so the new setting takes effect.

`--dry-run` prints the changes instead of making them. `agent007 install --all`
does it after the service and voice, and plain `agent007 install` offers it when
Tailscale is installed. `agent007 doctor` checks the result. The rest of this
page is what it automates, and the other options.

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
   laptop, or your phone: the app fits a phone screen). Sign both into the same tailnet.
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

As a service (`agent007 install`), put these in `~/.agent-007/.env`: the
service reads only that file, not the `.env` of the folder you used to start it
from. `agent007 install` copies keys that file lacks from the current folder's
`.env`, and `agent007 doctor` flags a `tailscale serve` hostname missing from
`ALLOWED_ORIGINS`.

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

> **Voice input needs this HTTPS setup.** Browsers only grant microphone access
> in a secure context (HTTPS or localhost), so the in-app voice input (the
> terminal's mic button, the Billion tab's mic, `Cmd+D`) works over `tailscale serve` but not over the plain
> `http://...:7007` bind above. One boundary caveat: Web Speech recognition in
> Chrome/Edge streams the microphone audio to Google/Microsoft servers for
> transcription (Safari may process on-device), so dictated content leaves the
> tailnet even though the app's own traffic doesn't — don't dictate secrets.
> Also note the microphone permission is granted per origin: the tailnet
> hostname prompts separately from localhost, and a denial there sticks until
> you reset it in the browser's site settings for that origin.

### SSH into the host too

Enable **Tailscale SSH** and reach the mini with `ssh you@mac-mini` — key-free and
gated by tailnet ACLs. Useful for starting/restarting the server.

## Behind a reverse proxy (`PUBLIC_URL`)

Any proxy that terminates https and forwards to `http://127.0.0.1:7007` works,
as long as it passes WebSocket upgrades (the terminals, the board and Talk all
run over one WebSocket). Tell Agent 007 the address the browser uses:

```bash
agent007 install --public-url https://agent.example.com   # the service, with PUBLIC_URL; no Tailscale
# or, in a terminal:  PUBLIC_URL=https://agent.example.com agent007   (or --public-url)
```

`install --public-url` writes `PUBLIC_URL` to `~/.agent-007/.env`, then installs
and (re)starts the service bound to `127.0.0.1`. It warns if `HOST` is
`0.0.0.0`, if the URL is not https, or if a `PUBLIC_URL` set elsewhere would
win. With `--all` it takes the place of the Tailscale step. With `PUBLIC_URL`
set, the server:

- lets that hostname through the origin check for the API and the WebSocket,
  as an `ALLOWED_ORIGINS` entry would, and treats that page as your own
  browser even when the proxy sends its own `Host` header;
- believes `X-Forwarded-Proto` and `X-Forwarded-For` from a proxy on the same
  machine (loopback) and no one else;
- uses it for every link it sends out (Telegram round messages; `APP_URL`,
  its older name, still works). The page itself only uses relative URLs and
  builds its `wss://` address from the page's own, so nothing in the browser
  needs it.

`agent007 status` says which mode the server is in and what the proxy last
sent (`proxy headers: last forwarded request 2m ago: https from 203.0.113.9`);
`agent007 doctor` checks `PUBLIC_URL`, `HOST` and that requests are arriving as
https.

**Voice input and Talk to Billion work behind the proxy.** The browser decides
whether the microphone is allowed from the address it sees, so an
`https://` page from the proxy is a secure context even though Agent 007 itself
only sees plain http on localhost. The certificate must be one the browser
trusts (Cloudflare's always is; a local one must be installed on each device,
see (c)). An `http://` `PUBLIC_URL` gets no microphone.

## Cloudflare Tunnel + Access

`cloudflared` on the host dials out to Cloudflare, so the machine needs no open
port, and Cloudflare Access signs people in before a request reaches it. The
Zero Trust free plan covers up to 50 users. You need a domain on Cloudflare.

1. Install `cloudflared` on the host and create the tunnel:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create agent-007            # prints the tunnel ID
   cloudflared tunnel route dns agent-007 agent.example.com
   ```

2. `~/.cloudflared/config.yml` (or `/etc/cloudflared/config.yml` for the system
   service):

   ```yaml
   tunnel: agent-007
   credentials-file: /home/you/.cloudflared/<TUNNEL-ID>.json
   ingress:
     - hostname: agent.example.com
       service: http://127.0.0.1:7007
     - service: http_status:404
   ```

   cloudflared passes WebSockets, the browser's `Host` and
   `X-Forwarded-Proto: https` without further settings. Run it with
   `cloudflared tunnel run agent-007`, or `sudo cloudflared service install`
   to keep it running.

3. **Set the Access policy before you open the URL.** In the Zero Trust
   dashboard: *Access → Applications → Add an application → Self-hosted*,
   domain `agent.example.com`. Add a policy with action **Allow** and an
   **Include** rule of *Emails* (yours, one per person) or *Emails ending in*
   `@yourcompany.com`. Sign-in is a one-time code by email unless you add
   Google under *Settings → Authentication → Login methods*. Leave no
   *Everyone* rule: that would hand a shell to anyone with an email address.

4. On the host: `agent007 install --public-url https://agent.example.com`.

With Access in front, every request carries `Cf-Access-Authenticated-User-Email`.
Agent 007 logs each email the first time it sees it, `agent007 status` shows
the last one, and the Settings panel says *Signed in through Cloudflare Access
as …*. **That is display only: the `Cf-Access-Jwt-Assertion` token is not
verified**, so the email is whatever the header said. Access is what keeps
people out; Agent 007's own user accounts stay off. Because the server listens
on `127.0.0.1`, only programs on the host itself could send a forged header.

## WireGuard + a local certificate

With your own WireGuard network (the host at, say, `10.8.0.1`), run a proxy on
the WireGuard address that terminates https and forwards to the server on
`127.0.0.1`. A plain `HOST=10.8.0.1` bind works too, but it is http, so the
microphone is off.

Give the host a name that resolves to `10.8.0.1` on your devices (a DNS record
pointing at the private address, or each device's hosts file), e.g.
`agent.wg.example`.

**caddy** (`Caddyfile`), with its own local certificate authority:

```
https://agent.wg.example {
	bind 10.8.0.1
	tls internal
	reverse_proxy 127.0.0.1:7007
}
```

Then install caddy's root certificate
(`~/.local/share/caddy/pki/authorities/local/root.crt`, or `caddy trust` on the
host) on each phone and laptop, or the browser will not grant the microphone.
`mkcert` works the same way with any proxy.

**nginx** needs the WebSocket, `Host` and forwarded headers spelled out, and a
body limit that fits a Talk recording:

```nginx
server {
    listen 10.8.0.1:443 ssl;
    server_name agent.wg.example;
    ssl_certificate     /etc/nginx/agent.pem;
    ssl_certificate_key /etc/nginx/agent-key.pem;
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:7007;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1d;
    }
}
```

Then `agent007 install --public-url https://agent.wg.example`.

## Not recommended: router port-forwarding

Only works if you have a real public IP (not CGNAT), and exposes the host to the
internet. If you must, put it behind an authenticating reverse proxy — never
expose the raw server.

## Environment variables

| Variable          | Default     | Purpose |
|-------------------|-------------|---------|
| `PORT`            | `7007`      | Listen port |
| `HOST`            | `127.0.0.1` | Bind interface. `0.0.0.0` = all interfaces (use only behind Tailscale/trusted network) |
| `PUBLIC_URL`      | *(none)*    | The https address a reverse proxy or tunnel serves the app at. Allowed as an origin, used in links, and turns on the proxy checks in `status` and `doctor`. Only the origin is used (no path prefix) |
| `ALLOWED_ORIGINS` | *(none)*    | Comma-separated extra origins allowed by the cross-origin check. Bare hostnames (`mac-mini.tailXXXX.ts.net`), `host:port` (`mac-mini:7007`), or full origins (`https://mac-mini:7007`); only the hostname is used. `*` disables the check for **any** origin — avoid it: even on the default localhost bind, `*` lets any website you visit drive this server through your browser (drive-by command execution) |

Loopback origins (`localhost`, `127.0.0.1`, `[::1]`) are always allowed regardless of `ALLOWED_ORIGINS`, and so is `PUBLIC_URL`'s hostname.

The origin check only blocks cross-origin **browser** requests — it is not access control. Non-browser clients (curl, native WebSocket) send no `Origin` and always pass. When `HOST` is remote, the network boundary (Tailscale / a trusted LAN) is what actually gates who can reach the server; behind a proxy, the proxy's sign-in does.
