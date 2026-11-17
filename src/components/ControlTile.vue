<script setup>
import { onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

// A system control: an icon, a name and a line of detail. With `confirm`, the first click arms it
// and a second click within a few seconds runs it. With `to`, it is a link instead.
const props = defineProps({
  icon: { type: String, required: true },
  label: String,
  hint: String,
  confirm: String,
  tone: { type: String, default: '' }, // '', 'danger', 'warn', 'accent'
  disabled: Boolean,
  busy: Boolean,
  to: String,
});
const emit = defineEmits(['run']);

const armed = ref(false);
let timer;

function click() {
  if (props.disabled || props.busy) return;
  if (props.confirm && !armed.value) {
    armed.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => { armed.value = false; }, 4000);
    return;
  }
  armed.value = false;
  emit('run');
}

onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <RouterLink v-if="to" :to="to" class="tile" :class="tone">
    <span class="tile-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icon"/></svg></span>
    <span class="tile-text"><strong>{{ label }}</strong><span v-if="hint">{{ hint }}</span></span>
  </RouterLink>
  <button
    v-else
    type="button"
    class="tile"
    :class="[tone, { armed, busy }]"
    :disabled="disabled"
    :aria-busy="busy"
    @click="click"
    @blur="armed = false"
  >
    <span class="tile-icon">
      <span v-if="busy" class="spinner"></span>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path :d="icon"/></svg>
    </span>
    <span class="tile-text">
      <strong>{{ armed ? confirm : label }}</strong>
      <span>{{ armed ? 'Click again to confirm' : hint }}</span>
    </span>
  </button>
</template>

<style scoped>
.tile {
  --tone: var(--text);
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 64px;
  padding: 10px 14px 10px 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg);
  color: var(--text);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, transform 0.1s;
}
.tile:hover:not(:disabled) { border-color: var(--line-strong); background: var(--hover); }
.tile:active:not(:disabled) { transform: scale(0.985); }
.tile:disabled { opacity: 0.5; cursor: default; }
.tile.danger { --tone: var(--down); }
.tile.warn { --tone: var(--warn); }
.tile.accent { --tone: var(--accent); }
.tile-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--tone) 12%, transparent);
  color: var(--tone);
}
.tile-icon svg { width: 19px; height: 19px; }
.tile-text { display: grid; min-width: 0; gap: 1px; }
.tile-text strong { overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.tile-text span { overflow: hidden; color: var(--muted); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
.tile.armed { border-color: var(--tone); background: color-mix(in srgb, var(--tone) 10%, var(--bg)); }
.tile.armed .tile-icon { background: var(--tone); color: #fff; }
.tile.armed .tile-text strong { color: var(--tone); }
.tile.busy { cursor: progress; }
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
