<script setup>
import { computed, onActivated, onMounted, onUnmounted, ref } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import ConfirmButton from '../components/ConfirmButton.vue';
import { getJson, post } from '../api.js';
import { attempt } from '../toast.js';

defineOptions({ name: 'TerminalView' });

const RECONNECT_MS = 2000;

const container = ref(null);
const connected = ref(false);
const ended = ref('');
// With tmux: the server's sessions and the one shown. Without: a single plain shell.
const tmux = ref(null);
const sessions = ref([]);
const current = ref(null);
const ctrl = ref(false);

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  scrollback: 5000,
  theme: { background: '#161513', foreground: '#ecebe6', cursor: '#ecebe6', selectionBackground: '#4a4842' },
});
const fit = new FitAddon();
term.loadAddon(fit);

let ws = null;
let reconnectTimer;

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function resize() {
  if (!container.value?.offsetParent) return;
  fit.fit();
  send({ type: 'resize', cols: term.cols, rows: term.rows });
}

function disconnect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  connected.value = false;
}

function connect(name = current.value) {
  disconnect();
  current.value = name;
  ended.value = '';
  term.reset();
  const params = name ? `?${new URLSearchParams({ session: name })}` : '';
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal${params}`);
  ws = socket;
  socket.onopen = () => {
    connected.value = true;
    resize();
    term.focus();
    if (tmux.value) loadSessions();
  };
  socket.onmessage = (e) => term.write(e.data);
  socket.onclose = (e) => {
    connected.value = false;
    ws = null;
    // A tmux session outlives the connection: quietly reattach after a network blip.
    if (e.code !== 4000 && tmux.value && name) {
      ended.value = 'Reconnecting…';
      reconnectTimer = setTimeout(() => connect(name), RECONNECT_MS);
      return;
    }
    ended.value = e.code === 4000 ? 'Session ended' : 'Connection lost';
    if (tmux.value) loadSessions();
  };
}

async function loadSessions() {
  const result = await getJson('/api/terminal/sessions').catch(() => null);
  if (!result) return;
  tmux.value = result.tmux;
  sessions.value = result.sessions;
}

function nextName() {
  const names = new Set(sessions.value.map((s) => s.name));
  if (!names.has('main')) return 'main';
  let n = 2;
  while (names.has(`shell-${n}`)) n++;
  return `shell-${n}`;
}

function newSession() {
  const name = nextName();
  sessions.value = [...sessions.value, { name }];
  connect(name);
}

async function endSession(name) {
  if (!(await attempt(() => post(`/api/terminal/sessions/${name}/kill`), `Ended ${name}`))) return;
  await loadSessions();
  if (name !== current.value) return;
  const other = sessions.value[0];
  if (other) connect(other.name);
  else newSession();
}

// Extra keys for phones, whose keyboards have no Esc, Ctrl, Tab or arrows.
const KEYS = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', ctrl: true },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: '|', data: '|' },
  { label: '~', data: '~' },
  { label: '/', data: '/' },
  { label: '-', data: '-' },
];

function pressKey(key) {
  if (key.ctrl) {
    ctrl.value = !ctrl.value;
  } else {
    send({ type: 'input', data: key.data });
  }
  term.focus();
}

// With Ctrl armed from the key bar, the next letter becomes its control character (Ctrl+C = \x03).
term.onData((data) => {
  if (ctrl.value && data.length === 1 && /[a-z@[\\\]^_ ]/i.test(data)) {
    ctrl.value = false;
    send({ type: 'input', data: String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f) });
    return;
  }
  send({ type: 'input', data });
});

const status = computed(() => {
  if (connected.value) return current.value ? `Connected to ${current.value}` : 'Connected';
  return ended.value || 'Connecting…';
});

const observer = new ResizeObserver(() => resize());

onMounted(async () => {
  term.open(container.value);
  observer.observe(container.value);
  await loadSessions();
  if (tmux.value) connect(sessions.value[0]?.name || 'main');
  else connect(null);
});

onActivated(() => {
  resize();
  term.focus();
  if (tmux.value) loadSessions();
});

onUnmounted(() => {
  observer.disconnect();
  disconnect();
  term.dispose();
});
</script>

<template>
  <div class="terminal-page">
    <header class="page-head">
      <div v-if="tmux" class="sessions" role="tablist">
        <button
          v-for="s in sessions"
          :key="s.name"
          type="button"
          role="tab"
          class="session"
          :class="{ active: s.name === current }"
          :aria-selected="s.name === current"
          @click="s.name !== current && connect(s.name)"
        >{{ s.name }}</button>
        <button type="button" class="session add" title="New session" @click="newSession">+</button>
      </div>
      <p class="muted small status">
        <span class="dot" :class="{ on: connected }"></span>{{ status }}
        <span v-if="tmux === false" title="Install tmux on the server to keep shells running when you close the tab.">· sessions end when you leave</span>
      </p>
      <div class="actions">
        <ConfirmButton v-if="tmux && current" class="small" label="End session" :confirm="`End ${current}?`" danger @confirm="endSession(current)" />
        <button v-if="!connected && ended && ended !== 'Reconnecting…'" type="button" class="btn small primary" @click="connect(tmux ? current || nextName() : null)">
          {{ tmux ? 'Reconnect' : 'New session' }}
        </button>
      </div>
    </header>
    <div ref="container" class="terminal" @click="term.focus()"></div>
    <div class="keys" aria-label="Extra keys">
      <button
        v-for="key in KEYS"
        :key="key.label"
        type="button"
        :class="{ armed: key.ctrl && ctrl }"
        @pointerdown.prevent
        @click="pressKey(key)"
      >{{ key.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.terminal-page { display: flex; flex-direction: column; height: calc(100vh - 150px); min-height: 320px; }
.page-head { flex-wrap: wrap; }
.sessions { display: flex; flex-wrap: wrap; gap: 4px; }
.session {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  color: var(--muted);
  font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
  cursor: pointer;
}
.session:hover { color: var(--text); }
.session.active { border-color: var(--line-strong); background: var(--hover); color: var(--text); }
.session.add { font-family: inherit; }
.status { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 160px; margin: 0; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--line-strong); }
.dot.on { background: var(--up); }
.actions { display: flex; gap: 6px; }
.terminal {
  flex: 1;
  min-height: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #161513;
  overflow: hidden;
}
.terminal :deep(.xterm) { height: 100%; }
.keys { display: none; gap: 6px; margin-top: 8px; overflow-x: auto; scrollbar-width: none; }
.keys button {
  flex: none;
  min-width: 44px;
  height: 38px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--card);
  color: var(--text);
  font: 14px ui-monospace, SFMono-Regular, Menlo, monospace;
  touch-action: manipulation;
}
.keys button.armed { border-color: var(--text); background: var(--text); color: var(--bg); }
@media (hover: none), (max-width: 760px) {
  .keys { display: flex; }
}
@media (max-width: 560px) {
  /* Room for the bottom tab bar. */
  .terminal-page { height: calc(100dvh - 170px - env(safe-area-inset-bottom)); }
  .terminal { padding: 6px; }
}
</style>
