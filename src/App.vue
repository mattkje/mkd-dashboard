<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import LoginView from './views/LoginView.vue';
import LogsDialog from './components/LogsDialog.vue';
import Toaster from './components/Toaster.vue';
import { getJson, localJson, post } from './api.js';
import { lockedOut, serverPath, state } from './store.js';
import { theme } from './theme.js';

const route = useRoute();
const router = useRouter();

const NAV = [
  { to: '/', label: 'Apps', remote: true, icon: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z' },
  { to: '/system', label: 'System', remote: true, icon: 'M4 5h16v11H4zM9 20h6M12 16v4' },
  { to: '/power', label: 'Power', icon: 'M13 2 4 14h7l-1 8 9-12h-7z' },
  { to: '/updates', label: 'Updates', remote: true, icon: 'M12 3v12M7 10l5 5 5-5M5 21h14' },
  { to: '/docker', label: 'Docker', icon: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8' },
  { to: '/files', label: 'Files', remote: true, icon: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z' },
  { to: '/terminal', label: 'Terminal', icon: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3' },
];

// The camera is a "web" server: selecting it opens its own dashboard full-screen (CameraView),
// so there are no agent tabs to show for it.
const currentWeb = computed(() => state.servers.find((s) => s.id === state.server)?.web);
// Another server shows only the pages its agent answers (see server/agent.js).
const nav = computed(() => (currentWeb.value ? [] : NAV.filter((item) => !state.server || item.remote).map((item) => ({ ...item, to: serverPath(item.to) }))));
const serverName = computed(() => (state.server ? state.servers.find((s) => s.id === state.server)?.name : null));
// state.servers lists this machine first; the switcher only appears when there are others.
const hasOthers = computed(() => state.servers.some((s) => !s.self));
const shown = computed(() => state.servers.find((s) => s.id === state.server) || state.servers[0]);
const dot = (s) => (s?.up === false ? 'down' : s?.up ? 'up' : 'unknown');

// Servers older than this page don't list themselves.
const withSelf = (list) => (list.some((s) => s.self) ? list : [{ id: '', name: 'This server', self: true, up: true }, ...list]);

// One open menu at a time: 'servers', 'account' or null.
const menu = ref(null);
const toggle = (name) => { menu.value = menu.value === name ? null : name; };
const closeMenus = () => { menu.value = null; };
const onKey = (e) => { if (e.key === 'Escape') closeMenus(); };

// Stays on the same page when the other server has it, otherwise goes to its Apps page.
function switchServer(id) {
  const picked = state.servers.find((s) => s.id === id);
  if (picked && picked.web) { router.push('/camera'); closeMenus(); return; }
  const page = route.path.replace(/^\/s\/[^/]+/, '') || '/';
  const item = NAV.find((n) => n.to === page);
  const target = item && (item.remote || !id) ? page : '/';
  router.push(id ? `/s/${id}${target === '/' ? '' : target}` : target);
  closeMenus();
}

// Agents' reachability changes; refresh it whenever the switcher opens.
watch(menu, async (open) => {
  if (open === 'servers') state.servers = withSelf(await localJson('/api/servers').catch(() => state.servers));
});

const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const THEME_ICONS = {
  system: 'M4 5h16v11H4zM9 20h6M12 16v4',
  light: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  dark: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
};

async function signOut() {
  try {
    await post('/api/logout');
  } finally {
    lockedOut();
  }
}

// This dashboard's title, its updates badge and the other servers, whichever server is shown.
watch(() => state.session.authed, async (authed) => {
  if (!authed) return;
  state.title = (await localJson('/api/config').catch(() => null))?.title ?? null;
  state.servers = withSelf(await localJson('/api/servers').catch(() => []));
  const updates = await localJson('/api/updates').catch(() => null);
  if (updates) state.updates = updates.sources.reduce((sum, s) => sum + s.items.length, 0);
});

watch(
  () => [state.title, serverName.value, route.meta.title],
  ([title, server, page]) => { document.title = [page, server, title || 'MKD'].filter(Boolean).join(' · '); },
);

onUnmounted(() => {
  document.removeEventListener('click', closeMenus);
  document.removeEventListener('keydown', onKey);
});

onMounted(async () => {
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', onKey);
  try {
    Object.assign(state.session, await getJson('/api/session'));
  } catch {}
  state.session.checked = true;
});
</script>

<template>
  <template v-if="state.session.checked">
    <LoginView v-if="!state.session.authed" />
    <div v-else class="shell">
      <header class="nav">
        <div class="brand-group">
          <RouterLink to="/" class="brand"><img src="/logo.svg" alt="" class="brand-logo"><span class="brand-name">{{ state.title ?? 'MKD' }}</span></RouterLink>
          <!-- Which machine the pages show. Highlighted when it isn't this one. -->
          <div v-if="hasOthers" class="menu-wrap" @click.stop>
            <button
              type="button"
              class="switcher"
              :class="{ remote: state.server, open: menu === 'servers' }"
              aria-haspopup="menu"
              :aria-expanded="menu === 'servers'"
              :title="`Showing ${shown?.name}. Switch server`"
              @click="toggle('servers')"
            >
              <span class="sdot" :class="dot(shown)"></span>
              <span class="switcher-name">{{ shown?.name }}</span>
              <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>
            </button>
            <div v-if="menu === 'servers'" class="popover servers-menu" role="menu">
              <p class="popover-label">Servers</p>
              <button
                v-for="s in state.servers"
                :key="s.id"
                type="button"
                role="menuitemradio"
                class="popover-item"
                :aria-checked="s.id === state.server"
                @click="switchServer(s.id)"
              >
                <span class="sdot" :class="dot(s)"></span>
                <span class="item-text">
                  <strong>{{ s.name }}</strong>
                  <span class="muted">{{ s.self ? 'This server' : s.web ? 'Camera dashboard' : s.up === false ? `${s.host} · not answering` : s.host }}</span>
                </span>
                <svg v-if="s.id === state.server" class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>
              </button>
            </div>
          </div>
        </div>
        <!-- On phones this becomes a tab bar fixed to the bottom of the screen. -->
        <nav class="tabs">
          <RouterLink v-for="item in nav" :key="item.to" :to="item.to" :title="item.label">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="item.icon"/></svg>
            <span>{{ item.label }}</span>
            <b v-if="item.to === '/updates' && !state.server && state.updates" class="badge">{{ state.updates }}</b>
          </RouterLink>
        </nav>
        <div class="menu-wrap" @click.stop>
          <button
            type="button"
            class="icon-btn"
            :class="{ open: menu === 'account' }"
            title="Settings"
            aria-label="Settings"
            aria-haspopup="menu"
            :aria-expanded="menu === 'account'"
            @click="toggle('account')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4"/></svg>
          </button>
          <div v-if="menu === 'account'" class="popover account-menu" role="menu">
            <p class="popover-label">Appearance</p>
            <div class="theme-pick" role="radiogroup" aria-label="Theme">
              <button
                v-for="[value, label] in THEMES"
                :key="value"
                type="button"
                role="radio"
                :aria-checked="theme === value"
                :class="{ on: theme === value }"
                @click="theme = value"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="THEME_ICONS[value]"/></svg>{{ label }}
              </button>
            </div>
            <div class="popover-sep"></div>
            <button type="button" class="popover-item danger" role="menuitem" @click="signOut">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg>
              <span class="item-text"><strong>Sign out</strong></span>
            </button>
          </div>
        </div>
      </header>
      <main>
        <!-- The terminal stays alive while you look at other pages. -->
        <RouterView v-slot="{ Component }">
          <KeepAlive include="TerminalView">
            <component :is="Component" :key="state.server" />
          </KeepAlive>
        </RouterView>
      </main>
      <LogsDialog />
    </div>
  </template>
  <Toaster />
</template>
