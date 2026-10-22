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
});

export function lockedOut() {
  state.session.authed = false;
  state.openMenu = null;
  state.logs = null;
}

export function openLogs(title, url) {
  state.openMenu = null;
  state.logs = { title, url };
}
