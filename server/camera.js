// Surveillance page: one IP camera's RTSP stream, shown live and saved as photos and recordings.
// Everything goes through ffmpeg; the browser never talks to the camera itself.
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HttpError, childEnv } = require('./http');
const { sendFile } = require('./files');

const URL_ = process.env.CAMERA_URL || '';
const NAME = process.env.CAMERA_NAME || 'Camera';
const DIR = path.resolve(process.env.CAMERA_DIR || path.join(os.homedir(), 'Surveillance'));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CAPTURE_LIST_LIMIT = 50;
const INPUT = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', URL_];

let recording = null; // { child, file, since }

function requireCamera() {
  if (!URL_) throw new HttpError(404, 'no camera configured (set CAMERA_URL)');
}

// photo-2026-11-18_14-05-09.jpg, in the server's local time.
function captureName(kind, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${kind}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}

function startFfmpeg(args, stdio) {
  const child = spawn(FFMPEG, [...INPUT, ...args], { env: childEnv(), stdio });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.failure = () => (child.spawnError?.code === 'ENOENT'
    ? 'ffmpeg is not installed on the server (sudo apt install ffmpeg)'
    : stderr.trim().split('\n').pop() || 'could not reach the camera');
  child.on('error', (err) => { child.spawnError = err; });
  return child;
}

// Exits with the process' exit code, or rejects with ffmpeg's last error line.
function finished(child) {
  return new Promise((resolve, reject) => {
    child.on('close', (code) => (code === 0 ? resolve() : reject(new HttpError(502, child.failure()))));
  });
}

async function captures() {
  const names = await fsp.readdir(DIR).catch(() => []);
  const list = await Promise.all(names
    .filter((n) => /^(photo|video)-[\d_-]+\.(jpg|mp4)$/.test(n))
    .map(async (name) => {
      const st = await fsp.stat(path.join(DIR, name)).catch(() => null);
      return st && { name, kind: name.startsWith('photo') ? 'photo' : 'video', size: st.size, time: st.mtimeMs };
    }));
  return list.filter(Boolean).sort((a, b) => b.time - a.time).slice(0, CAPTURE_LIST_LIMIT);
}

async function status() {
  if (!URL_) return { configured: false };
  return {
    configured: true,
    name: NAME,
    dir: DIR,
    recording: recording && { name: path.basename(recording.file), since: recording.since },
    captures: await captures(),
  };
}

// Live view as MJPEG (multipart/x-mixed-replace), which an <img> plays on every browser,
// phones included. One ffmpeg per viewer, stopped when the viewer goes away.
function live(req, res) {
  requireCamera();
  const child = startFfmpeg(['-an', '-vf', 'fps=10', '-q:v', '7', '-f', 'mpjpeg', '-'], ['ignore', 'pipe', 'pipe']);
  let started = false;
  child.stdout.once('data', () => {
    started = true;
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  child.stdout.on('data', (chunk) => { if (started) res.write(chunk); });
  child.on('close', () => {
    if (!started && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(child.failure());
    }
    res.end();
  });
  res.on('close', () => child.kill('SIGKILL'));
}

async function photo() {
  requireCamera();
  await fsp.mkdir(DIR, { recursive: true });
  const name = captureName('photo', 'jpg');
  const child = startFfmpeg(['-frames:v', '1', '-q:v', '2', path.join(DIR, name)], ['ignore', 'ignore', 'pipe']);
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    await finished(child);
  } finally {
    clearTimeout(timer);
  }
  return { name };
}

// Video copied as-is (no re-encoding); the camera's G.711 audio becomes AAC, which MP4 needs.
// Fragmented MP4 stays playable even if the dashboard stops mid-recording.
async function startRecording() {
  requireCamera();
  if (recording) throw new HttpError(409, 'already recording');
  await fsp.mkdir(DIR, { recursive: true });
  const file = path.join(DIR, captureName('video', 'mp4'));
  const child = startFfmpeg([
    '-map', '0:v', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', file,
  ], ['ignore', 'ignore', 'pipe']);
  const entry = { child, file, since: Date.now() };
  recording = entry;
  child.on('close', () => { if (recording === entry) recording = null; });
  // A camera that can't be reached fails within a few seconds; report that instead of "recording".
  const early = await Promise.race([
    finished(child).then(() => null, (err) => err),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (early) {
    await fsp.rm(file, { force: true });
    throw early;
  }
  return { name: path.basename(file) };
}

async function stopRecording() {
  if (!recording) return { stopped: false };
  const { child, file } = recording;
  const done = new Promise((resolve) => child.on('close', resolve));
  child.kill('SIGINT'); // ffmpeg finishes the file on SIGINT
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await done;
  clearTimeout(timer);
  return { stopped: true, name: path.basename(file) };
}

async function capture(name, req, res, inline) {
  if (!/^(photo|video)-[\d_-]+\.(jpg|mp4)$/.test(name)) throw new HttpError(400, 'invalid name');
  try {
    await sendFile(path.join(DIR, name), req, res, inline);
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, 'not found');
    throw err;
  }
}

module.exports = { status, live, photo, startRecording, stopRecording, capture };
