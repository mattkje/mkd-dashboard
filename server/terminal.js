// Web terminal: a WebSocket per browser tab. With tmux installed each connection attaches to a
// named tmux session, so shells survive closed tabs, lost connections and dashboard restarts.
// Without tmux it runs a plain login shell that ends with the connection.
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const { HttpError, childEnv, run } = require('./http');

const PYTHON = process.env.PYTHON || 'python3';
const TMUX = process.env.TMUX_BIN || 'tmux';
const HELPER = path.join(__dirname, 'pty-helper.py');
const SHELL = process.env.SHELL || os.userInfo().shell || '/bin/bash';
const SESSION_PATTERN = /^[\w.-]{1,40}$/;

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const open = new Set();

let tmuxAvailable = null;
async function hasTmux() {
  if (tmuxAvailable === null) tmuxAvailable = (await run(TMUX, ['-V'])).ok;
  return tmuxAvailable;
}

function checkSession(name) {
  if (!SESSION_PATTERN.test(name || '')) throw new HttpError(400, 'invalid session name');
  return name;
}

async function sessions() {
  if (!(await hasTmux())) return { tmux: false, sessions: [] };
  const result = await run(TMUX, ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}']);
  // "no server running" just means there are no sessions yet.
  const list = result.ok ? result.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, windows, attached, created] = line.split('\t');
    return { name, windows: Number(windows), attached: Number(attached), created: Number(created) * 1000 };
  }) : [];
  return { tmux: true, sessions: list.sort((a, b) => a.created - b.created) };
}

async function killSession(name) {
  const result = await run(TMUX, ['kill-session', '-t', `=${checkSession(name)}`]);
  if (!result.ok) throw new HttpError(404, result.stderr || 'no such session');
  return { ok: true };
}

// Starts the session detached if needed, then returns the command that attaches to it.
async function tmuxCommand(name) {
  const target = `=${name}`;
  if (!(await run(TMUX, ['has-session', '-t', target])).ok) {
    const created = await run(TMUX, ['new-session', '-d', '-s', name, '-c', os.homedir()]);
    if (!created.ok) throw new Error(created.stderr || 'tmux new-session failed');
    // Mouse mode lets the wheel scroll tmux history in the browser.
    await run(TMUX, ['set-option', '-t', target, 'mouse', 'on']);
  }
  return [TMUX, 'attach-session', '-t', target];
}

// Cross-site WebSocket hijacking guard: the page must come from the same host.
function sameOrigin(req) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(req.headers.origin).host === host;
  } catch {
    return false;
  }
}

function handleUpgrade(req, socket, head) {
  if (!auth.isAuthed(req) || !sameOrigin(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const name = new URL(req.url, 'http://x').searchParams.get('session');
  if (name && !SESSION_PATTERN.test(name)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    connect(ws, auth.sessionKey(req), name).catch((err) => {
      ws.send(`\r\nCould not start terminal: ${err.message}\r\n`);
      ws.close();
    });
  });
}

async function connect(ws, session, name) {
  const command = name && (await hasTmux()) ? await tmuxCommand(name) : [SHELL, '-l'];
  if (ws.readyState !== ws.OPEN) return;
  const child = spawn(PYTHON, [HELPER, ...command], {
    cwd: os.homedir(),
    env: childEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const entry = { ws, session };
  open.add(entry);
  console.log(`terminal opened${name ? ` (${name})` : ''}, ${open.size} open`);

  // Writes after the shell exits fail with EPIPE; the close handler below deals with that.
  child.stdin.on('error', () => {});
  child.stdio[3].on('error', () => {});

  // Chunks can split multi-byte characters; the decoders hold partial ones back.
  const out = new StringDecoder('utf8');
  const err = new StringDecoder('utf8');
  child.stdout.on('data', (chunk) => ws.send(out.write(chunk)));
  child.stderr.on('data', (chunk) => ws.send(err.write(chunk)));
  child.on('error', (error) => {
    ws.send(`\r\nCould not start terminal: ${error.message}\r\n`);
    ws.close();
  });
  // 4000 tells the browser the shell or session ended, rather than the connection dropping.
  child.on('close', (code) => {
    ws.send(`\r\n[${name ? 'detached' : 'process exited'}${code ? ` with code ${code}` : ''}]\r\n`);
    ws.close(4000, 'ended');
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'input' && typeof message.data === 'string') child.stdin.write(message.data);
    if (message.type === 'resize') {
      const cols = Math.trunc(message.cols);
      const rows = Math.trunc(message.rows);
      if (cols > 0 && cols <= 1000 && rows > 0 && rows <= 1000) child.stdio[3].write(`${cols} ${rows}\n`);
    }
  });
  // For tmux this only detaches the client; the session keeps running.
  ws.on('close', () => {
    open.delete(entry);
    child.kill('SIGTERM');
    console.log(`terminal closed, ${open.size} open`);
  });
}

// Signing out closes that session's terminals.
auth.onLogout((session) => {
  for (const entry of open) if (entry.session === session) entry.ws.close();
});

module.exports = { handleUpgrade, sessions, killSession };
