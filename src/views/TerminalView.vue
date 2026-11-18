<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import ConfirmButton from '../components/ConfirmButton.vue';
import { getJson, post } from '../api.js';
import { attempt, toast } from '../toast.js';

defineOptions({ name: 'TerminalView' });

const RECONNECT_MS = 2000;
const FONT_KEY = 'mkd-terminal-font';
const FONT_MIN = 9;
const FONT_MAX = 24;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

const page = ref(null);
const container = ref(null);
const textDialog = ref(null);
const helpDialog = ref(null);
const textOutput = ref(null);

const connected = ref(false);
const ended = ref('');
// With tmux: the server's sessions and the one shown. Without: a single plain shell.
const tmux = ref(null);
const sessions = ref([]);
const current = ref(null);
const ctrl = ref(false);
const full = ref(false);
const size = ref('');
const flash = ref('');
const renaming = ref(null);
const renameTo = ref('');
const text = ref('');
const textLoading = ref(false);
const fontSize = ref(storedFont());

function storedFont() {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return n >= FONT_MIN && n <= FONT_MAX ? n : 13;
  } catch {
    return 13;
  }
}

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: fontSize.value,
  lineHeight: 1.1,
  scrollback: 5000,
  // Option-drag on a Mac (Shift-drag elsewhere) selects text even while tmux has the mouse.
  macOptionClickForcesSelection: true,
  macOptionIsMeta: true,
  allowProposedApi: true,
  theme: {
    background: '#161513',
    foreground: '#ecebe6',
    cursor: '#ecebe6',
    cursorAccent: '#161513',
    selectionBackground: '#5a564e',
    black: '#2a2926',
    red: '#e26a5f',
    green: '#5cbf7c',
    yellow: '#e0a83e',
    blue: '#7aa2ea',
    magenta: '#c792ea',
    cyan: '#5fc4c4',
    white: '#d6d4cd',
    brightBlack: '#77736b',
    brightRed: '#f08a80',
    brightGreen: '#7fd69b',
    brightYellow: '#f0c46a',
    brightBlue: '#9dbcf2',
    brightMagenta: '#dcabf5',
    brightCyan: '#86dada',
    brightWhite: '#ffffff',
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon((event, uri) => window.open(uri, '_blank', 'noopener')));
// Text that tmux copies (drag with the mouse) arrives as OSC 52 and goes to the browser clipboard.
// Programs may only write the clipboard, never read it.
term.loadAddon(new ClipboardAddon({
  readText: () => '',
  writeText: (selection, data) => copyFromProgram(data),
}));

let ws = null;
let reconnectTimer;
let flashTimer;
let fitFrame = 0;
let sentSize = '';
// Text tmux copied that the browser would not take yet (Safari needs a click or key first).
let pendingCopy = '';

// Clipboard

async function copyText(value, quiet = false) {
  if (!value) return false;
  let ok = false;
  try {
    await navigator.clipboard.writeText(value);
    ok = true;
  } catch {
    // Plain http, or a browser that wants a click first: the old way still works inside a click.
    const area = document.createElement('textarea');
    area.value = value;
    area.style.cssText = 'position:fixed;opacity:0;';
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {}
    area.remove();
    term.focus();
  }
  if (!quiet) showFlash(ok ? `Copied ${value.length.toLocaleString()} characters` : 'Could not copy: use the Text button');
  return ok;
}

function showFlash(message) {
  flash.value = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash.value = ''; }, 2200);
}

// tmux sends what you dragged over without a click behind it, which Safari refuses. Then keep the
// text, and ⌘C / Ctrl+Shift+C / the copy button copies it, because a key or click is allowed to.
async function copyFromProgram(value) {
  if (!value) return;
  pendingCopy = value;
  if (await copyText(value, true)) {
    pendingCopy = '';
    showFlash(`Copied ${value.length.toLocaleString()} characters`);
  } else {
    showFlash(`Selected ${value.length.toLocaleString()} characters: press ${IS_MAC ? '⌘C' : 'Ctrl+Shift+C'} to copy`);
  }
}

