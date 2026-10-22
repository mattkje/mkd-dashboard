// Password login with sessions that survive restarts, and a lockout after repeated failures.
const crypto = require('node:crypto');
const { HttpError, readJson } = require('./http');
const stored = require('./state');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'mkd_session';
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Keyed by a hash of the token, so the sessions file is useless to whoever reads it.
const sessions = new Map();
const failures = new Map();
const logoutListeners = [];

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function loadSessions() {
  const now = Date.now();
  for (const [key, expires] of Object.entries(stored.load('sessions.json', {}))) {
    if (expires > now) sessions.set(key, expires);
  }
}

function saveSessions() {
  stored.save('sessions.json', Object.fromEntries(sessions));
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((part) => {
      const i = part.indexOf('=');
      const value = part.slice(i + 1).trim();
      try {
        return [part.slice(0, i).trim(), decodeURIComponent(value)];
      } catch {
        return [part.slice(0, i).trim(), value];
      }
    }),
  );
}

function sessionKey(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  return token ? hash(token) : null;
}

function isAuthed(req) {
  const key = sessionKey(req);
  const expires = key && sessions.get(key);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(key);
    saveSessions();
    return false;
  }
  return true;
}

// Behind tailscale serve every request comes from 127.0.0.1. The proxy appends the real client
// to X-Forwarded-For, so only the last entry is trustworthy; earlier ones come from the client.
function clientKey(req) {
  const remote = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && /^(127\.|::1$|::ffff:127\.)/.test(remote)) return forwarded.split(',').pop().trim();
  return remote;
}

function pruneFailures() {
  const now = Date.now();
  for (const [key, record] of failures) {
    if (record.until ? record.until < now : record.last < now - LOCKOUT_MS) failures.delete(key);
  }
}

function passwordMatches(given) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(given)).digest(),
    crypto.createHash('sha256').update(ADMIN_PASSWORD).digest(),
  );
}

// Secure everywhere except plain-HTTP development on localhost.
function sessionCookie(req, token, maxAgeMs) {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
  const secure = local && req.headers['x-forwarded-proto'] !== 'https' ? '' : '; Secure';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

async function login(req) {
  if (!ADMIN_PASSWORD) throw new HttpError(403, 'login disabled: ADMIN_PASSWORD not set');
  pruneFailures();
  const client = clientKey(req);
  const record = failures.get(client);
  if (record?.until > Date.now()) {
    const minutes = Math.ceil((record.until - Date.now()) / 60000);
    throw new HttpError(429, `too many attempts, try again in ${minutes} min`);
  }
  const { password } = await readJson(req);
  if (!passwordMatches(password || '')) {
    const count = (record?.until > 0 ? 0 : record?.count || 0) + 1;
    failures.set(client, { count, last: Date.now(), until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
    console.log(`failed login from ${client} (${count})`);
    await new Promise((r) => setTimeout(r, 1000));
    throw new HttpError(401, 'wrong password');
  }
  failures.delete(client);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(hash(token), Date.now() + SESSION_TTL_MS);
  saveSessions();
  console.log(`login from ${client}`);
  return { cookie: sessionCookie(req, token, SESSION_TTL_MS) };
}

function logout(req) {
  const key = sessionKey(req);
  if (key && sessions.delete(key)) saveSessions();
  for (const listener of logoutListeners) listener(key);
  return { cookie: sessionCookie(req, '', 0) };
}

loadSessions();

module.exports = {
  enabled: Boolean(ADMIN_PASSWORD),
  isAuthed,
  sessionKey,
  login,
  logout,
  onLogout: (listener) => logoutListeners.push(listener),
};
