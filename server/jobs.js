// Long-running maintenance jobs (apt, docker pulls). One at a time; the client polls the output.
const { spawn } = require('node:child_process');
const { HttpError, childEnv } = require('./http');

const OUTPUT_LIMIT = 1024 * 1024;

let job = null;

function busy() {
  return job && !job.done;
}

function claim(title) {
  if (busy()) throw new HttpError(409, `${job.title} is still running`);
  // dropped counts output trimmed from the front, so client offsets stay absolute.
  job = { id: Date.now(), title, output: '', dropped: 0, done: false, code: null, started: Date.now() };
  return job;
}

function append(current, chunk) {
  current.output += chunk;
  const excess = current.output.length - OUTPUT_LIMIT;
  if (excess > 0) {
    current.output = current.output.slice(excess);
    current.dropped += excess;
  }
}

function finish(current, code) {
  current.done = true;
  current.code = code;
  console.log(`${current.title}: exit ${code}`);
}

// Runs the commands one after another, stopping at the first failure.
function start(title, commands, { onDone } = {}) {
  const current = claim(title);
  console.log(`${title}: started`);
  const done = (code) => {
    finish(current, code);
    onDone?.(current);
  };
  const next = (i) => {
    if (i === commands.length) return done(0);
    const [cmd, args] = commands[i];
    append(current, `$ ${[cmd, ...args].join(' ')}\n`);
    const child = spawn(cmd, args, { env: childEnv() });
    child.stdout.on('data', (chunk) => append(current, chunk));
    child.stderr.on('data', (chunk) => append(current, chunk));
    child.on('error', (err) => append(current, `${err.message}\n`));
    child.on('close', (code) => (code === 0 ? next(i + 1) : done(code ?? 1)));
  };
  next(0);
  return state(0);
}

function state(offset = 0) {
  if (!job) return { job: null };
  const { output, dropped, ...rest } = job;
  return { job: { ...rest, offset: dropped + output.length, output: output.slice(Math.max(0, offset - dropped)) } };
}

module.exports = { busy, claim, finish, start, state };
