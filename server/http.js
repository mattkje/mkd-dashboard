// Small HTTP helpers shared by the API modules.
const { execFile, spawn } = require('node:child_process');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 4096) {
  const body = await readBody(req, limit);
  try {
    return body.length ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

// Environment for child processes, without the dashboard's own secrets.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ADMIN_PASSWORD;
  return env;
}

function run(cmd, args, { timeout = 30000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: childEnv(env), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim(), code: err?.code });
    });
  });
}

// Like run(), but stdout and stderr interleaved in one string, as a terminal would show them.
function runMerged(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: childEnv(), timeout });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (err) => resolve({ ok: false, output, code: err.code }));
    child.on('close', (code) => resolve({ ok: code === 0, output, code }));
  });
}

module.exports = { HttpError, sendJson, readBody, readJson, childEnv, run, runMerged };
