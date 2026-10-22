// Home lab control panel. Serves the Vue frontend that `npm run build` writes to dist/,
// and an API that is entirely behind the admin password login.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Local settings from .env (any variable from the README's Environment table), before any
// module reads process.env.
// Variables that are already set win.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const auth = require('./server/auth');
const apps = require('./server/apps');
const system = require('./server/system');
const docker = require('./server/docker');
const files = require('./server/files');
const terminal = require('./server/terminal');
const monitor = require('./server/monitor');
const alerts = require('./server/alerts');
const jobs = require('./server/jobs');
const updates = require('./server/updates');
const minecraft = require('./server/minecraft');
const { HttpError, sendJson } = require('./server/http');

const PORT = Number(process.env.PORT) || 8090;
// Published on the tailnet through `tailscale serve`, so only loopback by default.
const HOST = process.env.HOST || '127.0.0.1';
const STATIC_DIR = path.join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const lines = (url) => Math.min(Math.max(Number(url.searchParams.get('lines')) || 200, 10), 5000);
const follow = (url) => url.searchParams.get('follow') === '1';
const param = (url, name) => url.searchParams.get(name);

// [method, path pattern, handler(req, res, params, url)]. A handler returns the JSON body,
// or nothing when it wrote the response itself. First match wins.
const routes = [
  ['GET', /^\/api\/config$/, (req, res, params, url) => apps.loadConfig({ raw: param(url, 'raw') === '1' })],
  ['POST', /^\/api\/config$/, (req) => apps.saveConfig(req)],
  ['GET', /^\/api\/status$/, () => apps.statusAll()],
  ['GET', /^\/api\/apps\/([\w-]+)\/logs$/, (req, res, [id], url) => (
    follow(url) ? apps.followServiceLogs(id, lines(url), res) : apps.serviceLogs(id, lines(url))
  )],
  ['POST', /^\/api\/apps\/([\w-]+)\/(\w+)$/, (req, res, [id, action]) => apps.serviceAction(id, action)],

  ['GET', /^\/api\/history\/system$/, () => monitor.systemHistory()],
  ['GET', /^\/api\/history\/apps$/, () => monitor.appHistory()],
  ['GET', /^\/api\/alerts$/, () => alerts.recent()],
  ['POST', /^\/api\/alerts\/test$/, () => alerts.test()],

  ['GET', /^\/api\/system$/, () => system.stats()],
  ['POST', /^\/api\/system\/power\/(\w+)$/, (req, res, [action]) => system.power(action)],
  ['GET', /^\/api\/updates$/, () => updates.list()],
  ['POST', /^\/api\/updates\/check$/, () => updates.check()],
  ['POST', /^\/api\/updates\/refresh$/, () => updates.refresh()],
  ['POST', /^\/api\/updates\/([\w-]+)$/, (req, res, [source]) => updates.update(source)],
  ['GET', /^\/api\/job$/, (req, res, params, url) => jobs.state(Number(param(url, 'offset')) || 0)],

  ['GET', /^\/api\/docker$/, () => docker.containers()],
  ['GET', /^\/api\/docker\/stats$/, () => docker.stats()],
  ['POST', /^\/api\/docker\/projects\/([\w.-]+)\/(\w+)$/, (req, res, [project, action]) => docker.stackAction(project, action)],
  ['POST', /^\/api\/docker\/([\w.-]+)\/update$/, (req, res, [id], url) => docker.update(id, param(url, 'project') === '1')],
  ['POST', /^\/api\/docker\/([\w.-]+)\/(\w+)$/, (req, res, [id, action]) => docker.action(id, action)],
  ['GET', /^\/api\/docker\/([\w.-]+)\/logs$/, (req, res, [id], url) => (
    follow(url) ? docker.followLogs(id, lines(url), res) : docker.logs(id, lines(url))
  )],

  ['GET', /^\/api\/files$/, (req, res, params, url) => files.list(param(url, 'path'))],
  ['GET', /^\/api\/files\/search$/, (req, res, params, url) => files.search(param(url, 'path'), param(url, 'q'))],
  ['GET', /^\/api\/files\/read$/, (req, res, params, url) => files.read(param(url, 'path'))],
  ['GET', /^\/api\/files\/download$/, (req, res, params, url) => files.download(param(url, 'path'), req, res, url.searchParams.has('inline'))],
  ['GET', /^\/api\/files\/zip$/, (req, res, params, url) => files.downloadZip(url.searchParams.getAll('path'), res)],
  ['POST', /^\/api\/files\/write$/, (req) => files.write(req)],
  ['POST', /^\/api\/files\/mkdir$/, (req) => files.mkdir(req)],
  ['POST', /^\/api\/files\/rename$/, (req) => files.rename(req)],
  ['POST', /^\/api\/files\/move$/, (req) => files.move(req)],
  ['POST', /^\/api\/files\/delete$/, (req) => files.remove(req)],
  ['POST', /^\/api\/files\/upload$/, (req, res, params, url) => files.upload(
    req, param(url, 'path'), param(url, 'name'), param(url, 'overwrite') === '1',
  )],

  ['GET', /^\/api\/minecraft$/, () => minecraft.overview()],
  ['POST', /^\/api\/minecraft\/command$/, (req) => minecraft.command(req)],

  ['GET', /^\/api\/terminal\/sessions$/, () => terminal.sessions()],
  ['POST', /^\/api\/terminal\/sessions\/([\w.-]+)\/kill$/, (req, res, [name]) => terminal.killSession(name)],
];

