import { ref, watch } from 'vue';

// 'system' follows the OS; 'light' and 'dark' override it. Remembered per browser.
const KEY = 'mkd-theme';
const THEMES = ['system', 'light', 'dark'];

function stored() {
  try {
    return THEMES.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'system';
  } catch {
    return 'system';
  }
}

export const theme = ref(stored());

export function cycleTheme() {
  theme.value = THEMES[(THEMES.indexOf(theme.value) + 1) % THEMES.length];
}

watch(theme, (value) => {
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem(KEY, value);
  } catch {}
}, { immediate: true });
