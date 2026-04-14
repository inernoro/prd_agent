/**
 * Executor local API routes — called by the Scheduler to execute operations.
 * These endpoints are the "hands" that do the actual Docker/Git work.
 */
import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { WorktreeService } from '../services/worktree.js';
import type { ContainerService } from '../services/container.js';
import type { CdsConfig, IShellExecutor, BranchEntry, OperationLog, OperationLogEvent } from '../types.js';
import { topoSortLayers } from '../services/topo-sort.js';

export interface ExecutorRouterDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  shell: IShellExecutor;
  config: CdsConfig;
}

export function createExecutorRouter(deps: ExecutorRouterDeps): Router {
  const { stateService, worktreeService, containerService, shell, config } = deps;
  const router = Router();

  // ── Auth middleware: verify executor token ──
  router.use((req, res, next) => {
    if (config.executorToken) {
      const token = req.headers['x-executor-token'] as string | undefined;
      if (token !== config.executorToken) {
        res.status(401).json({ error: 'Invalid executor token' });
        return;
      }
    }
    next();
  });

  function getMergedEnv(): Record<string, string> {
    const cdsEnv = stateService.getCdsEnvVars();
    const mirrorEnv = stateService.getMirrorEnvVars();
    const customEnv = stateService.getCustomEnv();
    return { ...cdsEnv, ...mirrorEnv, ...customEnv };
  }

  // ── GET /exec/status — current load and branch status ──
  router.get('/status', (_req, res) => {
    const branches = stateService.getAllBranches();
    const branchStatus: Record<string, { status: string; services: Record<string, unknown> }> = {};
    for (const b of branches) {
      branchStatus[b.id] = { status: b.status, services: b.services };
    }
    res.json({ branches: branchStatus });
  });

  // ── POST /exec/deploy — deploy a branch (create worktree + build + run) ──
  router.post('/deploy', async (req, res) => {
    const { branchId, branchName, profiles: profilesData, env: envOverrides } = req.body as {
      branchId: string;
      branchName: string;
      profiles: Array<{ id: string; name: string; dockerImage: string; workDir: string; command: string; containerPort: number; env?: Record<string, string>; cacheMounts?: Array<{ hostPath: string; containerPath: string }>; dependsOn?: string[]; readinessProbe?: { path?: string; intervalSeconds?: number; timeoutSeconds?: number }; pathPrefixes?: string[]; containerWorkDir?: string; buildTimeout?: number }>;
      env?: Record<string, string>;
    };

    // SSE response
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
      // Ensure worktree exists.
      // P4 Part 18 (G1.2): executor routes stay on the single
      // config.repoRoot. A remote executor is a separately-hosted
      // node pinned to a single bind-mounted repo; per-project clone
      // lives on the master and is not replicated to executors yet.
      let entry = stateService.getBranch(branchId);
      if (!entry) {
        sendEvent('step', { step: 'worktree', status: 'running', title: `正在为 ${branchName} 创建工作树...` });
        await shell.exec(`mkdir -p "${config.worktreeBase}"`);
        const worktreePath = `${config.worktreeBase}/${branchId}`;
        await worktreeService.create(config.repoRoot, branchName, worktreePath);

        entry = {
          id: branchId,
          branch: branchName,
          worktreePath,
          services: {},
          status: 'building',
          createdAt: new Date().toISOString(),
        };
        stateService.addBranch(entry);
        stateService.save();
        sendEvent('step', { step: 'worktree', status: 'done', title: '工作树已创建' });
      }

      // Pull latest
      sendEvent('step', { step: 'pull', status: 'running', title: '正在拉取最新代码...' });
      const pullResult = await worktreeService.pull(entry.branch, entry.worktreePath);
      sendEvent('step', { step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}` });

      entry.status = 'building';
      stateService.save();

      // Pre-allocate ports
      for (const profile of profilesData) {
        if (!entry.services[profile.id]) {
          const hostPort = stateService.allocatePort(config.portStart);
          entry.services[profile.id] = {
            profileId: profile.id,
            containerName: `cds-${branchId}-${profile.id}`,
            hostPort,
            status: 'idle',
          };
        }
      }
      stateService.save();

      // Build and run each profile
      const mergedEnv = { ...getMergedEnv(), ...(envOverrides || {}) };

      for (const profile of profilesData) {
        sendEvent('step', { step: `build-${profile.id}`, status: 'running', title: `正在构建 ${profile.name}...` });
        const svc = entry.services[profile.id];
        svc.status = 'building';

        try {
          await containerService.runService(entry, profile, svc, (chunk) => {
            sendEvent('log', { profileId: profile.id, chunk });
          }, mergedEnv);

          svc.status = 'running';
          sendEvent('step', { step: `build-${profile.id}`, status: 'done', title: `${profile.name} 运行于 :${svc.hostPort}` });
        } catch (err) {
          svc.status = 'error';
          svc.errorMessage = (err as Error).message;
          sendEvent('step', { step: `build-${profile.id}`, status: 'error', title: `${profile.name} 失败`, log: (err as Error).message });
        }
      }

      // Update overall status
      const statuses = Object.values(entry.services).map(s => s.status);
      entry.status = statuses.some(s => s === 'running') ? 'running' : 'error';
      entry.lastAccessedAt = new Date().toISOString();
      stateService.save();

      sendEvent('complete', {
        message: entry.status === 'running' ? '部署完成' : '部分服务失败',
        services: entry.services,
      });
    } catch (err) {
      sendEvent('error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── POST /exec/stop — stop all services for a branch ──
  router.post('/stop', async (req, res) => {
    const { branchId } = req.body as { branchId: string };
    const entry = stateService.getBranch(branchId);
    if (!entry) {
      res.status(404).json({ error: `Branch "${branchId}" not found on this executor` });
      return;
    }

    try {
      for (const svc of Object.values(entry.services)) {
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        svc.status = 'stopped';
      }
      entry.status = 'idle';
      stateService.save();
      res.json({ message: 'All services stopped' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /exec/pull — pull latest code for a branch ──
  router.post('/pull', async (req, res) => {
    const { branchId } = req.body as { branchId: string };
    const entry = stateService.getBranch(branchId);
    if (!entry) {
      res.status(404).json({ error: `Branch "${branchId}" not found` });
      return;
    }
    try {
      const result = await worktreeService.pull(entry.branch, entry.worktreePath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── GET /exec/logs/:branchId — get container logs ──
  router.get('/logs/:branchId', async (req, res) => {
    const { branchId } = req.params;
    const { profileId } = req.query as { profileId?: string };
    const entry = stateService.getBranch(branchId);
    if (!entry) {
      res.status(404).json({ error: `Branch "${branchId}" not found` });
      return;
    }
    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: 'No service found' });
      return;
    }
    try {
      const logs = await containerService.getLogs(svc.containerName);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /exec/delete — delete branch (stop + remove worktree) ──
  router.post('/delete', async (req, res) => {
    const { branchId } = req.body as { branchId: string };
    const entry = stateService.getBranch(branchId);
    if (!entry) {
      res.status(404).json({ error: `Branch "${branchId}" not found` });
      return;
    }
    try {
      for (const svc of Object.values(entry.services)) {
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
      }
      // P4 Part 18 (G1.2): executor stays on config.repoRoot.
      try { await worktreeService.remove(config.repoRoot, entry.worktreePath); } catch { /* ok */ }
      stateService.removeLogs(branchId);
      stateService.removeBranch(branchId);
      stateService.save();
      res.json({ message: `Branch "${branchId}" deleted` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /exec/infra/start — start an infra service ──
  router.post('/infra/start', async (req, res) => {
    const { service } = req.body as { service: unknown };
    try {
      const svc = service as import('../types.js').InfraService;
      await containerService.startInfraService(svc);
      res.json({ message: 'Service started' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /exec/infra/stop — stop an infra service ──
  router.post('/infra/stop', async (req, res) => {
    const { containerName } = req.body as { containerName: string };
    try {
      await containerService.stopInfraService(containerName);
      res.json({ message: 'Service stopped' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
