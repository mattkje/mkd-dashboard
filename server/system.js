// Host stats, package updates and power actions.
const fs = require('node:fs');
const os = require('node:os');
const { HttpError, run } = require('./http');
const jobs = require('./jobs');

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

async function stats() {
  const [cpu, disk] = await Promise.all([cpuUsage(pageSample), disks()]);
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
  };
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

module.exports = { stats, power, helperCommand, osName, cpuUsage, memory, disks };
