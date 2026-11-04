import { lockedOut, state } from './store.js';

// Requests while another server is shown go to its agent, through this dashboard
// (/api/servers/<id>/api/...). Signing in and the list of servers are always this one's.
const LOCAL_ONLY = /^\/api\/(session|login|logout|servers)(\/|$|\?)/;

export function apiUrl(url) {
  return state.server && url.startsWith('/api/') && !LOCAL_ONLY.test(url) ? `/api/servers/${state.server}${url}` : url;
}

// Any 401 means the session ended (expired, signed out elsewhere, server state wiped): back to the login page.
async function request(url, options, local) {
  const res = await fetch(local ? url : apiUrl(url), options);
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (res.status === 401 && url !== '/api/login') lockedOut();
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

// Always this dashboard's own API, whichever server is shown.
export function localJson(url) {
  return request(url, undefined, true);
}

export function getJson(url, params) {
  return request(params ? `${url}?${new URLSearchParams(params)}` : url);
}

// The server rejects POSTs without X-Mkd (CSRF guard on top of the SameSite cookie).
export function post(url, body) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mkd': '1' },
    body: JSON.stringify(body || {}),
  });
}

export function upload(url, params, file) {
  return request(`${url}?${new URLSearchParams(params)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Mkd': '1' },
    body: file,
  });
}

export async function refreshStatus() {
  try {
    state.status = await getJson('/api/status');
    state.statusLoaded = true;
    state.statusError = false;
  } catch {
    state.statusError = true;
  }
}
