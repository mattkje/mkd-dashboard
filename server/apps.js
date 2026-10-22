// Apps from apps.json: up/down checks, and the systemd units behind local apps.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, readJson, run } = require('./http');
const logs = require('./logs');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '..', 'apps.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'apps.example.json');

// apps.json is your own and not in git; a fresh checkout starts from the example.
if (!process.env.CONFIG_PATH && !fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  console.log('Created apps.json from apps.example.json');
}
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS) || 4000;
// Development only: point at dev/fake-systemctl and dev/fake-journalctl to work without systemd.
// A custom systemctl is run without sudo.
const SYSTEMCTL = process.env.SYSTEMCTL || 'systemctl';
const JOURNALCTL = process.env.JOURNALCTL || 'journalctl';

const ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable']);
const UNIT_PATTERN = /^[A-Za-z0-9@._:-]+$/;

// "${TAILNET}" in apps.json becomes that environment variable (from .env or the service's
// env file), so host names can stay out of the file. Secrets are never filled in.
const SECRET_NAME = /PASSWORD|TOKEN|SECRET|KEY/;

function expand(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => (SECRET_NAME.test(name) ? match : process.env[name] ?? match));
}

// Config is re-read on every request so edits to apps.json apply on page refresh.
// raw keeps the ${...} placeholders, for editing.
function loadConfig({ raw: keepPlaceholders = false } = {}) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const fill = (app) => (keepPlaceholders ? app : Object.fromEntries(Object.entries(app).map(([k, v]) => [k, expand(v)])));
  const groups = (raw.groups || []).map((group, gi) => ({
    name: group.name || `Group ${gi + 1}`,
    apps: (group.apps || []).map((app, ai) => ({ ...fill(app), id: `${gi}-${ai}` })),
  }));
  return { title: raw.title || 'MKD', groups };
}

const APP_FIELDS = {
  name: 'string', description: 'string', port: 'number', scheme: 'string', path: 'string',
  url: 'string', icon: 'string', checkUrl: 'string', service: 'string',
};

function cleanApp(raw, where) {
  const app = {};
  for (const [key, type] of Object.entries(APP_FIELDS)) {
    let value = raw[key];
    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === null || value === '') continue;
    if (key === 'port') value = Number(value);
    if (typeof value !== type) throw new HttpError(400, `${where}: ${key} must be a ${type}`);
    app[key] = value;
  }
  if (!app.name) throw new HttpError(400, `${where}: name is required`);
  if (app.url) {
    if (!/^https?:\/\/\S+$/.test(app.url)) throw new HttpError(400, `${app.name}: url must start with http:// or https://`);
    delete app.port;
    delete app.scheme;
  } else if (!Number.isInteger(app.port) || app.port < 1 || app.port > 65535) {
    throw new HttpError(400, `${app.name}: needs a port (1-65535) or a url`);
  }
  if (app.scheme && !['http', 'https'].includes(app.scheme)) throw new HttpError(400, `${app.name}: scheme must be http or https`);
  if (app.checkUrl && !/^https?:\/\/\S+$/.test(app.checkUrl)) throw new HttpError(400, `${app.name}: checkUrl must be a full URL`);
  if (app.service && !UNIT_PATTERN.test(app.service)) throw new HttpError(400, `${app.name}: invalid service name`);
  return app;
}

