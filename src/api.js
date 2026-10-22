import { lockedOut, state } from './store.js';

// Any 401 means the session ended (expired, signed out elsewhere, server state wiped): back to the login page.
async function request(url, options) {
  const res = await fetch(url, options);
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (res.status === 401 && url !== '/api/login') lockedOut();
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
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
