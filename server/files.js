// File browser. Runs with the dashboard user's permissions, limited to FILES_ROOT.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { HttpError, readJson } = require('./http');
const zip = require('./zip');

const ROOT = fs.realpathSync(path.resolve(process.env.FILES_ROOT || '/'));
const HOME = os.homedir();
const TEXT_LIMIT = 2 * 1024 * 1024;
const UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
const SEARCH_LIMIT = 200;
const SEARCH_VISIT_LIMIT = 50000;

// Types the browser may show inline for previews. Anything else (HTML, SVG, scripts) is only
// ever downloaded, so a file can't run code on the dashboard's origin.
const PREVIEW_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
};

function inRoot(p) {
  return p === ROOT || p.startsWith(ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep);
}

// Resolves a client path to an absolute path inside ROOT, following symlinks of existing parts.
async function resolve(p) {
  if (typeof p !== 'string' || !p) throw new HttpError(400, 'path required');
  const abs = path.resolve(ROOT, p);
  let real = abs;
  try {
    real = await fsp.realpath(abs);
  } catch {
    // A link whose target doesn't exist could point anywhere; writing through it would escape ROOT.
    if ((await fsp.lstat(abs).catch(() => null))?.isSymbolicLink()) throw new HttpError(403, 'broken symlink');
    // Not there yet (new file or folder): check its parent instead.
    real = path.join(await fsp.realpath(path.dirname(abs)).catch(() => path.dirname(abs)), path.basename(abs));
  }
  if (!inRoot(abs) || !inRoot(real)) throw new HttpError(403, 'outside the allowed folder');
  return abs;
}

function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new HttpError(400, 'invalid name');
  }
  return name;
}

function fsError(err) {
  if (err instanceof HttpError) return err;
  const status = { ENOENT: 404, EACCES: 403, EPERM: 403, EEXIST: 409, ENOTDIR: 400, EISDIR: 400, ENOTEMPTY: 409 }[err.code];
  return new HttpError(status || 500, err.code ? `${err.code}: ${err.message.split(', ')[0]}` : err.message);
}

const wrap = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    throw fsError(err);
  }
};

const list = wrap(async (p) => {
  const dir = await resolve(p || (inRoot(HOME) ? HOME : ROOT));
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(dirents.map(async (d) => {
    const full = path.join(dir, d.name);
    const lst = await fsp.lstat(full).catch(() => null);
    // Show where symlinks lead, and treat links to folders as folders.
    const st = d.isSymbolicLink() ? await fsp.stat(full).catch(() => null) : lst;
    return {
      name: d.name,
      dir: Boolean(st?.isDirectory()),
      link: d.isSymbolicLink(),
      size: st?.size ?? 0,
      mtime: (st || lst)?.mtimeMs ?? 0,
      mode: lst ? (lst.mode & 0o777).toString(8).padStart(3, '0') : '',
    };
  }));
  entries.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { path: dir, parent: dir === ROOT ? null : path.dirname(dir), home: HOME, root: ROOT, entries };
});

