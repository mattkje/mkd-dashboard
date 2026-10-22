<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ConfirmButton from '../components/ConfirmButton.vue';
import EmptyState from '../components/EmptyState.vue';
import FileEditor from '../components/FileEditor.vue';
import FilePreview from '../components/FilePreview.vue';
import { getJson, post, upload } from '../api.js';
import { bytes, dateTime } from '../format.js';
import { attempt, toast } from '../toast.js';

const route = useRoute();
const router = useRouter();

const listing = ref(null);
const loading = ref(false);
const error = ref('');
const showHidden = ref(false);
const editing = ref(null);
const previewing = ref(null);
const preview = ref(null);
const renaming = ref(null);
const newName = ref('');
const creating = ref(false);
const folderName = ref('');
const uploads = ref([]);
const dragging = ref(false);
const fileInput = ref(null);
const nameInput = ref(null);
const selected = ref(new Set());
const moving = ref(false);
const moveTo = ref('');
// Typing filters this folder; "Search subfolders" looks deeper on the server.
const filter = ref('');
const results = ref(null);
const searching = ref(false);

const join = (dir, name) => `${dir === '/' ? '' : dir}/${name}`;

const entries = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return (listing.value?.entries ?? [])
    .filter((e) => showHidden.value || !e.name.startsWith('.') || (q && e.name.toLowerCase().includes(q)))
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .map((e) => ({ ...e, path: join(listing.value.path, e.name) }));
});

const rows = computed(() => results.value ?? entries.value);
// The single selected entry, for the Rename/Download buttons that replace row actions on phones.
const selectedEntry = computed(() => (selected.value.size === 1 ? rows.value.find((e) => selected.value.has(e.path)) : null));
const allSelected = computed(() => rows.value.length > 0 && rows.value.every((e) => selected.value.has(e.path)));

// "/home/me/docs" becomes [/, home, matti, docs] with the path to each.
const crumbs = computed(() => {
  const path = listing.value?.path;
  if (!path) return [];
  const parts = path.split('/').filter(Boolean);
  return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))];
});

