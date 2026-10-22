import { lockedOut } from './store.js';

// Reads a following log endpoint (?follow=1) and hands each chunk of text to onText,
// until the server ends the stream or signal aborts it.
export async function streamText(url, params, signal, onText) {
  const res = await fetch(`${url}?${new URLSearchParams({ ...params, follow: '1' })}`, { signal });
  if (res.status === 401) return lockedOut();
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || res.statusText);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onText(value);
  }
}
