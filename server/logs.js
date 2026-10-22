// Streams a following log command (journalctl -f, docker logs -f) to the browser as plain text,
// until the browser disconnects.
const { spawn } = require('node:child_process');
const { childEnv } = require('./http');

function follow(cmd, args, res) {
  const child = spawn(cmd, args, { env: childEnv() });
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    // Stops proxies from buffering the stream.
    'X-Accel-Buffering': 'no',
  });
  child.stdout.pipe(res, { end: false });
  child.stderr.pipe(res, { end: false });
  child.on('error', (err) => res.end(`\n${err.code === 'ENOENT' ? `${cmd} not available` : err.message}\n`));
  child.on('close', () => res.end());
  // Keeps idle connections open through proxies.
  const keepAlive = setInterval(() => res.write(''), 25000);
  res.on('close', () => {
    clearInterval(keepAlive);
    child.kill();
  });
}

module.exports = { follow };
