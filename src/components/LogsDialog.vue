<script setup>
import { nextTick, ref, watch } from 'vue';
import { getJson } from '../api.js';
import { lockedOut, state } from '../store.js';

const TEXT_LIMIT = 2 * 1024 * 1024;

const dialog = ref(null);
const output = ref(null);
const text = ref('');
const error = ref('');
const loading = ref(false);
const lines = ref(200);
const following = ref(false);
let stream = null;

// Keeps the view pinned to the bottom, unless you scrolled up to read.
async function scrollDown(force) {
  const el = output.value;
  const atBottom = el && el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  await nextTick();
  if (el && (force || atBottom)) el.scrollTop = el.scrollHeight;
}

async function load() {
  if (!state.logs) return;
  stop();
  loading.value = true;
  error.value = '';
  try {
    text.value = (await getJson(state.logs.url, { lines: lines.value })).text || 'No log lines.';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
  scrollDown(true);
}

// Streams new lines as they are written (journalctl -f / docker logs -f).
async function follow() {
  stop();
  following.value = true;
  error.value = '';
  text.value = '';
  const controller = new AbortController();
  stream = controller;
  try {
    const params = new URLSearchParams({ lines: lines.value, follow: '1' });
    const res = await fetch(`${state.logs.url}?${params}`, { signal: controller.signal });
    if (res.status === 401) return lockedOut();
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || res.statusText);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text.value = (text.value + value).slice(-TEXT_LIMIT);
      scrollDown(false);
    }
  } catch (err) {
    if (err.name !== 'AbortError') error.value = err.message;
  } finally {
    if (stream === controller) {
      stream = null;
      following.value = false;
    }
  }
}

function stop() {
  stream?.abort();
  stream = null;
  following.value = false;
}

function toggleFollow() {
  if (following.value) stop();
  else follow();
}

watch(() => state.logs, (logs) => {
  if (!logs) {
    stop();
    return dialog.value?.close();
  }
  text.value = '';
  if (!dialog.value.open) dialog.value.showModal();
  load();
});

watch(lines, () => (following.value ? follow() : load()));
</script>

<template>
  <dialog ref="dialog" class="sheet logs" @close="stop(); state.logs = null">
    <header class="sheet-head">
      <h3>{{ state.logs?.title }}</h3>
      <select v-model.number="lines" class="input small" aria-label="Lines">
        <option :value="100">100 lines</option>
        <option :value="200">200 lines</option>
        <option :value="1000">1000 lines</option>
        <option :value="5000">5000 lines</option>
      </select>
      <button type="button" class="btn small" :class="{ primary: following }" @click="toggleFollow">
        <span v-if="following" class="live"></span>{{ following ? 'Following' : 'Follow' }}
      </button>
      <button type="button" class="btn small" :disabled="loading || following" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      <button type="button" class="btn small" @click="dialog.close()">Close</button>
    </header>
    <p v-if="error" class="error-text">{{ error }}</p>
    <pre ref="output" class="output">{{ text || (following ? 'Waiting for log lines…' : '') }}</pre>
  </dialog>
</template>

<style scoped>
.logs { width: min(1100px, calc(100vw - 32px)); }
.output { height: min(70vh, 720px); }
.live { width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: var(--up); animation: pulse 1.4s infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
@media (max-width: 560px) {
  .sheet-head { flex-wrap: wrap; }
  .sheet-head h3 { flex-basis: 100%; }
}
</style>
