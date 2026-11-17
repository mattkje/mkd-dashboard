<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import ConfirmButton from '../components/ConfirmButton.vue';
import ControlTile from '../components/ControlTile.vue';
import EmptyState from '../components/EmptyState.vue';
import JobOutput from '../components/JobOutput.vue';
import Sparkline from '../components/Sparkline.vue';
import { getJson, post } from '../api.js';
import { bytes, dateTime, duration, percent } from '../format.js';
import { openLogs, serverPath, state } from '../store.js';
import { attempt, toast } from '../toast.js';

const STATS_MS = 5000;
const HISTORY_MS = 60000;

const stats = ref(null);
const statsError = ref('');
const history = ref([]);
const updates = ref(null);
const alerts = ref(null);
const jobOutput = ref(null);
const jobRunning = ref(false);
const powerMessage = ref('');
const busy = ref('');
const procs = ref(null);
const procSort = ref('cpu');

const ICONS = {
  restart: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  power: 'M12 3v8M6.34 6.34a8 8 0 1 0 11.32 0',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  clockOff: 'M12 7v5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5 5l14 14',
  updates: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  cleanup: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  dashboard: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  journal: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  docker: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
};

const timeFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const scheduledText = computed(() => {
  const s = stats.value?.scheduled;
  return s ? `${s.mode === 'poweroff' ? 'Shutdown' : 'Restart'} ${timeFormat.format(new Date(s.at))}` : '';
});

const level = (value) => (value >= 0.9 ? 'bad' : value >= 0.75 ? 'warn' : '');

// One row per resource: current value, a detail line, and its last 24 hours.
const meters = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const series = (pick) => history.value.flatMap((h) => (pick(h) == null ? [] : [{ t: h.t, v: pick(h) }]));
  const list = [
    { label: 'CPU', value: s.cpu, detail: `${s.cpus} cores · load ${s.load.map((n) => n.toFixed(2)).join(' ')}`, points: series((h) => h.cpu) },
    { label: 'Memory', value: s.memory.used / s.memory.total, detail: `${bytes(s.memory.used)} of ${bytes(s.memory.total)}`, points: series((h) => h.mem) },
  ];
  if (s.memory.swapTotal) {
    list.push({ label: 'Swap', value: s.memory.swapUsed / s.memory.swapTotal, detail: `${bytes(s.memory.swapUsed)} of ${bytes(s.memory.swapTotal)}`, points: [] });
  }
  for (const disk of s.disks) {
    list.push({
      label: disk.mount,
      value: disk.used / disk.total,
      detail: `${bytes(disk.used)} of ${bytes(disk.total)} · ${bytes(disk.total - disk.used)} free`,
      points: series((h) => h.disks?.[disk.mount]),
    });
  }
  return list;
});

async function loadStats() {
  try {
    stats.value = await getJson('/api/system');
    statsError.value = '';
  } catch (err) {
    statsError.value = err.message;
  }
}

async function loadHistory() {
  history.value = (await getJson('/api/history/system').catch(() => null))?.samples ?? history.value;
}

// Totals only; the Updates page has the details and the buttons.
async function loadUpdates() {
  try {
    const result = await getJson('/api/updates');
    const items = result.sources.flatMap((s) => s.items);
    updates.value = { total: items.length, security: items.filter((i) => i.security).length };
  } catch (err) {
    updates.value = { error: err.message };
  }
}

async function loadAlerts() {
  if (state.server) return;
  alerts.value = await getJson('/api/alerts').catch(() => alerts.value);
}

function jobDone() {
  loadUpdates();
  loadStats();
}

const MESSAGES = {
  reboot: 'Restarting. The dashboard will be back in a minute or two.',
  poweroff: 'Shutting down. Start the server again by hand.',
  'dashboard-restart': 'Restarting the dashboard. This page reconnects by itself in a few seconds.',
};
const DONE = {
  'reboot-schedule': 'Restart scheduled for 04:00',
  'shutdown-cancel': 'Scheduled restart cancelled',
};

