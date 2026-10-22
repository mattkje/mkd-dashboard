<script setup>
import { computed, ref, watch } from 'vue';
import ServiceMenu from './ServiceMenu.vue';
import { appUrl, colorFor, iconSrc } from '../apps.js';
import { percent } from '../format.js';
import { state } from '../store.js';

// history: { uptime, downs, buckets } over 24 hours. editing: tile is edited, not opened.
const props = defineProps({ app: Object, history: Object, editing: Boolean });
const emit = defineEmits(['edit']);

const url = computed(() => appUrl(props.app));
const icon = computed(() => iconSrc(props.app.icon));
const status = computed(() => (props.editing ? null : state.status[props.app.id]));
const hasService = computed(() => Boolean(props.app.service && !props.app.url));
const open = computed(() => state.openMenu === props.app.id);
// Show the letter until the icon has loaded, and keep it if the icon fails.
const iconLoaded = ref(false);
watch(icon, () => { iconLoaded.value = false; });

const uptimeTitle = computed(() => {
  const h = props.history;
  if (!h || h.uptime === null) return '';
  const downs = h.downs ? ` · went down ${h.downs}×` : '';
  return `${percent(h.uptime)} up over the last 24 hours${downs}`;
});

function segment(value) {
  if (value === null) return '';
  if (value >= 0.999) return 'up';
  return value <= 0.001 ? 'down' : 'partial';
}

function toggleMenu() {
  state.openMenu = open.value ? null : props.app.id;
}
</script>

<template>
  <div class="app" :class="{ down: status && !status.up, open, 'has-service': hasService && !editing, editing }">
    <!-- The link covers the whole tile; the service menu button sits above it. -->
    <button
      v-if="editing"
      type="button"
      class="app-link"
      :aria-label="`Edit ${app.name}`"
      @click="emit('edit')"
    ></button>
    <a
      v-else
      class="app-link"
      :href="url"
      target="_blank"
      rel="noopener"
      :title="url.replace(/^https?:\/\//, '')"
      :aria-label="`Open ${app.name}`"
    ></a>
    <div class="icon-wrap">
      <div class="icon" :class="{ 'has-img': iconLoaded }" :style="{ background: colorFor(app.name) }">
        <template v-if="!iconLoaded">{{ app.name.charAt(0).toUpperCase() }}</template>
        <img v-if="icon" v-show="iconLoaded" :src="icon" alt="" @load="iconLoaded = true">
      </div>
      <i
        class="dot"
        :class="status && (status.up ? 'up' : 'down')"
        :title="status && (status.up ? 'Running' : 'Not responding')"
      ></i>
    </div>
    <div class="name">{{ app.name }}</div>
    <div v-if="app.description" class="desc">{{ app.description }}</div>
    <div v-if="!editing && history?.uptime != null" class="uptime" :title="uptimeTitle">
      <i v-for="(value, i) in history.buckets" :key="i" :class="segment(value)"></i>
    </div>
    <span v-if="editing" class="edit-badge" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>
    </span>
    <template v-if="hasService && !editing">
      <button class="more" type="button" title="Service" @click.stop="toggleMenu">
        <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
      <ServiceMenu v-if="open" :app-id="app.id" />
    </template>
  </div>
</template>

<style scoped>
.uptime { display: flex; gap: 1px; height: 4px; margin: 10px 4px 0; }
.uptime i { flex: 1; border-radius: 1px; background: var(--line); }
.uptime i.up { background: color-mix(in srgb, var(--up) 70%, transparent); }
.uptime i.partial { background: var(--warn); }
.uptime i.down { background: var(--down); }
.editing { cursor: grab; border-style: dashed; }
.editing .app-link { border: 0; background: none; cursor: inherit; }
.edit-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--line);
  color: var(--muted);
  pointer-events: none;
}
.edit-badge svg { width: 13px; height: 13px; }
</style>
