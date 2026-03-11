import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ShellExecutor } from './services/shell-executor.js';
import { StateService } from './services/state.js';
import { WorktreeService } from './services/worktree.js';
import { ContainerService } from './services/container.js';
import { ProxyService } from './services/proxy.js';

const configPath = process.argv[2] || undefined;
const config = loadConfig(configPath);

const shell = new ShellExecutor();

// ── State ──
const stateFile = path.join(config.repoRoot, '.cds', 'state.json');
const stateService = new StateService(stateFile);
stateService.load();

// ── Services ──
const worktreeService = new WorktreeService(shell, config.repoRoot);
const containerService = new ContainerService(shell, config);
const proxyService = new ProxyService(stateService);

// Configure proxy: resolve branch slug → upstream URL
proxyService.setResolveUpstream((branchId, profileId) => {
  const branch = stateService.getBranch(branchId);
  if (!branch) return null;

  if (profileId && branch.services[profileId]) {
    const svc = branch.services[profileId];
    if (svc.status === 'running') return `http://127.0.0.1:${svc.hostPort}`;
  }

  // Fallback: find first running service
  for (const svc of Object.values(branch.services)) {
    if (svc.status === 'running') return `http://127.0.0.1:${svc.hostPort}`;
  }
  return null;
});

// Auto-build: when a request hits an unbuilt branch
proxyService.setOnAutoBuild(async (branchSlug, _req, res) => {
  const branch = stateService.getBranch(branchSlug);

  if (branch?.status === 'building') {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'building',
      message: `Branch "${branchSlug}" is currently building. Please wait...`,
    }));
    return;
  }

  // Check if remote branch exists
  const exists = await worktreeService.branchExists(branchSlug);
  // Also try the original branch name patterns
  const candidates = [branchSlug, `feature/${branchSlug}`, `fix/${branchSlug}`];
  let resolvedBranch: string | null = null;

  if (exists) {
    resolvedBranch = branchSlug;
  } else {
    for (const candidate of candidates) {
      if (await worktreeService.branchExists(candidate)) {
        resolvedBranch = candidate;
        break;
      }
    }
  }

  if (!resolvedBranch) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `远程仓库中未找到分支 "${branchSlug}"`,
    }));
    return;
  }

  // SSE: stream build progress
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (event: string, data: unknown) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* */ }
  };

  try {
    // Create worktree if branch doesn't exist locally
    let entry = stateService.getBranch(branchSlug);
    if (!entry) {
      sendEvent('step', { step: 'worktree', status: 'running', title: `Creating worktree for ${resolvedBranch}...` });
      const worktreePath = `${config.worktreeBase}/${branchSlug}`;
      await worktreeService.create(resolvedBranch, worktreePath);

      entry = {
        id: branchSlug,
        branch: resolvedBranch,
        worktreePath,
        services: {},
        status: 'building',
        createdAt: new Date().toISOString(),
      };
      stateService.addBranch(entry);
      stateService.save();
      sendEvent('step', { step: 'worktree', status: 'done', title: 'Worktree created' });
    }

    entry.status = 'building';
    stateService.save();

    // Build all profiles
    const profiles = stateService.getBuildProfiles();
    for (const profile of profiles) {
      sendEvent('step', { step: `build-${profile.id}`, status: 'running', title: `Building ${profile.name}...` });

      if (!entry.services[profile.id]) {
        const hostPort = stateService.allocatePort(config.portStart);
        entry.services[profile.id] = {
          profileId: profile.id,
          containerName: `cds-${branchSlug}-${profile.id}`,
          hostPort,
          status: 'building',
        };
        stateService.save();
      }

      const svc = entry.services[profile.id];
      svc.status = 'building';

      const customEnv = stateService.getCustomEnv();
      await containerService.runService(entry, profile, svc, (chunk) => {
        sendEvent('log', { profileId: profile.id, chunk });
      }, customEnv);

      svc.status = 'running';
      sendEvent('step', { step: `build-${profile.id}`, status: 'done', title: `${profile.name} ready on :${svc.hostPort}` });
    }

    entry.status = 'running';
    entry.lastAccessedAt = new Date().toISOString();
    stateService.save();

    sendEvent('complete', {
      message: `Branch "${branchSlug}" is now running.`,
      hint: 'Refresh to access the application.',
    });
  } catch (err) {
    const entry = stateService.getBranch(branchSlug);
    if (entry) {
      entry.status = 'error';
      entry.errorMessage = (err as Error).message;
      stateService.save();
    }
    sendEvent('error', { message: (err as Error).message });
  } finally {
    res.end();
  }
});

// ── Master server (dashboard + API on masterPort) ──
const app = createServer({
  stateService,
  worktreeService,
  containerService,
  proxyService,
  shell,
  config,
});

app.listen(config.masterPort, () => {
  console.log(`\n  Cloud Development Suite`);
  console.log(`  ──────────────────────`);
  console.log(`  Dashboard:  http://localhost:${config.masterPort}`);
  console.log(`  Worker:     http://localhost:${config.workerPort}`);
  console.log(`  State file: ${stateFile}`);
  console.log(`  Repo root:  ${config.repoRoot}`);
  console.log('');
});

// ── Worker server (reverse proxy on workerPort) ──
const workerServer = http.createServer((req, res) => {
  proxyService.handleRequest(req, res);
});

workerServer.on('upgrade', (req, socket, head) => {
  proxyService.handleUpgrade(req, socket, head);
});

workerServer.listen(config.workerPort, () => {
  console.log(`  Worker proxy listening on :${config.workerPort}`);
  console.log(`  Route via X-Branch header or configure routing rules in dashboard.`);
  console.log('');
});
