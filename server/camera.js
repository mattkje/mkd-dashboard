// Reverse proxy to the camera's own dashboard (the mkd-cam web UI it serves on its LAN
// address). The camera is LAN-only HTTP; this dashboard is reachable anywhere over Tailscale,
// so proxying it here (with the camera's Basic Auth injected) makes the camera reachable from
// anywhere — and, because it's then served over the dashboard's HTTPS origin, the browser lets
// its push-to-talk microphone work.
//
// Enable by setting CAMERA_WEB to the camera's URL including credentials, e.g.
//   CAMERA_WEB=http://admin:mkd-cam-2026@192.168.1.62
const http = require('node:http');

const CAM = process.env.CAMERA_WEB || '';
const NAME = process.env.CAMERA_NAME || 'mkd-cam';
const enabled = Boolean(CAM);

let host = '';
let port = 80;
let authHeader = '';
if (enabled) {
  const u = new URL(CAM);
  host = u.hostname;
  port = u.port ? Number(u.port) : 80;
  if (u.username) {
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    authHeader = `Basic ${Buffer.from(creds).toString('base64')}`;
  }
}

// The dropdown entry, shown alongside the agent servers (server/servers.js).
function info() {
  return enabled ? { id: 'cam', name: NAME, web: true } : null;
}

const PASS_BACK = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'cache-control'];

// Forward one browser request to the camera, streaming both ways (pages, the MJPEG live view,
// file uploads/downloads, the shell-exec endpoint). `subpath` already includes the query string.
function proxy(req, res, subpath) {
  const headers = { connection: 'close' };
  for (const name of ['content-type', 'content-length', 'range']) if (req.headers[name]) headers[name] = req.headers[name];
  if (authHeader) headers.authorization = authHeader;
  // The camera's stock GoAhead server emits slightly malformed headers (e.g. a bare date line
  // with no field name on snapshots), which Node's strict parser rejects. It's a trusted device
  // on the LAN, so parse its responses leniently. A fresh, non-keep-alive socket also keeps Node
  // from treating the camera's per-reply close as an error.
  const upstream = http.request({ host, port, method: req.method, path: subpath, headers, agent: false, insecureHTTPParser: true }, (answer) => {
    const out = Object.fromEntries(PASS_BACK.filter((h) => answer.headers[h]).map((h) => [h, answer.headers[h]]));
    res.writeHead(answer.statusCode, out);
    answer.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('camera not reachable');
    } else {
      res.destroy();
    }
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

module.exports = { enabled, info, proxy };
