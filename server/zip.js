// Minimal streaming ZIP writer (deflate, data descriptors, no ZIP64), so folders can be
// downloaded without installing zip on the server. Each entry is limited to 4 GB.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_SIZE = 0xffffffff;

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// Every file under the given paths, with names relative to base. Symlinks are skipped.
async function* walk(abs, name) {
  const st = await fsp.lstat(abs);
  if (st.isDirectory()) {
    yield { name: `${name}/`, abs, st, dir: true };
    for (const entry of await fsp.readdir(abs)) yield* walk(path.join(abs, entry), `${name}/${entry}`);
  } else if (st.isFile()) {
    yield { name, abs, st, dir: false };
  }
}

function write(out, buffer) {
  return new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('client went away'));
    if (out.write(buffer)) resolve();
    else out.once('drain', resolve);
  });
}

async function pipeDeflated(file, out) {
  let crc = 0;
  let compressed = 0;
  let size = 0;
  const deflate = zlib.createDeflateRaw();
  deflate.on('data', (chunk) => { compressed += chunk.length; });
  const source = fs.createReadStream(file);
  source.on('data', (chunk) => {
    crc = zlib.crc32(chunk, crc);
    size += chunk.length;
  });
  await new Promise((resolve, reject) => {
    source.on('error', reject);
    deflate.on('error', reject);
    deflate.on('end', resolve);
    deflate.on('data', (chunk) => {
      if (!out.write(chunk)) {
        deflate.pause();
        out.once('drain', () => deflate.resume());
      }
    });
    source.pipe(deflate);
  });
  return { crc, compressed, size };
}

// paths: absolute paths; each is added under its own base name.
async function stream(paths, out) {
  const central = [];
  let offset = 0;
  for (const root of paths) {
    for await (const entry of walk(root, path.basename(root))) {
      if (entry.st.size > MAX_SIZE) throw new Error(`${entry.name} is larger than 4 GB`);
      const name = Buffer.from(entry.name, 'utf8');
      const { time, day } = dosTime(entry.st.mtime);
      const method = entry.dir ? 0 : 8;
      // Flags: bit 3 = sizes in a data descriptor after the data, bit 11 = UTF-8 names.
      const flags = (entry.dir ? 0 : 0x0008) | 0x0800;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt16LE(name.length, 26);
      await write(out, Buffer.concat([local, name]));
      let info = { crc: 0, compressed: 0, size: 0 };
      if (!entry.dir) {
        info = await pipeDeflated(entry.abs, out);
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(info.crc >>> 0, 4);
        descriptor.writeUInt32LE(info.compressed, 8);
        descriptor.writeUInt32LE(info.size, 12);
        await write(out, descriptor);
      }
      central.push({ name, flags, method, time, day, offset, ...info, dir: entry.dir });
      offset += 30 + name.length + info.compressed + (entry.dir ? 0 : 16);
      if (offset > MAX_SIZE) throw new Error('archive larger than 4 GB');
      if (central.length > 0xffff) throw new Error('more than 65535 files');
    }
  }
  const start = offset;
  for (const e of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4); // made by Unix, version 2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(e.flags, 8);
    header.writeUInt16LE(e.method, 10);
    header.writeUInt16LE(e.time, 12);
    header.writeUInt16LE(e.day, 14);
    header.writeUInt32LE(e.crc >>> 0, 16);
    header.writeUInt32LE(e.compressed, 20);
    header.writeUInt32LE(e.size, 24);
    header.writeUInt16LE(e.name.length, 28);
    header.writeUInt32LE(((e.dir ? 0o40755 : 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(e.offset, 42);
    await write(out, Buffer.concat([header, e.name]));
    offset += 46 + e.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - start, 12);
  end.writeUInt32LE(start, 16);
  await write(out, end);
  out.end();
}

module.exports = { stream };
