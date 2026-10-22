import { reactive } from 'vue';

// Short messages in the corner after an action: toast('Restarted gitea'), toast('Failed: …', 'error').
export const toasts = reactive([]);

let nextId = 1;

export function toast(message, kind = 'ok', ms = kind === 'error' ? 7000 : 3500) {
  const id = nextId++;
  toasts.push({ id, message, kind });
  setTimeout(() => dismiss(id), ms);
}

export function dismiss(id) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

// Runs an action and reports how it went: await attempt(() => post(...), 'Restarted gitea').
export async function attempt(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}
