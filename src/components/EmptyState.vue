<script setup>
// A centered message for "nothing here" and "can't load this" states.
defineProps({
  title: String,
  text: String,
  error: Boolean,
});
</script>

<template>
  <div class="empty-state" :class="{ error }">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <template v-if="error"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></template>
      <template v-else><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/></template>
    </svg>
    <strong>{{ title }}</strong>
    <p v-if="text">{{ text }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty-state {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 48px 24px;
  border: 1px dashed var(--line-strong);
  border-radius: 16px;
  color: var(--muted);
  text-align: center;
}
.empty-state svg { width: 28px; height: 28px; margin-bottom: 4px; stroke-width: 1.6; }
.empty-state.error svg { color: var(--down); }
.empty-state strong { color: var(--text); font-weight: 600; }
.empty-state p { max-width: 460px; margin: 0; font-size: 14px; }
</style>
