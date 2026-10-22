// Everything on the server that can be updated, in one list: apt packages, a new OS release,
// snaps, flatpaks, firmware, Docker images and the dashboard itself. Each source reports
// whether its tool exists here, what is out of date, and whether the dashboard can update it.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, run } = require('./http');
const jobs = require('./jobs');
const docker = require('./docker');
const system = require('./system');

const APP_DIR = path.join(__dirname, '..');
const DEV = Boolean(process.env.HELPER);
const SOURCE_TIMEOUT_MS = 90 * 1000;
const REGISTRY_TIMEOUT_MS = 15 * 1000;
// Git must never wait for a password or host-key prompt.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

const missing = (result) => result.code === 'ENOENT';

// "pkg/noble-security 1.2 amd64 [upgradable from: 1.1]"
async function apt() {
  const result = await run('apt', ['list', '--upgradable']);
  if (missing(result) && !DEV) return { available: false };
  const items = result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/);
    return match ? [{ name: match[1], current: match[4], latest: match[3], security: /-security/.test(match[2]) }] : [];
  });
  return { available: true, items, canUpdate: true };
}

// Ubuntu only. Exits 0 and names the release when there is one (only LTS to LTS on an LTS install).
async function release() {
  const result = await run('do-release-upgrade', ['-c'], { timeout: 60000 });
  if (missing(result)) return { available: false };
  const name = `${result.stdout}\n${result.stderr}`.match(/New release '([^']+)' available/)?.[1];
  return {
    available: true,
    current: system.osName(),
    items: name ? [{ name: 'Ubuntu', current: system.osName(), latest: name }] : [],
    canUpdate: false,
    note: 'A release upgrade asks questions and can take an hour. Run sudo do-release-upgrade in the Terminal (inside tmux, so it survives a dropped connection).',
  };
}

// "Name  Version  Rev  Size  Publisher  Notes", or "All snaps up to date." on stderr.
async function snap() {
  const result = await run('snap', ['refresh', '--list']);
  if (missing(result)) return { available: false };
  const items = result.stdout.split('\n').slice(1).filter(Boolean).map((line) => {
    const [name, latest] = line.split(/\s+/);
    return { name, latest };
  });
  return { available: true, items, canUpdate: true };
}

async function flatpak() {
  const result = await run('flatpak', ['remote-ls', '--updates', '--columns=application,version']);
  if (missing(result)) return { available: false };
  const items = result.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, latest] = line.split('\t');
    return { name, latest: latest || '' };
  });
  return { available: true, items, canUpdate: true };
}

// fwupdmgr exits non-zero with "No updates available" when everything is current.
async function firmware() {
  const result = await run('fwupdmgr', ['get-updates', '--json'], { timeout: 60000 });
  if (missing(result)) return { available: false };
  let devices = [];
  try {
    devices = JSON.parse(result.stdout).Devices || [];
  } catch {}
  const items = devices.flatMap((d) => (d.Releases?.length ? [{
    name: d.Name,
    current: d.Version || '',
    latest: d.Releases[0].Version,
    note: d.Releases[0].Summary || '',
  }] : []));
  return {
    available: true,
    items,
    canUpdate: true,
    note: 'Firmware updates can need a restart, and some are applied while the machine boots.',
  };
}

// "nginx:1.27" -> registry-1.docker.io, library/nginx, 1.27. Pinned digests are skipped.
function parseImage(ref) {
  if (ref.includes('@') || /^(sha256:)?[0-9a-f]{12,64}$/.test(ref)) return null;
  let registry = 'registry-1.docker.io';
  let name = ref;
  const first = ref.split('/')[0];
  if (ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first === 'docker.io' ? registry : first;
    name = ref.slice(first.length + 1);
  }
  let tag = 'latest';
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  if (registry === 'registry-1.docker.io' && !name.includes('/')) name = `library/${name}`;
  return { registry, name, tag };
}

