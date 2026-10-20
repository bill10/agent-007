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
- **The server no longer cuts a healthy page whose ping replies go missing.**
  Through cloudflared or Tailscale Serve, or from a suspended tab, the
  socket's protocol-level pong could go missing while the page's own ping
  every 15 s still arrived, and the server's heartbeat dropped the connection.
  Any message from the page now counts as alive.
