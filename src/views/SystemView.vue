<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import ConfirmButton from '../components/ConfirmButton.vue';
import EmptyState from '../components/EmptyState.vue';
import JobOutput from '../components/JobOutput.vue';
import Sparkline from '../components/Sparkline.vue';
import { getJson, post } from '../api.js';
import { bytes, dateTime, duration, percent } from '../format.js';
import { attempt } from '../toast.js';

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
  alerts.value = await getJson('/api/alerts').catch(() => alerts.value);
}

function jobDone() {
  loadUpdates();
  loadStats();
}

async function power(action) {
  if (await attempt(() => post(`/api/system/power/${action}`))) {
    powerMessage.value = action === 'reboot'
      ? 'Restarting. The dashboard will be back in a minute or two.'
      : 'Shutting down. Start the server again by hand.';
  }
}

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
  statsTimer = setInterval(loadStats, STATS_MS);
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

    <template v-if="stats">
      <section class="panel overview">
        <div>
          <p class="host">{{ stats.hostname }}</p>
          <p class="muted">{{ stats.os }} · {{ stats.arch }} · kernel {{ stats.kernel }}</p>
          <p class="muted">{{ stats.cpuModel }}</p>
        </div>
        <div class="uptime">
          <span class="muted">Up</span>
          <strong>{{ duration(stats.uptime) }}</strong>
          <span v-if="stats.rebootRequired" class="chip warn">Restart required</span>
        </div>
      </section>

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
      <div class="skeleton" style="height: 110px"></div>
      <div class="skeleton" style="height: 260px"></div>
    </template>

    <div class="columns">
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
          <RouterLink to="/updates" class="btn">{{ updates.total ? 'Review and install' : 'Open updates' }}</RouterLink>
        </template>
        <p v-else-if="updates" class="muted">{{ updates.error }}</p>
        <div v-else class="skeleton" style="height: 80px"></div>
        <JobOutput ref="jobOutput" @running="jobRunning = $event" @done="jobDone" />
      </section>

      <div class="side">
        <section class="panel">
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

        <section class="panel">
          <h3>Power</h3>
          <p class="muted">Restarting takes every app on this server down for a minute or two.</p>
          <div class="actions">
            <ConfirmButton label="Restart server" confirm="Restart now? Click again" danger :disabled="jobRunning" @confirm="power('reboot')" />
            <ConfirmButton label="Shut down" confirm="Shut down? Click again" danger :disabled="jobRunning" @confirm="power('poweroff')" />
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.system { display: grid; gap: 16px; }
.overview { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.overview .host { margin: 0 0 4px; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.overview p { margin: 0; }
.uptime { display: grid; justify-items: end; align-content: start; gap: 2px; }
.uptime strong { font-size: 22px; font-weight: 600; }
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
@media (max-width: 760px) {
  .columns { grid-template-columns: 1fr; }
}
</style>