// Supports Range requests, so videos can be scrubbed in the preview.
const download = wrap(async (p, req, res, inline) => {
  const file = await resolve(p);
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new HttpError(400, 'not a file');
  const name = encodeURIComponent(path.basename(file));
  const type = inline && PREVIEW_TYPES[path.extname(file).toLowerCase()];
  const headers = {
    'Content-Type': type || 'application/octet-stream',
    'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && st.size > 0) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return pipeline(fs.createReadStream(file, { start, end }), res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  await pipeline(fs.createReadStream(file), res);
});

// One or more files/folders as a single .zip.
const downloadZip = wrap(async (paths, res) => {
  if (!paths.length) throw new HttpError(400, 'path required');
  const targets = await Promise.all(paths.map(resolve));
  await Promise.all(targets.map((t) => fsp.lstat(t)));
  const base = targets.length === 1 ? path.basename(targets[0]) : path.basename(path.dirname(targets[0])) || 'files';
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`,
    'Cache-Control': 'no-store',
  });
  try {
    await zip.stream(targets, res);
  } catch (err) {
    console.error(`zip: ${err.message}`);
    res.destroy();
  }
});

// Name search below a folder; skips symlinks and stops at SEARCH_LIMIT results.
const search = wrap(async (p, query) => {
  const dir = await resolve(p);
  const needle = String(query || '').toLowerCase();
  if (!needle) throw new HttpError(400, 'search text required');
  const results = [];
  const queue = [dir];
  let visited = 0;
  while (queue.length && results.length < SEARCH_LIMIT && visited < SEARCH_VISIT_LIMIT) {
    const current = queue.shift();
    const dirents = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const d of dirents) {
      visited++;
      const full = path.join(current, d.name);
      if (d.name.toLowerCase().includes(needle)) {
        const st = await fsp.lstat(full).catch(() => null);
        results.push({ path: full, name: d.name, dir: d.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
        if (results.length >= SEARCH_LIMIT) break;
      }
      if (d.isDirectory()) queue.push(full);
    }
  }
  return { results, complete: !queue.length && results.length < SEARCH_LIMIT };
});

const read = wrap(async (p) => {
  const file = await resolve(p);
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new HttpError(400, 'not a file');
  if (st.size > TEXT_LIMIT) throw new HttpError(413, 'too large to edit here, download it instead');
  const data = await fsp.readFile(file);
  if (data.subarray(0, 8192).includes(0)) throw new HttpError(415, 'binary file, download it instead');
  return { path: file, content: data.toString('utf8'), mtime: st.mtimeMs };
});

// Refuses to overwrite a file that changed since it was opened.
const write = wrap(async (req) => {
  const { path: p, content, mtime } = await readJson(req, TEXT_LIMIT * 2);
  if (typeof content !== 'string') throw new HttpError(400, 'content required');
  const file = await resolve(p);
  const st = await fsp.stat(file).catch(() => null);
  if (st && mtime && Math.abs(st.mtimeMs - mtime) > 1) throw new HttpError(409, 'file changed on disk since it was opened');
  await fsp.writeFile(file, content);
  return { ok: true, mtime: (await fsp.stat(file)).mtimeMs };
});

const mkdir = wrap(async (req) => {
  const { path: dir, name } = await readJson(req);
  await fsp.mkdir(await resolve(path.join(await resolve(dir), checkName(name))));
  return { ok: true };
});

const rename = wrap(async (req) => {
  const { path: p, name } = await readJson(req);
  const from = await resolve(p);
  const to = await resolve(path.join(path.dirname(from), checkName(name)));
  if (await fsp.lstat(to).catch(() => null)) throw new HttpError(409, `${name} already exists`);
  await fsp.rename(from, to);
  return { ok: true };
});

function pathList(body) {
  const paths = body.paths || (body.path ? [body.path] : []);
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'path required');
  return paths;
}

const remove = wrap(async (req) => {
  const targets = await Promise.all(pathList(await readJson(req, 64 * 1024)).map(resolve));
  for (const target of targets) {
    if (target === ROOT || target === HOME) throw new HttpError(400, `refusing to delete ${target}`);
  }
  for (const target of targets) {
    await fsp.rm(target, { recursive: true });
    console.log(`deleted ${target}`);
  }
  return { ok: true };
});

const move = wrap(async (req) => {
  const body = await readJson(req, 64 * 1024);
  const dest = await resolve(body.to);
  if (!(await fsp.stat(dest)).isDirectory()) throw new HttpError(400, 'destination is not a folder');
  const sources = await Promise.all(pathList(body).map(resolve));
  for (const source of sources) {
    const target = path.join(dest, path.basename(source));
    if (dest === source || dest.startsWith(source + path.sep)) throw new HttpError(400, `can't move ${path.basename(source)} into itself`);
    if (await fsp.lstat(target).catch(() => null)) throw new HttpError(409, `${path.basename(source)} already exists there`);
  }
  for (const source of sources) {
    const target = path.join(dest, path.basename(source));
    try {
      await fsp.rename(source, target);
    } catch (err) {
      // Across file systems rename fails; copy then delete instead.
      if (err.code !== 'EXDEV') throw err;
      await fsp.cp(source, target, { recursive: true, preserveTimestamps: true });
      await fsp.rm(source, { recursive: true });
    }
  }
  return { ok: true };
});

// Raw request body is the file; written to a temporary name first so a broken upload leaves nothing behind.
const upload = wrap(async (req, dir, name, overwrite) => {
  const target = await resolve(path.join(await resolve(dir), checkName(name)));
  if (!overwrite && await fsp.lstat(target).catch(() => null)) throw new HttpError(409, `${name} already exists`);
  if (Number(req.headers['content-length']) > UPLOAD_LIMIT) throw new HttpError(413, 'file too large');
  const temp = path.join(path.dirname(target), `.${name}.upload-${process.pid}-${Date.now()}`);
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > UPLOAD_LIMIT) req.destroy(new HttpError(413, 'file too large'));
  });
  try {
    await pipeline(req, fs.createWriteStream(temp, { flags: 'wx' }));
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true });
    throw err;
  }
  return { ok: true };
});

module.exports = { list, download, downloadZip, search, read, write, mkdir, rename, remove, move, upload };