// Validated and rewritten whole; the previous file is kept as apps.json.bak.
async function saveConfig(req) {
  const raw = await readJson(req, 256 * 1024);
  if (!Array.isArray(raw.groups)) throw new HttpError(400, 'groups must be a list');
  const config = {
    title: String(raw.title || 'MKD').trim() || 'MKD',
    groups: raw.groups.map((group, gi) => {
      const name = String(group.name || '').trim();
      if (!name) throw new HttpError(400, `group ${gi + 1} needs a name`);
      if (!Array.isArray(group.apps)) throw new HttpError(400, `${name}: apps must be a list`);
      return { name, apps: group.apps.map((app, ai) => cleanApp(app || {}, `${name}, app ${ai + 1}`)) };
    }),
  };
  if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  fs.writeFileSync(`${CONFIG_PATH}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(`${CONFIG_PATH}.tmp`, CONFIG_PATH);
  console.log('apps.json updated');
  return loadConfig();
}

function findApp(id) {
  return loadConfig().groups.flatMap((g) => g.apps).find((app) => app.id === id);
}

// "gitea" and "gitea.service" both refer to gitea.service.
function unitName(app) {
  if (!app.service || app.url) return null;
  const unit = app.service.includes('.') ? app.service : `${app.service}.service`;
  return UNIT_PATTERN.test(unit) ? unit : null;
}

function unitFor(id) {
  const app = findApp(id);
  const unit = app && unitName(app);
  if (!unit) throw new HttpError(404, 'app has no service');
  return unit;
}

// Local apps (port only) are checked on 127.0.0.1; external apps on their own URL.
function checkTarget(app) {
  if (app.checkUrl) return app.checkUrl;
  if (app.url) return app.url;
  const scheme = app.scheme || 'http';
  return `${scheme}://127.0.0.1:${app.port}${app.path || ''}`;
}

// Any HTTP response (including 401/403/redirects) means the app is up.
function probe(url) {
  return new Promise((resolve) => {
    const started = Date.now();
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve({ up: false, error: 'invalid url' });
    }
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      target,
      { method: 'GET', timeout: CHECK_TIMEOUT_MS, rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve({ up: true, code: res.statusCode, ms: Date.now() - started });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ up: false, error: err.code || err.message }));
    req.end();
  });
}

// Reading unit state needs no privileges.
async function serviceState(unit) {
  const result = await run(SYSTEMCTL, [
    'show', unit, '--property=LoadState,ActiveState,SubState,UnitFileState',
  ]);
  if (result.code === 'ENOENT') return { unit, error: 'systemctl not available' };
  if (!result.ok) return { unit, error: result.stderr || 'systemctl failed' };
  const props = Object.fromEntries(result.stdout.split('\n').map((line) => line.split('=', 2)));
  if (props.LoadState === 'not-found') return { unit, error: 'unit not found' };
  return { unit, active: props.ActiveState, sub: props.SubState, enabled: props.UnitFileState };
}

async function statusAll() {
  const apps = loadConfig().groups.flatMap((g) => g.apps);
  const results = await Promise.all(apps.map(async (app) => {
    const unit = unitName(app);
    const [http, service] = await Promise.all([
      probe(checkTarget(app)),
      unit ? serviceState(unit) : null,
    ]);
    return service ? { ...http, service } : http;
  }));
  return Object.fromEntries(apps.map((app, i) => [app.id, results[i]]));
}

// Changing state needs root; when not root, sudo must allow exactly this command (see deploy/install.sh).
async function serviceAction(id, action) {
  if (!ACTIONS.has(action)) throw new HttpError(400, 'unknown action');
  const unit = unitFor(id);
  // Lazy: monitor.js requires this module. A deliberate stop shouldn't raise a "down" alert.
  if (action === 'stop' || action === 'restart') require('./monitor').expect(`app:${findApp(id).name}`);
  const result = process.env.SYSTEMCTL || process.getuid?.() === 0
    ? await run(SYSTEMCTL, [action, unit])
    : await run('sudo', ['-n', 'systemctl', action, unit]);
  console.log(`${action} ${unit}: ${result.ok ? 'ok' : result.stderr}`);
  if (!result.ok) throw new HttpError(500, result.stderr || `systemctl ${action} failed`);
  return { ok: true, service: await serviceState(unit) };
}

// Reading the journal needs membership of the systemd-journal group (see deploy/install.sh).
async function serviceLogs(id, lines) {
  const unit = unitFor(id);
  const result = await run(JOURNALCTL, ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso']);
  if (result.code === 'ENOENT') throw new HttpError(501, 'journalctl not available');
  if (!result.ok) throw new HttpError(500, result.stderr || 'journalctl failed');
  return { title: unit, text: result.stdout };
}

function followServiceLogs(id, lines, res) {
  logs.follow(JOURNALCTL, ['-u', unitFor(id), '-n', String(lines), '--no-pager', '-o', 'short-iso', '--follow'], res);
}

module.exports = { loadConfig, saveConfig, statusAll, serviceAction, serviceLogs, followServiceLogs };
