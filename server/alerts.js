// Push notifications through ntfy and/or Telegram, whichever is configured.
//
//   NTFY_URL=https://ntfy.sh/my-secret-topic   (any ntfy server; NTFY_TOKEN for protected topics)
//   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=456
const { HttpError } = require('./http');

const NTFY_URL = process.env.NTFY_URL || '';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const RECENT_LIMIT = 50;

const recent = [];

const LEVELS = {
  down: { priority: 4, tag: 'red_circle', icon: '🔴' },
  warn: { priority: 4, tag: 'warning', icon: '🟠' },
  up: { priority: 3, tag: 'green_circle', icon: '🟢' },
  info: { priority: 3, tag: 'information_source', icon: 'ℹ️' },
};

function channels() {
  return [NTFY_URL && 'ntfy', TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && 'telegram'].filter(Boolean);
}

// JSON publishing (POST to the server root with the topic in the body) allows non-ASCII titles.
async function ntfy({ title, message, level }) {
  const url = new URL(NTFY_URL);
  const topic = url.pathname.replace(/^\/+|\/+$/g, '');
  const res = await fetch(new URL('/', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(NTFY_TOKEN && { Authorization: `Bearer ${NTFY_TOKEN}` }) },
    body: JSON.stringify({ topic, title, message, priority: LEVELS[level].priority, tags: [LEVELS[level].tag] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ntfy: ${res.status} ${await res.text()}`);
}

async function telegram({ title, message, level }) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `${LEVELS[level].icon} ${title}\n${message}` }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`telegram: ${res.status} ${await res.text()}`);
}

// Never throws: a failing channel is logged and shown on the alert, not fatal for the monitor.
async function send(title, message, level = 'info') {
  const alert = { t: Date.now(), title, message, level, errors: [] };
  recent.unshift(alert);
  recent.length = Math.min(recent.length, RECENT_LIMIT);
  const senders = { ntfy, telegram };
  await Promise.all(channels().map(async (name) => {
    try {
      await senders[name]({ title, message, level });
    } catch (err) {
      alert.errors.push(err.message);
      console.error(`alert via ${name} failed: ${err.message}`);
    }
  }));
  console.log(`alert: ${title}: ${message}`);
  return alert;
}

async function test() {
  if (!channels().length) throw new HttpError(400, 'no alert channel configured');
  const alert = await send('Test alert', 'Alerts from the MKD dashboard reach you here.', 'info');
  if (alert.errors.length) throw new HttpError(502, alert.errors.join('; '));
  return { ok: true };
}

module.exports = { channels, send, test, recent: () => ({ channels: channels(), recent }) };
