<script setup>
import { onUnmounted, ref } from 'vue';

// A button that needs a second click within a few seconds, for actions that are hard to undo.
const props = defineProps({
  label: String,
  confirm: String,
  danger: Boolean,
  disabled: Boolean,
});
const emit = defineEmits(['confirm']);

const armed = ref(false);
let timer;

function click() {
  if (!armed.value) {
    armed.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => { armed.value = false; }, 4000);
    return;
  }
  armed.value = false;
  emit('confirm');
}

onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <button
    type="button"
    class="btn"
    :class="{ danger, armed }"
    :disabled="disabled"
    @click.stop="click"
    @blur="armed = false"
  >{{ armed ? (props.confirm || `${props.label}? Click again`) : props.label }}</button>
</template>
