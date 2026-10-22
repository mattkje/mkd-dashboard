<script setup>
import { computed, reactive, ref, watch } from 'vue';
import ConfirmButton from './ConfirmButton.vue';
import { colorFor, iconSrc } from '../apps.js';

// Edits one app of the draft config. target: { app, groupIndex } (app is null for a new one), or null when closed.
const props = defineProps({ target: Object, groups: Array });
const emit = defineEmits(['save', 'remove', 'close']);

const dialog = ref(null);
const EMPTY = { name: '', description: '', kind: 'local', port: '', scheme: 'http', path: '', url: '', icon: '', service: '', checkUrl: '', group: 0 };

const form = reactive({ ...EMPTY });
const error = ref('');
const advanced = ref(false);

watch(() => props.target, (target) => {
  if (!target) return dialog.value?.close();
  const app = target.app || {};
  Object.assign(form, EMPTY, app, { kind: app.url ? 'remote' : 'local', port: app.port ?? '', group: target.groupIndex });
  for (const key of Object.keys(EMPTY)) form[key] ??= EMPTY[key];
  advanced.value = Boolean(app.checkUrl);
  error.value = '';
  dialog.value.showModal();
});

const preview = computed(() => iconSrc((form.icon || '').trim()));

function save() {
  error.value = '';
  const app = {
    name: String(form.name).trim(),
    description: String(form.description).trim(),
    icon: String(form.icon).trim(),
    checkUrl: String(form.checkUrl).trim(),
  };
  if (!app.name) return (error.value = 'Give the app a name.');
  if (form.kind === 'remote') {
    app.url = String(form.url).trim();
    if (!/^https?:\/\/\S+$/.test(app.url)) return (error.value = 'The URL must start with http:// or https://.');
  } else {
    app.port = Number(form.port);
    if (!Number.isInteger(app.port) || app.port < 1 || app.port > 65535) return (error.value = 'Port must be a number from 1 to 65535.');
    app.scheme = form.scheme;
    app.path = String(form.path).trim();
    app.service = String(form.service).trim();
  }
  for (const key of Object.keys(app)) if (app[key] === '') delete app[key];
  if (app.scheme === 'http') delete app.scheme;
  emit('save', { app, groupIndex: form.group });
  dialog.value.close();
}
</script>

<template>
  <dialog ref="dialog" class="sheet editor" @close="emit('close')">
    <form @submit.prevent="save">
      <header class="sheet-head">
        <h3>{{ target?.app ? `Edit ${target.app.name}` : 'Add app' }}</h3>
        <ConfirmButton v-if="target?.app" class="small" label="Remove" confirm="Remove app?" danger @confirm="emit('remove'); dialog.close()" />
        <button type="button" class="btn small" @click="dialog.close()">Cancel</button>
        <button type="submit" class="btn small primary">{{ target?.app ? 'Done' : 'Add' }}</button>
      </header>

      <div class="fields">
        <div class="preview">
          <div class="icon" :style="{ background: colorFor(form.name || '?') }">
            <img v-if="preview" :src="preview" alt="" @error="$event.target.hidden = true" @load="$event.target.hidden = false">
            <span>{{ (form.name || '?').charAt(0).toUpperCase() }}</span>
          </div>
        </div>
        <label>Name<input v-model="form.name" class="input" required autofocus></label>
        <label>Description<input v-model="form.description" class="input" placeholder="Media server"></label>
        <label>Group
          <select v-model.number="form.group" class="input">
            <option v-for="(group, i) in groups" :key="i" :value="i">{{ group.name }}</option>
          </select>
        </label>

        <div class="kind" role="radiogroup" aria-label="Where it runs">
          <label><input v-model="form.kind" type="radio" value="local"> On this server</label>
          <label><input v-model="form.kind" type="radio" value="remote"> Somewhere else (URL)</label>
        </div>

        <template v-if="form.kind === 'local'">
          <div class="row">
            <label>Port<input v-model="form.port" class="input" inputmode="numeric" placeholder="8096"></label>
            <label>Scheme
              <select v-model="form.scheme" class="input"><option>http</option><option>https</option></select>
            </label>
            <label>Path<input v-model="form.path" class="input" placeholder="/web"></label>
          </div>
          <label>systemd service
            <input v-model="form.service" class="input" placeholder="jellyfin">
            <small class="muted">Enables start/stop and logs. Re-run <code>deploy/install.sh</code> on the server after changing it.</small>
          </label>
        </template>
        <label v-else>URL<input v-model="form.url" class="input" placeholder="https://other-server.tailnet.ts.net:3000"></label>

        <label>Icon
          <input v-model="form.icon" class="input" placeholder="jellyfin, or /icons/my-app.png, or https://…">
          <small class="muted">A name from <a href="https://dashboardicons.com" target="_blank" rel="noopener">dashboard-icons</a>, or an image URL.</small>
        </label>

        <button v-if="!advanced" type="button" class="link small" @click="advanced = true">More options</button>
        <label v-else>Status check URL
          <input v-model="form.checkUrl" class="input" placeholder="Defaults to the app's own address">
        </label>

        <p v-if="error" class="error-text">{{ error }}</p>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.editor { width: min(520px, calc(100vw - 32px)); }
.fields { display: grid; gap: 14px; }
label { display: grid; gap: 5px; font-size: 13px; font-weight: 500; }
label .input { font-weight: 400; }
small { font-weight: 400; }
.row { display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 10px; }
.kind { display: flex; flex-wrap: wrap; gap: 6px 18px; }
.kind label { display: flex; align-items: center; gap: 6px; font-weight: 400; }
.preview { display: flex; justify-content: center; }
.preview .icon { position: relative; overflow: hidden; }
.preview img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: var(--menu); }
.link { justify-self: start; padding: 0; border: 0; background: none; color: var(--muted); text-decoration: underline; cursor: pointer; }
code { font-size: 12px; }
p { margin: 0; }
</style>
