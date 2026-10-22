<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import ConfirmButton from '../components/ConfirmButton.vue';
import EmptyState from '../components/EmptyState.vue';
import JobOutput from '../components/JobOutput.vue';
import { getJson, post } from '../api.js';
import { state } from '../store.js';
import { attempt } from '../toast.js';

const data = ref(null);
const error = ref('');
const checking = ref(false);
const jobRunning = ref(false);
const jobOutput = ref(null);
const showSkipped = ref(false);
const now = ref(Date.now());

// Sources with something to install first; the rest are listed as up to date.
const pending = computed(() => (data.value?.sources ?? []).filter((s) => s.items.length || s.error));
const current = computed(() => (data.value?.sources ?? []).filter((s) => !s.items.length && !s.error));
const total = computed(() => pending.value.reduce((sum, s) => sum + s.items.length, 0));
const security = computed(() => pending.value.reduce((sum, s) => sum + s.items.filter((i) => i.security).length, 0));
// What "Update everything" covers (see server/updates.js): not firmware or a new OS release.
const allCount = computed(() => pending.value
  .filter((s) => s.canUpdate && !['firmware', 'release'].includes(s.id))
  .reduce((sum, s) => sum + s.items.filter((i) => s.id !== 'docker' || i.ids?.length).length, 0));

