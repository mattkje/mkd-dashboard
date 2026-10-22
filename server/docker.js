// Docker containers through the docker CLI (the dashboard user must be in the docker group).
const { HttpError, run, runMerged } = require('./http');
const jobs = require('./jobs');
const logs = require('./logs');

const DOCKER = process.env.DOCKER || 'docker';
const ACTIONS = new Set(['start', 'stop', 'restart']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function checkId(id) {
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'invalid container or project name');
  return id;
}

function dockerError(result) {
  if (result.code === 'ENOENT') return new HttpError(501, 'docker not available');
  return new HttpError(500, (result.stderr ?? result.output)?.trim() || 'docker failed');
}

// `docker ps` joins labels with commas, and values can contain commas too (config_files):
// split only where the next part looks like "key=".
function parseLabels(text) {
  return Object.fromEntries((text || '').split(/,(?=[\w.-]+=)/).map((pair) => {
    const i = pair.indexOf('=');
    return [pair.slice(0, i), pair.slice(i + 1)];
  }));
}

async function containers() {
  const result = await run(DOCKER, ['ps', '-a', '--format', '{{json .}}']);
  if (!result.ok) throw dockerError(result);
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const c = JSON.parse(line);
    const labels = parseLabels(c.Labels);
    return {
      id: c.ID,
      name: c.Names,
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports,
      project: labels['com.docker.compose.project'] || '',
      service: labels['com.docker.compose.service'] || '',
    };
  });
}

// CPU and memory per running container; takes a second or two, so it's a separate call.
async function stats() {
  const result = await run(DOCKER, ['stats', '--no-stream', '--format', '{{json .}}']);
  if (!result.ok) throw dockerError(result);
  return Object.fromEntries(result.stdout.split('\n').filter(Boolean).map((line) => {
    const s = JSON.parse(line);
    return [s.ID, { cpu: parseFloat(s.CPUPerc) / 100, mem: parseFloat(s.MemPerc) / 100, memUsage: s.MemUsage }];
  }));
}

function expect(ids) {
  // Lazy: monitor.js requires this module.
  const monitor = require('./monitor');
  for (const id of ids) monitor.expectContainer(id);
}

async function action(id, name) {
  if (!ACTIONS.has(name)) throw new HttpError(400, 'unknown action');
  if (name !== 'start') expect([id]);
  const result = await run(DOCKER, [name, checkId(id)], { timeout: 120000 });
  console.log(`docker ${name} ${id}: ${result.ok ? 'ok' : result.stderr}`);
  if (!result.ok) throw dockerError(result);
  return { ok: true };
}

async function projectIds(project) {
  const result = await run(DOCKER, ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${checkId(project)}`]);
  if (!result.ok) throw dockerError(result);
  const ids = result.stdout.split('\n').filter(Boolean);
  if (!ids.length) throw new HttpError(404, 'no containers in this project');
  return ids;
}

async function stackAction(project, name) {
  if (!ACTIONS.has(name)) throw new HttpError(400, 'unknown action');
  const ids = await projectIds(project);
  if (name !== 'start') expect(ids);
  const result = await run(DOCKER, [name, ...ids], { timeout: 300000 });
  console.log(`docker ${name} project ${project}: ${result.ok ? 'ok' : result.stderr}`);
  if (!result.ok) throw dockerError(result);
  return { ok: true };
}

// Compose labels say where the project lives; without them we can't recreate a container safely.
async function composeArgs(id) {
  const result = await run(DOCKER, ['inspect', '--format', '{{json .Config.Labels}}', checkId(id)]);
  if (!result.ok) throw dockerError(result);
  const labels = JSON.parse(result.stdout) || {};
  const project = labels['com.docker.compose.project'];
  const dir = labels['com.docker.compose.project.working_dir'];
  if (!project || !dir) throw new HttpError(400, 'only containers started with Docker Compose can be updated here');
  const files = (labels['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean);
  return {
    args: ['compose', '--project-directory', dir, ...files.flatMap((f) => ['-f', f]), '-p', project],
    project,
    service: labels['com.docker.compose.service'],
  };
}

// Pulls newer images and recreates the container (or the whole project) as a job.
async function update(id, wholeProject) {
  const { args, project, service } = await composeArgs(id);
  const target = wholeProject ? [] : [service];
  expect(wholeProject ? await projectIds(project) : [id]);
  return jobs.start(`Update ${wholeProject ? project : service}`, [
    [DOCKER, [...args, 'pull', ...target]],
    [DOCKER, [...args, 'up', '-d', ...target]],
  ]);
}

// Pull and recreate commands for several Compose containers: one pull/up pair per project.
async function updateCommands(ids) {
  const byProject = new Map();
  for (const id of ids) {
    const { args, project, service } = await composeArgs(id);
    if (!byProject.has(project)) byProject.set(project, { args, services: new Set() });
    byProject.get(project).services.add(service);
  }
  expect(ids);
  return [...byProject.values()].flatMap(({ args, services }) => [
    [DOCKER, [...args, 'pull', ...services]],
    [DOCKER, [...args, 'up', '-d', ...services]],
  ]);
}

async function logLines(id, lines) {
  const result = await runMerged(DOCKER, ['logs', '--tail', String(lines), '--timestamps', checkId(id)]);
  if (!result.ok) throw dockerError(result);
  return { title: id, text: result.output.trimEnd() };
}

function followLogs(id, lines, res) {
  logs.follow(DOCKER, ['logs', '--tail', String(lines), '--timestamps', '--follow', checkId(id)], res);
}

module.exports = { DOCKER, containers, stats, action, stackAction, update, updateCommands, logs: logLines, followLogs };
