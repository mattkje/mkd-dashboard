<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import EmptyState from '../components/EmptyState.vue';
import { getJson, post } from '../api.js';
import { attempt } from '../toast.js';
import { apiUrl } from '../api.js';
import { bytes, dateTime } from '../format.js';

const data = ref(null);
const error = ref('');
const busy = ref('');
const live = ref(true);
const streamKey = ref(0);
const now = ref(Date.now());

// Live view and saved captures are this dashboard's own routes even when another server is shown;
// this page only exists for the main dashboard, so apiUrl keeps them local anyway.
const liveSrc = computed(() => `${apiUrl('/api/camera/live')}?k=${streamKey.value}`);
const recording = computed(() => data.value?.recording);
const elapsed = computed(() => {
  if (!recording.value) return '';
  const s = Math.max(0, Math.floor((now.value - recording.value.since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});

function captureUrl(name, inline) {
  return `${apiUrl(`/api/camera/captures/${encodeURIComponent(name)}`)}${inline ? '?inline=1' : ''}`;
}

async function load() {
  try {
    data.value = await getJson('/api/camera');
    error.value = '';
  } catch (err) {
    error.value = err.message;
  }
}

async function photo() {
  busy.value = 'photo';
  await attempt(() => post('/api/camera/photo'), 'Photo saved');
  busy.value = '';
  load();
}

async function toggleRecording() {
  busy.value = 'record';
  if (recording.value) {
    await attempt(() => post('/api/camera/record/stop'), 'Recording saved');
  } else {
    await attempt(() => post('/api/camera/record/start'), 'Recording started');
  }
  busy.value = '';
  load();
}

function reloadStream() {
  streamKey.value += 1;
  live.value = true;
}

let poll, tick;
onMounted(() => {
  load();
  poll = setInterval(load, 5000);
  tick = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => { clearInterval(poll); clearInterval(tick); });
</script>

<template>
  <div>
    <header class="page-head">
      <p class="muted">{{ data?.configured ? data.name : 'Surveillance' }}</p>
      <div class="actions">
        <button type="button" class="btn small" :disabled="!data?.configured" @click="reloadStream">Reload stream</button>
      </div>
    </header>

    <EmptyState
      v-if="data && !data.configured"
      title="No camera configured"
      text="Set CAMERA_URL (and optionally CAMERA_NAME, CAMERA_DIR) in the dashboard's environment, then restart it."
    />
    <EmptyState v-else-if="error && !data" error title="Could not load the camera" :text="error" />

    <template v-else-if="data?.configured">
      <div class="viewer panel">
        <div class="frame">
          <img v-if="live" :src="liveSrc" alt="Live camera view" @error="live = false" />
          <div v-else class="offline">
            <span>Stream stopped.</span>
            <button type="button" class="btn small" @click="reloadStream">Try again</button>
          </div>
          <span v-if="recording" class="rec">● REC {{ elapsed }}</span>
        </div>
        <div class="controls">
          <button type="button" class="btn" :disabled="busy === 'photo'" @click="photo">
            {{ busy === 'photo' ? 'Saving…' : 'Take photo' }}
          </button>
          <button
            type="button"
            class="btn"
            :class="{ armed: recording }"
            :disabled="busy === 'record'"
            @click="toggleRecording"
          >
            {{ recording ? 'Stop recording' : 'Record' }}
          </button>
          <span class="muted small path">Saved to {{ data.dir }}</span>
        </div>
      </div>

      <h2 class="section">Captures</h2>
      <EmptyState v-if="!data.captures.length" title="Nothing saved yet" text="Photos and recordings you take appear here." />
      <div v-else class="gallery">
        <figure v-for="c in data.captures" :key="c.name" class="item panel">
          <a :href="captureUrl(c.name, true)" target="_blank" rel="noopener" class="thumb">
            <img v-if="c.kind === 'photo'" :src="captureUrl(c.name, true)" :alt="c.name" loading="lazy" />
            <span v-else class="video-badge">▶ video</span>
          </a>
          <figcaption>
            <span class="ellipsis" :title="c.name">{{ c.name }}</span>
            <span class="muted small">{{ dateTime(c.time) }} · {{ bytes(c.size) }}</span>
            <a class="btn small" :href="captureUrl(c.name)" download>Download</a>
          </figcaption>
        </figure>
      </div>
    </template>
  </div>
</template>

<style scoped>
.viewer { display: grid; gap: 14px; }
.frame {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  display: grid;
  place-items: center;
}
.frame img { width: 100%; height: 100%; object-fit: contain; }
.offline { display: grid; gap: 10px; justify-items: center; color: var(--muted); }
.rec {
  position: absolute; top: 12px; left: 12px;
  padding: 3px 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--down) 85%, #000); color: #fff;
  font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
}
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.controls .path { margin-left: auto; }
.section { margin: 24px 0 12px; font-size: 16px; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
.item { padding: 0; overflow: hidden; }
.thumb {
  display: grid; place-items: center;
  aspect-ratio: 16 / 9; background: #000;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.video-badge { color: #fff; font-size: 14px; }
figcaption { display: grid; gap: 4px; padding: 10px 12px; }
figcaption .btn { justify-self: start; margin-top: 4px; }
@media (max-width: 640px) {
  .controls .path { margin-left: 0; width: 100%; }
}
</style>
