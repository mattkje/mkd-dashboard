import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

const API_PORT = Number(process.env.API_PORT) || 8090;
const dev = (file) => fileURLToPath(new URL(`dev/${file}`, import.meta.url));

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Runs server.js next to the Vite dev server, with the fakes in dev/ so service
// controls, logs, updates and power actions work without systemd or apt.
// Admin password is "dev".
// If something already listens on API_PORT (e.g. the "Dashboard (Node)" run
// configuration), that server is used instead.
function devApiServer() {
  return {
    name: 'mkd-dev-api-server',
    apply: 'serve',
    async configureServer() {
      // Vite re-runs this when the config changes; keep one server per Vite process.
      if (globalThis.mkdApiServer || (await portInUse(API_PORT))) return;
      // .env may set its own password; otherwise development uses "dev".
      const fileEnv = loadEnv('development', fileURLToPath(new URL('.', import.meta.url)), '');
      const child = spawn(process.execPath, ['--watch', 'server.js'], {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        stdio: 'inherit',
        env: {
          ...process.env,
          PORT: String(API_PORT),
          HOST: '127.0.0.1',
          ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || fileEnv.ADMIN_PASSWORD || 'dev',
          SYSTEMCTL: dev('fake-systemctl'),
          JOURNALCTL: dev('fake-journalctl'),
          HELPER: dev('fake-helper'),
        },
      });
      globalThis.mkdApiServer = child;
      process.on('exit', () => child.kill());
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => {
          child.kill();
          process.exit();
        });
      }
    },
  };
}

// `npm run dev` serves the frontend on :5173 and forwards API calls (and the terminal WebSocket) to server.js.
export default defineConfig({
  plugins: [vue(), devApiServer()],
  server: {
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, ws: true } },
  },
});
