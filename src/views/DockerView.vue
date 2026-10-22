<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import ConfirmButton from '../components/ConfirmButton.vue';
import EmptyState from '../components/EmptyState.vue';
import JobOutput from '../components/JobOutput.vue';
import { getJson, post } from '../api.js';
import { percent } from '../format.js';
import { openLogs } from '../store.js';
import { attempt } from '../toast.js';

const REFRESH_MS = 10000;

const containers = ref(null);
const stats = ref({});
const error = ref('');
const busy = reactive({});
const jobOutput = ref(null);
const jobRunning = ref(false);

// Compose projects first (alphabetically), then standalone containers.
const groups = computed(() => {
  const byProject = new Map();
  for (const c of containers.value ?? []) {
    const key = c.project || '';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(c);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b))
    .map(([project, list]) => ({ project, containers: list, running: list.filter((c) => c.state === 'running').length }));
});

const friendlyError = computed(() => {
  if (/not available/.test(error.value)) {
    return { title: 'Docker isn’t installed', text: 'The docker command was not found on this server.' };
  }
  if (/permission denied/i.test(error.value)) {
    return { title: 'No access to Docker', text: 'The dashboard user is not in the docker group. Re-run deploy/install.sh, which adds it.' };
  }
  return { title: 'Could not list containers', text: error.value };
});

// "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp" becomes "8080→80".
function ports(text) {
  const published = text.split(', ').flatMap((p) => p.match(/:(\d+)->(\d+)\//)?.slice(1).join('→') ?? []);
  return [...new Set(published)].join(', ');
}

async function load() {
  try {
    containers.value = await getJson('/api/docker');
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
}

async function loadStats() {
  stats.value = await getJson('/api/docker/stats').catch(() => stats.value);
}

const PAST = { start: 'Started', stop: 'Stopped', restart: 'Restarted' };

async function act(key, url, action, label) {
  busy[key] = action;
  await attempt(() => post(url), `${PAST[action]} ${label}`);
  delete busy[key];
  load();
}

async function update(c, wholeProject) {
  const query = wholeProject ? '?project=1' : '';
  if (await attempt(() => post(`/api/docker/${c.id}/update${query}`))) jobOutput.value.poll();
}

let timer;
onMounted(() => {
  load();
  loadStats();
  timer = setInterval(() => {
    load();
    loadStats();
  }, REFRESH_MS);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div>
    <header class="page-head">
      <p class="muted">
        <template v-if="containers">{{ containers.filter((c) => c.state === 'running').length }} of {{ containers.length }} containers running</template>
      </p>
      <button type="button" class="btn small" @click="load(); loadStats()">Refresh</button>
    </header>

    <JobOutput ref="jobOutput" class="panel job-panel" hide-finished @running="jobRunning = $event" @done="load" />

    <EmptyState v-if="error" error :title="friendlyError.title" :text="friendlyError.text" />
    <EmptyState v-else-if="containers && !containers.length" title="No containers" text="Nothing has been created with Docker on this server yet." />
    <div v-else-if="!containers" class="skeleton" style="height: 320px; border-radius: 16px"></div>

    <section v-for="g in groups" :key="g.project" class="stack">
      <header class="stack-head">
        <h2>{{ g.project || 'Standalone' }} <span class="count">{{ g.running }}/{{ g.containers.length }} running</span></h2>
        <div v-if="g.project" class="actions">
          <span v-if="busy[`project:${g.project}`]" class="muted small">{{ busy[`project:${g.project}`] }}…</span>
          <template v-else>
            <button v-if="g.running < g.containers.length" type="button" class="btn small" @click="act(`project:${g.project}`, `/api/docker/projects/${g.project}/start`, 'start', g.project)">Start all</button>
            <button v-if="g.running" type="button" class="btn small" @click="act(`project:${g.project}`, `/api/docker/projects/${g.project}/restart`, 'restart', g.project)">Restart all</button>
            <ConfirmButton v-if="g.running" class="small" label="Stop all" confirm="Stop the whole stack?" danger @confirm="act(`project:${g.project}`, `/api/docker/projects/${g.project}/stop`, 'stop', g.project)" />
            <ConfirmButton class="small" label="Update stack" confirm="Pull and recreate all?" :disabled="jobRunning" @confirm="update(g.containers[0], true)" />
          </template>
        </div>
      </header>
      <div class="list">
        <div v-for="c in g.containers" :key="c.id" class="row" :class="{ stopped: c.state !== 'running' }">
          <i class="state" :class="c.state" :title="c.state"></i>
          <div class="main">
            <strong class="ellipsis">{{ c.name }}</strong>
            <div class="muted small ellipsis" :title="c.image">{{ c.image }}</div>
          </div>
          <div class="meta small">
            <span>{{ c.status }}</span>
            <span v-if="ports(c.ports)" class="muted">{{ ports(c.ports) }}</span>
          </div>
          <div class="usage small">
            <template v-if="stats[c.id]">
              <span title="CPU">{{ percent(stats[c.id].cpu) }} CPU</span>
              <span class="muted" :title="stats[c.id].memUsage">{{ stats[c.id].memUsage.split(' / ')[0] }}</span>
            </template>
          </div>
          <div class="actions">
            <span v-if="busy[c.id]" class="muted small">{{ busy[c.id] }}…</span>
            <template v-else>
              <button v-if="c.state !== 'running'" type="button" class="btn small" @click="act(c.id, `/api/docker/${c.id}/start`, 'start', c.name)">Start</button>
              <template v-else>
                <button type="button" class="btn small" @click="act(c.id, `/api/docker/${c.id}/restart`, 'restart', c.name)">Restart</button>
                <ConfirmButton class="small" label="Stop" danger @confirm="act(c.id, `/api/docker/${c.id}/stop`, 'stop', c.name)" />
              </template>
              <ConfirmButton
                v-if="c.project"
                class="small"
                label="Update"
                confirm="Pull and recreate?"
                :disabled="jobRunning"
                @confirm="update(c, false)"
              />
            </template>
            <button type="button" class="btn small" @click="openLogs(c.name, `/api/docker/${c.id}/logs`)">Logs</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.job-panel { margin-bottom: 16px; }
.job-panel :deep(.job) { margin-top: 0; }
.stack { margin-top: 24px; }
.stack-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin-bottom: 10px; }
.stack-head h2 { flex: 1; min-width: 200px; margin: 0; }
.list { border: 1px solid var(--line); border-radius: 16px; background: var(--card); overflow: hidden; }
.row {
  display: grid;
  grid-template-columns: auto minmax(0, 1.3fr) minmax(0, 1fr) 90px 290px;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
}
.row + .row { border-top: 1px solid var(--line); }
.state { width: 9px; height: 9px; border-radius: 50%; background: var(--line-strong); }
.state.running { background: var(--up); }
.state.restarting, .state.paused { background: var(--warn); }
.state.dead { background: var(--down); }
.main { display: grid; min-width: 0; }
.main strong { font-weight: 550; }
.stopped .main strong { color: var(--muted); }
.meta, .usage { display: grid; gap: 2px; min-width: 0; }
.meta span, .usage span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
@media (max-width: 860px) {
  .row { grid-template-columns: auto minmax(0, 1fr) auto; }
  .meta { grid-column: 2; }
  .usage { grid-row: 1; grid-column: 3; text-align: right; }
  .actions { grid-column: 2 / -1; justify-content: flex-start; }
}
</style>