const checkedAgo = computed(() => {
  if (!data.value) return '';
  const minutes = Math.round((now.value - data.value.checkedAt) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
});

function setData(result) {
  data.value = result;
  state.updates = result.sources.reduce((sum, s) => sum + s.items.length, 0);
}

async function load() {
  try {
    setData(await getJson('/api/updates'));
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
}

// Re-checks every source on the server; takes a few seconds (registries, git fetch).
async function recheck() {
  checking.value = true;
  try {
    setData(await post('/api/updates/check'));
  } catch (err) {
    error.value = err.message;
  } finally {
    checking.value = false;
  }
}

async function refresh() {
  if (await attempt(() => post('/api/updates/refresh'))) jobOutput.value.poll();
}

async function update(id) {
  if (await attempt(() => post(`/api/updates/${id}`))) jobOutput.value.poll();
}

const UPDATE_LABELS = {
  apt: 'Update packages',
  snap: 'Refresh snaps',
  flatpak: 'Update flatpaks',
  firmware: 'Install firmware',
  docker: 'Pull and recreate',
  dashboard: 'Update and restart',
};

const CONFIRMS = {
  firmware: 'May need a restart. Install?',
  dashboard: 'The dashboard restarts. Go?',
  docker: 'Containers restart. Go?',
};

let clock;
onMounted(() => {
  load();
  clock = setInterval(() => { now.value = Date.now(); }, 30000);
});
onUnmounted(() => clearInterval(clock));
</script>

<template>
  <div class="updates">
    <header class="page-head">
      <p class="muted">
        <template v-if="data">
          <strong v-if="total" class="headline">{{ total }} {{ total === 1 ? 'update' : 'updates' }} available</strong>
          <strong v-else class="headline good">Everything is up to date</strong>
          <span v-if="security" class="chip bad">{{ security }} security</span>
          <span class="small"> · checked {{ checkedAgo }}</span>
        </template>
      </p>
      <div class="actions">
        <button type="button" class="btn small" :disabled="jobRunning || checking" @click="refresh">
          {{ checking ? 'Checking…' : 'Check now' }}
        </button>
        <ConfirmButton
          class="small primary"
          :label="`Update everything${allCount ? ` (${allCount})` : ''}`"
          confirm="Install all? Click again"
          :disabled="jobRunning || !allCount"
          @confirm="update('all')"
        />
      </div>
    </header>

    <p v-if="data?.reboot" class="banner warn-banner">
      A restart is needed to finish installing
      <template v-if="data.reboot.packages.length">{{ data.reboot.packages.slice(0, 6).join(', ') }}{{ data.reboot.packages.length > 6 ? '…' : '' }}</template>
      <template v-else>earlier updates</template>.
      <RouterLink to="/system">Restart from the System page</RouterLink>.
    </p>

    <JobOutput ref="jobOutput" class="panel" @running="jobRunning = $event" @done="recheck" />

    <EmptyState v-if="error && !data" error title="Could not check for updates" :text="error" />
    <template v-else-if="!data">
      <div v-for="n in 3" :key="n" class="skeleton" style="height: 120px; border-radius: 16px"></div>
    </template>

    <section v-for="source in pending" :key="source.id" class="panel source">
      <header class="source-head">
        <h3>{{ source.title }}</h3>
        <span v-if="source.error" class="chip bad">check failed</span>
        <span v-else class="chip">{{ source.items.length }}</span>
        <span v-if="source.items.some((i) => i.security)" class="chip bad">{{ source.items.filter((i) => i.security).length }} security</span>
        <ConfirmButton
          v-if="source.canUpdate && source.items.length"
          class="small"
          :label="UPDATE_LABELS[source.id] || 'Update'"
          :confirm="CONFIRMS[source.id] || 'Install? Click again'"
          :disabled="jobRunning"
          @confirm="update(source.id)"
        />
      </header>
      <p v-if="source.error" class="error-text small">{{ source.error }}</p>
      <p v-if="source.note" class="muted small note">{{ source.note }}</p>
      <ul class="items">
        <li v-for="item in source.items" :key="item.name + (item.latest || '')">
          <div class="item-name">
            <strong :title="item.name">{{ item.name }}</strong>
            <span v-if="item.security" class="chip bad">security</span>
            <span v-if="item.containers" class="muted small">used by {{ item.containers.join(', ') }}</span>
            <span v-if="item.note" class="muted small">{{ item.note }}</span>
          </div>
          <span class="versions small">
            <template v-if="item.current"><span class="muted">{{ item.current }}</span> → </template>{{ item.latest }}
          </span>
        </li>
      </ul>
      <template v-if="source.skipped?.length">
        <button type="button" class="link small" @click="showSkipped = !showSkipped">
          {{ showSkipped ? 'Hide' : 'Show' }} {{ source.skipped.length }} not checked
        </button>
        <ul v-if="showSkipped" class="items skipped">
          <li v-for="s in source.skipped" :key="s.name">
            <span class="ellipsis">{{ s.name }}</span>
            <span class="muted small">{{ s.reason }}</span>
          </li>
        </ul>
      </template>
    </section>

    <section v-if="current.length" class="panel">
      <h3>Up to date</h3>
      <ul class="current">
        <li v-for="source in current" :key="source.id">
          <i></i>
          <strong>{{ source.title }}</strong>
          <span v-if="source.note" class="muted small">{{ source.note }}</span>
          <span v-if="source.skipped?.length" class="muted small">({{ source.skipped.length }} not checked)</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.updates { display: grid; gap: 16px; }
.page-head { margin-bottom: 0; }
.page-head p { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.headline { color: var(--text); font-size: 18px; font-weight: 600; }
.headline.good { color: var(--up); }
.actions { display: flex; gap: 8px; }
.chip.bad { border-color: color-mix(in srgb, var(--down) 45%, var(--line)); color: var(--down); }
.warn-banner { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); margin: 0; }
.warn-banner a { color: inherit; font-weight: 550; }
.source-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.source-head h3 { margin: 0 4px 0 0; }
.source-head .btn { margin-left: auto; }
.note { margin: 0 0 10px; }
.items { max-height: 360px; margin: 0; padding: 0; overflow: auto; list-style: none; }
.items li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  padding: 7px 0;
  border-top: 1px solid var(--line);
}
.item-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
.item-name strong { overflow: hidden; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.versions { flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-align: right; }
.skipped li { color: var(--muted); }
.link { margin-top: 8px; padding: 0; border: 0; background: none; color: var(--muted); text-decoration: underline; cursor: pointer; }
.current { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.current li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.current i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--up); }
.current strong { font-weight: 550; }
@media (max-width: 560px) {
  .actions { flex: 1 1 100%; }
  .items li { flex-direction: column; gap: 2px; }
  .versions { text-align: left; }
}
</style>
