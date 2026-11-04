// Other machines this dashboard controls, each running this checkout in agent mode
// (server/agent.js). They are listed in servers.json (not in git, it holds the tokens):
//
//   [{ "id": "prod", "name": "mkd-server-prod", "url": "http://100.125.237.48:8099", "token": "..." }]
//
// Nothing stays connected: the browser's requests for a server's pages are passed on to its agent
// one by one, and the monitor asks each agent for a short status every few minutes.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { HttpError } = require('./http');

const SERVERS_FILE = process.env.SERVERS_FILE || path.join(__dirname, '..', 'servers.json');
const ID = /^[a-z0-9-]{1,32}$/;
const HEADERS_TIMEOUT_MS = 20000;
// Response headers worth passing on (downloads, streamed logs, caching).
const PASS_BACK = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'cache-control', 'x-accel-buffering'];

// Re-read on every request, so edits apply without a restart. A broken file means no servers.
function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`servers.json: ${err.message}`);
    return [];
  }
  return (Array.isArray(raw) ? raw : []).filter((s) => {
    const ok = s && ID.test(s.id) && typeof s.token === 'string' && s.token && /^https?:\/\/[^/]+\/?$/.test(s.url || '');
    if (!ok) console.error(`servers.json: skipping invalid entry ${JSON.stringify(s?.id)}`);
    return ok;
  });
}

// What the browser may know: no URLs with ports, no tokens.
function list() {
  return load().map((s) => ({ id: s.id, name: s.name || s.id, host: new URL(s.url).hostname }));
}

function find(id) {
  const server = load().find((s) => s.id === id);
  if (!server) throw new HttpError(404, 'unknown server');
  return server;
}

function request(server, method, pathAndQuery, headers = {}) {
  const target = new URL(pathAndQuery, server.url);
  const client = target.protocol === 'https:' ? https : http;
  return client.request(target, {
    method,
    headers: { ...headers, authorization: `Bearer ${server.token}`, 'x-mkd': '1' },
  });
}

// Passes one browser request on to the server's agent, streaming both ways (uploads,
// downloads, followed logs). Closing the browser's request ends the agent's.
function proxy(req, res, id, pathAndQuery) {
  const server = find(id);
  const forward = {};
  for (const name of ['content-type', 'content-length', 'range']) if (req.headers[name]) forward[name] = req.headers[name];
  return new Promise((resolve) => {
    const upstream = request(server, req.method, pathAndQuery, forward);
    const timer = setTimeout(() => upstream.destroy(new Error('timeout')), HEADERS_TIMEOUT_MS);
    upstream.on('response', (answer) => {
      clearTimeout(timer);
      const headers = Object.fromEntries(PASS_BACK.filter((h) => answer.headers[h]).map((h) => [h, answer.headers[h]]));
      res.writeHead(answer.statusCode, headers);
      answer.pipe(res);
      answer.on('end', resolve);
    });
    upstream.on('error', (err) => {
      clearTimeout(timer);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `${server.name || server.id} isn’t answering (${err.code || err.message})` }));
      } else {
        res.destroy();
      }
      resolve();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
}

// For the monitor: true when the agent answers its system stats.
function reachable(server) {
  return new Promise((resolve) => {
    const upstream = request(server, 'GET', '/api/system');
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.on('response', (answer) => {
      answer.resume();
      resolve(answer.statusCode === 200);
    });
    upstream.on('error', () => resolve(false));
    upstream.end();
  });
}

module.exports = { load, list, proxy, reachable };