// The digest the tag points to now, via the registry API. Anonymous tokens are fetched as the
// registry asks for them (Docker Hub, GHCR, Quay all work this way). HEAD requests don't count
// against Docker Hub's pull limits.
async function remoteDigest({ registry, name, tag }) {
  const url = `https://${registry}/v2/${name}/manifests/${tag}`;
  const headers = {
    Accept: [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.docker.distribution.manifest.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
    ].join(', '),
  };
  let res = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  if (res.status === 401) {
    const challenge = res.headers.get('www-authenticate') || '';
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!params.realm) throw new Error(`${registry}: login required`);
    const tokenUrl = new URL(params.realm);
    if (params.service) tokenUrl.searchParams.set('service', params.service);
    tokenUrl.searchParams.set('scope', params.scope || `repository:${name}:pull`);
    const tokenRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!tokenRes.ok) throw new Error(`${registry}: login required`);
    const token = await tokenRes.json();
    headers.Authorization = `Bearer ${token.token || token.access_token}`;
    res = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  }
  if (!res.ok) throw new Error(`${registry}: ${res.status}`);
  return res.headers.get('docker-content-digest');
}

// Compares the image each container runs with what its tag points to in the registry.
async function dockerImages() {
  let containers;
  try {
    containers = await docker.containers();
  } catch (err) {
    if (/not available/.test(err.message)) return { available: false };
    throw err;
  }
  if (!containers.length) return { available: true, items: [], canUpdate: true };
  const inspected = await run(docker.DOCKER, ['inspect', '--format', '{{.Id}} {{.Image}}', ...containers.map((c) => c.id)]);
  const imageOf = new Map(inspected.stdout.split('\n').filter(Boolean).map((line) => {
    const [id, image] = line.split(' ');
    return [id.slice(0, 12), image];
  }));
  const imageIds = [...new Set(imageOf.values())];
  const images = await run(docker.DOCKER, ['image', 'inspect', '--format', '{{.Id}} {{json .RepoDigests}}', ...imageIds]);
  const digestsOf = new Map(images.stdout.split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf(' ');
    return [line.slice(0, i), (JSON.parse(line.slice(i + 1)) || []).map((d) => d.split('@')[1])];
  }));

  // One registry lookup per image reference, shared by the containers using it.
  const byRef = new Map();
  for (const c of containers) {
    if (!byRef.has(c.image)) byRef.set(c.image, []);
    byRef.get(c.image).push(c);
  }
  const results = await Promise.all([...byRef.entries()].map(async ([ref, list]) => {
    const local = digestsOf.get(imageOf.get(list[0].id)) || [];
    const parsed = parseImage(ref);
    const base = {
      name: ref,
      containers: list.map((c) => c.name),
      ids: list.filter((c) => c.project).map((c) => c.id),
    };
    if (!parsed) return { ...base, skip: ref.includes('@') ? 'pinned to a digest' : 'image no longer has a tag' };
    if (!local.length) return { ...base, skip: 'built locally' };
    try {
      const latest = await remoteDigest(parsed);
      return local.includes(latest) ? null : {
        ...base,
        current: local[0].slice(7, 19),
        latest: latest.slice(7, 19),
        note: base.ids.length ? '' : 'Not started with Compose: pull and recreate it yourself',
      };
    } catch (err) {
      return { ...base, skip: err.message };
    }
  }));
  return {
    available: true,
    items: results.filter((r) => r && !r.skip),
    skipped: results.filter((r) => r?.skip).map((r) => ({ name: r.name, reason: r.skip })),
    canUpdate: true,
  };
}

// The dashboard's own git checkout, compared with its upstream branch.
async function dashboard() {
  const git = (args, opts) => run('git', ['-C', APP_DIR, ...args], { env: GIT_ENV, ...opts });
  const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}']);
  if (missing(upstream)) return { available: false };
  if (!upstream.ok) {
    return { available: true, items: [], canUpdate: false, note: 'This checkout has no upstream branch to update from.' };
  }
  const fetched = await git(['fetch', '--quiet'], { timeout: 60000 });
  const log = await git(['log', '--format=%h %s', 'HEAD..@{u}']);
  const items = log.stdout.split('\n').filter(Boolean).slice(0, 30).map((line) => {
    const [hash, ...subject] = line.split(' ');
    return { name: subject.join(' '), latest: hash };
  });
  return {
    available: true,
    items,
    canUpdate: !DEV,
    note: [
      !fetched.ok && `Could not fetch ${upstream.stdout}: ${fetched.stderr}`,
      DEV && 'Self-update is off in development.',
    ].filter(Boolean).join(' ') || `Tracks ${upstream.stdout}.`,
  };
}