async function control(action) {
  busy.value = action;
  const ok = await attempt(() => post(`/api/system/power/${action}`), DONE[action]);
  busy.value = '';
  if (!ok) return;
  if (MESSAGES[action]) powerMessage.value = MESSAGES[action];
  if (action === 'cleanup') jobOutput.value?.poll(true);
  loadStats();
}

async function checkUpdates() {
  busy.value = 'updates';
  if (await attempt(() => post('/api/updates/refresh'))) jobOutput.value?.poll(true);
  busy.value = '';
}

function showJournal() {
  openLogs(stats.value ? `Journal · ${stats.value.hostname}` : 'System journal', '/api/system/journal');
}

async function copyAddress(address) {
  try {
    await navigator.clipboard.writeText(address);
    toast(`Copied ${address}`);
  } catch {
    toast('Could not copy', 'error');
  }
}

async function loadProcesses() {
  procs.value = await getJson('/api/system/processes', { sort: procSort.value }).catch((err) => ({
    error: /^404|not found/i.test(err.message) ? `${OUTDATED_HINT}: its dashboard is older than this one.` : err.message,
  }));
}

function sortBy(value) {
  procSort.value = value;
  loadProcesses();
}

async function endProcess(p) {
  if (await attempt(() => post(`/api/system/processes/${p.pid}/kill`), `Sent stop to ${p.name} (${p.pid})`)) {
    setTimeout(loadProcesses, 800);
  }
}

// Agents on other servers answer only what their version knows; older ones lack these.
const outdated = computed(() => Boolean(state.server && stats.value && !('network' in stats.value)));
const OUTDATED_HINT = 'Update the dashboard on this server to use this';

