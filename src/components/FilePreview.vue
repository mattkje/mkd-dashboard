<script setup>
import { computed, ref, watch } from 'vue';

// Shows an image, video, audio file or PDF inline. path: absolute path, or null when closed.
const props = defineProps({ path: String });
const emit = defineEmits(['close']);

const KINDS = {
  image: /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i,
  video: /\.(mp4|webm|mov|m4v)$/i,
  audio: /\.(mp3|m4a|ogg|wav|flac)$/i,
  pdf: /\.pdf$/i,
};

const dialog = ref(null);

const kind = computed(() => Object.keys(KINDS).find((k) => KINDS[k].test(props.path || '')));
const url = computed(() => `/api/files/download?${new URLSearchParams({ path: props.path || '', inline: '1' })}`);
const downloadUrl = computed(() => `/api/files/download?${new URLSearchParams({ path: props.path || '' })}`);

watch(() => props.path, (path) => {
  if (path) dialog.value.showModal();
  else dialog.value?.close();
});

defineExpose({ canPreview: (path) => Object.values(KINDS).some((re) => re.test(path)) });
</script>

<template>
  <dialog ref="dialog" class="sheet preview" @close="emit('close')" @click.self="dialog.close()">
    <header class="sheet-head">
      <h3 :title="path">{{ path?.split('/').pop() }}</h3>
      <a class="btn small" :href="downloadUrl" download>Download</a>
      <button type="button" class="btn small" @click="dialog.close()">Close</button>
    </header>
    <div v-if="path" class="stage">
      <img v-if="kind === 'image'" :src="url" alt="">
      <video v-else-if="kind === 'video'" :src="url" controls autoplay playsinline></video>
      <audio v-else-if="kind === 'audio'" :src="url" controls autoplay></audio>
      <iframe v-else-if="kind === 'pdf'" :src="url" title="PDF preview"></iframe>
    </div>
  </dialog>
</template>

<style scoped>
.preview { width: min(1200px, calc(100vw - 32px)); }
.stage { display: grid; place-items: center; min-height: 200px; border-radius: 10px; background: var(--bg); overflow: hidden; }
img, video { display: block; max-width: 100%; max-height: 76vh; object-fit: contain; }
audio { width: min(480px, 100%); margin: 40px 20px; }
iframe { width: 100%; height: 76vh; border: 0; background: #fff; }
</style>
