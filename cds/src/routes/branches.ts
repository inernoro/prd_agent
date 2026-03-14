import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { StateService } from '../services/state.js';
import type { WorktreeService } from '../services/worktree.js';
import type { ContainerService } from '../services/container.js';
import type { BranchEntry, CdsConfig, IShellExecutor, OperationLog, OperationLogEvent, BuildProfile, RoutingRule, ServiceState, InfraService } from '../types.js';
import { discoverComposeFiles, parseComposeFile, parseComposeString, toComposeYaml, parseCdsCompose, toCdsCompose } from '../services/compose-parser.js';
import type { ComposeServiceDef } from '../services/compose-parser.js';
import { combinedOutput } from '../types.js';
import { topoSortLayers } from '../services/topo-sort.js';

export interface RouterDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  shell: IShellExecutor;
  config: CdsConfig;
}

export function createBranchRouter(deps: RouterDeps): Router {
  const {
    stateService,
    worktreeService,
    containerService,
    shell,
    config,
  } = deps;

  const router = Router();

  // ── Helper: merged env (CDS_* auto vars + customEnv, later wins) ──
  function getMergedEnv(): Record<string, string> {
    const cdsEnv = stateService.getCdsEnvVars();   // CDS_HOST, CDS_MONGODB_PORT, etc.
    const mirrorEnv = stateService.getMirrorEnvVars(); // npm/corepack mirror (if enabled)
    const customEnv = stateService.getCustomEnv();
    return { ...cdsEnv, ...mirrorEnv, ...customEnv };
  }

  /** Mask sensitive env var values for trace logging */
  function maskSecrets(env: Record<string, string>): Record<string, string> {
    const SENSITIVE = /secret|password|token|key|credential/i;
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      masked[k] = SENSITIVE.test(k) ? '***' : v;
    }
    return masked;
  }

  // ── Helper: SSE setup ──
  function initSSE(res: import('express').Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  function sendSSE(res: import('express').Response, event: string, data: unknown) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected */ }
  }

  /** Write deploy event to stdout (captured by cds.log when running in background) */
  function logDeploy(branchId: string, message: string) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`  [deploy:${branchId}] ${ts} ${message}`);
  }

  // ── Remote branches ──

  router.get('/remote-branches', async (_req, res) => {
    try {
      await shell.exec(
        'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
        { cwd: config.repoRoot, timeout: 30_000 },
      );

      const SEP = '<SEP>';
      const format = [
        '%(refname:lstrip=3)', '%(committerdate:iso8601)',
        '%(authorname)', '%(subject)',
      ].join(SEP);

      const result = await shell.exec(
        `git for-each-ref --sort=-committerdate --format="${format}" refs/remotes/origin`,
        { cwd: config.repoRoot },
      );

      const branches = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [name, date, author, subject] = line.split(SEP);
          return { name, date, author, subject };
        })
        .filter(b => b.name !== 'HEAD');

      res.json({ branches });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Branches CRUD ──

  router.get('/branches', async (_req, res) => {
    const state = stateService.getState();
    const branches = Object.values(state.branches);

    // Reconcile container status
    for (const b of branches) {
      for (const [profileId, svc] of Object.entries(b.services)) {
        if (svc.status === 'running') {
          const running = await containerService.isRunning(svc.containerName);
          if (!running) {
            svc.status = 'stopped';
            b.services[profileId] = svc;
          }
        }
      }
      // Update overall status
      const statuses = Object.values(b.services).map(s => s.status);
      if (statuses.some(s => s === 'running')) b.status = 'running';
      else if (statuses.some(s => s === 'building')) b.status = 'building';
      else if (statuses.some(s => s === 'error')) b.status = 'error';
      else b.status = 'idle';
    }
    stateService.save();

    // Fetch latest commit subject for each branch (serves as "需求" info)
    const branchesWithSubject = await Promise.all(
      branches.map(async (b) => {
        try {
          const result = await shell.exec(
            'git log -1 --format=%s',
            { cwd: b.worktreePath, timeout: 5000 },
          );
          return { ...b, subject: result.stdout.trim() };
        } catch {
          return { ...b, subject: '' };
        }
      }),
    );

    // Sort: favorites first, then by creation date
    branchesWithSubject.sort((a, b) => {
      const fa = a.isFavorite ? 1 : 0;
      const fb = b.isFavorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return 0; // preserve original order
    });

    res.json({
      branches: branchesWithSubject,
      defaultBranch: state.defaultBranch,
    });
  });

  router.post('/branches', async (req, res) => {
    try {
      const { branch } = req.body as { branch?: string };
      if (!branch) {
        res.status(400).json({ error: '分支名称不能为空' });
        return;
      }

      const id = StateService.slugify(branch);
      if (stateService.getBranch(id)) {
        res.status(409).json({ error: `分支 "${id}" 已存在` });
        return;
      }

      await shell.exec(`mkdir -p "${config.worktreeBase}"`);
      const worktreePath = `${config.worktreeBase}/${id}`;
      await worktreeService.create(branch, worktreePath);

      const entry: BranchEntry = {
        id,
        branch,
        worktreePath,
        services: {},
        status: 'idle',
        createdAt: new Date().toISOString(),
      };
      stateService.addBranch(entry);
      stateService.save();

      res.status(201).json({ branch: entry });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/branches/:id', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    initSSE(res);
    try {
      // Stop all running services
      for (const svc of Object.values(entry.services)) {
        sendSSE(res, 'step', { step: 'stop', status: 'running', title: `正在停止 ${svc.containerName}...` });
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        sendSSE(res, 'step', { step: 'stop', status: 'done', title: `已停止 ${svc.containerName}` });
      }

      // Remove worktree
      sendSSE(res, 'step', { step: 'worktree', status: 'running', title: '正在删除工作树...' });
      try { await worktreeService.remove(entry.worktreePath); } catch { /* ok */ }
      sendSSE(res, 'step', { step: 'worktree', status: 'done', title: '工作树已删除' });

      stateService.removeLogs(id);
      stateService.removeBranch(id);
      stateService.save();

      sendSSE(res, 'complete', { message: `分支 "${id}" 已删除` });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Pull latest code ──

  router.post('/branches/:id/pull', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      const result = await worktreeService.pull(entry.branch, entry.worktreePath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Build & Run (SSE stream) ──

  router.post('/branches/:id/deploy', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const profiles = stateService.getBuildProfiles();
    if (profiles.length === 0) {
      res.status(400).json({ error: '尚未配置构建配置，请先添加至少一个构建配置。' });
      return;
    }

    initSSE(res);

    const opLog: OperationLog = {
      type: 'build',
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
    };

    function logEvent(ev: OperationLogEvent) {
      opLog.events.push(ev);
      sendSSE(res, 'step', ev);
      logDeploy(id, `[${ev.status}] ${ev.title || ev.step}${ev.log ? ' — ' + ev.log : ''}`);
    }

    try {
      logDeploy(id, '开始部署');

      // Pull latest code
      logEvent({ step: 'pull', status: 'running', title: '正在拉取最新代码...', timestamp: new Date().toISOString() });
      const pullResult = await worktreeService.pull(entry.branch, entry.worktreePath);
      logEvent({ step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`, detail: pullResult as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });

      entry.status = 'building';
      stateService.save();

      // ── Compute startup layers (topological sort by dependsOn) ──
      const infraIds = new Set(
        stateService.getInfraServices()
          .filter(s => s.status === 'running')
          .map(s => s.id),
      );

      const { layers, warnings: topoWarnings } = topoSortLayers(
        profiles,
        p => p.id,
        p => p.dependsOn ?? [],
        infraIds,
      );

      // ── Trace: dependency graph + layer plan ──
      const depGraph: Record<string, string[]> = {};
      for (const p of profiles) {
        if (p.dependsOn && p.dependsOn.length > 0) depGraph[p.id] = p.dependsOn;
      }
      logEvent({
        step: 'startup-plan',
        status: 'info',
        title: `启动计划: ${layers.length} 层, ${profiles.length} 服务`,
        detail: {
          dependencyGraph: depGraph,
          layers: layers.map(l => ({ layer: l.layer, services: l.items.map(p => p.id) })),
          resolvedInfra: Array.from(infraIds),
          ...(topoWarnings.length > 0 ? { warnings: topoWarnings } : {}),
        },
        timestamp: new Date().toISOString(),
      });

      // ── Pre-allocate ports synchronously (before parallel execution) ──
      for (const profile of profiles) {
        if (!entry.services[profile.id]) {
          const hostPort = stateService.allocatePort(config.portStart);
          entry.services[profile.id] = {
            profileId: profile.id,
            containerName: `cds-${id}-${profile.id}`,
            hostPort,
            status: 'idle',
          };
        }
      }
      stateService.save();

      // ── Execute layer by layer (parallel within each layer) ──
      for (const layer of layers) {
        const layerServiceNames = layer.items.map(p => p.name).join(', ');
        logEvent({
          step: `layer-${layer.layer}`,
          status: 'running',
          title: `启动第 ${layer.layer} 层: ${layerServiceNames}`,
          timestamp: new Date().toISOString(),
        });

        const layerStartTime = Date.now();

        await Promise.all(layer.items.map(async (profile) => {
          const serviceStartTime = Date.now();
          logEvent({
            step: `build-${profile.id}`,
            status: 'running',
            title: `正在构建 ${profile.name}...`,
            timestamp: new Date().toISOString(),
          });

          const svc = entry.services[profile.id];
          svc.status = 'building';

          try {
            const mergedEnv = getMergedEnv();

            // ── Trace: resolved CDS_* env vars for this service ──
            const cdsVars: Record<string, string> = {};
            for (const [k, v] of Object.entries(mergedEnv)) {
              if (k.startsWith('CDS_')) cdsVars[k] = v;
            }
            logEvent({
              step: `env-${profile.id}`,
              status: 'info',
              title: `${profile.name} 环境变量`,
              detail: {
                cdsVars: maskSecrets(cdsVars),
                profileEnvKeys: Object.keys(profile.env ?? {}),
              },
              timestamp: new Date().toISOString(),
            });

            await containerService.runService(entry, profile, svc, (chunk) => {
              sendSSE(res, 'log', { profileId: profile.id, chunk });
              for (const line of chunk.split('\n')) {
                if (line.trim()) logDeploy(id, line);
              }
            }, mergedEnv);

            svc.status = 'running';
            const elapsed = Date.now() - serviceStartTime;
            logEvent({
              step: `build-${profile.id}`,
              status: 'done',
              title: `${profile.name} 运行于 :${svc.hostPort}`,
              detail: { elapsedMs: elapsed },
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            svc.status = 'error';
            svc.errorMessage = (err as Error).message;
            const elapsed = Date.now() - serviceStartTime;
            logEvent({
              step: `build-${profile.id}`,
              status: 'error',
              title: `${profile.name} 失败`,
              log: (err as Error).message,
              detail: { elapsedMs: elapsed },
              timestamp: new Date().toISOString(),
            });
          }
        }));

        const layerElapsed = Date.now() - layerStartTime;
        logEvent({
          step: `layer-${layer.layer}`,
          status: 'done',
          title: `第 ${layer.layer} 层完成`,
          detail: { elapsedMs: layerElapsed },
          timestamp: new Date().toISOString(),
        });
      }

      // Update overall status
      const statuses = Object.values(entry.services).map(s => s.status);
      const hasRunning = statuses.some(s => s === 'running');
      const hasError = statuses.some(s => s === 'error');
      entry.status = hasRunning ? 'running' : 'error';
      entry.lastAccessedAt = new Date().toISOString();

      opLog.status = hasError ? 'error' : 'completed';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();

      const failedNames = Object.values(entry.services)
        .filter(s => s.status === 'error')
        .map(s => s.profileId);
      const completeMsg = hasError
        ? `部分服务启动失败: ${failedNames.join(', ')}`
        : '所有服务已启动';
      logDeploy(id, `部署完成: ${completeMsg}`);
      sendSSE(res, 'complete', {
        message: completeMsg,
        services: entry.services,
      });
    } catch (err) {
      entry.status = 'error';
      entry.errorMessage = (err as Error).message;
      opLog.status = 'error';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();
      logDeploy(id, `部署失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Redeploy a single service (SSE stream) ──

  router.post('/branches/:id/deploy/:profileId', async (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const profiles = stateService.getBuildProfiles();
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
      res.status(404).json({ error: `构建配置 "${profileId}" 不存在` });
      return;
    }

    initSSE(res);

    const opLog: OperationLog = {
      type: 'build',
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
    };

    function logEvent(ev: OperationLogEvent) {
      opLog.events.push(ev);
      sendSSE(res, 'step', ev);
      logDeploy(id, `[${ev.status}] ${ev.title || ev.step}${ev.log ? ' — ' + ev.log : ''}`);
    }

    try {
      logDeploy(id, `开始部署服务 ${profile.name}`);

      // Pull latest code
      logEvent({ step: 'pull', status: 'running', title: '正在拉取最新代码...', timestamp: new Date().toISOString() });
      const pullResult = await worktreeService.pull(entry.branch, entry.worktreePath);
      logEvent({ step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`, detail: pullResult as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });

      // Build & run the single profile
      logEvent({ step: `build-${profile.id}`, status: 'running', title: `正在构建 ${profile.name}...`, timestamp: new Date().toISOString() });

      if (!entry.services[profile.id]) {
        const hostPort = stateService.allocatePort(config.portStart);
        entry.services[profile.id] = {
          profileId: profile.id,
          containerName: `cds-${id}-${profile.id}`,
          hostPort,
          status: 'building',
        };
        stateService.save();
      }

      const svc = entry.services[profile.id];
      svc.status = 'building';

      try {
        const mergedEnv = getMergedEnv();
        await containerService.runService(entry, profile, svc, (chunk) => {
          sendSSE(res, 'log', { profileId: profile.id, chunk });
          for (const line of chunk.split('\n')) {
            if (line.trim()) logDeploy(id, line);
          }
        }, mergedEnv);

        svc.status = 'running';
        logEvent({ step: `build-${profile.id}`, status: 'done', title: `${profile.name} 运行于 :${svc.hostPort}`, timestamp: new Date().toISOString() });
      } catch (err) {
        svc.status = 'error';
        svc.errorMessage = (err as Error).message;
        logEvent({ step: `build-${profile.id}`, status: 'error', title: `${profile.name} 失败`, log: (err as Error).message, timestamp: new Date().toISOString() });
      }

      // Update overall status
      const statuses = Object.values(entry.services).map(s => s.status);
      entry.status = statuses.some(s => s === 'running') ? 'running' : 'error';
      entry.lastAccessedAt = new Date().toISOString();

      opLog.status = svc.status === 'running' ? 'completed' : 'error';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();

      const completeMsg = svc.status === 'running' ? `${profile.name} 已启动` : `${profile.name} 启动失败`;
      logDeploy(id, `部署完成: ${completeMsg}`);
      sendSSE(res, 'complete', {
        message: completeMsg,
        services: entry.services,
      });
    } catch (err) {
      entry.status = 'error';
      entry.errorMessage = (err as Error).message;
      opLog.status = 'error';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();
      logDeploy(id, `部署失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Stop all services for a branch ──

  router.post('/branches/:id/stop', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      for (const svc of Object.values(entry.services)) {
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        svc.status = 'stopped';
      }
      entry.status = 'idle';
      stateService.save();
      res.json({ message: '所有服务已停止' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Set default branch ──

  router.post('/branches/:id/set-default', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    stateService.setDefaultBranch(id);
    stateService.save();
    res.json({ message: `Default branch set to "${id}"` });
  });

  // ── Update branch metadata (favorite, notes) ──

  router.patch('/branches/:id', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      const { isFavorite, notes, tags } = req.body as { isFavorite?: boolean; notes?: string; tags?: string[] };
      stateService.updateBranchMeta(id, { isFavorite, notes, tags });
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Container logs ──

  router.get('/branches/:id/logs', (req, res) => {
    const { id } = req.params;
    const logs = stateService.getLogs(id);
    res.json({ logs });
  });

  router.post('/branches/:id/container-logs', async (req, res) => {
    const { id } = req.params;
    const { profileId } = req.body as { profileId?: string };
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到服务' });
      return;
    }

    try {
      const logs = await containerService.getLogs(svc.containerName);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Container env ──

  router.post('/branches/:id/container-env', async (req, res) => {
    const { id } = req.params;
    const { profileId } = req.body as { profileId?: string };
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到服务' });
      return;
    }

    try {
      const env = await containerService.getEnv(svc.containerName);
      res.json({ env });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Git log (historical commits) ──

  router.get('/branches/:id/git-log', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const count = Math.min(parseInt(req.query.count as string) || 20, 50);
    try {
      const SEP = '<SEP>';
      const format = ['%h', '%s', '%an', '%ar'].join(SEP);
      const result = await shell.exec(
        `git log -${count} --format="${format}"`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      const commits = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [hash, subject, author, date] = line.split(SEP);
          return { hash, subject, author, date };
        });
      res.json({ commits });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Reset branch status ──

  router.post('/branches/:id/reset', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    entry.status = 'idle';
    entry.errorMessage = undefined;
    for (const svc of Object.values(entry.services)) {
      if (svc.status === 'error' || svc.status === 'building') {
        svc.status = 'idle';
        svc.errorMessage = undefined;
      }
    }
    stateService.save();
    res.json({ message: '分支状态已重置' });
  });

  // ── Routing rules CRUD ──

  router.get('/routing-rules', (_req, res) => {
    res.json({ rules: stateService.getRoutingRules() });
  });

  router.post('/routing-rules', (req, res) => {
    try {
      const rule = req.body as RoutingRule;
      if (!rule.id || !rule.type || !rule.match || !rule.branch) {
        res.status(400).json({ error: 'id、类型、匹配模式和目标分支为必填项' });
        return;
      }
      rule.priority = rule.priority ?? 0;
      rule.enabled = rule.enabled ?? true;
      stateService.addRoutingRule(rule);
      stateService.save();
      res.status(201).json({ rule });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/routing-rules/:id', (req, res) => {
    try {
      stateService.updateRoutingRule(req.params.id, req.body);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/routing-rules/:id', (req, res) => {
    try {
      stateService.removeRoutingRule(req.params.id);
      stateService.save();
      res.json({ message: '已删除' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Build profiles CRUD ──

  router.get('/build-profiles', (_req, res) => {
    res.json({ profiles: stateService.getBuildProfiles() });
  });

  router.post('/build-profiles', (req, res) => {
    try {
      const profile = req.body as BuildProfile;
      if (!profile.id || !profile.name || !profile.dockerImage || !profile.command) {
        res.status(400).json({ error: 'id、名称、Docker 镜像和 command 为必填项' });
        return;
      }
      profile.workDir = profile.workDir || '.';
      profile.containerPort = profile.containerPort || 8080;
      stateService.addBuildProfile(profile);
      stateService.save();
      res.status(201).json({ profile });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/build-profiles/:id', (req, res) => {
    try {
      stateService.updateBuildProfile(req.params.id, req.body);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/build-profiles/:id', (req, res) => {
    try {
      stateService.removeBuildProfile(req.params.id);
      stateService.save();
      res.json({ message: '已删除' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Docker images (for dropdown selection) ──

  router.get('/docker-images', async (_req, res) => {
    try {
      const result = await shell.exec(
        `docker images --format '{"repo":"{{.Repository}}","tag":"{{.Tag}}","size":"{{.Size}}","id":"{{.ID}}"}'`,
        { timeout: 10_000 },
      );
      const images = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter((img: { repo: string; tag: string }) => img.repo !== '<none>' && img.tag !== '<none>');
      res.json({ images });
    } catch {
      // Docker not accessible — return presets only
      res.json({ images: [] });
    }
  });

  // ── Package manager detection ──

  type PackageManager = 'npm' | 'pnpm' | 'yarn';

  /**
   * Detect the package manager for a Node.js project by checking lock files.
   * Priority: pnpm-lock.yaml > yarn.lock > package-lock.json > npm (default)
   */
  function detectPackageManager(projectDir: string): PackageManager {
    if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(projectDir, 'package-lock.json'))) return 'npm';
    return 'npm';
  }

  /** Build command prefix and cache mount for a detected package manager */
  function nodeProfileCommands(pm: PackageManager) {
    switch (pm) {
      case 'pnpm':
        return {
          installPrefix: 'corepack enable && pnpm install --frozen-lockfile && ',
          runPrefix: 'corepack enable && pnpm exec ',
          cacheMounts: [{ hostPath: '/tmp/cds-cache/pnpm', containerPath: '/root/.local/share/pnpm/store' }],
        };
      case 'yarn':
        return {
          installPrefix: 'corepack enable && yarn install --frozen-lockfile && ',
          runPrefix: 'corepack enable && yarn exec ',
          cacheMounts: [{ hostPath: '/tmp/cds-cache/yarn', containerPath: '/usr/local/share/.cache/yarn' }],
        };
      default:
        return {
          installPrefix: 'npm install && ',
          runPrefix: 'npx ',
          cacheMounts: [{ hostPath: '/tmp/cds-cache/npm', containerPath: '/root/.npm' }],
        };
    }
  }

  /**
   * Check if a build command uses pnpm/yarn without corepack enable prefix.
   * Returns a warning string or null if OK.
   */
  function checkCorepackPrefix(cmd: string | undefined, profileLabel: string): string | null {
    if (!cmd) return null;
    const needsCorepack = /\b(pnpm|yarn)\b/.test(cmd) && !/corepack\s+enable/.test(cmd);
    if (needsCorepack) {
      return `${profileLabel}: 命令使用了 pnpm/yarn 但缺少 "corepack enable &&" 前缀，在 node:*-slim 镜像中会失败`;
    }
    return null;
  }

  // ── Package manager detection API ──

  router.get('/detect-pm/:workDir', (_req, res) => {
    const workDir = _req.params.workDir;
    const fullPath = path.join(config.repoRoot, workDir);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: `目录 "${workDir}" 不存在` });
      return;
    }
    const pm = detectPackageManager(fullPath);
    const commands = nodeProfileCommands(pm);
    res.json({ workDir, packageManager: pm, ...commands });
  });

  // ── Quickstart: seed default build profiles for this project ──

  router.post('/quickstart', (_req, res) => {
    const existing = stateService.getBuildProfiles();
    if (existing.length > 0) {
      res.status(409).json({ error: '构建配置已存在。请先删除现有配置或手动添加。' });
      return;
    }

    // Auto-detect package manager for admin panel
    const adminDir = path.join(config.repoRoot, 'prd-admin');
    const pm = fs.existsSync(adminDir) ? detectPackageManager(adminDir) : 'npm';
    const nodeCmd = nodeProfileCommands(pm);

    const defaults: BuildProfile[] = [
      {
        id: 'api',
        name: 'Backend API (.NET 8)',
        dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
        workDir: 'prd-api',
        command: 'dotnet restore && dotnet build --no-restore && dotnet run --no-build --project src/PrdAgent.Api/PrdAgent.Api.csproj --urls http://0.0.0.0:8080',
        containerPort: 8080,
        cacheMounts: [
          { hostPath: '/tmp/cds-cache/nuget', containerPath: '/root/.nuget/packages' },
        ],
      },
      {
        id: 'admin',
        name: 'Admin Panel (Vite)',
        dockerImage: 'node:20-slim',
        workDir: 'prd-admin',
        command: `${nodeCmd.installPrefix}${nodeCmd.runPrefix}vite --host 0.0.0.0 --port 5173`,
        containerPort: 5173,
        cacheMounts: nodeCmd.cacheMounts,
      },
    ];

    for (const profile of defaults) {
      stateService.addBuildProfile(profile);
    }
    stateService.save();

    res.status(201).json({
      message: `快速启动: 已创建 ${defaults.length} 个构建配置 (检测到包管理器: ${pm})`,
      profiles: defaults,
      detectedPackageManager: pm,
    });
  });

  // ── Custom environment variables ──

  router.get('/env', (_req, res) => {
    res.json({ env: stateService.getCustomEnv() });
  });

  // Helper: sync CDS-relevant env vars into runtime config
  function syncCdsConfig() {
    const env = stateService.getCustomEnv();
    if (env.SWITCH_DOMAIN) config.switchDomain = env.SWITCH_DOMAIN;
    if (env.MAIN_DOMAIN) config.mainDomain = env.MAIN_DOMAIN;
    if (env.PREVIEW_DOMAIN) config.previewDomain = env.PREVIEW_DOMAIN;
    // Repo root & worktree base: allow UI override for directory isolation
    if (env.CDS_REPO_ROOT) {
      config.repoRoot = env.CDS_REPO_ROOT;
      worktreeService.repoRoot = env.CDS_REPO_ROOT;
    }
    if (env.CDS_WORKTREE_BASE) config.worktreeBase = env.CDS_WORKTREE_BASE;
  }

  router.put('/env', (req, res) => {
    const env = req.body as Record<string, string>;
    if (!env || typeof env !== 'object') {
      res.status(400).json({ error: '请求体必须是键值对对象' });
      return;
    }
    stateService.setCustomEnv(env);
    stateService.save();
    syncCdsConfig();
    res.json({ message: '环境变量已更新', env });
  });

  router.put('/env/:key', (req, res) => {
    const { key } = req.params;
    const { value } = req.body as { value?: string };
    if (value === undefined) {
      res.status(400).json({ error: '值不能为空' });
      return;
    }
    stateService.setCustomEnvVar(key, value);
    stateService.save();
    syncCdsConfig();
    res.json({ message: `Set ${key}` });
  });

  router.delete('/env/:key', (req, res) => {
    const { key } = req.params;
    stateService.removeCustomEnvVar(key);
    stateService.save();
    res.json({ message: `Deleted ${key}` });
  });

  // ── Mirror acceleration ──

  router.get('/mirror', (_req, res) => {
    res.json({ enabled: stateService.isMirrorEnabled() });
  });

  router.put('/mirror', (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是布尔值' });
      return;
    }
    stateService.setMirrorEnabled(enabled);
    stateService.save();
    res.json({ message: enabled ? '镜像加速已开启' : '镜像加速已关闭', enabled });
  });

  // ── Config (read-only) ──

  router.get('/config', async (_req, res) => {
    const customEnv = stateService.getCustomEnv();

    // GitHub repo URL: prefer explicit config from UI env vars, fallback to git remote auto-detection
    let githubRepoUrl = customEnv.GITHUB_REPO_URL || '';
    if (!githubRepoUrl) {
      try {
        const result = await shell.exec('git remote get-url origin', { cwd: config.repoRoot, timeout: 5000 });
        const remote = result.stdout.trim();
        // Match patterns: git@github.com:owner/repo.git, https://github.com/owner/repo.git, or proxy /git/owner/repo
        const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
        const httpMatch = remote.match(/github\.com\/([^/]+\/[^/.]+)/);
        const proxyMatch = remote.match(/\/git\/([^/]+\/[^/.]+)/);
        const match = sshMatch || httpMatch || proxyMatch;
        if (match) {
          githubRepoUrl = `https://github.com/${match[1].replace(/\.git$/, '')}`;
        }
      } catch { /* ignore */ }
    }

    res.json({
      ...config,
      githubRepoUrl,
      jwt: { ...config.jwt, secret: '***' },
      sharedEnv: Object.fromEntries(
        Object.entries(config.sharedEnv).map(([k, v]) => [k, k.includes('PASSWORD') || k.includes('SECRET') ? '***' : v]),
      ),
    });
  });

  // ── Check updates (compare local vs remote for all branches) ──

  router.get('/check-updates', async (_req, res) => {
    const state = stateService.getState();
    const branches = Object.values(state.branches);

    // Fetch latest remote refs once
    try {
      await shell.exec(
        'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
        { cwd: config.repoRoot, timeout: 30_000 },
      );
    } catch {
      // If fetch fails, we can still compare with last known remote state
    }

    const updates: Record<string, { behind: number; latestRemoteSubject?: string }> = {};

    await Promise.all(branches.map(async (b) => {
      try {
        // Count commits local is behind remote
        const behindResult = await shell.exec(
          `git rev-list --count HEAD..origin/${b.branch} 2>/dev/null || echo 0`,
          { cwd: b.worktreePath, timeout: 10_000 },
        );
        const behind = parseInt(behindResult.stdout.trim()) || 0;

        let latestRemoteSubject: string | undefined;
        if (behind > 0) {
          const subjectResult = await shell.exec(
            `git log -1 --format=%s origin/${b.branch}`,
            { cwd: b.worktreePath, timeout: 5_000 },
          );
          latestRemoteSubject = subjectResult.stdout.trim();
        }

        if (behind > 0) {
          updates[b.id] = { behind, latestRemoteSubject };
        }
      } catch {
        // Branch may not have a remote tracking branch — skip
      }
    }));

    res.json({ updates });
  });

  // ── Cleanup all non-default branches ──

  router.post('/cleanup', async (_req, res) => {
    initSSE(res);
    try {
      const state = stateService.getState();
      const toRemove = Object.values(state.branches).filter(b => b.id !== state.defaultBranch);
      for (const entry of toRemove) {
        sendSSE(res, 'step', { step: 'cleanup', status: 'running', title: `正在删除 ${entry.id}...` });
        for (const svc of Object.values(entry.services)) {
          try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        }
        try { await worktreeService.remove(entry.worktreePath); } catch { /* ok */ }
        stateService.removeLogs(entry.id);
        stateService.removeBranch(entry.id);
        sendSSE(res, 'step', { step: 'cleanup', status: 'done', title: `已删除 ${entry.id}` });
      }
      stateService.save();
      sendSSE(res, 'complete', { message: `已清理 ${toRemove.length} 个分支` });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Factory reset: stop all containers, clear all config, keep Docker volumes ──

  router.post('/factory-reset', async (_req, res) => {
    initSSE(res);
    try {
      const state = stateService.getState();

      // 1. Stop and remove all branch containers + worktrees
      const branches = Object.values(state.branches);
      for (const entry of branches) {
        sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止分支 ${entry.id}...` });
        for (const svc of Object.values(entry.services)) {
          try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        }
        try { await worktreeService.remove(entry.worktreePath); } catch { /* ok */ }
      }

      // 2. Stop and remove all infra service containers (volumes preserved)
      for (const svc of state.infraServices) {
        sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止基础设施 ${svc.name}...` });
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
      }

      // 3. Clear all state (but keep the file — it will be overwritten with defaults)
      const freshState: typeof state = {
        routingRules: [],
        buildProfiles: [],
        branches: {},
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: {},
        infraServices: [],
      };
      Object.assign(state, freshState);
      stateService.save();

      sendSSE(res, 'complete', {
        message: `已恢复出厂设置：清除 ${branches.length} 个分支、${state.infraServices.length} 个基础设施服务、所有配置。Docker 数据卷已保留。`,
      });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Compose-based infrastructure service discovery ──

  /** Convert a ComposeServiceDef to an InfraService (allocating a host port) */
  function composeDefToInfraService(def: ComposeServiceDef): InfraService {
    const hostPort = stateService.allocatePort(config.portStart);
    return {
      id: def.id,
      name: def.name,
      dockerImage: def.dockerImage,
      containerPort: def.containerPort,
      hostPort,
      containerName: `cds-infra-${def.id}`,
      status: 'stopped',
      volumes: [...def.volumes],
      env: { ...def.env },
      healthCheck: def.healthCheck ? { ...def.healthCheck } : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  // ── Infrastructure services CRUD ──

  router.get('/infra', async (_req, res) => {
    const services = stateService.getInfraServices();

    // Reconcile status with Docker
    for (const svc of services) {
      if (svc.status === 'running') {
        const running = await containerService.isRunning(svc.containerName);
        if (!running) {
          svc.status = 'stopped';
        }
      }
    }
    stateService.save();

    res.json({ services });
  });

  // Discover infrastructure services from compose files in the repo
  router.get('/infra/discover', (_req, res) => {
    try {
      const composeFiles = discoverComposeFiles(config.repoRoot);
      const discovered: { file: string; services: ComposeServiceDef[] }[] = [];

      for (const file of composeFiles) {
        try {
          const services = parseComposeFile(file);
          if (services.length > 0) {
            discovered.push({ file: path.relative(config.repoRoot, file), services });
          }
        } catch { /* skip unparseable files */ }
      }

      res.json({ discovered });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra', async (req, res) => {
    try {
      const body = req.body as Partial<InfraService>;

      if (!body.id || !body.dockerImage || !body.containerPort) {
        res.status(400).json({ error: 'id、Docker 镜像和容器端口为必填项' });
        return;
      }
      const hostPort = stateService.allocatePort(config.portStart);
      const service: InfraService = {
        id: body.id,
        name: body.name || body.id,
        dockerImage: body.dockerImage,
        containerPort: body.containerPort,
        hostPort,
        containerName: `cds-infra-${body.id}`,
        status: 'stopped',
        volumes: body.volumes || [],
        env: body.env || {},
        healthCheck: body.healthCheck,
        createdAt: new Date().toISOString(),
      };

      stateService.addInfraService(service);
      stateService.save();

      res.status(201).json({ service });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/infra/:id', (req, res) => {
    try {
      const updates = req.body as Partial<InfraService>;
      stateService.updateInfraService(req.params.id, updates);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/infra/:id', async (req, res) => {
    const { id } = req.params;
    const service = stateService.getInfraService(id);
    if (!service) {
      res.status(404).json({ error: `基础设施服务 "${id}" 不存在` });
      return;
    }
    try {
      // Stop container if running
      try { await containerService.stopInfraService(service.containerName); } catch { /* ok */ }
      stateService.removeInfraService(id);
      stateService.save();
      res.json({ message: `已删除基础设施服务 "${id}"` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/start', async (req, res) => {
    const { id } = req.params;
    const service = stateService.getInfraService(id);
    if (!service) {
      res.status(404).json({ error: `基础设施服务 "${id}" 不存在` });
      return;
    }
    try {
      await containerService.startInfraService(service);
      stateService.updateInfraService(id, { status: 'running', errorMessage: undefined });
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已启动`, service: stateService.getInfraService(id) });
    } catch (err) {
      stateService.updateInfraService(id, { status: 'error', errorMessage: (err as Error).message });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/stop', async (req, res) => {
    const { id } = req.params;
    const service = stateService.getInfraService(id);
    if (!service) {
      res.status(404).json({ error: `基础设施服务 "${id}" 不存在` });
      return;
    }
    try {
      await containerService.stopInfraService(service.containerName);
      stateService.updateInfraService(id, { status: 'stopped' });
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已停止` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/restart', async (req, res) => {
    const { id } = req.params;
    const service = stateService.getInfraService(id);
    if (!service) {
      res.status(404).json({ error: `基础设施服务 "${id}" 不存在` });
      return;
    }
    try {
      try { await containerService.stopInfraService(service.containerName); } catch { /* ok */ }
      await containerService.startInfraService(service);
      stateService.updateInfraService(id, { status: 'running', errorMessage: undefined });
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已重启`, service: stateService.getInfraService(id) });
    } catch (err) {
      stateService.updateInfraService(id, { status: 'error', errorMessage: (err as Error).message });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/infra/:id/logs', async (req, res) => {
    const { id } = req.params;
    const service = stateService.getInfraService(id);
    if (!service) {
      res.status(404).json({ error: `基础设施服务 "${id}" 不存在` });
      return;
    }
    try {
      const logs = await containerService.getLogs(service.containerName);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/infra/:id/health', async (req, res) => {
    const { id } = req.params;
    const service = stateService.getInfraService(id);
    if (!service) {
      res.status(404).json({ error: `基础设施服务 "${id}" 不存在` });
      return;
    }
    try {
      const health = await containerService.getInfraHealth(service.containerName);
      res.json({ health });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Quick setup: discover infra from compose files and start them
  router.post('/infra/quickstart', async (req, res) => {
    const { compose: composeYaml, serviceIds } = req.body as { compose?: string; serviceIds?: string[] };
    const results: { id: string; status: string; error?: string }[] = [];

    // Resolve service definitions: from inline compose YAML, or auto-discover from repo
    let defs: ComposeServiceDef[] = [];
    if (composeYaml) {
      defs = parseComposeString(composeYaml);
    } else {
      const composeFiles = discoverComposeFiles(config.repoRoot);
      const seenIds = new Set<string>();
      for (const file of composeFiles) {
        try {
          for (const def of parseComposeFile(file)) {
            if (!seenIds.has(def.id)) {
              seenIds.add(def.id);
              defs.push(def);
            }
          }
        } catch { /* skip */ }
      }
    }

    // Filter by requested IDs if specified
    if (serviceIds && serviceIds.length > 0) {
      defs = defs.filter(d => serviceIds.includes(d.id));
    }

    if (defs.length === 0) {
      res.json({ results: [], message: '未找到基础设施服务定义。请在项目中添加 docker-compose.yml 或 cds-compose.yml 文件。' });
      return;
    }

    for (const def of defs) {
      // Skip if already exists
      if (stateService.getInfraService(def.id)) {
        results.push({ id: def.id, status: 'exists' });
        continue;
      }

      const service = composeDefToInfraService(def);

      try {
        stateService.addInfraService(service);
        await containerService.startInfraService(service);
        stateService.updateInfraService(service.id, { status: 'running' });
        results.push({ id: service.id, status: 'started' });
      } catch (err) {
        stateService.updateInfraService(service.id, { status: 'error', errorMessage: (err as Error).message });
        results.push({ id: service.id, status: 'error', error: (err as Error).message });
      }
    }

    stateService.save();
    res.json({ results });
  });

  // ── Config Import / Export ──

  /** Validate a CDS Config JSON blob */
  function validateConfigBlob(blob: unknown): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!blob || typeof blob !== 'object') {
      return { valid: false, errors: ['配置必须是一个 JSON 对象'], warnings };
    }
    const cfg = blob as Record<string, unknown>;
    const schema = cfg.$schema as string | undefined;
    if (schema && schema !== 'cds-config') {
      errors.push('$schema 字段值应为 "cds-config"');
    }
    // Validate buildProfiles
    if (cfg.buildProfiles !== undefined) {
      if (!Array.isArray(cfg.buildProfiles)) {
        errors.push('buildProfiles 必须是数组');
      } else {
        for (let i = 0; i < cfg.buildProfiles.length; i++) {
          const p = cfg.buildProfiles[i] as Record<string, unknown>;
          if (!p.id) errors.push(`buildProfiles[${i}]: 缺少 id`);
          if (!p.name) errors.push(`buildProfiles[${i}]: 缺少 name`);
          if (!p.dockerImage) errors.push(`buildProfiles[${i}]: 缺少 dockerImage`);
          if (!p.command) errors.push(`buildProfiles[${i}]: 缺少 command`);
          if (p.containerPort !== undefined) {
            const port = Number(p.containerPort);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              errors.push(`buildProfiles[${i}]: containerPort 必须在 1-65535 之间`);
            }
          }
          // Check corepack prefix for pnpm/yarn commands
          const label = `buildProfiles[${i}]`;
          const cmdWarn = checkCorepackPrefix(p.command as string | undefined, `${label}.command`);
          if (cmdWarn) warnings.push(cmdWarn);

          // Cross-check: if workDir has a lock file that doesn't match the command's PM
          if (p.workDir && typeof p.workDir === 'string') {
            const fullDir = path.join(config.repoRoot, p.workDir);
            if (fs.existsSync(fullDir)) {
              const detectedPm = detectPackageManager(fullDir);
              const cmdToCheck = (p.command as string) || '';
              const usesWrongPm =
                (detectedPm === 'pnpm' && /\bnpm install\b/.test(cmdToCheck)) ||
                (detectedPm === 'npm' && /\bpnpm install\b/.test(cmdToCheck)) ||
                (detectedPm === 'yarn' && !/\byarn install\b/.test(cmdToCheck) && /\b(npm|pnpm) install\b/.test(cmdToCheck));
              if (usesWrongPm) {
                warnings.push(`${label}: 检测到 ${p.workDir}/ 使用 ${detectedPm}，但命令使用了其他包管理器`);
              }
            }
          }
        }
      }
    }
    // Validate envVars
    if (cfg.envVars !== undefined && (typeof cfg.envVars !== 'object' || Array.isArray(cfg.envVars))) {
      errors.push('envVars 必须是键值对对象');
    }
    // Validate infraServices — accepts array of full definitions OR a compose YAML string
    if (cfg.infraServices !== undefined) {
      if (typeof cfg.infraServices === 'string') {
        // Compose YAML string — validate it parses
        try {
          const defs = parseComposeString(cfg.infraServices as string);
          if (defs.length === 0) {
            warnings.push('infraServices (compose YAML): 未解析到任何服务');
          }
        } catch (e) {
          errors.push(`infraServices (compose YAML): 解析失败 — ${(e as Error).message}`);
        }
      } else if (Array.isArray(cfg.infraServices)) {
        for (let i = 0; i < cfg.infraServices.length; i++) {
          const s = cfg.infraServices[i] as Record<string, unknown>;
          if (!s.id) {
            errors.push(`infraServices[${i}]: 缺少 id`);
          }
          if (!s.dockerImage && !s.image) {
            errors.push(`infraServices[${i}]: 缺少 dockerImage`);
          }
          if (!s.containerPort) {
            errors.push(`infraServices[${i}]: 缺少 containerPort`);
          }
        }
      } else {
        errors.push('infraServices 必须是数组或 compose YAML 字符串');
      }
    }
    // Validate routingRules
    if (cfg.routingRules !== undefined) {
      if (!Array.isArray(cfg.routingRules)) {
        errors.push('routingRules 必须是数组');
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  /** Resolve infraServices from config — supports array of full defs or compose YAML string */
  function resolveInfraDefs(cfg: Record<string, unknown>): ComposeServiceDef[] {
    if (!cfg.infraServices) return [];

    if (typeof cfg.infraServices === 'string') {
      return parseComposeString(cfg.infraServices as string);
    }

    if (Array.isArray(cfg.infraServices)) {
      return (cfg.infraServices as Array<Record<string, unknown>>).map(s => ({
        id: (s.id as string) || '',
        name: (s.name as string) || (s.id as string) || '',
        dockerImage: (s.dockerImage as string) || (s.image as string) || '',
        containerPort: (s.containerPort as number) || 0,
        volumes: (s.volumes as Array<{ name: string; containerPath: string }>) || [],
        env: (s.env as Record<string, string>) || {},
        healthCheck: s.healthCheck as ComposeServiceDef['healthCheck'],
      }));
    }

    return [];
  }

  /** Preview what an import would do (without applying) */
  function previewImport(cfg: Record<string, unknown>) {
    const summary = {
      buildProfiles: { add: 0, replace: 0, skip: 0, items: [] as string[] },
      envVars: { add: 0, replace: 0, items: [] as string[] },
      infraServices: { add: 0, skip: 0, items: [] as string[] },
      routingRules: { add: 0, replace: 0, items: [] as string[] },
    };

    if (Array.isArray(cfg.buildProfiles)) {
      for (const p of cfg.buildProfiles as Array<{ id: string; name?: string }>) {
        const existing = stateService.getBuildProfile(p.id);
        if (existing) {
          summary.buildProfiles.replace++;
          summary.buildProfiles.items.push(`替换: ${p.name || p.id}`);
        } else {
          summary.buildProfiles.add++;
          summary.buildProfiles.items.push(`新增: ${p.name || p.id}`);
        }
      }
    }

    if (cfg.envVars && typeof cfg.envVars === 'object') {
      const currentEnv = stateService.getCustomEnv();
      for (const key of Object.keys(cfg.envVars as Record<string, string>)) {
        if (key in currentEnv) {
          summary.envVars.replace++;
          summary.envVars.items.push(`覆盖: ${key}`);
        } else {
          summary.envVars.add++;
          summary.envVars.items.push(`新增: ${key}`);
        }
      }
    }

    // Resolve infra services from array or compose YAML string
    const infraDefs = resolveInfraDefs(cfg);
    for (const def of infraDefs) {
      const existing = stateService.getInfraService(def.id);
      if (existing) {
        summary.infraServices.skip++;
        summary.infraServices.items.push(`跳过 (已存在): ${def.id}`);
      } else {
        summary.infraServices.add++;
        summary.infraServices.items.push(`新增: ${def.name || def.id}`);
      }
    }

    if (Array.isArray(cfg.routingRules)) {
      for (const r of cfg.routingRules as Array<{ id: string; name?: string }>) {
        const existing = stateService.getRoutingRules().find(x => x.id === r.id);
        if (existing) {
          summary.routingRules.replace++;
          summary.routingRules.items.push(`替换: ${r.name || r.id}`);
        } else {
          summary.routingRules.add++;
          summary.routingRules.items.push(`新增: ${r.name || r.id}`);
        }
      }
    }

    return summary;
  }

  // POST /api/import-config — validate, preview, and optionally apply
  // Accepts { config: <JSON object | YAML string>, dryRun? }
  // Auto-detects format: YAML string → CDS compose, JSON object → direct config
  router.post('/import-config', async (req, res) => {
    try {
      const { config: configBlob, dryRun } = req.body as { config: unknown; dryRun?: boolean };

      // Auto-detect format: string → try CDS compose YAML, object → JSON config
      let cfg: Record<string, unknown>;
      if (typeof configBlob === 'string') {
        const cdsConfig = parseCdsCompose(configBlob);
        if (cdsConfig) {
          // Convert CDS compose to internal format (reuse existing validate/apply pipeline)
          cfg = {
            $schema: 'cds-config',
            buildProfiles: cdsConfig.buildProfiles,
            envVars: cdsConfig.envVars,
            infraServices: cdsConfig.infraServices.length > 0 ? cdsConfig.infraServices : undefined,
            routingRules: cdsConfig.routingRules.length > 0 ? cdsConfig.routingRules : undefined,
          };
        } else {
          // Not a CDS compose — try parsing as JSON string
          try {
            cfg = JSON.parse(configBlob);
          } catch {
            res.status(400).json({
              valid: false,
              errors: ['无法解析输入：既不是有效的 CDS Compose YAML（需包含 services 定义），也不是有效的 JSON'],
              warnings: [],
            });
            return;
          }
        }
      } else {
        cfg = configBlob as Record<string, unknown>;
      }

      // Validate
      const validation = validateConfigBlob(cfg);
      if (!validation.valid) {
        res.status(400).json({ valid: false, errors: validation.errors, warnings: validation.warnings });
        return;
      }
      const preview = previewImport(cfg);

      // If dry run, return preview only (include warnings)
      if (dryRun) {
        res.json({ valid: true, preview, applied: false, warnings: validation.warnings });
        return;
      }

      // Apply: build profiles (add or replace)
      if (Array.isArray(cfg.buildProfiles)) {
        for (const p of cfg.buildProfiles as BuildProfile[]) {
          const existing = stateService.getBuildProfile(p.id);
          if (existing) {
            stateService.updateBuildProfile(p.id, p);
          } else {
            p.workDir = p.workDir || '.';
            p.containerPort = p.containerPort || 8080;
            stateService.addBuildProfile(p);
          }
        }
      }

      // Apply: env vars (merge, new wins)
      if (cfg.envVars && typeof cfg.envVars === 'object') {
        const newVars = cfg.envVars as Record<string, string>;
        for (const [key, value] of Object.entries(newVars)) {
          stateService.setCustomEnvVar(key, value);
        }
      }

      // Apply: infra services (add if not exists, skip existing)
      const infraResults: { id: string; status: string }[] = [];
      const infraDefs = resolveInfraDefs(cfg);
      for (const def of infraDefs) {
        if (stateService.getInfraService(def.id)) {
          infraResults.push({ id: def.id, status: 'exists' });
          continue;
        }

        if (def.id && def.dockerImage && def.containerPort) {
          const service = composeDefToInfraService(def);
          stateService.addInfraService(service);
          infraResults.push({ id: service.id, status: 'created' });
        }
      }

      // Apply: routing rules (add or replace)
      if (Array.isArray(cfg.routingRules)) {
        for (const r of cfg.routingRules as RoutingRule[]) {
          const existing = stateService.getRoutingRules().find(x => x.id === r.id);
          if (existing) {
            stateService.updateRoutingRule(r.id, r);
          } else {
            r.priority = r.priority ?? 0;
            r.enabled = r.enabled ?? true;
            stateService.addRoutingRule(r);
          }
        }
      }

      // Sync CDS config (domains etc.)
      syncCdsConfig();
      stateService.save();

      res.json({
        valid: true,
        preview,
        applied: true,
        infraResults,
        warnings: validation.warnings,
        message: '配置已成功导入',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/export-config — export current config as CDS Compose YAML (default) or JSON
  // Export current CDS config as Compose YAML
  router.get('/export-config', (_req, res) => {
    const profiles = stateService.getBuildProfiles();
    const envVars = stateService.getCustomEnv();
    const infra = stateService.getInfraServices();
    const rules = stateService.getRoutingRules();

    const yamlContent = toCdsCompose(profiles, envVars, infra, rules);
    res.type('text/yaml').send(yamlContent);
  });

  // POST /api/import-and-init — import config + start infra + create main branch + deploy (SSE progress)
  // Same config parsing as /import-config, but after applying config it also:
  //   1. Starts all new infra services
  //   2. Creates a main branch worktree (if not exists)
  //   3. Deploys the main branch (build + run all profiles)
  router.post('/import-and-init', async (req, res) => {
    const { config: configBlob } = req.body as { config: unknown };

    // ── Parse config (same logic as import-config) ──
    let cfg: Record<string, unknown>;
    if (typeof configBlob === 'string') {
      const cdsConfig = parseCdsCompose(configBlob);
      if (cdsConfig) {
        cfg = {
          $schema: 'cds-config',
          buildProfiles: cdsConfig.buildProfiles,
          envVars: cdsConfig.envVars,
          infraServices: cdsConfig.infraServices.length > 0 ? cdsConfig.infraServices : undefined,
          routingRules: cdsConfig.routingRules.length > 0 ? cdsConfig.routingRules : undefined,
        };
      } else {
        try {
          cfg = JSON.parse(configBlob);
        } catch {
          res.status(400).json({ error: '无法解析配置：既不是有效的 CDS Compose YAML，也不是有效的 JSON' });
          return;
        }
      }
    } else {
      cfg = configBlob as Record<string, unknown>;
    }

    // Validate
    const validation = validateConfigBlob(cfg);
    if (!validation.valid) {
      res.status(400).json({ valid: false, errors: validation.errors });
      return;
    }

    // ── Start SSE stream ──
    initSSE(res);
    const send = (step: string, status: string, title: string) => {
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString() });
    };

    try {
      // ── Phase 1: Apply config ──
      send('config', 'running', '正在写入配置...');

      // Apply build profiles
      if (Array.isArray(cfg.buildProfiles)) {
        for (const p of cfg.buildProfiles as BuildProfile[]) {
          const existing = stateService.getBuildProfile(p.id);
          if (existing) {
            stateService.updateBuildProfile(p.id, p);
          } else {
            p.workDir = p.workDir || '.';
            p.containerPort = p.containerPort || 8080;
            stateService.addBuildProfile(p);
          }
        }
      }

      // Apply env vars
      if (cfg.envVars && typeof cfg.envVars === 'object') {
        for (const [key, value] of Object.entries(cfg.envVars as Record<string, string>)) {
          stateService.setCustomEnvVar(key, value);
        }
      }

      // Apply routing rules
      if (Array.isArray(cfg.routingRules)) {
        for (const r of cfg.routingRules as RoutingRule[]) {
          const existing = stateService.getRoutingRules().find(x => x.id === r.id);
          if (existing) {
            stateService.updateRoutingRule(r.id, r);
          } else {
            r.priority = r.priority ?? 0;
            r.enabled = r.enabled ?? true;
            stateService.addRoutingRule(r);
          }
        }
      }

      // Apply infra service definitions (don't start yet)
      const infraDefs = resolveInfraDefs(cfg);
      const newInfraServices: InfraService[] = [];
      for (const def of infraDefs) {
        if (stateService.getInfraService(def.id)) continue;
        if (def.id && def.dockerImage && def.containerPort) {
          const service = composeDefToInfraService(def);
          stateService.addInfraService(service);
          newInfraServices.push(service);
        }
      }

      syncCdsConfig();
      stateService.save();
      send('config', 'done', `配置已写入 (${stateService.getBuildProfiles().length} 个构建配置, ${newInfraServices.length} 个基础设施)`);

      // ── Phase 2: Start infra services ──
      const allInfra = stateService.getInfraServices();
      const infraToStart = allInfra.filter(s => s.status !== 'running');
      if (infraToStart.length > 0) {
        send('infra', 'running', `正在启动 ${infraToStart.length} 个基础设施服务...`);
        for (const svc of infraToStart) {
          send(`infra-${svc.id}`, 'running', `正在启动 ${svc.name} (${svc.dockerImage})...`);
          try {
            await containerService.startInfraService(svc);
            stateService.updateInfraService(svc.id, { status: 'running', errorMessage: undefined });
            send(`infra-${svc.id}`, 'done', `${svc.name} 已启动 → :${svc.hostPort}`);
          } catch (err) {
            stateService.updateInfraService(svc.id, { status: 'error', errorMessage: (err as Error).message });
            send(`infra-${svc.id}`, 'error', `${svc.name} 启动失败: ${(err as Error).message}`);
          }
        }
        stateService.save();
        send('infra', 'done', '基础设施服务就绪');
      } else {
        send('infra', 'done', '基础设施服务已在运行中');
      }

      // ── Phase 3: Create main branch worktree ──
      // Detect default branch name
      let mainBranch = 'main';
      try {
        const result = await shell.exec('git symbolic-ref refs/remotes/origin/HEAD', { cwd: config.repoRoot, timeout: 5000 });
        const ref = result.stdout.trim(); // e.g., refs/remotes/origin/main
        if (ref) mainBranch = ref.replace('refs/remotes/origin/', '');
      } catch {
        // Fallback: try 'main', then 'master'
        try {
          await shell.exec('git rev-parse --verify origin/main', { cwd: config.repoRoot, timeout: 5000 });
          mainBranch = 'main';
        } catch {
          mainBranch = 'master';
        }
      }

      const mainSlug = StateService.slugify(mainBranch);
      let entry = stateService.getBranch(mainSlug);

      if (!entry) {
        send('worktree', 'running', `正在为 ${mainBranch} 创建工作树...`);
        // Ensure worktreeBase directory exists (first-time setup)
        await shell.exec(`mkdir -p "${config.worktreeBase}"`);
        const worktreePath = `${config.worktreeBase}/${mainSlug}`;
        await worktreeService.create(mainBranch, worktreePath);

        entry = {
          id: mainSlug,
          branch: mainBranch,
          worktreePath,
          services: {},
          status: 'idle',
          createdAt: new Date().toISOString(),
        };
        stateService.addBranch(entry);
        if (!stateService.getState().defaultBranch) {
          stateService.setDefaultBranch(mainSlug);
        }
        stateService.save();
        send('worktree', 'done', `工作树已创建: ${mainBranch}`);
      } else {
        send('worktree', 'done', `工作树已存在: ${mainBranch}`);
      }

      // ── Phase 4: Deploy main branch (build + run all profiles) ──
      const profiles = stateService.getBuildProfiles();
      if (profiles.length > 0) {
        send('deploy', 'running', `正在部署 ${mainBranch} (${profiles.length} 个服务)...`);

        entry.status = 'building';
        stateService.save();

        // Pre-allocate ports
        for (const profile of profiles) {
          if (!entry.services[profile.id]) {
            const hostPort = stateService.allocatePort(config.portStart);
            entry.services[profile.id] = {
              profileId: profile.id,
              containerName: `cds-${mainSlug}-${profile.id}`,
              hostPort,
              status: 'idle',
            };
          }
        }
        stateService.save();

        const mergedEnv = getMergedEnv();

        for (const profile of profiles) {
          const svc = entry.services[profile.id];
          send(`deploy-${profile.id}`, 'running', `正在构建 ${profile.name}...`);
          svc.status = 'building';

          try {
            await containerService.runService(entry, profile, svc, (chunk) => {
              sendSSE(res, 'log', { profileId: profile.id, chunk });
            }, mergedEnv);

            svc.status = 'running';
            send(`deploy-${profile.id}`, 'done', `${profile.name} 就绪 → :${svc.hostPort}`);
          } catch (err) {
            svc.status = 'error';
            entry.errorMessage = (err as Error).message;
            send(`deploy-${profile.id}`, 'error', `${profile.name} 构建失败: ${(err as Error).message}`);
          }
        }

        const hasError = Object.values(entry.services).some(s => s.status === 'error');
        entry.status = hasError ? 'error' : 'running';
        stateService.save();

        send('deploy', hasError ? 'error' : 'done',
          hasError ? '部分服务构建失败' : `部署完成，所有服务已就绪`);
      }

      send('complete', 'done', '初始化完成');
      sendSSE(res, 'done', { message: '初始化完成' });
    } catch (err) {
      send('error', 'error', `初始化失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
    }

    res.end();
  });

  return router;
}
