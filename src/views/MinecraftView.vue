<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import ConfirmButton from '../components/ConfirmButton.vue';
import EmptyState from '../components/EmptyState.vue';
import { getJson, post } from '../api.js';
import { streamText } from '../logStream.js';
import { attempt, toast } from '../toast.js';

const REFRESH_MS = 10000;
const CONSOLE_LIMIT = 512 * 1024;
const PLAYER = /^[A-Za-z0-9_]{3,16}$/;

const info = ref(null);
const loadError = ref('');
const service = ref(null);
const busy = reactive({});
const newPlayer = ref('');
const message = ref('');
const commandText = ref('');
const consoleText = ref('');
const consoleEl = ref(null);
const following = ref(false);
let stream = null;

const running = computed(() => service.value?.active === 'active');
const online = computed(() => Boolean(info.value?.status));

async function load() {
  try {
    info.value = await getJson('/api/minecraft');
    loadError.value = '';
    if (info.value.appId) service.value = (await getJson('/api/status'))[info.value.appId]?.service ?? null;
  } catch (err) {
    loadError.value = err.message;
  }
}

// Every action is a console command; the reply goes to the console and a toast.
async function run(cmd, success) {
  busy[cmd] = true;
  const body = await attempt(() => post('/api/minecraft/command', { command: cmd }), success);
  delete busy[cmd];
  if (body) appendConsole(`> ${cmd}\n${body.output ? `${body.output}\n` : ''}`);
  load();
  return body;
}

function player(cmd, name, success) {
  return run(`${cmd} ${name}`, success);
}

async function addToWhitelist() {
  const name = newPlayer.value.trim();
  if (!PLAYER.test(name)) return toast('Player names are 3–16 letters, digits or _', 'error');
  if (await player('whitelist add', name, `Added ${name} to the whitelist`)) newPlayer.value = '';
}

async function say() {
  const text = message.value.trim();
  if (text && await run(`say ${text}`, 'Message sent')) message.value = '';
}

