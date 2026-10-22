<script setup>
import { dismiss, toasts } from '../toast.js';
</script>

<template>
  <div class="toaster" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <button
        v-for="t in toasts"
        :key="t.id"
        type="button"
        class="toast"
        :class="t.kind"
        title="Dismiss"
        @click="dismiss(t.id)"
      >
        <i></i>{{ t.message }}
      </button>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toaster {
  position: fixed;
  right: 16px;
  bottom: calc(16px + env(safe-area-inset-bottom));
  z-index: 50;
  display: grid;
  justify-items: end;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--menu);
  box-shadow: var(--shadow);
  color: var(--text);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
}
.toast i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--up); }
.toast.error { border-color: color-mix(in srgb, var(--down) 40%, var(--line)); }
.toast.error i { background: var(--down); }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }
@media (max-width: 560px) {
  /* Above the bottom tab bar. */
  .toaster { bottom: calc(76px + env(safe-area-inset-bottom)); left: 16px; justify-items: stretch; }
}
</style>
