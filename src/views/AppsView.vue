<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import AppCard from '../components/AppCard.vue';
import AppEditor from '../components/AppEditor.vue';
import ConfirmButton from '../components/ConfirmButton.vue';
import EmptyState from '../components/EmptyState.vue';
import { getJson, post, refreshStatus } from '../api.js';
import { appUrl, searchText } from '../apps.js';
import { state } from '../store.js';
import { toast } from '../toast.js';

const REFRESH_MS = 30000;
const HISTORY_MS = 60000;

const configError = ref('');
const query = ref('');
const search = ref(null);
const history = ref({});

// Edit mode works on a copy of the config, saved in one go.
const draft = ref(null);
const editTarget = ref(null);
const dragging = ref(null);
const saving = ref(false);

const groups = computed(() => {
  if (draft.value) return draft.value.groups;
  return state.config?.groups.filter((g) => g.apps.length) ?? [];
});
const apps = computed(() => groups.value.flatMap((g) => g.apps));

// Hidden with v-show rather than removed, so icons don't reload while typing.
const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  return new Set(apps.value.filter((app) => draft.value || !q || searchText(app).includes(q)).map((app) => app.id ?? app));
});

const counts = computed(() => {
  const results = apps.value.map((app) => state.status[app.id]).filter(Boolean);
  return { total: results.length, up: results.filter((s) => s.up).length };
});

const summary = computed(() => {
  if (state.statusError) return 'Could not check status';
  if (!state.statusLoaded) return 'Checking…';
  const { up, total } = counts.value;
  return up === total ? `All ${total} apps running` : `${total - up} of ${total} apps not responding`;
});

const summaryState = computed(() => {
  if (state.statusError || (state.statusLoaded && counts.value.up < counts.value.total)) return 'bad';
  return state.statusLoaded ? 'good' : '';
});

function downCount(group) {
  return group.apps.filter((app) => state.status[app.id] && !state.status[app.id].up).length;
}

