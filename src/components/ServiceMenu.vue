<script setup>
import { computed, ref, watch } from 'vue';
import { post, refreshStatus } from '../api.js';
import { openLogs, state } from '../store.js';
import { toast } from '../toast.js';

const CONFIRM = new Set(['stop', 'disable']);
const LABELS = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  enable: 'Start on boot',
  disable: 'Don’t start on boot',
};

const DONE = {
  start: 'Started',
  stop: 'Stopped',
  restart: 'Restarted',
  enable: 'Enabled start on boot for',
  disable: 'Disabled start on boot for',
};

const props = defineProps({ appId: String });

const service = computed(() => state.status[props.appId]?.service);
const running = computed(() => service.value?.active === 'active');
const enabled = computed(() => service.value?.enabled === 'enabled');
const actions = computed(() => [...(running.value ? ['restart', 'stop'] : ['start']), enabled.value ? 'disable' : 'enable']);

const busy = ref(false);
const note = ref('');
const armed = ref(null);

// Fresh service state clears a failure note and any half-confirmed action.
watch(service, () => {
  note.value = '';
  armed.value = null;
});

const heading = computed(() => {
  if (busy.value) return 'Working…';
  return note.value || (running.value ? 'Running' : 'Stopped');
});

function label(action) {
  return armed.value === action ? `${LABELS[action]}? Click again` : LABELS[action];
}

// Stop and disable need a second click.
async function run(action) {
  if (CONFIRM.has(action) && armed.value !== action) {
    armed.value = action;
    return;
  }
  busy.value = true;
  try {
    const body = await post(`/api/apps/${props.appId}/${action}`);
    state.status[props.appId] = { ...state.status[props.appId], service: body.service };
    toast(`${DONE[action]} ${body.service.unit}`);
    setTimeout(refreshStatus, 1500);
  } catch (err) {
    note.value = `Failed: ${err.message}`;
    toast(`${LABELS[action]} failed: ${err.message}`, 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="menu" @click.stop>
    <div class="menu-state">
      <template v-if="!service">Checking…</template>
      <template v-else-if="service.error"><strong>{{ service.unit }}</strong>{{ service.error }}</template>
      <template v-else>
        <strong>{{ heading }}</strong>{{ service.unit }} · {{ enabled ? 'starts on boot' : 'manual start' }}
      </template>
    </div>
    <template v-if="service && !service.error">
      <button
        v-for="action in actions"
        :key="action"
        type="button"
        :class="{ danger: CONFIRM.has(action) }"
        :disabled="busy"
        @click="run(action)"
      >{{ label(action) }}</button>
    </template>
    <button v-if="service" type="button" class="menu-logs" @click="openLogs(service.unit, `/api/apps/${appId}/logs`)">View logs</button>
  </div>
</template>
