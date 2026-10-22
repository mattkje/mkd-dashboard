<script setup>
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { getJson } from '../api.js';
import { toast } from '../toast.js';

// Live output of the current maintenance job (apt, docker update). Call poll() after starting one.
// Emits running (true/false) on every poll, and done when a job it watched finishes.
// hideFinished: show a finished job only if it was started from this page.
defineProps({ hideFinished: Boolean });
const emit = defineEmits(['done', 'running']);

const POLL_MS = 1000;

const job = ref(null);
const output = ref(null);
let timer;
// Set when this page started the job, so a job that finishes before the next poll still reports.
let started = false;
const ownJob = ref(null);

// Appends new output since the last poll, until the job is done.
async function poll(fresh = false) {
  clearTimeout(timer);
  try {
    const offset = fresh ? 0 : job.value?.offset || 0;
    const next = (await getJson('/api/job', { offset })).job;
    if (!next) return;
    emit('running', !next.done);
    const same = !fresh && next.id === job.value?.id;
    const wasRunning = same && !job.value.done;
    if (started) ownJob.value = next.id;
    job.value = { ...next, output: same ? job.value.output + next.output : next.output };
    await nextTick();
    if (output.value) output.value.scrollTop = output.value.scrollHeight;
    if (!next.done) {
      timer = setTimeout(() => poll(), POLL_MS);
    } else if (wasRunning || started) {
      started = false;
      toast(next.code === 0 ? `${next.title}: done` : `${next.title} failed (exit ${next.code})`, next.code === 0 ? 'ok' : 'error');
      emit('done', next);
    }
  } catch {
    timer = setTimeout(() => poll(), POLL_MS * 5);
  }
}

defineExpose({
  poll: () => {
    started = true;
    return poll(true);
  },
});

onMounted(() => poll(true));
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div v-if="job && (!hideFinished || !job.done || job.id === ownJob)" class="job">
    <p class="small">
      <strong>{{ job.title }}</strong>
      <span class="muted"> · {{ job.done ? (job.code === 0 ? 'finished' : `failed (exit ${job.code})`) : 'running…' }}</span>
    </p>
    <pre ref="output" class="output">{{ job.output || '…' }}</pre>
  </div>
</template>

<style scoped>
.job { margin-top: 16px; }
.job p { margin: 0 0 6px; }
.output { max-height: 320px; }
</style>
