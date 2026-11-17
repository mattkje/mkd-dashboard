// Host stats, system controls (power, cleanup, dashboard restart), processes and the system journal.
const fs = require('node:fs');
const os = require('node:os');
const { HttpError, run } = require('./http');
const jobs = require('./jobs');
const logs = require('./logs');

const SYSTEMCTL = process.env.SYSTEMCTL || 'systemctl';
const JOURNALCTL = process.env.JOURNALCTL || 'journalctl';
const CLOCK_TICKS = 100; // USER_HZ, 100 on every Linux the dashboard targets.
const PAGE_SIZE = 4096;
const PROCESS_LIMIT = 12;

// Root-owned script that performs the few root actions the dashboard may run (deploy/mkd-dashboard-helper).
// Development only: HELPER points at dev/fake-helper, which is run without sudo.
const HELPER_PATH = '/usr/local/libexec/mkd-dashboard-helper';
const HELPER = process.env.HELPER;

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function osName() {
  const release = readText('/etc/os-release');
  const pretty = release?.match(/^PRETTY_NAME="?([^"\n]*)"?/m);
  return pretty ? pretty[1] : `${os.type()} ${os.release()}`;
}

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    const t = cpu.times;
    sum.idle += t.idle;
    sum.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return sum;
  }, { idle: 0, total: 0 });
}

// CPU usage since the caller's previous sample (or over a short sample on the first call).
// Each caller keeps its own sample, so the monitor and the System page don't skew each other.
async function cpuUsage(sample) {
  if (!sample.last) {
    sample.last = cpuTimes();
    await new Promise((r) => setTimeout(r, 250));
  }
  const now = cpuTimes();
  const total = now.total - sample.last.total;
  const usage = total > 0 ? 1 - (now.idle - sample.last.idle) / total : 0;
  sample.last = now;
  return Math.min(1, Math.max(0, usage));
}

const pageSample = {};

function memory() {
  const info = readText('/proc/meminfo');
  if (!info) return { total: os.totalmem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 };
  const kb = (key) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
  return {
    total: kb('MemTotal'),
    used: kb('MemTotal') - kb('MemAvailable'),
    swapTotal: kb('SwapTotal'),
    swapUsed: kb('SwapTotal') - kb('SwapFree'),
  };
}

// Real block devices only; skips tmpfs, loop/snap mounts and macOS system sub-volumes.
async function disks() {
  const result = await run('df', ['-kP']);
  if (!result.ok) return [];
  const seen = new Set();
  return result.stdout.split('\n').slice(1).map((line) => line.split(/\s+/)).flatMap((cols) => {
    const [device, size, used] = cols;
    const mount = cols.slice(5).join(' ');
    if (!device.startsWith('/dev/') || device.startsWith('/dev/loop') || seen.has(device)) return [];
    if (mount.startsWith('/snap/') || mount.startsWith('/private/var/')) return [];
    if (mount.startsWith('/System/Volumes/') && mount !== '/System/Volumes/Data') return [];
    seen.add(device);
    return [{ device, mount, total: Number(size) * 1024, used: Number(used) * 1024 }];
  });
}

function temperatures() {
  let zones = [];
  try {
    zones = fs.readdirSync('/sys/class/thermal').filter((name) => name.startsWith('thermal_zone'));
  } catch {}
  return zones.flatMap((zone) => {
    const milli = Number(readText(`/sys/class/thermal/${zone}/temp`));
    const type = readText(`/sys/class/thermal/${zone}/type`)?.trim() || zone;
    return Number.isFinite(milli) && milli > 0 ? [{ name: type, celsius: milli / 1000 }] : [];
  });
}

// IPv4 addresses people use to reach the machine: LAN and Tailscale, not Docker's bridges.
function network() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => {
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) return [];
    return addresses.filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address, tailscale: name.startsWith('tailscale') }));
  });
}

// A restart or shutdown planned with `shutdown` (systemd writes it here).
function scheduledShutdown() {
  const text = readText('/run/systemd/shutdown/scheduled');
  const usec = Number(text?.match(/^USEC=(\d+)/m)?.[1]);
  if (!usec) return null;
  return { at: Math.round(usec / 1000), mode: text.match(/^MODE=(\w+)/m)?.[1] || 'reboot' };
}

async function failedUnits() {
  // The development fake knows nothing about failed units.
  if (process.env.SYSTEMCTL) return [];
  const result = await run(SYSTEMCTL, ['--failed', '--plain', '--no-legend', '--no-pager']);
  if (!result.ok) return [];
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const [unit, , , , ...description] = line.trim().split(/\s+/);
    return { unit, description: description.join(' ') };
  });
}

