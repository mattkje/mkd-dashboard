<script setup>
import { computed, ref, watch } from 'vue';
import ConfirmButton from './ConfirmButton.vue';
import { getJson, post } from '../api.js';
import { toast } from '../toast.js';

// Path of the file to edit, or null when closed.
const props = defineProps({ path: String });
const emit = defineEmits(['close', 'saved']);

const dialog = ref(null);
const content = ref('');
const original = ref('');
const mtime = ref(0);
const error = ref('');
const saving = ref(false);
const loaded = ref(false);

const dirty = computed(() => content.value !== original.value);

watch(() => props.path, async (path) => {
  if (!path) return dialog.value?.close();
  loaded.value = false;
  error.value = '';
  content.value = original.value = '';
  dialog.value.showModal();
  try {
    const file = await getJson('/api/files/read', { path });
    content.value = original.value = file.content;
    mtime.value = file.mtime;
    loaded.value = true;
  } catch (err) {
    error.value = err.message;
  }
});

async function save() {
  if (!loaded.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await post('/api/files/write', { path: props.path, content: content.value, mtime: mtime.value });
    mtime.value = result.mtime;
    original.value = content.value;
    toast(`Saved ${props.path.split('/').pop()}`);
    emit('saved');
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
}

// Escape would close the dialog and drop unsaved changes.
function onCancel(e) {
  if (dirty.value) e.preventDefault();
}
</script>

<template>
  <dialog ref="dialog" class="sheet editor" @close="emit('close')" @cancel="onCancel" @keydown="onKeydown">
    <header class="sheet-head">
      <h3 :title="path">{{ path?.split('/').pop() }}<span v-if="dirty" class="muted"> · edited</span></h3>
      <button type="button" class="btn small primary" :disabled="!dirty || saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
      <ConfirmButton v-if="dirty" class="small" label="Close" confirm="Discard changes?" @confirm="dialog.close()" />
      <button v-else type="button" class="btn small" @click="dialog.close()">Close</button>
    </header>
    <p class="muted small path">{{ path }}</p>
    <p v-if="error" class="error-text">{{ error }}</p>
    <textarea
      v-if="loaded"
      v-model="content"
      class="output"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
    ></textarea>
  </dialog>
</template>

<style scoped>
.editor { width: min(1100px, calc(100vw - 32px)); }
.path { margin: -4px 0 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea { width: 100%; height: min(70vh, 760px); resize: vertical; border: 0; outline: none; color: var(--text); }
</style>
