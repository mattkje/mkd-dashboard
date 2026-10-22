<script setup>
import { computed, ref } from 'vue';
import { percent } from '../format.js';

// Area chart of 0..1 values over time, with a hover readout. points: [{ t, v }].
const props = defineProps({
  points: Array,
  level: String,
});

const W = 300;
const H = 64;
const hover = ref(null);

const range = computed(() => {
  const ts = props.points.map((p) => p.t);
  return { min: Math.min(...ts), max: Math.max(...ts) };
});

const x = (t) => (range.value.max === range.value.min ? W : ((t - range.value.min) / (range.value.max - range.value.min)) * W);
const y = (v) => H - Math.min(1, Math.max(0, v)) * (H - 2) - 1;

const line = computed(() => props.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(''));
const area = computed(() => (props.points.length ? `${line.value}L${W},${H}L${x(props.points[0].t).toFixed(1)},${H}Z` : ''));

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function onMove(e) {
  const box = e.currentTarget.getBoundingClientRect();
  const t = range.value.min + ((e.clientX - box.left) / box.width) * (range.value.max - range.value.min);
  let best = null;
  for (const p of props.points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  hover.value = best;
}
</script>

<template>
  <div class="spark" :class="level">
    <svg v-if="points.length > 1" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" @pointermove="onMove" @pointerleave="hover = null">
      <path class="area" :d="area"/>
      <path class="line" :d="line" vector-effect="non-scaling-stroke"/>
      <line v-if="hover" :x1="x(hover.t)" :x2="x(hover.t)" y1="0" :y2="H" class="cursor" vector-effect="non-scaling-stroke"/>
    </svg>
    <p v-else class="muted small">Collecting data…</p>
    <span v-if="hover" class="readout">{{ percent(hover.v) }} · {{ timeFormat.format(hover.t) }}</span>
  </div>
</template>

<style scoped>
.spark { position: relative; height: 64px; --c: var(--up); }
.spark.warn { --c: var(--warn); }
.spark.bad { --c: var(--down); }
svg { display: block; width: 100%; height: 100%; overflow: visible; cursor: crosshair; }
.area { fill: color-mix(in srgb, var(--c) 18%, transparent); stroke: none; }
.line { fill: none; stroke: var(--c); stroke-width: 1.5; }
.cursor { stroke: var(--muted); stroke-width: 1; }
.readout {
  position: absolute;
  top: -4px;
  right: 0;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--menu);
  font-size: 12px;
  pointer-events: none;
}
p { margin: 0; padding-top: 22px; }
</style>