async function stats() {
  const [cpu, disk, failed] = await Promise.all([cpuUsage(pageSample), disks(), failedUnits()]);
  return {
    hostname: os.hostname(),
    os: osName(),
    kernel: os.release(),
    arch: os.arch(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model.trim() || '',
    cpu,
    memory: memory(),
    disks: disk,
    temperatures: temperatures(),
    rebootRequired: fs.existsSync('/var/run/reboot-required'),
    bootTime: Date.now() - os.uptime() * 1000,
    network: network(),
    scheduled: scheduledShutdown(),
    failedUnits: failed,
  };
}

// Processes, by CPU (measured between two looks at /proc, like top) or by memory.

let users = null;
function userName(uid) {
  if (!users) {
    users = new Map((readText('/etc/passwd') || '').split('\n').map((line) => line.split(':')).map((f) => [Number(f[2]), f[0]]));
  }
  return users.get(uid) ?? String(uid);
}

function readProcesses() {
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    throw new HttpError(501, 'process list needs Linux');
  }
  return pids.flatMap((pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      return [{
        pid: Number(pid),
        name: stat.slice(stat.indexOf('(') + 1, close),
        uid: fs.statSync(`/proc/${pid}`).uid,
        ticks: Number(fields[11]) + Number(fields[12]),
        started: Number(fields[19]),
        rss: Number(fields[21]) * PAGE_SIZE,
      }];
    } catch {
      return []; // Ended while we looked.
    }
  });
}

let lastLook = null;

async function processes(sort = 'cpu') {
  if (!lastLook || Date.now() - lastLook.t > 30000) {
    lastLook = { t: Date.now(), list: readProcesses() };
    await new Promise((r) => setTimeout(r, 400));
  }
  const now = Date.now();
  const list = readProcesses();
  const before = new Map(lastLook.list.map((p) => [p.pid, p]));
  const seconds = Math.max(0.1, (now - lastLook.t) / 1000);
  lastLook = { t: now, list };
  const total = os.totalmem();
  const cores = os.cpus().length;
  const rows = list.map((p) => {
    const prev = before.get(p.pid);
    const used = prev && prev.started === p.started ? (p.ticks - prev.ticks) / CLOCK_TICKS : 0;
    return { ...p, cpu: Math.max(0, used / seconds / cores), memory: p.rss / total };
  });
  rows.sort(sort === 'memory' ? (a, b) => b.rss - a.rss : (a, b) => b.cpu - a.cpu || b.rss - a.rss);
  return {
    count: rows.length,
    processes: rows.slice(0, PROCESS_LIMIT).map((p) => ({
      pid: p.pid,
      name: p.name,
      user: userName(p.uid),
      own: p.uid === process.getuid?.(),
      cpu: p.cpu,
      memory: p.memory,
      rss: p.rss,
      command: (readText(`/proc/${p.pid}/cmdline`) || '').replace(/\0+$/, '').replace(/\0/g, ' ').slice(0, 300) || `[${p.name}]`,
    })),
  };
}

// SIGTERM, as the dashboard's user: other users' processes are refused by the kernel.
function killProcess(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new HttpError(400, 'not that one');
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'EPERM') throw new HttpError(403, 'that process belongs to another user');
    if (err.code === 'ESRCH') throw new HttpError(404, 'that process has already ended');
    throw err;
  }
  return { ok: true };
}

async function journal(lines) {
  const result = await run(JOURNALCTL, ['-n', String(lines), '--no-pager', '-o', 'short-iso']);
  if (result.code === 'ENOENT') throw new HttpError(501, 'journalctl not available');
  if (!result.ok) throw new HttpError(500, result.stderr || 'journalctl failed');
  return { title: 'System journal', text: result.stdout };
}

function followJournal(lines, res) {
  logs.follow(JOURNALCTL, ['-n', String(lines), '--no-pager', '-o', 'short-iso', '--follow'], res);
}

// Root actions go through the helper; see deploy/mkd-dashboard-helper for what each one runs.
function helperCommand(action) {
  if (HELPER) return [HELPER, [action]];
  if (process.getuid?.() === 0) return [HELPER_PATH, [action]];
  return ['sudo', ['-n', HELPER_PATH, action]];
}

async function power(action) {
  if (action !== 'reboot' && action !== 'poweroff') throw new HttpError(400, 'unknown action');
  // Hold the job slot so no update starts while the machine goes down.
  const current = jobs.claim(action === 'reboot' ? 'Restart' : 'Shut down');
  const [cmd, args] = helperCommand(action);
  console.log(`power: ${action}`);
  const result = await run(cmd, args);
  current.output = result.stderr || result.stdout;
  jobs.finish(current, result.ok ? 0 : 1);
  if (!result.ok) throw new HttpError(500, result.stderr || `${action} failed`);
  return { ok: true };
}

async function helper(action) {
  const [cmd, args] = helperCommand(action);
  const result = await run(cmd, args);
  if (!result.ok) throw new HttpError(500, result.stderr || `${action} failed`);
  return { ok: true };
}

// Everything the System page's control panel can do. Each maps to one fixed helper action.
async function control(action) {
  switch (action) {
    case 'reboot':
    case 'poweroff':
      return power(action);
    case 'reboot-schedule':
    case 'shutdown-cancel':
      console.log(`power: ${action}`);
      return helper(action);
    case 'dashboard-restart': {
      // Answer first: the restart ends this process.
      console.log('dashboard: restart requested');
      const [cmd, args] = helperCommand(action);
      setTimeout(() => run(cmd, args), 500);
      return { ok: true };
    }
    case 'cleanup':
      return jobs.start('Clean up disk', [helperCommand('cleanup')]);
    default:
      throw new HttpError(400, 'unknown action');
  }
}

module.exports = { stats, power, control, processes, killProcess, journal, followJournal, helperCommand, osName, cpuUsage, memory, disks };