function onSearchKeydown(e) {
  if (e.key === 'Enter') {
    const first = apps.value.find((app) => matches.value.has(app.id));
    if (first) window.open(appUrl(first), '_blank', 'noopener');
  }
  if (e.key === 'Escape') {
    query.value = '';
    search.value.blur();
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') state.openMenu = null;
  if (draft.value || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    search.value.focus();
  }
}

function closeMenu() {
  state.openMenu = null;
}

async function loadHistory() {
  history.value = await getJson('/api/history/apps').catch(() => history.value);
}

// Editing

// Edits the file as written, with ${...} placeholders, not the filled-in values shown on the tiles.
async function startEditing() {
  let raw;
  try {
    raw = await getJson('/api/config', { raw: '1' });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  state.openMenu = null;
  query.value = '';
  draft.value = { title: raw.title, groups: raw.groups };
}

function services(config) {
  return config.groups.flatMap((g) => g.apps.map((a) => (a.url ? '' : a.service || ''))).filter(Boolean).sort().join(',');
}

async function saveDraft() {
  saving.value = true;
  try {
    const servicesChanged = services(draft.value) !== services(state.config);
    state.config = await post('/api/config', draft.value);
    draft.value = null;
    toast(servicesChanged ? 'Saved. Re-run deploy/install.sh on the server for the service changes.' : 'Saved apps.json');
    refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    saving.value = false;
  }
}

function editApp(groupIndex, appIndex) {
  editTarget.value = { app: draft.value.groups[groupIndex].apps[appIndex], groupIndex, appIndex };
}

function addApp(groupIndex) {
  editTarget.value = { app: null, groupIndex };
}

function applyEdit({ app, groupIndex }) {
  const target = editTarget.value;
  const list = draft.value.groups;
  if (target.app && target.groupIndex === groupIndex) {
    list[groupIndex].apps[target.appIndex] = app;
  } else {
    if (target.app) list[target.groupIndex].apps.splice(target.appIndex, 1);
    list[groupIndex].apps.push(app);
  }
}

function removeApp() {
  const { groupIndex, appIndex } = editTarget.value;
  draft.value.groups[groupIndex].apps.splice(appIndex, 1);
}

function addGroup() {
  draft.value.groups.push({ name: 'New group', apps: [] });
}

function moveGroup(index, by) {
  const list = draft.value.groups;
  const [group] = list.splice(index, 1);
  list.splice(index + by, 0, group);
}

// Dropping on a tile puts the dragged app before it; dropping on "Add app" puts it at the end.
function drop(groupIndex, appIndex) {
  const from = dragging.value;
  dragging.value = null;
  if (!from) return;
  const list = draft.value.groups;
  const [app] = list[from.groupIndex].apps.splice(from.appIndex, 1);
  let index = appIndex ?? list[groupIndex].apps.length;
  if (from.groupIndex === groupIndex && from.appIndex < index) index--;
  list[groupIndex].apps.splice(index, 0, app);
}

let timer;
let historyTimer;

onMounted(async () => {
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', closeMenu);
  timer = setInterval(refreshStatus, REFRESH_MS);
  historyTimer = setInterval(loadHistory, HISTORY_MS);
  refreshStatus();
  loadHistory();
  // Re-read so edits to apps.json show up without a full reload.
  try {
    state.config = await getJson('/api/config');
  } catch (err) {
    configError.value = err.message;
  }
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('click', closeMenu);
  clearInterval(timer);
  clearInterval(historyTimer);
});
</script>

<template>
  <div>
    <header class="page-head">
      <template v-if="draft">
        <input v-model="draft.title" class="input title-input" aria-label="Dashboard title">
        <div class="actions">
          <button type="button" class="btn small" @click="addGroup">Add group</button>
          <button type="button" class="btn small" @click="draft = null">Cancel</button>
          <button type="button" class="btn small primary" :disabled="saving" @click="saveDraft">{{ saving ? 'Saving…' : 'Save' }}</button>
        </div>
      </template>
      <template v-else>
        <button id="summary" type="button" title="Check again" :class="summaryState" @click="refreshStatus">
          <i></i>{{ summary }}
        </button>
        <div class="actions">
          <label class="search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input
              id="search"
              ref="search"
              v-model="query"
              type="search"
              placeholder="Search"
              aria-label="Search apps"
              autocomplete="off"
              spellcheck="false"
              @keydown="onSearchKeydown"
            >
            <kbd>/</kbd>
          </label>
          <button v-if="state.config" type="button" class="icon-btn" title="Edit apps" aria-label="Edit apps" @click="startEditing">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>
          </button>
        </div>
      </template>
    </header>
    <p v-if="draft" class="muted small hint">Drag tiles to reorder or move them between groups. Click a tile to edit it.</p>

    <EmptyState v-if="configError" error title="Could not load apps.json" :text="configError" />
    <template v-else-if="!state.config">
      <section v-for="n in 2" :key="n" class="group">
        <div class="skeleton" style="width: 120px; height: 14px"></div>
        <div class="grid" style="margin-top: 14px">
          <div v-for="m in 5" :key="m" class="skeleton" style="height: 140px; border-radius: 16px"></div>
        </div>
      </section>
    </template>
    <EmptyState
      v-else-if="!groups.length && !draft"
      title="No apps yet"
      text="Add your first app with the pencil button above, or edit apps.json."
    />

    <section
      v-for="(group, gi) in groups"
      v-show="draft || group.apps.some((app) => matches.has(app.id))"
      :key="draft ? gi : group.name"
      class="group"
    >
      <h2 v-if="draft" class="group-edit">
        <input v-model="group.name" class="input small" aria-label="Group name">
        <button type="button" class="btn small" :disabled="gi === 0" title="Move up" @click="moveGroup(gi, -1)">↑</button>
        <button type="button" class="btn small" :disabled="gi === groups.length - 1" title="Move down" @click="moveGroup(gi, 1)">↓</button>
        <ConfirmButton class="small" label="Delete group" :confirm="group.apps.length ? `Delete with ${group.apps.length} apps?` : 'Delete?'" danger @confirm="draft.groups.splice(gi, 1)" />
      </h2>
      <h2 v-else>
        {{ group.name }}
        <span class="count">
          {{ group.apps.length }}<span v-if="downCount(group)" class="count-down"> · {{ downCount(group) }} down</span>
        </span>
      </h2>
      <div class="grid">
        <AppCard
          v-for="(app, ai) in group.apps"
          v-show="draft || matches.has(app.id)"
          :key="draft ? `${gi}-${ai}-${app.name}` : app.id"
          :app="app"
          :history="history[app.name]"
          :editing="Boolean(draft)"
          :draggable="Boolean(draft)"
          :class="{ dragging: dragging?.groupIndex === gi && dragging?.appIndex === ai }"
          @edit="editApp(gi, ai)"
          @dragstart="dragging = { groupIndex: gi, appIndex: ai }"
          @dragend="dragging = null"
          @dragover.prevent
          @drop.prevent="drop(gi, ai)"
        />
        <button
          v-if="draft"
          type="button"
          class="add-tile"
          @click="addApp(gi)"
          @dragover.prevent
          @drop.prevent="drop(gi)"
        >+ Add app</button>
      </div>
    </section>
    <EmptyState v-if="query && !matches.size" title="No matches" :text="`No app matches “${query}”.`" />

    <AppEditor v-if="draft" :target="editTarget" :groups="draft.groups" @save="applyEdit" @remove="removeApp" @close="editTarget = null" />
  </div>
</template>

<style scoped>
.actions { display: flex; align-items: center; gap: 8px; }
.title-input { width: 220px; font-size: 18px; font-weight: 600; }
.hint { margin: 0 0 4px; }
.group-edit { text-transform: none; letter-spacing: 0; }
.group-edit::after { display: none; }
.group-edit .input { width: 220px; color: var(--text); font-weight: 600; }
.add-tile {
  min-height: 120px;
  border: 1px dashed var(--line-strong);
  border-radius: 16px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.add-tile:hover { color: var(--text); border-color: var(--muted); }
.dragging { opacity: 0.4; }
@media (max-width: 560px) {
  .page-head .actions { flex: 1 1 100%; }
  .page-head .search { flex: 1; }
  .title-input { flex: 1; width: auto; }
}
</style>
