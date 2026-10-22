<script setup>
import { onMounted, ref } from 'vue';
import { post } from '../api.js';
import { state } from '../store.js';

const password = ref('');
const error = ref('');
const busy = ref(false);
const input = ref(null);

onMounted(() => input.value?.focus());

async function login() {
  error.value = '';
  busy.value = true;
  try {
    await post('/api/login', { password: password.value });
    password.value = '';
    state.session.authed = true;
  } catch (err) {
    error.value = err.message;
    input.value.select();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <form class="login-card" @submit.prevent="login">
      <div class="login-mark" aria-hidden="true"><span></span></div>
      <h1>MKD</h1>
      <p class="muted">Sign in to the control panel</p>
      <p v-if="!state.session.enabled" class="error-text">Login is disabled: ADMIN_PASSWORD is not set on the server.</p>
      <template v-else>
        <input
          ref="input"
          v-model="password"
          class="input"
          type="password"
          placeholder="Password"
          aria-label="Password"
          autocomplete="current-password"
          required
        >
        <button type="submit" class="btn primary" :disabled="busy || !password">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
        <p class="error-text" role="alert">{{ error }}</p>
      </template>
    </form>
  </main>
</template>

<style scoped>
.login-page { display: grid; place-items: center; min-height: calc(100vh - 112px); }
.login-card {
  display: grid;
  gap: 12px;
  width: min(340px, 100%);
  padding: 32px 28px 20px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--card);
  box-shadow: var(--shadow);
  text-align: center;
}
.login-mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin: 0 auto 4px;
  border-radius: 12px;
  background: var(--text);
}
.login-mark span { width: 16px; height: 16px; border-radius: 50%; background: var(--bg); }
h1 { margin: 0; font-size: 24px; }
.muted { margin: -8px 0 8px; }
.btn.primary { height: 40px; }
.error-text { min-height: 1.4em; margin: 0; }
</style>
