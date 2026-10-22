// Files the server keeps between restarts (sessions, history). systemd sets STATE_DIRECTORY
// (see deploy/mkd-dashboard.service); in development they go to .state/.
const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR = process.env.STATE_DIRECTORY || path.join(__dirname, '..', '.state');

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

// Written to a temporary file first, so a crash mid-write never leaves half a file.
function save(name, data) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(STATE_DIR, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { load, save };
