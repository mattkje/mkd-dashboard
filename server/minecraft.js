// Minecraft server panel: status through the Server List Ping (works without any setup) and
// commands through RCON (needs enable-rcon=true and MINECRAFT_RCON_PASSWORD).
// Starting, stopping and the console log go through the app in apps.json whose service is the
// Minecraft unit, so they use the same sudo rules and journal access as every other app.
const net = require('node:net');
const { HttpError, readJson } = require('./http');
const apps = require('./apps');

const HOST = process.env.MINECRAFT_HOST || '127.0.0.1';
const PORT = Number(process.env.MINECRAFT_PORT) || 25565;
const RCON_PORT = Number(process.env.MINECRAFT_RCON_PORT) || 25575;
const RCON_PASSWORD = process.env.MINECRAFT_RCON_PASSWORD || '';
const SERVICE = process.env.MINECRAFT_SERVICE || 'minecraft';
const TIMEOUT_MS = 5000;

const enabled = Boolean(RCON_PASSWORD);

// "§a" style formatting codes, which the browser would show literally.
const plain = (text) => String(text ?? '').replace(/§./g, '');

// Opens a TCP connection and hands every received chunk to onData(buffer, finish) until finish(result).
function exchange(port, onConnect, onData) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: HOST, port });
    let buffer = Buffer.alloc(0);
    let done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    socket.setTimeout(TIMEOUT_MS, () => finish(new HttpError(504, 'Minecraft server did not answer')));
    socket.on('connect', () => onConnect(socket));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        buffer = onData(buffer, (result) => finish(null, result)) ?? buffer;
      } catch (err) {
        finish(err);
      }
    });
    socket.on('error', (err) => finish(new HttpError(502, err.code === 'ECONNREFUSED' ? 'Minecraft server is not running' : err.message)));
    socket.on('close', () => finish(new HttpError(502, 'connection closed')));
  });
}

// --- Server List Ping (https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping) ---

function varInt(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

// Returns [value, bytes read], or null when the buffer ends mid-number.
function readVarInt(buffer, offset) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null;
    const byte = buffer[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return [value, i + 1];
  }
  throw new Error('bad varint');
}

const packet = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varInt(body.length), body]);
};

async function ping() {
  const started = Date.now();
  const host = Buffer.from(HOST);
  const port = Buffer.alloc(2);
  port.writeUInt16BE(PORT);
  const status = await exchange(PORT, (socket) => {
    // Handshake (protocol -1: "any"), next state 1 = status; then the status request.
    socket.write(packet(varInt(0), varInt(-1 >>> 0), varInt(host.length), host, port, varInt(1)));
    socket.write(packet(varInt(0)));
  }, (buffer, finish) => {
    const length = readVarInt(buffer, 0);
    if (!length || buffer.length < length[1] + length[0]) return;
    let offset = length[1];
    offset += readVarInt(buffer, offset)[1]; // packet id
    const [size, read] = readVarInt(buffer, offset);
    finish(JSON.parse(buffer.subarray(offset + read, offset + read + size).toString('utf8')));
  });
  const motd = typeof status.description === 'string'
    ? status.description
    : [status.description?.text, ...(status.description?.extra ?? []).map((e) => e.text ?? e)].join('');
  return {
    version: plain(status.version?.name),
    motd: plain(motd).trim(),
    online: status.players?.online ?? 0,
    max: status.players?.max ?? 0,
    ms: Date.now() - started,
  };
}

// --- RCON (https://minecraft.wiki/w/RCON) ---

const AUTH = 3;
const COMMAND = 2;

function rconPacket(id, type, body) {
  const text = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + text.length);
  out.writeInt32LE(10 + text.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  text.copy(out, 12);
  return out;
}

// The server collects the replies of all RCON connections in one shared buffer, so commands that
// run at the same time get each other's output. One command at a time, then.
let queue = Promise.resolve();

function rcon(command) {
  if (!enabled) return Promise.reject(new HttpError(400, 'RCON is not set up (MINECRAFT_RCON_PASSWORD)'));
  const result = queue.then(() => rconNow(command));
  queue = result.catch(() => {});
  return result;
}

// The command goes out only after the login reply: the server reads one packet per network read
// and drops the connection when two arrive together. Long replies arrive split over several
// packets, so collect until the server goes quiet.
function rconNow(command) {
  let socket;
  let reply = '';
  let quiet;
  return exchange(RCON_PORT, (connected) => {
    socket = connected;
    socket.write(rconPacket(1, AUTH, RCON_PASSWORD));
  }, (buffer, finish) => {
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
      const length = buffer.readInt32LE(0);
      const id = buffer.readInt32LE(4);
      const body = buffer.subarray(12, 4 + length - 2).toString('utf8');
      buffer = buffer.subarray(4 + length);
      if (id === -1) throw new HttpError(502, 'RCON password was rejected');
      if (id === 1) socket.write(rconPacket(2, COMMAND, command));
      if (id === 2) {
        reply += body;
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(plain(reply)), 150);
      }
    }
    return buffer;
  });
}

// "There are 2 of a max of 20 players online: Alex, Steve" and the like.
function names(reply) {
  const list = reply.slice(reply.indexOf(':') + 1).trim();
  return reply.includes(':') && list ? list.split(/,\s*|\s+and\s+/).map((n) => n.trim()).filter(Boolean) : [];
}

async function overview() {
  const app = apps.loadConfig().groups.flatMap((g) => g.apps)
    .find((a) => a.service === SERVICE || a.service === `${SERVICE}.service`);
  const [status, players, whitelist, banned] = await Promise.allSettled([
    ping(),
    ...['list', 'whitelist list', 'banlist players'].map((cmd) => (enabled ? rcon(cmd) : Promise.reject(new Error('RCON is not set up')))),
  ]);
  const value = (r, fn) => (r.status === 'fulfilled' ? fn(r.value) : null);
  return {
    rcon: enabled,
    appId: app?.id ?? null,
    status: value(status, (s) => s),
    error: status.status === 'rejected' ? status.reason.message : null,
    rconError: enabled && players.status === 'rejected' ? players.reason.message : null,
    players: value(players, names),
    whitelist: value(whitelist, names),
    banned: value(banned, (reply) => [...reply.matchAll(/(\w{1,16}) was banned by/g)].map((m) => m[1])),
  };
}

async function command(req) {
  const { command: text } = await readJson(req);
  const cmd = String(text ?? '').trim().replace(/^\//, '');
  if (!cmd || cmd.length > 1000 || /[\r\n]/.test(cmd)) throw new HttpError(400, 'invalid command');
  return { output: await rcon(cmd) };
}

module.exports = { enabled, overview, command };