async function load() {
  error.value = '';
  loading.value = true;
  try {
    listing.value = await getJson('/api/files', route.query.path ? { path: route.query.path } : undefined);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function go(path) {
  renaming.value = null;
  creating.value = false;
  router.push({ path: '/files', query: { path } });
}

function open(entry) {
  if (entry.dir) return go(entry.path);
  if (preview.value.canPreview(entry.path)) previewing.value = entry.path;
  else editing.value = entry.path;
}

const downloadUrl = (path) => `/api/files/download?${new URLSearchParams({ path })}`;
const zipUrl = (paths) => `/api/files/zip?${new URLSearchParams(paths.map((p) => ['path', p]))}`;

function toggle(entry) {
  const next = new Set(selected.value);
  if (next.has(entry.path)) next.delete(entry.path);
  else next.add(entry.path);
  selected.value = next;
}

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(rows.value.map((e) => e.path));
}

async function run(fn, done) {
  const ok = await attempt(fn, done);
  load();
  if (results.value) searchDeep();
  return ok;
}

async function startRename(entry) {
  renaming.value = entry.path;
  newName.value = entry.name;
  await nextTick();
  nameInput.value?.[0]?.select();
}

function rename(entry) {
  const name = newName.value.trim();
  renaming.value = null;
  if (!name || name === entry.name) return;
  run(() => post('/api/files/rename', { path: entry.path, name }), `Renamed to ${name}`);
}

function remove(paths) {
  const label = paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} items`;
  run(() => post('/api/files/delete', { paths }), `Deleted ${label}`);
  selected.value = new Set();
}

function startMove() {
  moving.value = true;
  moveTo.value = listing.value.path;
}

async function move() {
  const paths = [...selected.value];
  const to = moveTo.value.trim();
  moving.value = false;
  if (!to) return;
  if (await run(() => post('/api/files/move', { paths, to }), `Moved ${paths.length} ${paths.length === 1 ? 'item' : 'items'} to ${to}`)) {
    selected.value = new Set();
  }
}

function createFolder() {
  const name = folderName.value.trim();
  creating.value = false;
  folderName.value = '';
  if (name) run(() => post('/api/files/mkdir', { path: listing.value.path, name }), `Created ${name}`);
}

async function uploadFiles(fileList) {
  const dir = listing.value.path;
  for (const file of fileList) {
    const item = { name: file.name, state: 'uploading' };
    uploads.value = [...uploads.value, item];
    try {
      await upload('/api/files/upload', { path: dir, name: file.name }, file);
      item.state = 'done';
    } catch (err) {
      item.state = err.message;
      toast(`${file.name}: ${err.message}`, 'error');
    }
    uploads.value = [...uploads.value];
  }
  const done = fileList.filter((f) => uploads.value.some((u) => u.name === f.name && u.state === 'done')).length;
  if (done) toast(`Uploaded ${done} ${done === 1 ? 'file' : 'files'}`);
  load();
  setTimeout(() => { uploads.value = uploads.value.filter((u) => u.state === 'uploading'); }, 1500);
}

function onPick(e) {
  uploadFiles([...e.target.files]);
  e.target.value = '';
}

function onDrop(e) {
  dragging.value = false;
  if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
}

async function searchDeep() {
  const q = filter.value.trim();
  if (!q) return;
  searching.value = true;
  try {
    const found = await getJson('/api/files/search', { path: listing.value.path, q });
    results.value = found.results.map((r) => ({ ...r, mode: '', link: false }));
    if (!found.complete) toast('Showing the first matches only; narrow the search for more.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  filter.value = '';
  results.value = null;
}

function relative(path) {
  const base = listing.value?.path;
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

watch(() => route.query.path, () => {
  if (route.path !== '/files') return;
  selected.value = new Set();
  clearSearch();
  load();
}, { immediate: true });
watch(filter, (q) => { if (!q) results.value = null; });
</script>

<template>
  <div
    class="files"
    :class="{ dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
  >
    <header class="toolbar">
      <nav class="crumbs" aria-label="Path">
        <button v-for="crumb in crumbs" :key="crumb.path" type="button" @click="go(crumb.path)">{{ crumb.name }}</button>
      </nav>
      <div class="actions">
        <button type="button" class="btn small" :disabled="!listing?.parent" title="Up one folder" @click="go(listing.parent)">Up</button>
        <button type="button" class="btn small" @click="go(listing?.home)">Home</button>
        <button type="button" class="btn small" @click="creating = true">New folder</button>
        <button type="button" class="btn small" @click="fileInput.click()">Upload</button>
        <input ref="fileInput" type="file" multiple hidden @change="onPick">
      </div>
    </header>

    <div class="filter-row">
      <label class="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input
          id="search"
          v-model="filter"
          type="search"
          placeholder="Filter this folder"
          aria-label="Filter files"
          autocomplete="off"
          spellcheck="false"
          @keydown.enter="searchDeep"
          @keydown.esc="clearSearch"
        >
      </label>
      <button v-if="filter.trim()" type="button" class="btn small" :disabled="searching" @click="searchDeep">
        {{ searching ? 'Searching…' : 'Search subfolders' }}
      </button>
      <label class="toggle small"><input v-model="showHidden" type="checkbox"> Hidden files</label>
    </div>

    <div v-if="selected.size" class="selection">
      <strong>{{ selected.size }} selected</strong>
      <template v-if="moving">
        <form class="move" @submit.prevent="move">
          <input v-model="moveTo" class="input small" aria-label="Move to folder" autofocus>
          <button type="submit" class="btn small primary">Move here</button>
          <button type="button" class="btn small" @click="moving = false">Cancel</button>
        </form>
      </template>
      <template v-else>
        <button v-if="selectedEntry" type="button" class="btn small mobile-only" @click="startRename(selectedEntry)">Rename</button>
        <a v-if="selectedEntry && !selectedEntry.dir" class="btn small mobile-only" :href="downloadUrl(selectedEntry.path)" download>Download</a>
        <a class="btn small" :href="zipUrl([...selected])">Download .zip</a>
        <button type="button" class="btn small" @click="startMove">Move…</button>
        <ConfirmButton class="small" label="Delete" :confirm="`Delete ${selected.size}?`" danger @confirm="remove([...selected])" />
        <button type="button" class="btn small" @click="selected = new Set()">Clear</button>
      </template>
    </div>

    <ul v-if="uploads.length" class="uploads small">
      <li v-for="(u, i) in uploads" :key="i">
        {{ u.name }} · <span :class="{ 'error-text': !['uploading', 'done'].includes(u.state) }">{{ u.state }}</span>
      </li>
    </ul>

    <EmptyState v-if="error" error title="Can’t open this folder" :text="error">
      <button type="button" class="btn small" @click="go(listing?.home || '/')">Go home</button>
    </EmptyState>
    <div v-else-if="!listing" class="skeleton" style="height: 420px; border-radius: 16px"></div>

    <div v-else class="list" :class="{ loading }">
      <div v-if="rows.length" class="row head small muted">
        <input type="checkbox" :checked="allSelected" aria-label="Select all" @change="toggleAll">
        <span></span>
        <span>{{ results ? `${results.length} matches below this folder` : 'Name' }}</span>
        <span class="size">Size</span>
        <span class="date">Modified</span>
        <span class="mode"></span>
        <span></span>
      </div>
      <form v-if="creating" class="row" @submit.prevent="createFolder">
        <span></span>
        <span class="kind dir"></span>
        <input v-model="folderName" class="input small" placeholder="Folder name" autofocus @blur="createFolder" @keydown.esc="creating = false">
      </form>
      <div v-for="entry in rows" :key="entry.path" class="row" :class="{ selected: selected.has(entry.path) }">
        <input type="checkbox" :checked="selected.has(entry.path)" :aria-label="`Select ${entry.name}`" @change="toggle(entry)">
        <span class="kind" :class="{ dir: entry.dir, link: entry.link }"></span>
        <form v-if="renaming === entry.path" @submit.prevent="rename(entry)">
          <input ref="nameInput" v-model="newName" class="input small" @blur="rename(entry)" @keydown.esc="renaming = null">
        </form>
        <button v-else type="button" class="name" :title="entry.path" @click="open(entry)">
          {{ results ? relative(entry.path) : entry.name }}<span v-if="entry.link" class="muted"> ↗</span>
        </button>
        <span class="muted small size">{{ entry.dir ? '' : bytes(entry.size) }}</span>
        <span class="muted small date">{{ dateTime(entry.mtime) }}</span>
        <span class="muted small mode">{{ entry.mode }}</span>
        <div class="row-actions">
          <a class="btn small" :href="entry.dir ? zipUrl([entry.path]) : downloadUrl(entry.path)" :download="entry.dir ? null : ''">
            {{ entry.dir ? 'Zip' : 'Download' }}
          </a>
          <button type="button" class="btn small" @click="startRename(entry)">Rename</button>
          <ConfirmButton class="small" label="Delete" :confirm="entry.dir ? 'Delete folder and contents?' : 'Delete?'" danger @confirm="remove([entry.path])" />
        </div>
      </div>
      <EmptyState
        v-if="!rows.length && !creating"
        :title="filter ? 'No matches' : 'Empty folder'"
        :text="filter ? (results ? 'Nothing below this folder matches.' : 'Press Enter to search subfolders too.') : 'Drop files here to upload them.'"
        class="inner-empty"
      />
    </div>

    <FileEditor :path="editing" @close="editing = null" @saved="load" />
    <FilePreview ref="preview" :path="previewing" @close="previewing = null" />
  </div>
</template>

<style scoped>
.files { min-height: 60vh; border-radius: 16px; }
.files.dragging .list { outline: 2px dashed var(--muted); outline-offset: 4px; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; font-size: 14px; }
.crumbs button { padding: 3px 6px; border: 0; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
.crumbs button:hover { background: var(--hover); color: var(--text); }
.crumbs button:last-child { color: var(--text); font-weight: 550; }
.crumbs button + button + button::before { content: '/'; margin-right: 10px; color: var(--line-strong); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 12px; }
.filter-row #search { height: 34px; }
.toggle { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; color: var(--muted); cursor: pointer; }
.selection {
  position: sticky;
  top: 8px;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--menu);
  box-shadow: var(--shadow);
}
.selection strong { margin-right: 6px; font-size: 14px; }
.move { display: flex; flex: 1; gap: 6px; min-width: 240px; }
.move .input { flex: 1; }
.uploads { margin: 0 0 12px; padding: 0; list-style: none; }
.list { border: 1px solid var(--line); border-radius: 16px; background: var(--card); overflow: hidden; transition: opacity 0.15s; }
.list.loading { opacity: 0.6; }
.row {
  display: grid;
  grid-template-columns: 18px 18px minmax(0, 1fr) 80px 160px 40px auto;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 4px 12px 4px 14px;
}
.row + .row { border-top: 1px solid var(--line); }
.row:not(.head):hover { background: var(--hover); }
.row.selected { background: color-mix(in srgb, var(--accent) 9%, transparent); }
.row.head { min-height: 34px; }
.row form { min-width: 0; }
.row form .input { width: 100%; }
.kind { width: 16px; height: 16px; border: 1.5px solid var(--muted); border-radius: 3px; }
.kind.dir { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 22%, transparent); border-radius: 2px 5px 3px 3px; }
.name {
  overflow: hidden;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.name:hover { text-decoration: underline; }
.size { text-align: right; }
.row-actions { display: flex; gap: 6px; opacity: 0; transition: opacity 0.1s; }
.row:hover .row-actions, .row:focus-within .row-actions { opacity: 1; }
.inner-empty { margin: 12px; }
@media (max-width: 760px) {
  .row { grid-template-columns: 18px 18px minmax(0, 1fr) auto; }
  .size, .date, .mode { display: none; }
  /* Row actions move into the selection bar on phones. */
  .row-actions { display: none; }
  .toggle { margin-left: 0; }
  .filter-row .search { flex: 1; }
  .filter-row #search { width: 100%; }
}
@media (min-width: 761px) {
  .mobile-only { display: none; }
}
@media (hover: none) {
  .row-actions { opacity: 1; }
}
</style>
