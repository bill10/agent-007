---
bump: minor
---
### Added

- **Remote access without Tailscale: run Agent 007 behind Cloudflare Tunnel + Access, caddy or nginx at your own https address.** `agent007 install --public-url https://agent.example.com` writes `PUBLIC_URL` to `~/.agent-007/.env` and installs the service bound to `127.0.0.1`, no Tailscale involved (`--public-url` also works when starting in a terminal). With `PUBLIC_URL` set, that hostname passes the origin check for the API and WebSocket, a proxy on the same machine is believed about `X-Forwarded-Proto/For`, and Telegram links use it. Voice input and Talk to Billion work, since the browser sees https from the proxy. `agent007 status` and `doctor` say which mode is on and whether forwarded requests are arriving as https, and doctor flags a `HOST=0.0.0.0` that would bypass the proxy.
- **Shows who Cloudflare Access signed in.** Behind Access, the Settings panel and `agent007 status` show the `Cf-Access-Authenticated-User-Email`, and the server logs each email once. Display only: the Access JWT is not verified, and Agent 007's own user accounts stay off.
- **A rewritten remote access guide** (`docs/REMOTE.md`): Tailscale, Cloudflare Tunnel + Access with a copy-paste `cloudflared` config and the Access policy to set, and WireGuard with a local certificate (caddy and nginx configs), plus security notes: never expose the port directly, and the app trusts whoever the proxy lets in.
