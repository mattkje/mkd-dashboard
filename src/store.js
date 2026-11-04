import { reactive } from 'vue';

export const state = reactive({
  session: { checked: false, enabled: true, authed: false },
  config: null,
  status: {},
  statusLoaded: false,
  statusError: false,
  // Id of the app whose service menu is open.
  openMenu: null,
  // { title, url } of the log viewer, when open.
  logs: null,
  // Number of available updates, for the badge in the navigation (null until checked).
  updates: null,
  // This dashboard's own title (state.config is the shown server's apps).
  title: null,
  // Other machines with an agent (server/servers.js), and the one being shown ('' = this one).
  servers: [],
  server: '',
});

export function lockedOut() {
  state.session.authed = false;
  state.openMenu = null;
  state.logs = null;
}

// Paths for pages of the shown server: /files on this one, /s/prod/files on another.
export function serverPath(path) {
  return state.server ? `/s/${state.server}${path === '/' ? '' : path}` : path;
}

export function serverHost() {
  return state.servers.find((s) => s.id === state.server)?.host || location.hostname;
}

export function openLogs(title, url) {
  state.openMenu = null;
  state.logs = { title, url };
}
