// Agent mode: with AGENT_TOKEN set, this checkout serves no pages and no login. It answers a
// fixed part of the API for a main dashboard on another machine (see server/servers.js), which
// sends the token as "Authorization: Bearer <token>". Terminal, Docker, power use and alerts stay
// local to each machine.
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const TOKEN = process.env.AGENT_TOKEN || '';
// Optional comma-separated client addresses allowed to connect, e.g. the main dashboard's.
const ALLOW = (process.env.AGENT_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);

const enabled = Boolean(TOKEN);

// What the main dashboard's System, Apps (services), Updates and Files pages use.
const ROUTES = [
  /^\/api\/config$/,
  /^\/api\/status$/,
  /^\/api\/apps\/[\w-]+\/\w+$/,
  /^\/api\/history\/(system|apps)$/,
  /^\/api\/system$/,
  /^\/api\/system\/power\/\w+$/,
  /^\/api\/updates(\/[\w-]+)?$/,
  /^\/api\/job$/,
  /^\/api\/files(\/\w+)?$/,
];

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
const address = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

function authorize(req, pathname) {
  if (ALLOW.length && !ALLOW.includes(address(req))) throw new HttpError(403, 'not allowed');
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given || !crypto.timingSafeEqual(digest(given), digest(TOKEN))) throw new HttpError(401, 'bad token');
  if (!ROUTES.some((pattern) => pattern.test(pathname))) throw new HttpError(404, 'not found');
}

module.exports = { enabled, authorize };