function copySelection() {
  if (term.hasSelection()) copyText(term.getSelection());
  else if (pendingCopy) copyText(pendingCopy).then((ok) => { if (ok) pendingCopy = ''; });
  else showFlash(tmux.value ? 'Drag to select; it copies on release' : 'Select some text first');
}

async function paste() {
  try {
    const value = await navigator.clipboard.readText();
    if (value) term.paste(value);
  } catch {
    toast(`The browser blocked reading the clipboard. Press ${IS_MAC ? '⌘V' : 'Ctrl+Shift+V'} in the terminal instead.`, 'error');
  }
  term.focus();
}

// Copy-on-select for the terminal's own selection (Shift-drag, or any drag without tmux).
function onMouseUp() {
  if (term.hasSelection()) copyText(term.getSelection());
}

// Sizing

function send(message) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

// Fits the terminal to its box and tells the server when the size changed. Done on the next frame,
// so layout has settled (after a page switch, a font change or leaving full screen).
function scheduleFit(force = false) {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => fitNow(force));
}

function fitNow(force = false) {
  if (!container.value?.offsetParent) return;
  fit.fit();
  const key = `${term.cols}x${term.rows}`;
  size.value = `${term.cols}×${term.rows}`;
  if ((force || key !== sentSize) && send({ type: 'resize', cols: term.cols, rows: term.rows })) sentSize = key;
}

watch(fontSize, (value) => {
  term.options.fontSize = value;
  try {
    localStorage.setItem(FONT_KEY, String(value));
  } catch {}
  scheduleFit();
});

function zoom(step) {
  fontSize.value = step ? Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize.value + step)) : 13;
}

function toggleFull() {
  full.value = !full.value;
  nextTick(() => {
    scheduleFit();
    term.focus();
  });
}

// Connection

function disconnect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  connected.value = false;
}

