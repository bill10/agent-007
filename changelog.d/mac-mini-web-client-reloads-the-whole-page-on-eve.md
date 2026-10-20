---
bump: patch
---
### Fixed

- **The page no longer reloads every time its connection drops.** Behind
  Tailscale Serve, a Cloudflare tunnel or any proxy, an idle timeout or a
  network blip dropped the socket, and every reconnect reloaded the whole
  page. Now the page reconnects in place: closed tabs go, the terminal on
  screen gets its scrollback again, and the chat, board and status resync from
  the server. It reloads only when the server itself restarted or updated,
  which it tells apart by a boot id the server sends in its welcome.
