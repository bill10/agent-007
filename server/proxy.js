// What reaches the server through a reverse proxy or tunnel (docs/REMOTE.md):
// the X-Forwarded-Proto/For the proxy adds and, behind Cloudflare Access, the
// email Access signed in. Read with Express's `trust proxy` set to loopback
// (server.js), so req.protocol and req.ip are the browser's only when the
// request came from a proxy on this machine.
//
// Display only: Access's JWT (Cf-Access-Jwt-Assertion) is not verified, so the
// email is whatever arrived in Cf-Access-Authenticated-User-Email. Access is
// what keeps strangers out; this only says who it let in.

const EMAIL_HEADER = 'cf-access-authenticated-user-email';
let seen = null;
const logged = new Set();

export const accessEmail = (req) => String(req.headers[EMAIL_HEADER] || '').trim().slice(0, 254) || null;

// Express middleware: notes the newest forwarded request, logs each Access
// email once.
export function noteProxy(req, res, next) {
  const email = accessEmail(req);
  if (req.headers['x-forwarded-proto'] || req.headers['x-forwarded-for'] || email) {
    seen = { at: Date.now(), proto: req.protocol, ip: req.ip, email };
    // ponytail: the set grows by one per distinct email; Access caps who that can be.
    if (email && !logged.has(email)) {
      logged.add(email);
      console.log(`  Cloudflare Access: ${email} signed in (header, not verified)`);
    }
  }
  next();
}

// The newest forwarded request since the server started, or null.
export const proxySeen = () => seen;