async function handleApi(req, res, url) {
  const { pathname } = url;
  if (pathname === '/api/session') {
    const authed = auth.isAuthed(req);
    return sendJson(res, 200, { enabled: auth.enabled, authed, minecraft: authed && minecraft.enabled });
  }

  // Custom header blocks cross-site form posts (CSRF) on top of the SameSite cookie.
  if (req.method === 'POST' && req.headers['x-mkd'] !== '1') throw new HttpError(403, 'missing header');

  if (pathname === '/api/login' && req.method === 'POST') {
    const { cookie } = await auth.login(req);
    return sendJson(res, 200, { authed: true }, { 'Set-Cookie': cookie });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const { cookie } = auth.logout(req);
    return sendJson(res, 200, { authed: false }, { 'Set-Cookie': cookie });
  }

  if (!auth.isAuthed(req)) throw new HttpError(401, 'not logged in');
  for (const [method, pattern, handler] of routes) {
    const match = pathname.match(pattern);
    if (!match) continue;
    if (req.method !== method) continue;
    const body = await handler(req, res, match.slice(1), url);
    if (body !== undefined) sendJson(res, 200, body);
    return;
  }
  throw new HttpError(404, 'not found');
}

// Files from dist/; any other path gets index.html so the frontend's routes work on reload.
function serveStatic(req, res, url) {
  const urlPath = decodeURIComponent(url.pathname);
  let file = path.normalize(path.join(STATIC_DIR, urlPath));
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  if (urlPath === '/' || !path.extname(urlPath)) file = path.join(STATIC_DIR, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(file);
    // Vite puts a content hash in asset names, so they never change.
    const cache = urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    serveStatic(req, res, url);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.destroy();
    sendJson(res, err.status || 500, { error: err.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  try {
    if (new URL(req.url, 'http://x').pathname === '/api/terminal') return terminal.handleUpgrade(req, socket, head);
  } catch (err) {
    console.error(err);
  }
  socket.destroy();
});

monitor.start();

server.listen(PORT, HOST, () => {
  console.log(`Dashboard on http://${HOST}:${PORT}`);
  if (!auth.enabled) console.log('ADMIN_PASSWORD not set: login disabled, the portal cannot be used');
  if (!fs.existsSync(path.join(STATIC_DIR, 'index.html'))) console.log('dist/ is missing: run npm run build');
  console.log(`Alerts: ${alerts.channels().join(', ') || 'none configured (set NTFY_URL or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`);
});
