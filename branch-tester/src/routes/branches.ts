import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { StateService } from '../services/state.js';
import type { WorktreeService } from '../services/worktree.js';
import type { ContainerService } from '../services/container.js';
import type { SwitcherService } from '../services/switcher.js';
import type { BuilderService } from '../services/builder.js';
import type { BranchEntry, BtConfig, IShellExecutor, OperationLog, OperationLogEvent } from '../types.js';
import { combinedOutput } from '../types.js';

export interface RouterDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  switcherService: SwitcherService;
  builderService: BuilderService;
  shell: IShellExecutor;
  config: BtConfig;
}

export function createBranchRouter(deps: RouterDeps): Router {
  const {
    stateService,
    worktreeService,
    containerService,
    switcherService,
    builderService,
    shell,
    config,
  } = deps;

  const router = Router();

  // GET /remote-branches — list remote branches with latest commit info
  router.get('/remote-branches', async (_req, res) => {
    try {
      // Fetch latest refs from remote so for-each-ref has up-to-date data
      await shell.exec(
        'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
        { cwd: config.repoRoot, timeout: 30_000 },
      );

      // Get rich branch info from remote-tracking refs
      const SEP = '<SEP>';
      const format = [
        '%(refname:lstrip=3)',
        '%(committerdate:iso8601)',
        '%(authorname)',
        '%(subject)',
      ].join(SEP);

      const result = await shell.exec(
        `git for-each-ref --sort=-committerdate "refs/remotes/origin/" --format="${format}"`,
        { cwd: config.repoRoot, timeout: 15_000 },
      );

      if (result.exitCode !== 0) {
        res.status(502).json({ error: `git for-each-ref failed: ${combinedOutput(result)}` });
        return;
      }

      const existing = new Set(
        Object.values(stateService.getState().branches).map((b) => b.branch),
      );

      const branches = result.stdout
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const parts = line.split(SEP);
          return {
            name: parts[0]?.trim(),
            date: parts[1]?.trim(),
            author: parts[2]?.trim(),
            message: parts.slice(3).join(SEP).trim(),
          };
        })
        .filter((b) => b.name && b.name !== 'HEAD' && !existing.has(b.name));

      res.json({ branches });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /branches — list all (with live container status reconciliation)
  router.get('/branches', async (_req, res) => {
    const state = stateService.getState();
    let dirty = false;

    // Reconcile persisted status with actual Docker container state
    for (const entry of Object.values(state.branches)) {
      // Deploy mode: status says "running" but container is dead?
      if (entry.status === 'running') {
        const alive = await containerService.isRunning(entry.containerName);
        if (!alive) {
          entry.status = 'stopped';
          entry.errorMessage = '容器已退出（自动检测）';
          dirty = true;
        }
      }
      // Run mode: runStatus says "running" but container is dead?
      if (entry.runStatus === 'running' && entry.runContainerName) {
        const alive = await containerService.isRunning(entry.runContainerName);
        if (!alive) {
          entry.runStatus = 'stopped';
          entry.runErrorMessage = '容器已退出（自动检测）';
          dirty = true;
        }
      }
    }

    if (dirty) stateService.save();

    res.json({
      branches: state.branches,
      activeBranchId: state.activeBranchId,
      mainDbName: config.mongodb.defaultDbName,
    });
  });

  // GET /history — activation history
  router.get('/history', (_req, res) => {
    res.json({ history: stateService.getState().history });
  });

  // GET /config — current config
  router.get('/config', (_req, res) => {
    const safe = { ...config, jwt: { ...config.jwt, secret: '***' } };
    res.json(safe);
  });

  // POST /branches — add a branch
  router.post('/branches', async (req, res) => {
    try {
      const { branch } = req.body as { branch?: string };
      if (!branch) {
        res.status(400).json({ error: 'branch is required' });
        return;
      }

      const id = StateService.slugify(branch);
      if (stateService.getBranch(id)) {
        res.status(409).json({ error: `Branch "${id}" already exists` });
        return;
      }

      const worktreePath = path.join(config.worktreeBase, id);
      const containerName = `${config.docker.containerPrefix}-${id}`;
      const imageName = `${config.docker.apiImagePrefix}:${id}`;
      const dbName = stateService.allocateDbName(id, config.mongodb.defaultDbName);

      await worktreeService.create(branch, worktreePath);

      const entry = {
        id,
        branch,
        worktreePath,
        containerName,
        imageName,
        dbName,
        status: 'idle' as const,
        createdAt: new Date().toISOString(),
      };
      stateService.addBranch(entry);
      stateService.save();

      res.status(201).json({ branch: entry });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /branches/:id — remove a branch (blocked if active)
  router.delete('/branches/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      if (stateService.getState().activeBranchId === id) {
        res.status(400).json({ error: 'Cannot delete the active branch. Switch to another first.' });
        return;
      }

      // Stop deploy container if running
      if (entry.status === 'running') {
        await containerService.stop(entry.containerName);
      }
      // Stop run container if running
      if (entry.runStatus === 'running' && entry.runContainerName) {
        try { await containerService.stop(entry.runContainerName); } catch { /* may not exist */ }
      }

      try { await worktreeService.remove(entry.worktreePath); } catch { /* may not exist */ }
      try { await containerService.removeImage(entry.imageName); } catch { /* may not exist */ }

      stateService.removeBranch(id);
      stateService.removeLogs(id);
      stateService.save();

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /branches/:id/pull — pull latest code for a branch worktree
  router.post('/branches/:id/pull', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      if (entry.status === 'building') {
        res.status(409).json({ error: 'Branch is currently building, cannot pull' });
        return;
      }

      const pullResult = await worktreeService.pull(entry.branch, entry.worktreePath);
      res.json({ success: true, ...pullResult });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /branches/:id/logs — get operation logs for a branch
  router.get('/branches/:id/logs', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `Branch "${id}" not found` });
      return;
    }
    res.json({ logs: stateService.getLogs(id) });
  });

  // POST /branches/:id/reset — reset a stuck/error branch status back to idle
  router.post('/branches/:id/reset', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      // Stop any running containers (best-effort)
      if (entry.status === 'running') {
        try { await containerService.stop(entry.containerName); } catch { /* ok */ }
      }
      if (entry.runStatus === 'running' && entry.runContainerName) {
        try { await containerService.stop(entry.runContainerName); } catch { /* ok */ }
      }

      // Reset statuses
      entry.status = 'idle';
      entry.errorMessage = undefined;
      entry.buildLog = undefined;
      entry.runStatus = undefined;
      entry.runErrorMessage = undefined;
      stateService.save();

      res.json({ success: true, message: 'Branch status reset to idle' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /branches/:id/build — build branch (guarded: rejects if already building)
  router.post('/branches/:id/build', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      if (entry.status === 'building') {
        res.status(409).json({ error: 'Build already in progress' });
        return;
      }

      stateService.updateStatus(id, 'building');
      stateService.save();

      const buildsDir = path.join(config.repoRoot, config.deployDir, 'web', 'builds', id);

      const [apiLog, adminLog] = await Promise.all([
        builderService.buildApiImage(entry.worktreePath, entry.imageName),
        builderService.buildAdminStatic(entry.worktreePath, buildsDir),
      ]);

      stateService.updateStatus(id, 'built');
      stateService.getBranch(id)!.buildLog = `API: ${apiLog}\nAdmin: ${adminLog}`;
      stateService.save();

      res.json({ success: true, message: 'Build completed' });
    } catch (err) {
      const { id } = req.params;
      stateService.updateStatus(id, 'error');
      stateService.getBranch(id)!.buildLog = (err as Error).message;
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /branches/:id/start — start container (guarded: rejects if already running)
  router.post('/branches/:id/start', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      if (entry.status === 'running') {
        res.status(409).json({ error: 'Container already running' });
        return;
      }

      await containerService.start(entry);
      stateService.updateStatus(id, 'running');
      stateService.save();

      res.json({ success: true, containerName: entry.containerName });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /branches/:id/stop — stop container
  router.post('/branches/:id/stop', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      await containerService.stop(entry.containerName);
      stateService.updateStatus(id, 'stopped');
      stateService.save();

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Helper: determine which container name to use as nginx upstream
  function resolveUpstream(entry: BranchEntry): { upstream: string; mode: 'deploy' | 'run' } | null {
    // Prefer deploy container if running
    if (entry.status === 'running') {
      return { upstream: entry.containerName, mode: 'deploy' };
    }
    // Fallback to source-run container if running
    if (entry.runStatus === 'running' && entry.runContainerName) {
      return { upstream: entry.runContainerName, mode: 'run' };
    }
    return null;
  }

  // Helper: perform the activate sequence (sync + nginx switch)
  async function doActivate(id: string): Promise<void> {
    const entry = stateService.getBranch(id)!;
    const resolved = resolveUpstream(entry);
    if (!resolved) {
      throw new Error(`Branch "${id}" has no running container (deploy or source-run)`);
    }

    switcherService.backup();

    // Sync static files: prefer branch-specific build, fallback to main dist
    const buildsDir = path.join(config.repoRoot, config.deployDir, 'web', 'builds', id);
    const distDir = path.join(config.repoRoot, config.deployDir, 'web', 'dist');
    if (fs.existsSync(buildsDir)) {
      await switcherService.syncStaticFiles(buildsDir, distDir);
    }

    const modeLabel = resolved.mode === 'run' ? '源码' : '制品';
    const branchLabel = `${entry.branch} (${modeLabel})`;
    const newConf = switcherService.generateConfig(resolved.upstream, branchLabel);
    await switcherService.applyConfig(newConf);

    stateService.activate(id);
    stateService.save();
  }

  // POST /branches/:id/activate — switch active branch
  router.post('/branches/:id/activate', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      // Check if any container (deploy or source-run) is actually running
      const resolved = resolveUpstream(entry);
      if (!resolved) {
        // Double-check with Docker in case state is stale
        const deployAlive = await containerService.isRunning(entry.containerName);
        const runAlive = entry.runContainerName
          ? await containerService.isRunning(entry.runContainerName)
          : false;

        if (!deployAlive && !runAlive) {
          res.status(400).json({
            error: `分支 "${entry.branch}" 没有运行中的容器（部署和源码都未运行）`,
          });
          return;
        }
        // State was stale, update it
        if (deployAlive) entry.status = 'running';
        if (runAlive) entry.runStatus = 'running';
        stateService.save();
      }

      await doActivate(id);

      res.json({
        success: true,
        activeBranchId: id,
        url: `http://localhost:${config.gateway.port}`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ──────────────────────────────────────────────────────────
  //  Run / Re-run  (source-based, direct port, no nginx)
  //  Run  = code, not artifacts.  One branch = one running instance.
  //  Deploy = artifacts, via nginx gateway.  Separate container.
  // ──────────────────────────────────────────────────────────

  /** Shared logic for run / rerun SSE endpoints */
  async function doRun(
    req: import('express').Request,
    res: import('express').Response,
    opts: { forcePull: boolean },
  ) {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `Branch "${id}" not found` });
      return;
    }

    // Branch isolation: one branch can only have one running instance
    if (!opts.forcePull && entry.runStatus === 'running') {
      res.status(409).json({ error: 'Branch already running. Use rerun to pull latest and restart.' });
      return;
    }

    // Switch to SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const logType = opts.forcePull ? 'rerun' : 'run' as const;
    const opLog: OperationLog = {
      type: logType,
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
    };

    const send = (data: Record<string, unknown>) => {
      // Persist event (skip streaming chunks to keep logs lean)
      if (!data.chunk) {
        const event = { ...data, timestamp: new Date().toISOString() } as OperationLogEvent;
        // Deduplicate: if same step already logged, replace with latest state
        const existingIdx = data.step
          ? opLog.events.findIndex((e) => e.step === data.step)
          : -1;
        if (existingIdx >= 0) {
          opLog.events[existingIdx] = event;
        } else {
          opLog.events.push(event);
        }
      }
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    const portStart = config.run?.portStart ?? 9001;
    const baseImage = config.run?.baseImage ?? 'mcr.microsoft.com/dotnet/sdk:8.0';
    const command = config.run?.command ?? 'dotnet run --project src/PrdAgent.Api';
    const sourceDir = config.run?.sourceDir ?? 'prd-api';

    try {
      // ---- pull (rerun: pull latest code) ----
      if (opts.forcePull) {
        send({ step: 'pull', status: 'running', title: '拉取最新代码' });

        const beforeSha = await shell.exec('git rev-parse --short HEAD', { cwd: entry.worktreePath });
        await worktreeService.pull(entry.branch, entry.worktreePath);
        const afterSha = await shell.exec('git rev-parse --short HEAD', { cwd: entry.worktreePath });

        const diffStat = await shell.exec(
          `git diff --stat ${beforeSha.stdout.trim()}..${afterSha.stdout.trim()}`,
          { cwd: entry.worktreePath },
        );
        const diffLog = await shell.exec(
          `git log --oneline ${beforeSha.stdout.trim()}..${afterSha.stdout.trim()}`,
          { cwd: entry.worktreePath },
        );

        send({
          step: 'pull', status: 'done', title: '拉取最新代码',
          detail: {
            before: beforeSha.stdout.trim(),
            after: afterSha.stdout.trim(),
            changes: diffStat.stdout.trim(),
            newCommits: diffLog.stdout.trim(),
          },
        });
      }

      // ---- env info ----
      const commitResult = await shell.exec('git log --oneline -1', { cwd: entry.worktreePath });
      const commit = (await shell.exec('git rev-parse --short HEAD', { cwd: entry.worktreePath })).stdout.trim();

      // Allocate port + run container name if not yet assigned
      if (!entry.hostPort) {
        entry.hostPort = stateService.allocatePort(portStart);
      }
      if (!entry.runContainerName) {
        entry.runContainerName = `prdagent-run-${id}`;
      }
      stateService.save();

      send({
        step: 'env', status: 'done', title: '环境信息',
        detail: {
          mode: 'source',
          branch: entry.branch,
          commit,
          commitLog: commitResult.stdout.trim(),
          runContainerName: entry.runContainerName,
          hostPort: entry.hostPort,
          baseImage,
          sourceDir,
          url: `http://localhost:${entry.hostPort}`,
        },
      });

      // ---- stop old run container if running ----
      if (entry.runStatus === 'running') {
        send({ step: 'stop', status: 'running', title: '停止旧容器' });
        try { await containerService.stop(entry.runContainerName); } catch { /* may not exist */ }
        entry.runStatus = 'stopped';
        stateService.save();
        send({ step: 'stop', status: 'done', title: '停止旧容器' });
      }

      // ---- start from source (no build step!) ----
      send({ step: 'start', status: 'running', title: '启动源码容器' });

      await containerService.runFromSource(entry, {
        hostPort: entry.hostPort,
        baseImage,
        command,
        sourceDir,
      });
      entry.runStatus = 'running';
      entry.runErrorMessage = undefined;
      stateService.save();

      send({
        step: 'start', status: 'done', title: '启动源码容器',
        detail: {
          runContainerName: entry.runContainerName,
          hostPort: entry.hostPort,
          url: `http://localhost:${entry.hostPort}`,
          sourceMount: `${entry.worktreePath}/${sourceDir} → /src`,
        },
      });

      // ---- done ----
      send({
        step: 'complete', status: 'done',
        detail: { url: `http://localhost:${entry.hostPort}` },
      });

      opLog.status = 'completed';
    } catch (err) {
      const msg = (err as Error).message;
      send({ step: 'error', status: 'error', title: '运行失败', log: msg });
      entry.runStatus = 'error';
      entry.runErrorMessage = msg;
      stateService.save();
      opLog.status = 'error';
    } finally {
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();
      res.end();
    }
  }

  // POST /branches/:id/run — Run from source: mount worktree + SDK image + dotnet run
  router.post('/branches/:id/run', (req, res) => {
    doRun(req, res, { forcePull: false });
  });

  // POST /branches/:id/rerun — Pull latest code + restart source container
  router.post('/branches/:id/rerun', (req, res) => {
    doRun(req, res, { forcePull: true });
  });

  // POST /branches/:id/stop-run — Stop the source-based run container
  router.post('/branches/:id/stop-run', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }
      if (!entry.runContainerName || entry.runStatus !== 'running') {
        res.status(400).json({ error: 'No run container is active for this branch' });
        return;
      }

      await containerService.stop(entry.runContainerName);
      entry.runStatus = 'stopped';
      stateService.save();

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /branches/:id/deploy — SSE stream: build + start + activate + health check
  router.post('/branches/:id/deploy', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `Branch "${id}" not found` });
      return;
    }
    if (entry.status === 'building') {
      res.status(409).json({ error: 'Build already in progress' });
      return;
    }

    // Switch to SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const opLog: OperationLog = {
      type: 'deploy',
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
    };

    const send = (data: Record<string, unknown>) => {
      // Persist event (skip streaming chunks to keep logs lean)
      if (!data.chunk) {
        const event = { ...data, timestamp: new Date().toISOString() } as OperationLogEvent;
        // Deduplicate: if same step already logged, replace with latest state
        const existingIdx = data.step
          ? opLog.events.findIndex((e) => e.step === data.step)
          : -1;
        if (existingIdx >= 0) {
          opLog.events[existingIdx] = event;
        } else {
          opLog.events.push(event);
        }
      }
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    try {
      // ---- env info ----
      const commitResult = await shell.exec(
        'git log --oneline -1', { cwd: entry.worktreePath },
      );
      const shaResult = await shell.exec(
        'git rev-parse --short HEAD', { cwd: entry.worktreePath },
      );
      const commit = shaResult.stdout.trim();
      const buildsDir = path.join(config.repoRoot, config.deployDir, 'web', 'builds', id);

      send({
        step: 'env', status: 'done', title: '环境信息',
        detail: {
          mode: 'deploy',
          branch: entry.branch,
          commit,
          commitLog: commitResult.stdout.trim(),
          worktreePath: entry.worktreePath,
          containerName: entry.containerName,
          imageName: entry.imageName,
          dbName: entry.dbName,
          network: config.docker.network,
          gatewayPort: config.gateway.port,
        },
      });

      // ---- build ----
      if (entry.status === 'idle' || entry.status === 'error') {
        stateService.updateStatus(id, 'building');
        entry.errorMessage = undefined;
        stateService.save();

        // API image (stream build output in real-time)
        send({ step: 'build_api', status: 'running', title: '构建 API 镜像' });
        const apiLog = await builderService.buildApiImage(
          entry.worktreePath, entry.imageName,
          (chunk) => send({ step: 'build_api', status: 'running', title: '构建 API 镜像', chunk }),
        );
        send({ step: 'build_api', status: 'done', title: '构建 API 镜像' });

        // Admin static (stream build output in real-time)
        send({ step: 'build_admin', status: 'running', title: '构建前端静态文件' });
        const adminLog = await builderService.buildAdminStatic(
          entry.worktreePath, buildsDir,
          (chunk) => send({ step: 'build_admin', status: 'running', title: '构建前端静态文件', chunk }),
        );
        send({ step: 'build_admin', status: 'done', title: '构建前端静态文件' });

        // Write version file for health check
        const versionInfo = { commit, branch: entry.branch, builtAt: new Date().toISOString() };
        fs.mkdirSync(buildsDir, { recursive: true });
        fs.writeFileSync(path.join(buildsDir, 'bt-version.json'), JSON.stringify(versionInfo));

        stateService.updateStatus(id, 'built');
        stateService.getBranch(id)!.buildLog = `API:\n${apiLog}\nAdmin:\n${adminLog}`;
        stateService.save();
      } else {
        send({ step: 'build_api', status: 'skip', title: '构建 API 镜像 (已构建，跳过)' });
        send({ step: 'build_admin', status: 'skip', title: '构建前端静态文件 (已构建，跳过)' });
      }

      // ---- start ----
      if (stateService.getBranch(id)!.status !== 'running') {
        send({ step: 'start', status: 'running', title: '启动容器' });
        await containerService.start(stateService.getBranch(id)!);
        stateService.updateStatus(id, 'running');
        stateService.save();
        send({
          step: 'start', status: 'done', title: '启动容器',
          detail: { containerName: entry.containerName, network: config.docker.network },
        });
      } else {
        send({ step: 'start', status: 'skip', title: '启动容器 (已运行，跳过)' });
      }

      // ---- activate nginx ----
      send({ step: 'activate', status: 'running', title: '切换 Nginx 网关' });

      switcherService.backup();
      const distDir = path.join(config.repoRoot, config.deployDir, 'web', 'dist');
      await switcherService.syncStaticFiles(buildsDir, distDir);
      const deployLabel = `${entry.branch} (制品)`;
      const nginxConf = switcherService.generateConfig(entry.containerName, deployLabel);
      await switcherService.applyConfig(nginxConf);
      stateService.activate(id);
      stateService.save();

      send({
        step: 'activate', status: 'done', title: '切换 Nginx 网关',
        detail: {
          upstream: `${entry.containerName}:8080`,
          gateway: `http://localhost:${config.gateway.port}`,
          nginxConf,
        },
      });

      // ---- health check ----
      send({ step: 'health', status: 'running', title: '健康检查' });
      await new Promise((r) => setTimeout(r, 3000));

      const versionUrl = `http://localhost:${config.gateway.port}/bt-version.json`;
      const healthResult = await shell.exec(`curl -sf -m 5 "${versionUrl}"`, { timeout: 10_000 });

      let healthStatus: string;
      let healthDetail: Record<string, unknown>;
      if (healthResult.exitCode === 0) {
        try {
          const actual = JSON.parse(healthResult.stdout);
          const match = actual.commit === commit;
          healthStatus = match ? 'done' : 'warn';
          healthDetail = {
            url: versionUrl, expected: commit, actual: actual.commit,
            match, builtAt: actual.builtAt,
            hint: match ? '' : '版本不匹配 — 可能需要重新构建',
          };
        } catch {
          healthStatus = 'warn';
          healthDetail = { url: versionUrl, expected: commit, actual: '响应解析失败', match: false };
        }
      } else {
        healthStatus = 'warn';
        healthDetail = {
          url: versionUrl, expected: commit, actual: '无法连接',
          match: false, error: combinedOutput(healthResult).slice(0, 300),
          hint: '容器可能仍在启动，稍后可手动刷新检查',
        };
      }
      send({ step: 'health', status: healthStatus, title: '健康检查', detail: healthDetail });

      // ---- done ----
      send({ step: 'complete', status: 'done' });
      entry.errorMessage = undefined;
      stateService.save();
      opLog.status = 'completed';
    } catch (err) {
      const msg = (err as Error).message;
      const e = stateService.getBranch(id);
      if (e) {
        // Always set error status on deploy failure, regardless of current status
        stateService.updateStatus(id, 'error');
        e.errorMessage = msg;
        e.buildLog = msg;
        stateService.save();
      }
      send({ step: 'error', status: 'error', title: '部署失败', log: msg });
      opLog.status = 'error';
    } finally {
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();
      res.end();
    }
  });

  // POST /rollback — rollback to previous branch
  router.post('/rollback', async (_req, res) => {
    try {
      const history = stateService.getState().history;
      if (history.length <= 1) {
        res.status(400).json({ error: 'No history to rollback to' });
        return;
      }

      const previousId = history[history.length - 2];
      const entry = stateService.getBranch(previousId);
      if (!entry) {
        res.status(500).json({ error: `Previous branch "${previousId}" no longer exists` });
        return;
      }

      const running = await containerService.isRunning(entry.containerName);
      if (!running) {
        await containerService.start(entry);
        stateService.updateStatus(previousId, 'running');
      }

      // Switch nginx FIRST — if this fails, state stays untouched
      switcherService.backup();
      const buildsDir = path.join(config.repoRoot, config.deployDir, 'web', 'builds', previousId);
      const distDir = path.join(config.repoRoot, config.deployDir, 'web', 'dist');
      await switcherService.syncStaticFiles(buildsDir, distDir);

      const rollbackLabel = `${entry.branch} (回滚)`;
      const newConf = switcherService.generateConfig(entry.containerName, rollbackLabel);
      await switcherService.applyConfig(newConf);

      // Nginx succeeded — NOW commit the state change
      stateService.rollback();
      stateService.save();

      res.json({
        success: true,
        activeBranchId: previousId,
        url: `http://localhost:${config.gateway.port}`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /gateway/disconnect — clear active branch, nginx returns 502 for API calls
  router.post('/gateway/disconnect', async (_req, res) => {
    try {
      const state = stateService.getState();
      if (!state.activeBranchId) {
        res.json({ success: true, message: '网关已处于断开状态' });
        return;
      }

      // Generate nginx config that returns 502 directly for /api/ calls
      // (no upstream reference, so nginx -t won't fail on DNS resolution)
      switcherService.backup();
      const disconnectedConf = switcherService.generateConfig('_disconnected_upstream_');
      await switcherService.applyConfig(disconnectedConf);

      state.activeBranchId = null;
      stateService.save();

      res.json({ success: true, message: '网关已断开' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ================================================================
  // Database management
  // ================================================================

  // POST /branches/:id/db/clone — clone main DB into branch DB
  router.post('/branches/:id/db/clone', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) { res.status(404).json({ error: `Branch "${id}" not found` }); return; }

      const mainDbName = config.mongodb.defaultDbName;
      const targetDb = entry.dbName;

      if (targetDb === mainDbName) {
        res.status(400).json({ error: '当前分支已在使用主库，无需克隆' });
        return;
      }

      // Use mongodump/mongorestore inside the MongoDB container to clone
      const mongoContainer = 'prdagent-mongodb';
      const cmd = [
        `docker exec ${mongoContainer} mongosh --quiet --eval`,
        `"db.getMongo().getDB('${mainDbName}').getCollectionNames().forEach(function(c) {`,
        `  if (!c.startsWith('system.')) {`,
        `    const docs = db.getMongo().getDB('${mainDbName}').getCollection(c).find().toArray();`,
        `    if (docs.length > 0) {`,
        `      db.getMongo().getDB('${targetDb}').getCollection(c).drop();`,
        `      db.getMongo().getDB('${targetDb}').getCollection(c).insertMany(docs);`,
        `    }`,
        `  }`,
        `});"`,
      ].join(' ');

      const result = await shell.exec(cmd, { timeout: 120_000 });
      if (result.exitCode !== 0) {
        throw new Error(`数据库克隆失败: ${combinedOutput(result)}`);
      }

      res.json({
        success: true,
        message: `已将 ${mainDbName} 的数据克隆到 ${targetDb}`,
        sourceDb: mainDbName,
        targetDb,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /branches/:id/db/use-main — switch branch to use main DB
  router.post('/branches/:id/db/use-main', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) { res.status(404).json({ error: `Branch "${id}" not found` }); return; }

      const mainDbName = config.mongodb.defaultDbName;
      if (entry.dbName === mainDbName) {
        res.status(400).json({ error: '已在使用主库' });
        return;
      }

      // Save the original DB name so we can switch back
      if (!entry.originalDbName) {
        entry.originalDbName = entry.dbName;
      }
      entry.dbName = mainDbName;
      stateService.save();

      res.json({
        success: true,
        message: `分支已切换到主库 ${mainDbName}（需要重启容器生效）`,
        dbName: mainDbName,
        hint: '请重新运行或部署以使用新数据库',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /branches/:id/db/use-own — switch branch back to its own isolated DB
  router.post('/branches/:id/db/use-own', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) { res.status(404).json({ error: `Branch "${id}" not found` }); return; }

      const mainDbName = config.mongodb.defaultDbName;
      const own = entry.originalDbName;

      if (!own || entry.dbName !== mainDbName) {
        res.status(400).json({ error: '当前未使用主库，无需切换' });
        return;
      }

      entry.dbName = own;
      delete entry.originalDbName;
      stateService.save();

      res.json({
        success: true,
        message: `分支已切换回独立数据库 ${own}（需要重启容器生效）`,
        dbName: own,
        hint: '请重新运行或部署以使用新数据库',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