const SOURCES = [
  { id: 'apt', title: 'System packages', check: apt },
  { id: 'release', title: 'Operating system', check: release },
  { id: 'snap', title: 'Snaps', check: snap },
  { id: 'flatpak', title: 'Flatpaks', check: flatpak },
  { id: 'firmware', title: 'Firmware', check: firmware },
  { id: 'docker', title: 'Docker images', check: dockerImages },
  { id: 'dashboard', title: 'This dashboard', check: dashboard },
];

function rebootRequired() {
  if (!fs.existsSync('/var/run/reboot-required')) return null;
  let pkgs = [];
  try {
    pkgs = fs.readFileSync('/var/run/reboot-required.pkgs', 'utf8').split('\n').filter(Boolean);
  } catch {}
  return { packages: [...new Set(pkgs)] };
}

let cache = null;
let checking = null;

// Runs every source in parallel; a slow or broken one shows an error instead of holding up the rest.
function check() {
  checking ||= (async () => {
    const sources = await Promise.all(SOURCES.map(async ({ id, title, check: fn }) => {
      try {
        const result = await Promise.race([
          fn(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), SOURCE_TIMEOUT_MS)),
        ]);
        return { id, title, items: [], ...result };
      } catch (err) {
        return { id, title, available: true, items: [], error: err.message };
      }
    }));
    cache = { checkedAt: Date.now(), sources: sources.filter((s) => s.available), reboot: rebootRequired() };
    return cache;
  })().finally(() => { checking = null; });
  return checking;
}

async function list() {
  return cache || check();
}

function summary() {
  if (!cache) return null;
  const items = cache.sources.flatMap((s) => s.items);
  return { total: items.length, security: items.filter((i) => i.security).length, checkedAt: cache.checkedAt };
}

// Dashboard self-update: restarting the service ends this process, so it comes last, after the job reports done.
function dashboardCommands() {
  return [['git', ['-C', APP_DIR, 'pull', '--ff-only']], ['npm', ['ci', '--no-audit', '--no-fund']], ['npm', ['run', 'build']]];
}

function restartDashboard(job) {
  if (job.code !== 0) return;
  const [cmd, args] = system.helperCommand('dashboard-restart');
  setTimeout(() => run(cmd, args), 1000);
}

async function commandsFor(id) {
  const source = cache?.sources.find((s) => s.id === id);
  switch (id) {
    case 'apt': return [system.helperCommand('updates-install')];
    case 'snap': return [system.helperCommand('snap-refresh')];
    case 'flatpak': return [system.helperCommand('flatpak-update')];
    case 'firmware': return [system.helperCommand('firmware-update')];
    case 'docker': {
      const ids = (source?.items || []).flatMap((i) => i.ids || []);
      return ids.length ? docker.updateCommands(ids) : [];
    }
    case 'dashboard':
      if (DEV) throw new HttpError(400, 'self-update is off in development');
      return dashboardCommands();
    default: throw new HttpError(400, 'this can’t be updated from here');
  }
}

// Updates one source, or "all": everything with pending items except firmware and the OS release,
// which deserve a deliberate click of their own. The dashboard itself goes last.
async function update(id) {
  if (id !== 'all') {
    const commands = await commandsFor(id);
    if (!commands.length) throw new HttpError(400, 'nothing to update');
    const title = SOURCES.find((s) => s.id === id)?.title || id;
    return jobs.start(`Update ${title.toLowerCase()}`, commands, { onDone: id === 'dashboard' ? restartDashboard : refreshAfter });
  }
  const pending = (cache?.sources || []).filter((s) => s.items.length && s.canUpdate && !['firmware', 'release', 'dashboard'].includes(s.id));
  const commands = [];
  for (const s of pending) commands.push(...(await commandsFor(s.id)));
  const self = cache?.sources.find((s) => s.id === 'dashboard' && s.items.length && s.canUpdate);
  if (self) commands.push(...dashboardCommands());
  if (!commands.length) throw new HttpError(400, 'nothing to update');
  return jobs.start('Update everything', commands, { onDone: self ? restartDashboard : refreshAfter });
}

// Refreshes package lists (apt-get update, firmware metadata) as a job, then re-checks everything.
function refresh() {
  return jobs.start('Check for updates', [system.helperCommand('updates-refresh')], { onDone: refreshAfter });
}

function refreshAfter() {
  check().catch(() => {});
}

module.exports = { list, check, refresh, update, summary };
