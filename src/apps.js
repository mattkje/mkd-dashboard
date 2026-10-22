const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';

// Local apps link to whatever host the browser used to reach the dashboard
// (LAN IP, hostname or Tailscale name), so links work from any device.
export function appUrl(app) {
  if (app.url) return app.url;
  const scheme = app.scheme || 'http';
  const defaultPort = (scheme === 'http' && app.port === 80) || (scheme === 'https' && app.port === 443);
  const port = defaultPort ? '' : `:${app.port}`;
  return `${scheme}://${location.hostname}${port}${app.path || ''}`;
}

export function iconSrc(icon) {
  if (!icon) return null;
  return /^(https?:)?\/\//.test(icon) || icon.startsWith('/') ? icon : `${ICON_CDN}${icon}.svg`;
}

export function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 35% 52%)`;
}

export function searchText(app) {
  return [app.name, app.description, appUrl(app)].join(' ').toLowerCase();
}