async function sendCommand() {
  const cmd = commandText.value.trim().replace(/^\//, '');
  if (cmd && await run(cmd)) commandText.value = '';
}

const PAST = { start: 'Started', stop: 'Stopped', restart: 'Restarted' };

async function serviceAction(action) {
  busy[action] = true;
  const body = await attempt(() => post(`/api/apps/${info.value.appId}/${action}`), `${PAST[action]} the Minecraft server`);
  delete busy[action];
  if (body) service.value = body.service;
  setTimeout(load, 3000);
}

// --- Console: the service's journal, followed live -------------------------------------

async function appendConsole(text) {
  const el = consoleEl.value;
  const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  consoleText.value = (consoleText.value + text).slice(-CONSOLE_LIMIT);
  await nextTick();
  if (el && atBottom) el.scrollTop = el.scrollHeight;
}

async function followConsole() {
  if (!info.value?.appId || stream) return;
  const controller = new AbortController();
  stream = controller;
  following.value = true;
  consoleText.value = '';
  try {
    await streamText(`/api/apps/${info.value.appId}/logs`, { lines: 200 }, controller.signal, appendConsole);
  } catch (err) {
    if (err.name !== 'AbortError') appendConsole(`\n${err.message}\n`);
  } finally {
    if (stream === controller) {
      stream = null;
      following.value = false;
    }
  }
}

let timer;
onMounted(async () => {
  await load();
  followConsole();
  timer = setInterval(load, REFRESH_MS);
});
onUnmounted(() => {
  clearInterval(timer);
  stream?.abort();
});
</script>

<template>
  <div>
    <EmptyState v-if="loadError" error title="Could not reach the dashboard API" :text="loadError" />
    <div v-else-if="!info" class="skeleton" style="height: 320px; border-radius: 16px"></div>
    <template v-else>
      <section class="panel summary">
        <i class="dot-state" :class="{ up: online }"></i>
        <div class="main">
          <strong>{{ info.status?.motd || 'Minecraft server' }}</strong>
          <span class="muted small">
            <template v-if="info.status">{{ info.status.version }} · {{ info.status.online }}/{{ info.status.max }} players · {{ info.status.ms }} ms</template>
            <template v-else>{{ running ? 'Starting…' : info.error }}</template>
          </span>
        </div>
        <div v-if="info.appId" class="actions">
          <button v-if="!running" type="button" class="btn small" :disabled="busy.start" @click="serviceAction('start')">Start</button>
          <template v-else>
            <button type="button" class="btn small" :disabled="busy.restart" @click="serviceAction('restart')">Restart</button>
            <ConfirmButton class="small" label="Stop" confirm="Stop the server? Click again" danger :disabled="busy.stop" @confirm="serviceAction('stop')" />
          </template>
        </div>
      </section>
      <p v-if="!info.appId" class="warn-text small">
        Add an app with <code>"service": "minecraft"</code> to apps.json (and re-run deploy/install.sh) to start, stop and see the console here.
      </p>
      <p v-if="info.rconError" class="error-text small">RCON: {{ info.rconError }}</p>

      <div class="columns">
        <section class="panel">
          <h3>Players online</h3>
          <p v-if="!info.players?.length" class="muted small">{{ info.players ? 'Nobody is playing.' : 'Not available.' }}</p>
          <div v-for="name in info.players" :key="name" class="person">
            <span class="ellipsis">{{ name }}</span>
            <div class="actions">
              <button type="button" class="btn small" :disabled="!online" @click="player('op', name, `${name} is now an operator`)">Op</button>
              <button type="button" class="btn small" :disabled="!online" @click="player('deop', name, `${name} is no longer an operator`)">Deop</button>
              <ConfirmButton class="small" label="Kick" danger :disabled="!online" @confirm="player('kick', name, `Kicked ${name}`)" />
              <ConfirmButton class="small" label="Ban" danger :disabled="!online" @confirm="player('ban', name, `Banned ${name}`)" />
            </div>
          </div>
        </section>

        <section class="panel">
          <h3>Whitelist</h3>
          <div class="actions">
            <button type="button" class="btn small" :disabled="!online" @click="run('whitelist on', 'Whitelist turned on')">Turn on</button>
            <button type="button" class="btn small" :disabled="!online" @click="run('whitelist off', 'Whitelist turned off')">Turn off</button>
          </div>
          <form class="inline" @submit.prevent="addToWhitelist">
            <input v-model="newPlayer" class="input small" placeholder="Player name" aria-label="Player name" :disabled="!online">
            <button class="btn small" :disabled="!online || !newPlayer.trim()">Add</button>
          </form>
          <div v-for="name in info.whitelist" :key="name" class="person">
            <span class="ellipsis">{{ name }}</span>
            <ConfirmButton class="small" label="Remove" danger :disabled="!online" @confirm="player('whitelist remove', name, `Removed ${name} from the whitelist`)" />
          </div>
          <template v-if="info.banned?.length">
            <h3 class="sub">Banned</h3>
            <div v-for="name in info.banned" :key="name" class="person">
              <span class="ellipsis">{{ name }}</span>
              <button type="button" class="btn small" :disabled="!online" @click="player('pardon', name, `Unbanned ${name}`)">Unban</button>
            </div>
          </template>
        </section>

        <section class="panel">
          <h3>World</h3>
          <div class="actions">
            <button type="button" class="btn small" :disabled="!online || busy['save-all']" @click="run('save-all', 'World saved')">Save world</button>
            <button type="button" class="btn small" :disabled="!online" @click="run('time set day', 'It is now day')">Day</button>
            <button type="button" class="btn small" :disabled="!online" @click="run('time set night', 'It is now night')">Night</button>
            <button type="button" class="btn small" :disabled="!online" @click="run('weather clear', 'Weather cleared')">Clear weather</button>
          </div>
          <form class="inline" @submit.prevent="say">
            <input v-model="message" class="input small" placeholder="Message to everyone" aria-label="Message to everyone" :disabled="!online">
            <button class="btn small" :disabled="!online || !message.trim()">Say</button>
          </form>
        </section>
      </div>

      <section class="panel console">
        <h3>Console <span v-if="following" class="live" title="Live"></span></h3>
        <pre ref="consoleEl" class="output">{{ consoleText || (info.appId ? 'Waiting for log lines…' : 'No console without a service entry in apps.json.') }}</pre>
        <form class="inline" @submit.prevent="sendCommand">
          <input
            v-model="commandText"
            class="input small mono"
            :placeholder="info.rcon ? 'Command, e.g. gamemode creative Steve' : 'Set MINECRAFT_RCON_PASSWORD to send commands'"
            aria-label="Command"
            :disabled="!online || !info.rcon"
          >
          <button class="btn small primary" :disabled="!online || !info.rcon || !commandText.trim()">Send</button>
        </form>
      </section>
    </template>
  </div>
</template>

<style scoped>
.summary { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin-bottom: 16px; }
.summary .main { display: grid; flex: 1; min-width: 200px; }
.summary strong { font-weight: 550; }
.dot-state { width: 10px; height: 10px; border-radius: 50%; background: var(--down); }
.dot-state.up { background: var(--up); }
.columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 16px; }
.person { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; }
.person + .person { border-top: 1px solid var(--line); }
.inline { display: flex; gap: 8px; margin: 12px 0; }
.inline .input { flex: 1; min-width: 0; }
.sub { margin-top: 18px !important; }
.console .output { height: min(55vh, 520px); margin-bottom: 12px; overflow: auto; }
.console .inline { margin-bottom: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.live { display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--up); vertical-align: middle; animation: pulse 1.4s infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
</style>