function connect(name = current.value, start = null) {
  disconnect();
  current.value = name;
  ended.value = '';
  sentSize = '';
  term.reset();
  fitNow();
  // The size goes along, so the shell starts at the right size instead of 80×24.
  const params = new URLSearchParams({ cols: term.cols, rows: term.rows });
  if (name) params.set('session', name);
  if (start) params.set('start', start);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${params}`);
  ws = socket;
  socket.onopen = () => {
    connected.value = true;
    scheduleFit(true);
    term.focus();
    if (tmux.value) loadSessions();
  };
  socket.onmessage = (e) => term.write(e.data);
  socket.onclose = (e) => {
    connected.value = false;
    ws = null;
    // A tmux session outlives the connection: quietly reattach after a network blip.
    if (e.code !== 4000 && tmux.value && current.value) {
      ended.value = 'Reconnecting…';
      reconnectTimer = setTimeout(() => connect(current.value), RECONNECT_MS);
      return;
    }
    ended.value = e.code === 4000 ? 'Session ended' : 'Connection lost';
    if (tmux.value) loadSessions();
  };
}

function reconnect() {
  connect(tmux.value ? current.value || nextName() : null);
}

// Sessions

async function loadSessions() {
  const result = await getJson('/api/terminal/sessions').catch(() => null);
  if (!result) return;
  tmux.value = result.tmux;
  sessions.value = result.sessions;
}

function nextName(base = 'main') {
  const names = new Set(sessions.value.map((s) => s.name));
  if (!names.has(base)) return base;
  const stem = base === 'main' ? 'shell' : base;
  let n = 2;
  while (names.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

function newSession(start = null) {
  const name = nextName(start || 'main');
  sessions.value = [...sessions.value, { name }];
  connect(name, start);
}

// A new session with Claude Code running in it (or, without tmux, typed into this shell).
function startClaude() {
  if (tmux.value) newSession('claude');
  else {
    send({ type: 'input', data: 'claude\r' });
    term.focus();
  }
}

function switchTo(index) {
  const s = sessions.value[(index + sessions.value.length) % sessions.value.length];
  if (s && s.name !== current.value) connect(s.name);
}

function step(delta) {
  switchTo(sessions.value.findIndex((s) => s.name === current.value) + delta);
}

async function endSession(name) {
  if (!(await attempt(() => post(`/api/terminal/sessions/${name}/kill`), `Ended ${name}`))) return;
  await loadSessions();
  if (name !== current.value) return;
  const other = sessions.value[0];
  if (other) connect(other.name);
  else newSession();
}

function startRename(name) {
  renaming.value = name;
  renameTo.value = name;
  nextTick(() => document.querySelector('.session-rename')?.select());
}

async function finishRename() {
  const from = renaming.value;
  const to = renameTo.value.trim().replace(/\s+/g, '-');
  renaming.value = null;
  if (!from || !to || to === from) return term.focus();
  if (!/^[\w.-]{1,40}$/.test(to)) {
    toast('Names may use letters, digits, . _ and - (up to 40)', 'error');
    return term.focus();
  }
  // The tmux client stays attached through a rename, so there is no need to reconnect.
  if (await attempt(() => post(`/api/terminal/sessions/${from}/rename`, { to }))) {
    if (current.value === from) current.value = to;
    await loadSessions();
  }
  term.focus();
}

// The history as plain text, to select and copy with the browser (works on phones too).
async function openText() {
  text.value = '';
  textDialog.value.showModal();
  textLoading.value = true;
  if (tmux.value && current.value) {
    const result = await getJson(`/api/terminal/sessions/${current.value}/capture`).catch((err) => ({ text: `Could not read the session: ${err.message}` }));
    text.value = result.text;
  } else {
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line?.translateToString(true) ?? '');
    }
    text.value = lines.join('\n').replace(/\s+$/, '');
  }
  textLoading.value = false;
  await nextTick();
  if (textOutput.value) textOutput.value.scrollTop = textOutput.value.scrollHeight;
}

function closeDialog(dialog) {
  dialog.value?.close();
}

// Keyboard

const SHORTCUTS = computed(() => [
  ['Copy selection', IS_MAC ? '⌘C' : 'Ctrl+Shift+C'],
  ['Paste', IS_MAC ? '⌘V' : 'Ctrl+Shift+V'],
  ['Select text (with tmux)', 'Drag: copies on release'],
  ['Browser selection', IS_MAC ? '⌥ + drag' : 'Shift + drag'],
  ['Open history as text', `${ALT}+Shift+T`],
  ...(tmux.value ? [
    ['New session', `${ALT}+Shift+N`],
    ['New Claude session', `${ALT}+Shift+C`],
    ['Go to session 1–9', `${ALT}+1…9`],
    ['Previous / next session', `${ALT}+Shift+← / →`],
  ] : [['Start Claude', `${ALT}+Shift+C`]]),
  ['Full screen', `${ALT}+Shift+F`],
  ['Text size', `${MOD}+ =  /  ${MOD}+ −  /  ${MOD}+0`],
  ['This list', `${ALT}+Shift+/`],
]);

// Returns true when the key was a dashboard shortcut (and should not reach the shell).
function shortcut(e) {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (IS_MAC ? e.metaKey && !e.shiftKey && e.code === 'KeyC' : e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
    // Without a selection, Ctrl+Shift+C does nothing; ⌘C as well.
    copySelection();
    return true;
  }
  if (mod && !e.altKey && ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract'].includes(e.code)) {
    zoom({ Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1 }[e.code] || 0);
    return true;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.shiftKey) {
    const action = {
      KeyN: () => tmux.value && newSession(),
      KeyC: startClaude,
      KeyF: toggleFull,
      KeyT: openText,
      Slash: () => helpDialog.value.showModal(),
      ArrowLeft: () => tmux.value && step(-1),
      ArrowRight: () => tmux.value && step(1),
    }[e.code];
    if (!action) return false;
    action();
    return true;
  }
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit && tmux.value) {
    switchTo(Number(digit[1]) - 1);
    return true;
  }
  return false;
}

term.attachCustomKeyEventHandler((e) => {
  // Ctrl+Shift+V: let the browser paste into the terminal as usual.
  if (!IS_MAC && e.ctrlKey && e.shiftKey && e.code === 'KeyV') return false;
  if (e.type !== 'keydown') return true;
  if (!shortcut(e)) return true;
  e.preventDefault();
  return false;
});

// Extra keys for phones, whose keyboards have no Esc, Ctrl, Tab or arrows.
const KEYS = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', ctrl: true },
  { label: '^C', data: '\x03' },
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
  if (connected.value) return 'Connected';
  return ended.value || 'Connecting…';
});
const showOverlay = computed(() => !connected.value && ended.value && ended.value !== 'Reconnecting…');

const observer = new ResizeObserver(() => scheduleFit());
// tmux sizes a shared session to the client used last; coming back to this tab claims it again.
const onFocus = () => scheduleFit(true);
const onKeyUp = (e) => {
  if (e.key === 'Escape' && full.value && document.activeElement === document.body) toggleFull();
};

onMounted(async () => {
  term.open(container.value);
  observer.observe(container.value);
  window.addEventListener('focus', onFocus);
  window.addEventListener('keyup', onKeyUp);
  // Cell sizes are measured with the font; measure again once fonts are in.
  document.fonts?.ready.then(() => scheduleFit());
  await loadSessions();
  // tmux keeps its own history (scroll with the wheel), so xterm needs none, and no scrollbar
  // gutter on the right that the fit would leave empty.
  if (tmux.value) term.options.scrollback = 0;
  if (tmux.value) connect(sessions.value[0]?.name || 'main');
  else connect(null);
});

onActivated(() => {
  scheduleFit(true);
  term.focus();
  if (tmux.value) loadSessions();
});

onDeactivated(() => {
  full.value = false;
});

onUnmounted(() => {
  observer.disconnect();
  window.removeEventListener('focus', onFocus);
  window.removeEventListener('keyup', onKeyUp);
  cancelAnimationFrame(fitFrame);
  clearTimeout(flashTimer);
  disconnect();
  term.dispose();
});
</script>

<template>
  <div ref="page" class="terminal-page" :class="{ full }">
    <header class="term-head">
      <div v-if="tmux" class="sessions" role="tablist">
        <template v-for="(s, i) in sessions" :key="s.name">
          <input
            v-if="renaming === s.name"
            v-model="renameTo"
            class="session session-rename"
            maxlength="40"
            aria-label="Session name"
            @keydown.enter.prevent="finishRename"
            @keydown.esc.prevent="renaming = null; term.focus()"
            @blur="finishRename"
          >
          <button
            v-else
            type="button"
            role="tab"
            class="session"
            :class="{ active: s.name === current, claude: s.name.startsWith('claude') }"
            :aria-selected="s.name === current"
            :title="`${s.name}${i < 9 ? ` (${ALT}+${i + 1})` : ''} · double-click to rename`"
            @click="s.name !== current && connect(s.name)"
            @dblclick="startRename(s.name)"
          >
            <span v-if="s.name === current" class="dot" :class="{ on: connected }"></span>{{ s.name }}
          </button>
        </template>
        <button type="button" class="session add" :title="`New session (${ALT}+Shift+N)`" aria-label="New session" @click="newSession()">+</button>
      </div>
      <p v-else class="muted small status">
        <span class="dot" :class="{ on: connected }"></span>{{ status }}
        <span v-if="tmux === false" title="Install tmux on the server to keep shells running when you close the tab.">· ends when you leave</span>
      </p>

      <div class="tools">
        <button type="button" class="btn small claude-btn" :title="tmux ? `New session running Claude Code (${ALT}+Shift+C)` : `Run Claude Code (${ALT}+Shift+C)`" @click="startClaude">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/></svg>
          Claude
        </button>
        <span class="sep"></span>
        <button type="button" class="tool" :title="`Copy selection (${IS_MAC ? '⌘C' : 'Ctrl+Shift+C'})`" aria-label="Copy selection" @pointerdown.prevent @click="copySelection">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9h11v11H9zM5 15H4V4h11v1"/></svg>
        </button>
        <button type="button" class="tool" :title="`Paste (${IS_MAC ? '⌘V' : 'Ctrl+Shift+V'})`" aria-label="Paste" @pointerdown.prevent @click="paste">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v3H9zM8 4.5H5v16h14v-16h-3"/></svg>
        </button>
        <button type="button" class="tool" :title="`History as text, to select and copy (${ALT}+Shift+T)`" aria-label="History as text" @click="openText">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/></svg>
        </button>
        <span class="sep"></span>
        <button type="button" class="tool text" :disabled="fontSize <= FONT_MIN" :title="`Smaller text (${MOD}+−)`" aria-label="Smaller text" @pointerdown.prevent @click="zoom(-1)">A−</button>
        <button type="button" class="tool text" :disabled="fontSize >= FONT_MAX" :title="`Larger text (${MOD}+=)`" aria-label="Larger text" @pointerdown.prevent @click="zoom(1)">A+</button>
        <button type="button" class="tool" :title="`${full ? 'Exit full screen' : 'Full screen'} (${ALT}+Shift+F)`" :aria-label="full ? 'Exit full screen' : 'Full screen'" @click="toggleFull">
          <svg v-if="!full" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>
        </button>
        <button type="button" class="tool" :title="`Keyboard shortcuts (${ALT}+Shift+/)`" aria-label="Keyboard shortcuts" @click="helpDialog.showModal()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>
        </button>
        <ConfirmButton v-if="tmux && current" class="small" label="End" :confirm="`End ${current}?`" danger @confirm="endSession(current)" />
      </div>
    </header>

    <div class="frame">
      <div ref="container" class="terminal" @click="term.focus()" @mouseup="onMouseUp"></div>
      <div v-if="showOverlay" class="overlay">
        <p>{{ ended }}</p>
        <button type="button" class="btn small primary" @click="reconnect">{{ tmux ? `Reconnect to ${current || 'a new session'}` : 'New shell' }}</button>
      </div>
      <transition name="fade">
        <div v-if="flash" class="flash" role="status">{{ flash }}</div>
      </transition>
    </div>

    <footer class="term-foot muted">
      <span v-if="tmux" class="status"><span class="dot" :class="{ on: connected }"></span>{{ status }}</span>
      <span v-if="size">{{ size }}</span>
      <span class="hint">{{ tmux ? 'Drag to copy' : 'Select to copy' }} · {{ IS_MAC ? '⌥' : 'Shift' }}+drag for browser selection</span>
    </footer>

    <div class="keys" aria-label="Extra keys">
      <button
        v-for="key in KEYS"
        :key="key.label"
        type="button"
        :class="{ armed: key.ctrl && ctrl }"
        @pointerdown.prevent
        @click="pressKey(key)"
      >{{ key.label }}</button>
      <button type="button" @pointerdown.prevent @click="paste">Paste</button>
    </div>

    <dialog ref="textDialog" class="sheet text-sheet" @close="term.focus()">
      <header class="sheet-head">
        <h3>{{ current || 'Terminal' }} · text</h3>
        <button type="button" class="btn small primary" :disabled="!text" @click="copyText(text)">Copy all</button>
        <button type="button" class="btn small" @click="closeDialog(textDialog)">Close</button>
      </header>
      <pre ref="textOutput" class="text-output">{{ textLoading ? 'Loading…' : text || 'Nothing here yet.' }}</pre>
    </dialog>

    <dialog ref="helpDialog" class="sheet help-sheet" @close="term.focus()">
      <header class="sheet-head">
        <h3>Terminal shortcuts</h3>
        <button type="button" class="btn small" @click="closeDialog(helpDialog)">Close</button>
      </header>
      <dl class="shortcuts">
        <template v-for="[what, keys] in SHORTCUTS" :key="what">
          <dt>{{ what }}</dt>
          <dd><kbd>{{ keys }}</kbd></dd>
        </template>
      </dl>
    </dialog>
  </div>
</template>

<style scoped>
.terminal-page { display: flex; flex-direction: column; gap: 8px; height: calc(100vh - 150px); min-height: 320px; }
.terminal-page.full {
  position: fixed;
  inset: 0;
  z-index: 40;
  height: auto;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  background: var(--bg);
}

.term-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.sessions { display: flex; flex: 1; flex-wrap: wrap; gap: 4px; min-width: 0; }
.session {
  display: inline-flex;
  align-items: center;
  gap: 7px;
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
.session.claude { color: #d97757; }
.session.claude.active { color: #e8875f; }
.session.add { padding: 0 11px; font-family: inherit; font-size: 15px; }
input.session { width: 140px; color: var(--text); outline: none; cursor: text; border-color: var(--accent); }

.tools { display: flex; align-items: center; gap: 4px; }
.sep { width: 1px; height: 18px; margin: 0 4px; background: var(--line); }
.tool {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.tool:hover:not(:disabled) { border-color: var(--line); background: var(--card); color: var(--text); }
.tool:disabled { opacity: 0.4; cursor: default; }
.tool svg { width: 16px; height: 16px; }
.tool.text { font-size: 12px; font-weight: 600; }
.claude-btn { display: inline-flex; align-items: center; gap: 6px; color: #d97757; }
.claude-btn svg { width: 14px; height: 14px; stroke-width: 2.4; }
.claude-btn:hover:not(:disabled) { border-color: #d97757; }

.status { display: inline-flex; align-items: center; gap: 8px; margin: 0; }
p.status { flex: 1; min-width: 160px; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); }
.dot.on { background: var(--up); }

/* The padding lives on the frame: the fit measures the terminal's parent, which must have none. */
.frame {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 10px 4px 6px 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #161513;
  overflow: hidden;
}
.terminal { width: 100%; height: 100%; overflow: hidden; }
.terminal :deep(.xterm) { height: 100%; }
.terminal :deep(.xterm-viewport) { background: transparent !important; }

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 12px;
  background: rgba(22, 21, 19, 0.72);
  backdrop-filter: blur(1px);
  color: #ecebe6;
}
.overlay p { margin: 0; font-size: 14px; }
.flash {
  position: absolute;
  right: 14px;
  bottom: 12px;
  padding: 6px 10px;
  border: 1px solid #3d3b37;
  border-radius: 8px;
  background: #262522;
  color: #ecebe6;
  font-size: 12.5px;
  pointer-events: none;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.term-foot { display: flex; gap: 14px; align-items: center; margin-top: -2px; font-size: 12px; }
.term-foot .hint { margin-left: auto; }

.keys { display: none; gap: 6px; overflow-x: auto; scrollbar-width: none; }
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

.text-sheet { width: min(1100px, calc(100vw - 32px)); }
.text-output {
  height: min(70vh, 720px);
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
  overflow: auto;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre;
  user-select: text;
}
.help-sheet { width: min(460px, calc(100vw - 32px)); }
.shortcuts { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; margin: 0; font-size: 13.5px; }
.shortcuts dt { color: var(--muted); }
.shortcuts dd { margin: 0; text-align: right; }
kbd {
  padding: 2px 7px;
  border: 1px solid var(--line-strong);
  border-bottom-width: 2px;
  border-radius: 6px;
  background: var(--card);
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

@media (hover: none), (max-width: 760px) {
  .keys { display: flex; }
  .term-foot .hint { display: none; }
}
@media (max-width: 560px) {
  /* Room for the bottom tab bar. */
  .terminal-page { height: calc(100dvh - 170px - env(safe-area-inset-bottom)); }
  .terminal-page.full { height: auto; }
  .frame { padding: 6px 2px 4px 6px; }
  .tools { width: 100%; }
  .claude-btn { margin-right: auto; }
  .sep { display: none; }
}
</style>