const cpuText = (value) => `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;

async function testAlert() {
  if (await attempt(() => post('/api/alerts/test'), 'Test alert sent')) loadAlerts();
}

const LEVEL_NAMES = { down: 'Down', up: 'Recovered', warn: 'Warning', info: 'Info' };

let statsTimer;
let historyTimer;
onMounted(() => {
  loadStats();
  loadHistory();
  loadUpdates();
  loadAlerts();
  loadProcesses();
  statsTimer = setInterval(() => {
    loadStats();
    if (!document.hidden) loadProcesses();
  }, STATS_MS);
  historyTimer = setInterval(() => {
    loadHistory();
    loadAlerts();
  }, HISTORY_MS);
});
onUnmounted(() => {
  clearInterval(statsTimer);
  clearInterval(historyTimer);
});
</script>

<template>
  <div class="system">
    <p v-if="powerMessage" class="banner">{{ powerMessage }}</p>
    <EmptyState v-if="statsError && !stats" error title="Could not load system stats" :text="statsError" />

    <section v-if="stats" class="panel controls">
      <header class="host-head">
        <div class="host-id">
          <span class="host-dot" :class="{ warn: stats.rebootRequired || stats.failedUnits?.length }"></span>
          <div>
            <p class="host">{{ stats.hostname }}</p>
            <p class="muted small">{{ stats.os }} · {{ stats.arch }} · kernel {{ stats.kernel }}</p>
            <p class="muted small">{{ stats.cpuModel }}</p>
          </div>
        </div>
        <div class="uptime">
          <span class="muted small">{{ stats.bootTime ? `Up since ${dateTime(stats.bootTime)}` : 'Uptime' }}</span>
          <strong>{{ duration(stats.uptime) }}</strong>
          <div class="chips">
            <span v-if="stats.rebootRequired" class="chip warn">Restart required</span>
            <span v-if="scheduledText" class="chip accent">{{ scheduledText }}</span>
            <span v-if="stats.failedUnits?.length" class="chip bad">{{ stats.failedUnits.length }} failed {{ stats.failedUnits.length === 1 ? 'service' : 'services' }}</span>
          </div>
        </div>
      </header>

      <div v-if="stats.network?.length" class="addresses">
        <button v-for="n in stats.network" :key="n.name + n.address" type="button" class="address" :title="`${n.name} · click to copy`" @click="copyAddress(n.address)">
          <span class="muted">{{ n.tailscale ? 'Tailscale' : n.name.startsWith('w') ? 'Wi-Fi' : 'LAN' }}</span>
          <code>{{ n.address }}</code>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="ICONS.copy"/></svg>
        </button>
      </div>

      <div class="groups">
        <div class="group">
          <h4>Power</h4>
          <div class="tiles">
            <ControlTile :icon="ICONS.restart" label="Restart" hint="Apps are down for a minute or two" confirm="Restart now?" tone="danger" :disabled="jobRunning" :busy="busy === 'reboot'" @run="control('reboot')" />
            <ControlTile :icon="ICONS.power" label="Shut down" hint="Start it again by hand" confirm="Shut down now?" tone="danger" :disabled="jobRunning" :busy="busy === 'poweroff'" @run="control('poweroff')" />
            <ControlTile v-if="stats.scheduled" :icon="ICONS.clockOff" label="Cancel scheduled" :hint="scheduledText" tone="warn" :busy="busy === 'shutdown-cancel'" @run="control('shutdown-cancel')" />
            <ControlTile v-else :icon="ICONS.clock" label="Restart at 04:00" :hint="outdated ? OUTDATED_HINT : stats.rebootRequired ? 'Applies the pending updates' : 'When nobody is using it'" confirm="Schedule for 04:00?" tone="warn" :disabled="outdated" :busy="busy === 'reboot-schedule'" @run="control('reboot-schedule')" />
          </div>
        </div>
        <div class="group">
          <h4>Maintenance</h4>
          <div class="tiles">
            <ControlTile :icon="ICONS.updates" label="Check for updates" :hint="updates && !updates.error ? (updates.total ? `${updates.total} available now` : 'Up to date') : 'Refresh package lists'" tone="accent" :disabled="jobRunning" :busy="busy === 'updates'" @run="checkUpdates" />
            <ControlTile :icon="ICONS.cleanup" label="Clean up disk" hint="Unused packages, apt cache, old logs" confirm="Clean up now?" tone="accent" :disabled="jobRunning || outdated" :busy="busy === 'cleanup'" @run="control('cleanup')" />
            <ControlTile :icon="ICONS.dashboard" label="Restart dashboard" hint="If something looks stuck" confirm="Restart dashboard?" tone="accent" :disabled="outdated" :busy="busy === 'dashboard-restart'" @run="control('dashboard-restart')" />
          </div>
        </div>
        <div class="group">
          <h4>Tools</h4>
          <div class="tiles">
            <ControlTile :icon="ICONS.journal" label="System journal" :hint="outdated ? OUTDATED_HINT : 'Every service\'s logs, live'" :disabled="outdated" @run="showJournal" />
            <template v-if="!state.server">
              <ControlTile :icon="ICONS.terminal" label="Terminal" hint="A shell on this server" to="/terminal" />
              <ControlTile :icon="ICONS.docker" label="Docker" hint="Containers and stacks" to="/docker" />
            </template>
          </div>
        </div>
      </div>
      <JobOutput ref="jobOutput" @running="jobRunning = $event" @done="jobDone" />
    </section>

    <template v-if="stats">
      <section class="panel">
        <h3>Resources <span class="muted sub">· last 24 hours</span></h3>
        <div class="meters">
          <div v-for="meter in meters" :key="meter.label" class="meter-row">
            <div class="meter-label">
              <strong :title="meter.label">{{ meter.label }}</strong>
              <span :class="{ 'warn-text': level(meter.value) === 'warn', 'error-text': level(meter.value) === 'bad' }">{{ percent(meter.value) }}</span>
            </div>
            <Sparkline v-if="meter.points.length" :points="meter.points" :level="level(meter.value)" />
            <div v-else class="meter" :class="level(meter.value)"><i :style="{ width: percent(meter.value) }"></i></div>
            <span class="muted small">{{ meter.detail }}</span>
          </div>
        </div>
      </section>

      <section v-if="stats.temperatures.length" class="panel">
        <h3>Temperatures</h3>
        <div class="temps">
          <div v-for="t in stats.temperatures" :key="t.name" class="temp">
            <strong :class="{ 'warn-text': t.celsius >= 70, 'error-text': t.celsius >= 85 }">{{ Math.round(t.celsius) }}°C</strong>
            <span class="muted small">{{ t.name }}</span>
          </div>
        </div>
      </section>
    </template>
    <template v-else-if="!statsError">
      <div class="skeleton" style="height: 300px"></div>
      <div class="skeleton" style="height: 260px"></div>
    </template>

    <div class="columns">
      <section class="panel">
        <header class="panel-head">
          <h3>Processes <span v-if="procs?.count" class="muted sub">· {{ procs.count }} running</span></h3>
          <div class="segmented" role="group" aria-label="Sort processes">
            <button type="button" :class="{ on: procSort === 'cpu' }" @click="sortBy('cpu')">CPU</button>
            <button type="button" :class="{ on: procSort === 'memory' }" @click="sortBy('memory')">Memory</button>
          </div>
        </header>
        <p v-if="procs?.error" class="muted">{{ procs.error }}</p>
        <table v-else-if="procs" class="procs">
          <thead>
            <tr><th>Process</th><th class="hide-narrow">User</th><th class="num">CPU</th><th class="num">Memory</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="p in procs.processes" :key="p.pid">
              <td class="proc-name" :title="p.command">
                <strong>{{ p.name }}</strong>
                <span class="muted small">{{ p.pid }}</span>
              </td>
              <td class="muted small hide-narrow">{{ p.user }}</td>
              <td class="num" :class="{ 'warn-text': p.cpu >= 0.5 }">{{ cpuText(p.cpu) }}</td>
              <td class="num">{{ bytes(p.rss) }}</td>
              <td class="end">
                <ConfirmButton v-if="p.own" class="small" label="End" :confirm="`End ${p.pid}?`" danger @confirm="endProcess(p)" />
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="skeleton" style="height: 220px"></div>
      </section>

      <div class="side">
        <section class="panel">
          <h3>Updates</h3>
          <template v-if="updates && !updates.error">
            <p class="muted">
              <template v-if="updates.total">
                {{ updates.total }} {{ updates.total === 1 ? 'update is' : 'updates are' }} available<template v-if="updates.security">,
                  <span class="error-text">{{ updates.security }} for security</span></template>.
              </template>
              <template v-else>Everything is up to date.</template>
            </p>
            <RouterLink :to="serverPath('/updates')" class="btn">{{ updates.total ? 'Review and install' : 'Open updates' }}</RouterLink>
          </template>
          <p v-else-if="updates" class="muted">{{ updates.error }}</p>
          <div v-else class="skeleton" style="height: 80px"></div>
        </section>

        <section v-if="stats?.failedUnits?.length" class="panel">
          <h3>Failed services</h3>
          <ul class="failed">
            <li v-for="u in stats.failedUnits" :key="u.unit">
              <i></i>
              <div>
                <strong>{{ u.unit }}</strong>
                <span class="muted small">{{ u.description }}</span>
              </div>
            </li>
          </ul>
          <p class="muted small hint">Look in the system journal for why, or run <code>systemctl status &lt;name&gt;</code>.</p>
        </section>

        <!-- Alerts are sent by this dashboard, for every server; agents have none of their own. -->
        <section v-if="!state.server" class="panel">
          <h3>Alerts</h3>
          <template v-if="alerts">
            <p v-if="alerts.channels.length" class="muted">
              Sending to {{ alerts.channels.join(' and ') }} when an app or container goes down, or a disk passes 90%.
            </p>
            <p v-else class="muted">
              Not set up. Set <code>NTFY_URL</code>, or <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code>,
              in <code>/etc/mkd-dashboard.env</code> and restart the dashboard.
            </p>
            <button v-if="alerts.channels.length" type="button" class="btn small" @click="testAlert">Send test alert</button>
            <ul v-if="alerts.recent.length" class="alerts">
              <li v-for="a in alerts.recent.slice(0, 8)" :key="a.t + a.title">
                <i :class="a.level" :title="LEVEL_NAMES[a.level]"></i>
                <div>
                  <strong>{{ a.title }}</strong>
                  <span class="muted small">{{ dateTime(a.t) }}<template v-if="a.errors.length"> · <span class="error-text">not delivered</span></template></span>
                </div>
              </li>
            </ul>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.system { display: grid; gap: 16px; }
.host-head { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.host-head p { margin: 0; }
.host-id { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
.host-dot { flex: none; width: 10px; height: 10px; margin-top: 10px; border-radius: 50%; background: var(--up); box-shadow: 0 0 0 4px color-mix(in srgb, var(--up) 18%, transparent); }
.host-dot.warn { background: var(--warn); box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 18%, transparent); }
.host { margin: 0 0 2px; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.uptime { display: grid; justify-items: end; align-content: start; gap: 2px; }
.uptime strong { font-size: 22px; font-weight: 600; line-height: 1.2; }
.chips { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-top: 4px; }
.chip.accent { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }
.chip.bad { border-color: color-mix(in srgb, var(--down) 45%, var(--line)); color: var(--down); }
.addresses { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.address {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 99px;
  background: var(--bg);
  font-size: 12.5px;
  cursor: pointer;
}
.address:hover { border-color: var(--line-strong); }
.address svg { width: 12px; height: 12px; color: var(--muted); }
.groups { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
.group h4 { margin: 0 0 8px; color: var(--muted); font-size: 11.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.tiles { display: grid; gap: 8px; }
.controls :deep(.job) { margin-top: 16px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.panel-head h3 { margin: 0; }
.segmented { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
.segmented button { height: 24px; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: var(--muted); font-size: 12.5px; cursor: pointer; }
.segmented button.on { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.procs { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.procs th { padding: 0 8px 6px; color: var(--muted); font-size: 12px; font-weight: 500; text-align: left; }
.procs td { height: 38px; padding: 0 8px; border-top: 1px solid var(--line); }
.procs th:first-child, .procs td:first-child { padding-left: 0; }
.procs th:last-child, .procs td:last-child { padding-right: 0; }
.procs .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.proc-name { max-width: 0; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proc-name strong { margin-right: 6px; font-weight: 550; }
.procs .end { width: 1px; text-align: right; }
.procs .end :deep(.btn) { height: 26px; }
.failed { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.failed li { display: flex; gap: 10px; align-items: baseline; }
.failed li div { display: grid; min-width: 0; }
.failed strong { overflow: hidden; font-size: 14px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.failed i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--down); }
.hint { margin: 12px 0 0; }
.sub { text-transform: none; letter-spacing: 0; font-weight: 500; }
.meters { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 22px 28px; }
.meter-row { display: grid; gap: 6px; min-width: 0; }
.meter-label { display: flex; justify-content: space-between; gap: 8px; }
.meter-label strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.temps { display: flex; flex-wrap: wrap; gap: 12px 32px; }
.temp { display: grid; }
.temp strong { font-size: 20px; }
.columns { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.side { display: grid; gap: 16px; }
.alerts { display: grid; gap: 10px; margin: 14px 0 0; padding: 0; list-style: none; }
.alerts li { display: flex; gap: 10px; align-items: baseline; }
.alerts li div { display: grid; min-width: 0; }
.alerts strong { font-size: 14px; font-weight: 550; }
.alerts i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.alerts i.down { background: var(--down); }
.alerts i.up { background: var(--up); }
.alerts i.warn { background: var(--warn); }
code { font-size: 12px; }
@media (max-width: 900px) {
  .groups { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .columns { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .groups { grid-template-columns: 1fr; }
  .uptime { justify-items: start; }
  .chips { justify-content: flex-start; }
  .hide-narrow { display: none; }
}
</style>
