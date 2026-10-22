// Background checks once a minute: keeps 24 hours of history for the charts and uptime bars,
// and sends alerts when an app or container goes down or a disk fills up.
const stored = require('./state');
const alerts = require('./alerts');
const apps = require('./apps');
const docker = require('./docker');
const system = require('./system');
const updates = require('./updates');

const INTERVAL_MS = 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;
const BUCKETS = 48;
// An app must fail this many checks in a row before it counts as down (avoids alerts on blips).
const FAILS_BEFORE_DOWN = 2;
const DISK_ALERT = 0.9;
const DISK_CLEAR = 0.85;
// Changes the dashboard itself makes (stopping a service or container) don't trigger alerts for this long.
const EXPECTED_MS = 3 * 60 * 1000;
const UPDATES_MS = 6 * 60 * 60 * 1000;

const history = stored.load('history.json', { system: [], apps: {} });
const appState = new Map(); // name -> { fails, down }
const containerState = new Map(); // name -> { running, alerted }
const diskAlerted = new Set();
const expected = new Map(); // key -> until
let containerNames = new Map(); // id -> name
let ticks = 0;

function expect(key) {
  expected.set(key, Date.now() + EXPECTED_MS);
}

function isExpected(key) {
  return (expected.get(key) || 0) > Date.now();
}

function expectContainer(id) {
  const name = containerNames.get(id) || [...containerNames.entries()].find(([full]) => full.startsWith(id))?.[1];
  if (name) expect(`container:${name}`);
}

async function checkApps(now) {
  const config = apps.loadConfig();
  const status = await apps.statusAll();
  for (const app of config.groups.flatMap((g) => g.apps)) {
    const up = Boolean(status[app.id]?.up);
    (history.apps[app.name] ||= []).push([now, up ? 1 : 0]);
    // The first check after a start is the baseline: apps that are already down don't alert again.
    if (!appState.has(app.name)) {
      appState.set(app.name, { fails: up ? 0 : FAILS_BEFORE_DOWN, down: !up });
      continue;
    }
    const s = appState.get(app.name);
    s.fails = up ? 0 : s.fails + 1;
    if (!s.down && s.fails >= FAILS_BEFORE_DOWN) {
      s.down = true;
      if (!isExpected(`app:${app.name}`)) {
        alerts.send(`${app.name} is down`, `${app.description || 'App'} has not responded for ${FAILS_BEFORE_DOWN} minutes (${status[app.id]?.error || 'no response'}).`, 'down');
      }
    } else if (s.down && up) {
      s.down = false;
      if (!isExpected(`app:${app.name}`)) alerts.send(`${app.name} is back up`, `${app.description || 'App'} responds again.`, 'up');
    }
  }
}

async function checkSystem(now) {
  const [cpu, disks] = await Promise.all([system.cpuUsage(sample), system.disks()]);
  const memory = system.memory();
  const diskUse = Object.fromEntries(disks.map((d) => [d.mount, d.used / d.total]));
  history.system.push({ t: now, cpu, mem: memory.used / memory.total, disks: diskUse });
  for (const [mount, use] of Object.entries(diskUse)) {
    if (use >= DISK_ALERT && !diskAlerted.has(mount)) {
      diskAlerted.add(mount);
      alerts.send(`Disk ${mount} is ${Math.round(use * 100)}% full`, `Free up space on ${mount} before it runs out.`, 'warn');
    } else if (use < DISK_CLEAR) {
      diskAlerted.delete(mount);
    }
  }
}

// Only containers that were running and stopped on their own; removed containers are not alerts.
async function checkContainers() {
  let list;
  try {
    list = await docker.containers();
  } catch {
    return;
  }
  containerNames = new Map(list.map((c) => [c.id, c.name]));
  for (const c of list) {
    const running = c.state === 'running';
    const before = containerState.get(c.name);
    const s = { running, alerted: before?.alerted || false };
    const key = `container:${c.name}`;
    if (before?.running && !running && !isExpected(key)) {
      s.alerted = true;
      alerts.send(`Container ${c.name} stopped`, `${c.image}: ${c.status}`, 'down');
    } else if (running && before?.alerted) {
      s.alerted = false;
      if (!isExpected(key)) alerts.send(`Container ${c.name} is running again`, c.image, 'up');
    }
    containerState.set(c.name, s);
  }
}

const sample = {};

function prune(now) {
  const cutoff = now - KEEP_MS;
  history.system = history.system.filter((s) => s.t >= cutoff);
  for (const [name, points] of Object.entries(history.apps)) {
    const kept = points.filter(([t]) => t >= cutoff);
    if (kept.length) history.apps[name] = kept;
    else delete history.apps[name];
  }
}

async function tick() {
  const now = Date.now();
  const results = await Promise.allSettled([checkApps(now), checkSystem(now), checkContainers()]);
  for (const r of results) if (r.status === 'rejected') console.error('monitor:', r.reason);
  prune(now);
  // Every 5 minutes is plenty; at most a few minutes of history is lost on a crash.
  if (++ticks % 5 === 1) stored.save('history.json', history);
}

// Alerts when updates appear, and again only when more security updates show up.
let lastUpdates = { total: 0, security: 0 };
async function checkUpdates() {
  try {
    await updates.check();
  } catch (err) {
    console.error('update check:', err.message);
    return;
  }
  const now = updates.summary();
  if (now.security > lastUpdates.security) {
    alerts.send(`${now.security} security updates available`, `${now.total} updates in total. Install them from the Updates page.`, 'warn');
  } else if (now.total && !lastUpdates.total) {
    alerts.send(`${now.total} updates available`, 'Install them from the Updates page.', 'info');
  }
  lastUpdates = now;
}

function start() {
  setTimeout(tick, 5000);
  setInterval(tick, INTERVAL_MS);
  setTimeout(checkUpdates, 2 * 60 * 1000);
  setInterval(checkUpdates, UPDATES_MS);
  process.once('SIGTERM', () => {
    stored.save('history.json', history);
    process.exit(0);
  });
}

function systemHistory() {
  return { interval: INTERVAL_MS, samples: history.system };
}

// Per app: share of checks that were up, how often it went down, and BUCKETS slots over 24 hours
// (fraction up in each, or null without data).
function appHistory() {
  const now = Date.now();
  const size = KEEP_MS / BUCKETS;
  const start = now - KEEP_MS;
  return Object.fromEntries(Object.entries(history.apps).map(([name, points]) => {
    const buckets = Array.from({ length: BUCKETS }, () => [0, 0]);
    let downs = 0;
    let previous = 1;
    for (const [t, up] of points) {
      const i = Math.min(BUCKETS - 1, Math.floor((t - start) / size));
      if (i >= 0) {
        buckets[i][0] += up;
        buckets[i][1] += 1;
      }
      if (previous && !up) downs++;
      previous = up;
    }
    const upCount = points.reduce((sum, [, up]) => sum + up, 0);
    return [name, {
      uptime: points.length ? upCount / points.length : null,
      downs,
      buckets: buckets.map(([upIn, total]) => (total ? upIn / total : null)),
    }];
  }));
}

module.exports = { start, expect, expectContainer, systemHistory, appHistory };
