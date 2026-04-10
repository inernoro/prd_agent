import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { Router } from 'express';
import { StateService } from '../services/state.js';
import type { WorktreeService } from '../services/worktree.js';
import { resolveProfileWithMode } from '../services/container.js';
import type { ContainerService } from '../services/container.js';
import type { BranchEntry, CdsConfig, IShellExecutor, OperationLog, OperationLogEvent, BuildProfile, RoutingRule, ServiceState, InfraService, DataMigration, MongoConnectionConfig } from '../types.js';
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

  // ── Preview port servers (port mode: per-branch proxy with path-prefix routing) ──
  const previewServers = new Map<string, http.Server>();

  function cleanupPreviewServer(branchId: string) {
    const server = previewServers.get(branchId);
    if (server) {
      server.close();
      previewServers.delete(branchId);
      const entry = stateService.getBranch(branchId);
      if (entry) {
        delete entry.previewPort;
        stateService.save();
      }
      console.log(`[preview] Closed preview proxy for "${branchId}"`);
    }
  }

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

  /** Download MongoDB database tools binary (platform-independent fallback) */
  async function installMongoToolsBinary(sh: IShellExecutor, send: (msg: string) => void) {
    const archResult = await sh.exec('uname -m');
    const arch = archResult.stdout.trim();
    const isArm = arch === 'aarch64' || arch === 'arm64';
    const platform = isArm ? 'arm64' : 'x86_64';
    const url = `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-${platform}-100.10.0.deb`;
    send(`正在下载 MongoDB 工具 (${platform})...`);
    // Try dpkg if debian-based, otherwise extract manually
    const dlResult = await sh.exec(
      `cd /tmp && curl -fsSL -o mongo-tools.deb "${url}" 2>&1 && dpkg -x mongo-tools.deb /tmp/mongo-tools-extracted 2>&1 && cp /tmp/mongo-tools-extracted/usr/bin/mongo* /usr/local/bin/ 2>&1 && chmod +x /usr/local/bin/mongo* && rm -rf /tmp/mongo-tools.deb /tmp/mongo-tools-extracted`,
      { timeout: 120000 }
    );
    if (dlResult.exitCode !== 0) {
      // Try tarball as absolute fallback
      send('deb 安装失败，尝试 tarball...');
      const tgzUrl = `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-linux-${platform}-100.10.0.tgz`;
      await sh.exec(
        `cd /tmp && curl -fsSL -o mongo-tools.tgz "${tgzUrl}" && tar xzf mongo-tools.tgz && cp mongodb-database-tools-*/bin/mongo* /usr/local/bin/ && chmod +x /usr/local/bin/mongo* && rm -rf /tmp/mongo-tools.tgz /tmp/mongodb-database-tools-*`,
        { timeout: 120000 }
      );
    }
    send('MongoDB 工具已安装');
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

    // Fetch latest commit subject + short SHA for each branch
    const branchesWithSubject = await Promise.all(
      branches.map(async (b) => {
        try {
          const result = await shell.exec(
            'git log -1 --format=%h%n%s',
            { cwd: b.worktreePath, timeout: 5000 },
          );
          const lines = result.stdout.trim().split('\n');
          return { ...b, commitSha: lines[0] || '', subject: lines[1] || '' };
        } catch {
          return { ...b, commitSha: '', subject: '' };
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

    // Compute container capacity: (memoryGB - 1) * 2
    const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const maxContainers = Math.max(2, (totalMemGB - 1) * 2);
    let runningContainers = 0;
    for (const b of branches) {
      for (const svc of Object.values(b.services)) {
        if (svc.status === 'running' || svc.status === 'building' || svc.status === 'starting') {
          runningContainers++;
        }
      }
    }

    res.json({
      branches: branchesWithSubject,
      defaultBranch: state.defaultBranch,
      capacity: { maxContainers, runningContainers, totalMemGB },
      tabTitleEnabled: stateService.isTabTitleEnabled(),
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

      // Clear previous error state on new deploy
      entry.errorMessage = undefined;
      for (const svc of Object.values(entry.services)) {
        if (svc.errorMessage) svc.errorMessage = undefined;
      }
      entry.status = 'building';
      stateService.save();

      // Pull latest code
      logEvent({ step: 'pull', status: 'running', title: '正在拉取最新代码...', timestamp: new Date().toISOString() });
      const pullResult = await worktreeService.pull(entry.branch, entry.worktreePath);
      logEvent({ step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`, detail: pullResult as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });

      // Clear pinned commit — deploy always restores to branch HEAD
      if (entry.pinnedCommit) {
        entry.pinnedCommit = undefined;
        logEvent({ step: 'pull', status: 'done', title: '已取消固定提交，恢复到分支最新', timestamp: new Date().toISOString() });
      }
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
          // Resolve deploy mode overrides (e.g., dev → static)
          const effectiveProfile = resolveProfileWithMode(profile);
          const modeLabel = profile.activeDeployMode && profile.deployModes?.[profile.activeDeployMode]
            ? ` [${profile.deployModes[profile.activeDeployMode].label}]`
            : '';
          const serviceStartTime = Date.now();
          logEvent({
            step: `build-${profile.id}`,
            status: 'running',
            title: `正在构建 ${profile.name}${modeLabel}...`,
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
              title: `${effectiveProfile.name} 环境变量`,
              detail: {
                cdsVars: maskSecrets(cdsVars),
                profileEnvKeys: Object.keys(effectiveProfile.env ?? {}),
                deployMode: profile.activeDeployMode || 'default',
              },
              timestamp: new Date().toISOString(),
            });

            await containerService.runService(entry, effectiveProfile, svc, (chunk) => {
              sendSSE(res, 'log', { profileId: profile.id, chunk });
              for (const line of chunk.split('\n')) {
                if (line.trim()) {
                  logDeploy(id, line);
                  // Also store container output in operation log for historical viewing
                  opLog.events.push({
                    step: `log-${profile.id}`,
                    status: 'info',
                    title: line.trim(),
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }, mergedEnv);

            // Phase 1 passed (container alive). Set status based on startup signal.
            if (profile.startupSignal) {
              // Startup signal mode: watch container logs for a known string
              svc.status = 'starting';
              stateService.save();
              const elapsed = Date.now() - serviceStartTime;
              logEvent({
                step: `build-${profile.id}`,
                status: 'done',
                title: `${profile.name} 容器已启动，等待启动信号 :${svc.hostPort}`,
                detail: { elapsedMs: elapsed, startupSignal: profile.startupSignal },
                timestamp: new Date().toISOString(),
              });

              // Await startup signal — keep SSE stream open until ready
              const ready = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal, (chunk) => {
                for (const line of chunk.split('\n')) {
                  if (line.trim()) logDeploy(id, line);
                }
              });
              if (ready) {
                svc.status = 'running';
                logDeploy(id, `${profile.name} 启动成功 ✓`);
              } else {
                logDeploy(id, `${profile.name} 启动信号超时，服务可能仍在初始化`);
              }
              stateService.save();
            } else {
              svc.status = 'running';
              const elapsed = Date.now() - serviceStartTime;
              logEvent({
                step: `build-${profile.id}`,
                status: 'done',
                title: `${profile.name} 运行于 :${svc.hostPort}`,
                detail: { elapsedMs: elapsed },
                timestamp: new Date().toISOString(),
              });
            }
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
      const hasStarting = statuses.some(s => s === 'starting');
      const hasError = statuses.some(s => s === 'error');
      entry.status = hasRunning ? 'running' : hasStarting ? 'starting' : 'error';
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

      // Clear previous error state on new deploy
      entry.errorMessage = undefined;
      const existingSvc = entry.services[profile.id];
      if (existingSvc?.errorMessage) existingSvc.errorMessage = undefined;
      stateService.save();

      // Pull latest code
      logEvent({ step: 'pull', status: 'running', title: '正在拉取最新代码...', timestamp: new Date().toISOString() });
      const pullResult = await worktreeService.pull(entry.branch, entry.worktreePath);
      logEvent({ step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`, detail: pullResult as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });

      // Clear pinned commit — deploy always restores to branch HEAD
      if (entry.pinnedCommit) {
        entry.pinnedCommit = undefined;
        logEvent({ step: 'pull', status: 'done', title: '已取消固定提交，恢复到分支最新', timestamp: new Date().toISOString() });
        stateService.save();
      }

      // Resolve deploy mode overrides
      const effectiveProfile = resolveProfileWithMode(profile);
      const modeLabel = profile.activeDeployMode && profile.deployModes?.[profile.activeDeployMode]
        ? ` [${profile.deployModes[profile.activeDeployMode].label}]`
        : '';

      // Build & run the single profile
      logEvent({ step: `build-${profile.id}`, status: 'running', title: `正在构建 ${profile.name}${modeLabel}...`, timestamp: new Date().toISOString() });

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
        await containerService.runService(entry, effectiveProfile, svc, (chunk) => {
          sendSSE(res, 'log', { profileId: profile.id, chunk });
          for (const line of chunk.split('\n')) {
            if (line.trim()) logDeploy(id, line);
          }
        }, mergedEnv);

        if (profile.startupSignal) {
          // Startup signal mode: watch container logs for a known string
          svc.status = 'starting';
          stateService.save();
          logEvent({ step: `build-${profile.id}`, status: 'done', title: `${profile.name} 容器已启动，等待启动信号 :${svc.hostPort}`, timestamp: new Date().toISOString() });

          const signalReady = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal, (chunk) => {
            for (const line of chunk.split('\n')) {
              if (line.trim()) logDeploy(id, line);
            }
          });
          if (signalReady) {
            svc.status = 'running';
            logDeploy(id, `${profile.name} 启动成功 ✓`);
          } else {
            logDeploy(id, `${profile.name} 启动信号超时`);
          }
          stateService.save();
        } else {
          svc.status = 'running';
          logEvent({ step: `build-${profile.id}`, status: 'done', title: `${profile.name} 运行于 :${svc.hostPort}`, timestamp: new Date().toISOString() });
        }
      } catch (err) {
        svc.status = 'error';
        svc.errorMessage = (err as Error).message;
        logEvent({ step: `build-${profile.id}`, status: 'error', title: `${profile.name} 失败`, log: (err as Error).message, timestamp: new Date().toISOString() });
      }

      // Update overall status
      const statuses = Object.values(entry.services).map(s => s.status);
      const hasRunning = statuses.some(s => s === 'running');
      const hasStarting = statuses.some(s => s === 'starting');
      entry.status = hasRunning ? 'running' : hasStarting ? 'starting' : 'error';
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
      // Set stopping state immediately so frontend can show animation
      entry.status = 'stopping';
      for (const svc of Object.values(entry.services)) {
        if (svc.status === 'running' || svc.status === 'starting') {
          svc.status = 'stopping';
        }
      }
      stateService.save();

      // Actually stop containers
      for (const svc of Object.values(entry.services)) {
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        svc.status = 'stopped';
      }
      entry.status = 'idle';
      cleanupPreviewServer(id);
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

  // ── Preview port (port mode: per-branch proxy with path-prefix routing) ──

  router.post('/branches/:id/preview-port', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    if (entry.status !== 'running') {
      res.status(400).json({ error: '分支未运行' });
      return;
    }

    // Reuse existing preview port if still alive
    if (entry.previewPort && previewServers.has(id)) {
      res.json({ port: entry.previewPort });
      return;
    }

    // Allocate a new port
    const port = stateService.allocatePort(config.portStart);
    const profiles = stateService.getBuildProfiles();

    // Create a lightweight HTTP proxy that routes by path-prefix
    const server = http.createServer((proxyReq, proxyRes) => {
      const url = proxyReq.url || '/';

      // Detect which profile handles this path (reuse same logic as main proxy)
      const profileIds = Object.keys(entry.services);
      let targetProfileId: string | undefined;

      // Phase 1: explicit pathPrefixes
      const profilesWithRoutes = profiles
        .filter(p => p.pathPrefixes && p.pathPrefixes.length > 0 && profileIds.includes(p.id))
        .sort((a, b) => {
          const maxA = Math.max(...(a.pathPrefixes || []).map(s => s.length));
          const maxB = Math.max(...(b.pathPrefixes || []).map(s => s.length));
          return maxB - maxA;
        });
      for (const profile of profilesWithRoutes) {
        if (profile.pathPrefixes!.some(prefix => url.startsWith(prefix))) {
          targetProfileId = profile.id;
          break;
        }
      }
      // Phase 2: convention fallback
      if (!targetProfileId) {
        if (url.startsWith('/api/')) {
          targetProfileId = profileIds.find(pid => pid.includes('api') || pid.includes('backend'));
        }
        if (!targetProfileId) {
          targetProfileId = profileIds.find(pid => pid.includes('web') || pid.includes('frontend') || pid.includes('admin'))
            || profileIds[0];
        }
      }

      const svc = targetProfileId ? entry.services[targetProfileId] : undefined;
      if (!svc || svc.status !== 'running') {
        proxyRes.writeHead(502, { 'Content-Type': 'application/json' });
        proxyRes.end(JSON.stringify({ error: `Service "${targetProfileId}" not running` }));
        return;
      }

      const upstream = `http://127.0.0.1:${svc.hostPort}`;
      const upstreamUrl = new URL(upstream);
      const opts: http.RequestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: proxyReq.url,
        method: proxyReq.method,
        headers: { ...proxyReq.headers, host: `${upstreamUrl.hostname}:${upstreamUrl.port}` },
      };

      const upReq = http.request(opts, (upRes) => {
        proxyRes.writeHead(upRes.statusCode || 200, upRes.headers);
        upRes.pipe(proxyRes, { end: true });
      });
      upReq.on('error', () => {
        if (!proxyRes.headersSent) {
          proxyRes.writeHead(502, { 'Content-Type': 'application/json' });
          proxyRes.end(JSON.stringify({ error: 'Upstream connection failed' }));
        }
      });
      proxyReq.pipe(upReq, { end: true });
    });

    // WebSocket upgrade support (for Vite HMR)
    server.on('upgrade', (proxyReq, socket, head) => {
      const url = proxyReq.url || '/';
      const profileIds = Object.keys(entry.services);
      let targetProfileId: string | undefined;

      // Same path-prefix detection as above
      const profilesWithRoutes2 = profiles
        .filter(p => p.pathPrefixes && p.pathPrefixes.length > 0 && profileIds.includes(p.id))
        .sort((a, b) => {
          const maxA = Math.max(...(a.pathPrefixes || []).map(s => s.length));
          const maxB = Math.max(...(b.pathPrefixes || []).map(s => s.length));
          return maxB - maxA;
        });
      for (const profile of profilesWithRoutes2) {
        if (profile.pathPrefixes!.some(prefix => url.startsWith(prefix))) {
          targetProfileId = profile.id;
          break;
        }
      }
      if (!targetProfileId) {
        targetProfileId = profileIds.find(pid => pid.includes('web') || pid.includes('frontend') || pid.includes('admin'))
          || profileIds[0];
      }

      const svc = targetProfileId ? entry.services[targetProfileId] : undefined;
      if (!svc || svc.status !== 'running') { socket.destroy(); return; }

      const upstream = `http://127.0.0.1:${svc.hostPort}`;
      const upstreamUrl = new URL(upstream);
      const opts: http.RequestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: proxyReq.url,
        method: 'GET',
        headers: { ...proxyReq.headers, host: `${upstreamUrl.hostname}:${upstreamUrl.port}` },
      };

      const upReq = http.request(opts);
      upReq.on('upgrade', (upRes, upSocket, upHead) => {
        let raw = `HTTP/${upRes.httpVersion} ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          raw += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
        }
        raw += '\r\n';
        socket.write(raw);
        if (upHead.length > 0) socket.write(upHead);
        if (head.length > 0) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
      });
      upReq.on('error', () => socket.destroy());
      socket.on('error', () => upReq.destroy());
      upReq.end();
    });

    server.listen(port, '0.0.0.0', () => {
      entry.previewPort = port;
      previewServers.set(id, server);
      stateService.save();
      console.log(`[preview] Branch "${id}" preview proxy on port ${port}`);
      res.json({ port });
    });

    server.on('error', (err) => {
      console.error(`[preview] Failed to start preview proxy for "${id}":`, err);
      res.status(500).json({ error: `Preview port allocation failed: ${(err as Error).message}` });
    });
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
      const { isFavorite, notes, tags, isColorMarked } = req.body as { isFavorite?: boolean; notes?: string; tags?: string[]; isColorMarked?: boolean };
      stateService.updateBranchMeta(id, { isFavorite, notes, tags, isColorMarked });
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
      const running = await containerService.isRunning(svc.containerName);
      if (!running) {
        // Container may exist but stopped, or not exist at all – try docker inspect
        const inspectResult = await shell.exec(
          `docker inspect --format="{{.State.Status}}" ${svc.containerName}`,
        );
        if (inspectResult.exitCode !== 0) {
          res.json({ logs: `容器 ${svc.containerName} 不存在，可能已被清理。请重新部署。` });
          return;
        }
      }
      const logs = await containerService.getLogs(svc.containerName);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Container log stream (SSE) — replaces polling ──

  router.get('/branches/:id/container-logs-stream/:profileId', (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) { res.status(404).json({ error: `分支 "${id}" 不存在` }); return; }

    const svc = entry.services[profileId];
    if (!svc) { res.status(404).json({ error: '未找到服务' }); return; }

    initSSE(res);

    const ac = containerService.streamLogs(
      svc.containerName,
      (chunk) => sendSSE(res, 'log', { chunk }),
      () => { try { res.end(); } catch { /* already closed */ } },
    );

    // Client disconnect → stop docker logs -f
    req.on('close', () => ac.abort());
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

  // ── Container exec (run command inside container) ──

  router.post('/branches/:id/container-exec', async (req, res) => {
    const { id } = req.params;
    const { profileId, command } = req.body as { profileId?: string; command?: string };
    if (!command || typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: '请输入命令' });
      return;
    }

    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到运行中的服务' });
      return;
    }

    try {
      const result = await shell.exec(
        `docker exec ${svc.containerName} sh -c ${JSON.stringify(command)}`,
        { timeout: 30_000 },
      );
      res.json({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
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

  // ── Checkout specific commit (pin to historical commit) ──

  router.post('/branches/:id/checkout/:hash', async (req, res) => {
    const { id, hash } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    if (entry.status === 'building' || entry.status === 'starting') {
      res.status(409).json({ error: '分支正在构建/启动中，无法切换提交' });
      return;
    }

    try {
      // Validate the commit hash exists
      const verify = await shell.exec(
        `git cat-file -t ${hash}`,
        { cwd: entry.worktreePath, timeout: 5_000 },
      );
      if (verify.exitCode !== 0 || verify.stdout.trim() !== 'commit') {
        res.status(400).json({ error: `无效的提交: ${hash}` });
        return;
      }

      // Checkout the specific commit (detached HEAD)
      const result = await shell.exec(
        `git checkout ${hash}`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(combinedOutput(result));
      }

      // Get full short hash + subject for display
      const logResult = await shell.exec(
        'git log --oneline -1',
        { cwd: entry.worktreePath, timeout: 5_000 },
      );
      const [pinnedHash, ...subjectParts] = logResult.stdout.trim().split(' ');
      const pinnedSubject = subjectParts.join(' ');

      entry.pinnedCommit = pinnedHash || hash;
      stateService.save();

      res.json({
        message: `已切换到提交 ${pinnedHash}`,
        pinnedCommit: entry.pinnedCommit,
        subject: pinnedSubject,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Unpin commit (restore to branch HEAD) ──

  router.post('/branches/:id/unpin', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    try {
      const result = await shell.exec(
        `git checkout ${entry.branch}`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      if (result.exitCode !== 0) {
        // Worktree may not have local branch, reset to origin
        const reset = await shell.exec(
          `git checkout -B ${entry.branch} origin/${entry.branch}`,
          { cwd: entry.worktreePath, timeout: 10_000 },
        );
        if (reset.exitCode !== 0) throw new Error(combinedOutput(reset));
      }

      entry.pinnedCommit = undefined;
      stateService.save();
      res.json({ message: '已恢复到分支最新提交' });
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
    const profiles = stateService.getBuildProfiles().map(p => ({
      ...p,
      env: p.env ? maskSecrets(p.env) : p.env,
    }));
    res.json({ profiles });
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

  // ── Deploy mode switching ──

  router.put('/build-profiles/:id/deploy-mode', (req, res) => {
    try {
      const { id } = req.params;
      const { mode } = req.body as { mode?: string };
      const profile = stateService.getBuildProfile(id);
      if (!profile) {
        res.status(404).json({ error: `构建配置 "${id}" 不存在` });
        return;
      }
      // Validate mode exists (or null/empty to reset to default)
      if (mode && (!profile.deployModes || !profile.deployModes[mode])) {
        const available = profile.deployModes ? Object.keys(profile.deployModes).join(', ') : '无';
        res.status(400).json({ error: `部署模式 "${mode}" 不存在，可用: ${available}` });
        return;
      }
      stateService.updateBuildProfile(id, { activeDeployMode: mode || undefined });
      stateService.save();
      const label = mode && profile.deployModes?.[mode]?.label || 'default';
      res.json({ message: `已切换为 ${label}`, mode: mode || null });
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

  // Cache base path: /data/cds/{projectSlug}/cache — isolated per project (1 project = 1 github repo = 1 cache)
  const cacheBase = `/data/cds/${stateService.projectSlug}/cache`;

  /** Build command prefix and cache mount for a detected package manager */
  function nodeProfileCommands(pm: PackageManager) {
    switch (pm) {
      case 'pnpm':
        return {
          installPrefix: 'corepack enable && pnpm install --frozen-lockfile && ',
          runPrefix: 'corepack enable && pnpm exec ',
          cacheMounts: [{ hostPath: `${cacheBase}/pnpm`, containerPath: '/pnpm/store' }],
        };
      case 'yarn':
        return {
          installPrefix: 'corepack enable && yarn install --frozen-lockfile && ',
          runPrefix: 'corepack enable && yarn exec ',
          cacheMounts: [{ hostPath: `${cacheBase}/yarn`, containerPath: '/usr/local/share/.cache/yarn' }],
        };
      default:
        return {
          installPrefix: 'npm install && ',
          runPrefix: 'npx ',
          cacheMounts: [{ hostPath: `${cacheBase}/npm`, containerPath: '/root/.npm' }],
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
          { hostPath: `${cacheBase}/nuget`, containerPath: '/root/.nuget/packages' },
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
        // Wait for Vite to fully initialize (CSS/plugin pipeline ready) before routing traffic.
        // Without this, the proxy forwards requests while Vite is still starting, causing
        // CSS MIME type errors (Vite returns HTML fallback before transforms are ready).
        startupSignal: '➜  Network:',
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
    if (env.ROOT_DOMAINS) config.rootDomains = env.ROOT_DOMAINS.split(',').map(v => v.trim()).filter(Boolean);
    if (env.SWITCH_DOMAIN) config.switchDomain = env.SWITCH_DOMAIN;
    if (env.MAIN_DOMAIN) config.mainDomain = env.MAIN_DOMAIN;
    if (env.DASHBOARD_DOMAIN) config.dashboardDomain = env.DASHBOARD_DOMAIN;
    if (env.PREVIEW_DOMAIN) config.previewDomain = env.PREVIEW_DOMAIN;
    if (config.rootDomains?.length) {
      if (!env.MAIN_DOMAIN) config.mainDomain = config.rootDomains[0];
      if (!env.DASHBOARD_DOMAIN) config.dashboardDomain = config.rootDomains[0];
      if (!env.PREVIEW_DOMAIN) config.previewDomain = config.rootDomains[0];
    }
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

  // ── Tab title override ──

  router.get('/tab-title', (_req, res) => {
    res.json({ enabled: stateService.isTabTitleEnabled() });
  });

  router.put('/tab-title', (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是布尔值' });
      return;
    }
    stateService.setTabTitleEnabled(enabled);
    stateService.save();
    res.json({ message: enabled ? '标签页标题已开启' : '标签页标题已关闭', enabled });
  });

  // ── Preview mode (server-authoritative, shared across all users) ──

  router.get('/preview-mode', (_req, res) => {
    res.json({ mode: stateService.getPreviewMode() });
  });

  router.put('/preview-mode', (req, res) => {
    const { mode } = req.body as { mode?: string };
    if (mode !== 'simple' && mode !== 'port' && mode !== 'multi') {
      res.status(400).json({ error: "mode 必须是 'simple' | 'port' | 'multi'" });
      return;
    }
    stateService.setPreviewMode(mode);
    stateService.save();
    const labels: Record<string, string> = { simple: '简洁', port: '端口直连', multi: '子域名' };
    res.json({ message: `预览模式已切换为：${labels[mode]}`, mode });
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

    // CDS git commit short hash for version identification
    let cdsCommitHash = '';
    try {
      const result = await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot, timeout: 3000 });
      cdsCommitHash = result.stdout.trim();
    } catch { /* ignore */ }

    res.json({
      ...config,
      githubRepoUrl,
      cdsCommitHash,
      jwt: { ...config.jwt, secret: '***' },
      executorToken: config.executorToken ? '***' : undefined,
      sharedEnv: Object.fromEntries(
        Object.entries(config.sharedEnv).map(([k, v]) => [k, k.includes('PASSWORD') || k.includes('SECRET') ? '***' : v]),
      ),
      executors: Object.values(stateService.getExecutors()),
      previewMode: stateService.getPreviewMode(),
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

  // ── Cleanup orphan branches: remove local branches that no longer exist on remote ──

  router.post('/cleanup-orphans', async (_req, res) => {
    initSSE(res);
    try {
      // Step 1: fetch remote to get latest branch list
      sendSSE(res, 'step', { step: 'fetch', status: 'running', title: '正在拉取远程分支列表...' });
      await shell.exec(
        'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
        { cwd: config.repoRoot, timeout: 30_000 },
      );

      // Get all remote branch names
      const result = await shell.exec(
        'git for-each-ref --format="%(refname:lstrip=3)" refs/remotes/origin',
        { cwd: config.repoRoot },
      );
      const remoteBranches = new Set(
        result.stdout.trim().split('\n').filter(Boolean).filter(b => b !== 'HEAD'),
      );
      sendSSE(res, 'step', { step: 'fetch', status: 'done', title: `远程共 ${remoteBranches.size} 个分支` });

      // Step 2: identify orphans (local CDS branches whose git branch no longer exists on remote)
      const state = stateService.getState();
      const allLocal = Object.values(state.branches);
      const orphans = allLocal.filter(b => !remoteBranches.has(b.branch));

      if (orphans.length === 0) {
        sendSSE(res, 'complete', { message: '没有发现孤儿分支，一切正常', orphanCount: 0 });
        res.end();
        return;
      }

      sendSSE(res, 'step', { step: 'scan', status: 'info', title: `发现 ${orphans.length} 个孤儿分支`, detail: { orphans: orphans.map(b => ({ id: b.id, branch: b.branch })) } });

      // Step 3: stop containers, remove worktrees, delete from state
      let cleaned = 0;
      for (const entry of orphans) {
        sendSSE(res, 'step', { step: `cleanup-${entry.id}`, status: 'running', title: `正在清理 ${entry.branch}...` });

        // Stop all containers
        for (const svc of Object.values(entry.services)) {
          try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        }
        // Remove worktree
        try { await worktreeService.remove(entry.worktreePath); } catch { /* ok */ }
        // Remove from state
        stateService.removeLogs(entry.id);
        stateService.removeBranch(entry.id);
        cleaned++;

        sendSSE(res, 'step', { step: `cleanup-${entry.id}`, status: 'done', title: `已清理 ${entry.branch}` });
      }

      stateService.save();
      sendSSE(res, 'complete', { message: `已清理 ${cleaned} 个孤儿分支`, orphanCount: cleaned });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Prune stale local git branches not in CDS deployment list ──

  router.post('/prune-stale-branches', async (_req, res) => {
    initSSE(res);
    try {
      // Step 1: get current branch + CDS deployment branches
      const currentResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: config.repoRoot });
      const currentBranch = currentResult.stdout.trim();

      const state = stateService.getState();
      const deployedBranches = new Set(
        Object.values(state.branches).map(b => b.branch),
      );
      // Always keep current branch and common defaults
      const protectedBranches = new Set([currentBranch, 'main', 'master', 'develop', 'dev']);

      sendSSE(res, 'step', { step: 'scan', status: 'running', title: '正在扫描本地分支...' });

      // Step 2: list all local branches
      const localResult = await shell.exec('git branch --format="%(refname:short)"', { cwd: config.repoRoot });
      const localBranches = localResult.stdout.trim().split('\n').filter(Boolean);

      // Step 3: identify stale branches (not deployed, not protected)
      const staleBranches = localBranches.filter(b =>
        !deployedBranches.has(b) && !protectedBranches.has(b),
      );

      sendSSE(res, 'step', {
        step: 'scan', status: 'done',
        title: `本地 ${localBranches.length} 个分支，已部署 ${deployedBranches.size} 个，保护 ${protectedBranches.size} 个`,
      });

      if (staleBranches.length === 0) {
        sendSSE(res, 'complete', { message: '没有需要清理的分支', pruneCount: 0 });
        res.end();
        return;
      }

      sendSSE(res, 'step', {
        step: 'list', status: 'info',
        title: `发现 ${staleBranches.length} 个非列表分支待清理`,
      });

      // Step 4: delete each stale branch
      let pruned = 0;
      for (const branch of staleBranches) {
        sendSSE(res, 'step', { step: `del-${branch}`, status: 'running', title: `正在删除 ${branch}...` });
        try {
          await shell.exec(`git branch -D "${branch}"`, { cwd: config.repoRoot });
          pruned++;
          sendSSE(res, 'step', { step: `del-${branch}`, status: 'done', title: `已删除 ${branch}` });
        } catch (err) {
          sendSSE(res, 'step', { step: `del-${branch}`, status: 'error', title: `删除失败 ${branch}: ${(err as Error).message}` });
        }
      }

      sendSSE(res, 'complete', { message: `已清理 ${pruned} 个非列表分支`, pruneCount: pruned });
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

  // GET /api/export-skill — export cds-project-scan skill as tar.gz
  // Contains only skill files and README — no config/cds-compose.yml
  router.get('/export-skill', (_req, res) => {
    try {
      const skillDir = path.join(config.repoRoot, '.claude', 'skills', 'cds-project-scan');
      if (!fs.existsSync(skillDir)) {
        res.status(404).json({ error: '未找到 cds-project-scan 技能目录' });
        return;
      }

      // Build pack in a temp directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const packName = `cds-deployment-skill-${timestamp}`;
      const tmpDir = path.join(config.repoRoot, '.cds', 'tmp');
      const packDir = path.join(tmpDir, packName);

      // Clean & create temp dirs
      fs.mkdirSync(path.join(packDir, 'skills', 'reference'), { recursive: true });

      // Copy skill files
      const skillMain = path.join(skillDir, 'SKILL.md');
      if (fs.existsSync(skillMain)) {
        fs.copyFileSync(skillMain, path.join(packDir, 'skills', 'SKILL.md'));
      }
      const refDir = path.join(skillDir, 'reference');
      if (fs.existsSync(refDir)) {
        for (const f of fs.readdirSync(refDir)) {
          fs.copyFileSync(path.join(refDir, f), path.join(packDir, 'skills', 'reference', f));
        }
      }

      // Write README
      fs.writeFileSync(path.join(packDir, 'README.md'), `# CDS 部署技能包

本压缩包包含 CDS (Cloud Dev Space) 项目扫描技能文档。

## 包含内容

| 目录 | 内容 | 用途 |
|------|------|------|
| \`skills/\` | CDS 扫描技能文档 | 了解扫描规则和配置生成逻辑 |

## 使用方式

1. 将 \`skills/\` 目录复制到目标项目的 \`.claude/skills/cds-project-scan/\`
2. 在 Claude Code 中使用 \`/cds-scan\` 触发扫描
3. 扫描生成的 CDS Compose YAML 可在 CDS Dashboard 中一键导入
`, 'utf-8');

      // Create tar.gz using tar command (available on all Linux)
      const tarName = `${packName}.tar.gz`;
      execSync(`cd "${tmpDir}" && tar -czf "${tarName}" "${packName}/"`, { stdio: 'pipe' });

      // Clean up pack dir
      fs.rmSync(packDir, { recursive: true, force: true });

      // Send tar.gz
      const tarPath = path.join(tmpDir, tarName);
      const stat = fs.statSync(tarPath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${tarName}"`);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(tarPath);
      stream.pipe(res);
      stream.on('end', () => {
        fs.unlink(tarPath, () => {});
      });
    } catch (e) {
      console.error('export-skill error:', e);
      if (!res.headersSent) {
        res.status(500).json({ error: '导出失败: ' + (e as Error).message });
      }
    }
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

  // ── Self-update: switch CDS's own branch, pull, and restart ──

  // ── Data Migration ──

  /** Resolve 'local' MongoDB connection to actual host:port from infra */
  function resolveMongoConn(conn: MongoConnectionConfig): MongoConnectionConfig {
    if (conn.type === 'local') {
      const mongoInfra = stateService.getInfraServices().find(s => s.id === 'mongodb');
      if (!mongoInfra) throw new Error('本机 MongoDB 未在 CDS 基础设施中注册');
      const dockerHost = stateService.getCdsEnvVars()['CDS_HOST'] || '172.17.0.1';
      return { ...conn, host: dockerHost, port: mongoInfra.hostPort };
    }
    return conn;
  }

  /** Build mongosh auth args */
  function mongoAuthArgs(conn: MongoConnectionConfig): string {
    let args = '';
    if (conn.username) args += ` -u ${conn.username}`;
    if (conn.password) args += ` -p ${conn.password}`;
    if (conn.authDatabase) args += ` --authenticationDatabase ${conn.authDatabase}`;
    return args;
  }

  // GET /api/data-migrations — list all migration tasks
  router.get('/data-migrations', (_req, res) => {
    res.json(stateService.getDataMigrations());
  });

  // POST /api/data-migrations — create a new migration task
  router.post('/data-migrations', (req, res) => {
    const { name, dbType, source, target, collections } = req.body as {
      name: string;
      dbType: 'mongodb';
      source: MongoConnectionConfig;
      target: MongoConnectionConfig;
      collections?: string[];
    };
    if (!name || !dbType || !source || !target) {
      res.status(400).json({ error: '缺少必填字段: name, dbType, source, target' });
      return;
    }
    const id = `mig-${Date.now().toString(36)}`;
    const migration: DataMigration = {
      id,
      name,
      dbType,
      source,
      target,
      collections: collections?.length ? collections : undefined,
      status: 'pending',
      progress: 0,
      createdAt: new Date().toISOString(),
    };
    stateService.addDataMigration(migration);
    stateService.save();
    res.json(migration);
  });

  // DELETE /api/data-migrations/:id — delete a migration task
  router.delete('/data-migrations/:id', (req, res) => {
    const { id } = req.params;
    const migration = stateService.getDataMigration(id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    if (migration.status === 'running') { res.status(400).json({ error: '任务正在运行中，无法删除' }); return; }
    stateService.removeDataMigration(id);
    stateService.save();
    res.json({ message: '已删除' });
  });

  // POST /api/data-migrations/check-tools — check if mongodump/mongorestore are available, auto-install if not
  router.post('/data-migrations/check-tools', async (_req, res) => {
    try {
      // Check if mongodump exists
      const checkResult = await shell.exec('which mongodump 2>/dev/null || which /usr/bin/mongodump 2>/dev/null || echo "NOT_FOUND"');
      const hasTool = !checkResult.stdout.includes('NOT_FOUND');
      if (hasTool) {
        // Get version
        const verResult = await shell.exec('mongodump --version 2>&1 | head -1');
        res.json({ installed: true, version: verResult.stdout.trim() });
        return;
      }
      // Auto-install mongodb-database-tools
      res.json({ installed: false, message: '正在安装 mongodb-database-tools...' });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/install-tools — install mongodump/mongorestore
  router.post('/data-migrations/install-tools', async (_req, res) => {
    initSSE(res);
    const send = (msg: string) => sendSSE(res, 'progress', { message: msg });
    try {
      send('检测操作系统...');
      const osInfo = await shell.exec('cat /etc/os-release 2>/dev/null || echo "unknown"');
      const isDebian = osInfo.stdout.includes('debian') || osInfo.stdout.includes('ubuntu');
      const isAlpine = osInfo.stdout.includes('alpine');
      const isRhel = osInfo.stdout.includes('rhel') || osInfo.stdout.includes('centos') || osInfo.stdout.includes('fedora');

      if (isDebian) {
        send('检测到 Debian/Ubuntu，正在安装 mongodb-database-tools...');
        // Try apt-get first
        const aptResult = await shell.exec(
          'apt-get update -qq 2>/dev/null && apt-get install -y -qq mongodb-database-tools 2>&1 || echo "APT_FAILED"',
          { timeout: 120000 }
        );
        if (aptResult.stdout.includes('APT_FAILED')) {
          // Fallback: download from MongoDB directly
          send('apt 安装失败，尝试直接下载二进制文件...');
          await installMongoToolsBinary(shell, send);
        } else {
          send('apt 安装成功');
        }
      } else if (isAlpine) {
        send('检测到 Alpine，直接下载二进制文件...');
        await installMongoToolsBinary(shell, send);
      } else if (isRhel) {
        send('检测到 RHEL/CentOS，正在安装...');
        const yumResult = await shell.exec(
          'yum install -y mongodb-database-tools 2>&1 || dnf install -y mongodb-database-tools 2>&1 || echo "YUM_FAILED"',
          { timeout: 120000 }
        );
        if (yumResult.stdout.includes('YUM_FAILED')) {
          send('yum 安装失败，尝试直接下载二进制文件...');
          await installMongoToolsBinary(shell, send);
        }
      } else {
        send('未知系统，尝试直接下载二进制文件...');
        await installMongoToolsBinary(shell, send);
      }

      // Verify installation
      const verifyResult = await shell.exec('mongodump --version 2>&1 | head -1');
      if (verifyResult.exitCode === 0 && verifyResult.stdout.trim()) {
        sendSSE(res, 'done', { installed: true, version: verifyResult.stdout.trim() });
      } else {
        sendSSE(res, 'error', { message: '安装后验证失败，请手动安装 mongodb-database-tools' });
      }
      res.end();
    } catch (e) {
      sendSSE(res, 'error', { message: (e as Error).message });
      res.end();
    }
  });

  // POST /api/data-migrations/:id/execute — execute a migration task (SSE stream)
  router.post('/data-migrations/:id/execute', async (req, res) => {
    const { id } = req.params;
    const migration = stateService.getDataMigration(id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    if (migration.status === 'running') { res.status(400).json({ error: '任务已在运行中' }); return; }

    initSSE(res);
    const send = (progress: number, message: string) => {
      sendSSE(res, 'progress', { progress, message });
      stateService.updateDataMigration(id, { progress, progressMessage: message });
      stateService.save();
    };

    // Mark as running
    stateService.updateDataMigration(id, { status: 'running', startedAt: new Date().toISOString(), progress: 0, errorMessage: undefined, log: '' });
    stateService.save();

    let logOutput = '';
    const appendLog = (line: string) => { logOutput += line + '\n'; };

    try {
      const src = resolveMongoConn(migration.source);
      const tgt = resolveMongoConn(migration.target);

      send(5, '正在检查迁移工具...');
      const toolCheck = await shell.exec('which mongodump && which mongorestore');
      if (toolCheck.exitCode !== 0) {
        throw new Error('mongodump/mongorestore 未安装。请先在迁移面板点击"初始化工具"');
      }

      // Build SSH tunnel if needed
      let srcHost = src.host;
      let srcPort = src.port;
      let tgtHost = tgt.host;
      let tgtPort = tgt.port;

      if (src.sshTunnel?.enabled) {
        send(10, '正在建立源数据库 SSH 隧道...');
        const localPort = 27100 + Math.floor(Math.random() * 100);
        const tunnel = src.sshTunnel;
        const keyArg = tunnel.privateKeyPath ? `-i ${tunnel.privateKeyPath}` : '';
        const sshCmd = `ssh -f -N -L ${localPort}:${src.host}:${src.port} ${keyArg} -p ${tunnel.port} ${tunnel.username}@${tunnel.host} -o StrictHostKeyChecking=no -o ConnectTimeout=10`;
        const sshResult = await shell.exec(sshCmd, { timeout: 15000 });
        if (sshResult.exitCode !== 0) throw new Error(`SSH 隧道建立失败: ${sshResult.stderr}`);
        srcHost = '127.0.0.1';
        srcPort = localPort;
        appendLog(`SSH tunnel (source): localhost:${localPort} -> ${src.host}:${src.port} via ${tunnel.host}`);
      }

      if (tgt.sshTunnel?.enabled) {
        send(15, '正在建立目标数据库 SSH 隧道...');
        const localPort = 27200 + Math.floor(Math.random() * 100);
        const tunnel = tgt.sshTunnel;
        const keyArg = tunnel.privateKeyPath ? `-i ${tunnel.privateKeyPath}` : '';
        const sshCmd = `ssh -f -N -L ${localPort}:${tgt.host}:${tgt.port} ${keyArg} -p ${tunnel.port} ${tunnel.username}@${tunnel.host} -o StrictHostKeyChecking=no -o ConnectTimeout=10`;
        const sshResult = await shell.exec(sshCmd, { timeout: 15000 });
        if (sshResult.exitCode !== 0) throw new Error(`SSH 隧道建立失败: ${sshResult.stderr}`);
        tgtHost = '127.0.0.1';
        tgtPort = localPort;
        appendLog(`SSH tunnel (target): localhost:${localPort} -> ${tgt.host}:${tgt.port} via ${tunnel.host}`);
      }

      // Prepare dump directory
      const dumpDir = `/tmp/cds-migration-${id}`;
      await shell.exec(`rm -rf ${dumpDir} && mkdir -p ${dumpDir}`);

      // Build base auth args
      let srcAuth = '';
      if (src.username) srcAuth += ` --username=${src.username}`;
      if (src.password) srcAuth += ` --password=${src.password}`;
      if (src.authDatabase) srcAuth += ` --authenticationDatabase=${src.authDatabase}`;
      let tgtAuth = '';
      if (tgt.username) tgtAuth += ` --username=${tgt.username}`;
      if (tgt.password) tgtAuth += ` --password=${tgt.password}`;
      if (tgt.authDatabase) tgtAuth += ` --authenticationDatabase=${tgt.authDatabase}`;

      const cols = migration.collections?.length ? migration.collections : null;
      const totalSteps = cols ? cols.length * 2 : 2; // dump + restore per collection (or 1 each for full)
      let currentStep = 0;
      const stepProgress = (step: number) => Math.round(20 + (step / totalSteps) * 70); // 20% → 90%

      if (cols) {
        // ── Per-collection migration ──
        appendLog(`Per-collection migration: ${cols.length} collections`);
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          // Dump
          send(stepProgress(currentStep), `正在导出 ${col} (${i + 1}/${cols.length})...`);
          let dumpCmd = `mongodump --host=${srcHost} --port=${srcPort}${srcAuth}`;
          if (src.database) dumpCmd += ` --db=${src.database}`;
          dumpCmd += ` --collection=${col} --out=${dumpDir}`;
          appendLog(`dump: ${col}`);
          const dumpResult = await shell.exec(dumpCmd, { timeout: 600000, onData: (c) => appendLog(c) });
          if (dumpResult.exitCode !== 0) throw new Error(`mongodump ${col} 失败: ${dumpResult.stderr || dumpResult.stdout}`);
          currentStep++;

          // Restore
          send(stepProgress(currentStep), `正在导入 ${col} (${i + 1}/${cols.length})...`);
          const restorePath = src.database ? `${dumpDir}/${src.database}` : dumpDir;
          let restoreCmd = `mongorestore --host=${tgtHost} --port=${tgtPort}${tgtAuth}`;
          if (tgt.database) restoreCmd += ` --db=${tgt.database}`;
          restoreCmd += ` --collection=${col} --drop ${restorePath}/${col}.bson`;
          appendLog(`restore: ${col}`);
          const restoreResult = await shell.exec(restoreCmd, { timeout: 600000, onData: (c) => appendLog(c) });
          if (restoreResult.exitCode !== 0) throw new Error(`mongorestore ${col} 失败: ${restoreResult.stderr || restoreResult.stdout}`);
          currentStep++;
        }
      } else {
        // ── Full database/instance migration ──
        send(20, '正在导出源数据库...');
        let dumpCmd = `mongodump --host=${srcHost} --port=${srcPort}${srcAuth}`;
        if (src.database) dumpCmd += ` --db=${src.database}`;
        dumpCmd += ` --out=${dumpDir}`;
        appendLog(`dump: ${src.database || '(all dbs)'}`);

        const dumpResult = await shell.exec(dumpCmd, {
          timeout: 600000,
          onData: (chunk) => { appendLog(chunk); if (chunk.includes('done dumping')) send(50, '导出完成，准备导入...'); }
        });
        if (dumpResult.exitCode !== 0) throw new Error(`mongodump 失败: ${dumpResult.stderr || dumpResult.stdout}`);

        send(55, '正在导入到目标数据库...');
        const restorePath = src.database ? `${dumpDir}/${src.database}` : dumpDir;
        let restoreCmd = `mongorestore --host=${tgtHost} --port=${tgtPort}${tgtAuth}`;
        if (tgt.database) restoreCmd += ` --db=${tgt.database}`;
        restoreCmd += ` --drop ${restorePath}`;
        appendLog(`restore: ${tgt.database || '(all dbs)'}`);

        const restoreResult = await shell.exec(restoreCmd, {
          timeout: 600000,
          onData: (chunk) => { appendLog(chunk); if (chunk.includes('done')) send(85, '正在完成导入...'); }
        });
        if (restoreResult.exitCode !== 0) throw new Error(`mongorestore 失败: ${restoreResult.stderr || restoreResult.stdout}`);
      }

      // Cleanup dump files
      send(95, '正在清理临时文件...');
      await shell.exec(`rm -rf ${dumpDir}`);

      // Kill SSH tunnels if any
      if (src.sshTunnel?.enabled || tgt.sshTunnel?.enabled) {
        await shell.exec('pkill -f "ssh -f -N -L 271"').catch(() => {});
      }

      send(100, '迁移完成！');
      stateService.updateDataMigration(id, {
        status: 'completed',
        progress: 100,
        progressMessage: '迁移完成',
        finishedAt: new Date().toISOString(),
        log: logOutput,
      });
      stateService.save();
      sendSSE(res, 'done', { message: '迁移完成' });
      res.end();

    } catch (e) {
      const errMsg = (e as Error).message;
      appendLog(`ERROR: ${errMsg}`);
      stateService.updateDataMigration(id, {
        status: 'failed',
        errorMessage: errMsg,
        finishedAt: new Date().toISOString(),
        log: logOutput,
      });
      stateService.save();
      sendSSE(res, 'error', { message: errMsg });
      res.end();

      // Cleanup
      await shell.exec(`rm -rf /tmp/cds-migration-${id}`).catch(() => {});
      await shell.exec('pkill -f "ssh -f -N -L 271"').catch(() => {});
    }
  });

  // POST /api/data-migrations/:id/test-connection — test a MongoDB connection
  router.post('/data-migrations/test-connection', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }

    try {
      let host = connection.host;
      let port = connection.port;

      // Resolve local
      if (connection.type === 'local') {
        const mongoInfra = stateService.getInfraServices().find(s => s.id === 'mongodb');
        if (!mongoInfra) { res.json({ success: false, error: '本机 MongoDB 未注册' }); return; }
        host = stateService.getCdsEnvVars()['CDS_HOST'] || '172.17.0.1';
        port = mongoInfra.hostPort;
      }

      // Build mongosh/mongo test command
      let testCmd = `mongosh --host ${host} --port ${port} --eval "db.adminCommand({ping:1})" --quiet`;
      if (connection.username) testCmd = `mongosh --host ${host} --port ${port} -u ${connection.username} -p ${connection.password || ''} --authenticationDatabase ${connection.authDatabase || 'admin'} --eval "db.adminCommand({ping:1})" --quiet`;

      const result = await shell.exec(testCmd, { timeout: 10000 });
      if (result.exitCode === 0) {
        // Get database list
        let listCmd = `mongosh --host ${host} --port ${port} --eval "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))" --quiet`;
        if (connection.username) listCmd = `mongosh --host ${host} --port ${port} -u ${connection.username} -p ${connection.password || ''} --authenticationDatabase ${connection.authDatabase || 'admin'} --eval "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))" --quiet`;

        const listResult = await shell.exec(listCmd, { timeout: 10000 });
        let databases: unknown[] = [];
        try { databases = JSON.parse(listResult.stdout.trim()); } catch { /* ok */ }
        res.json({ success: true, databases });
      } else {
        // Fallback: try basic TCP connectivity
        const tcpResult = await shell.exec(`timeout 5 bash -c "echo > /dev/tcp/${host}/${port}" 2>&1 || echo "TCP_FAILED"`);
        if (tcpResult.stdout.includes('TCP_FAILED')) {
          res.json({ success: false, error: `无法连接到 ${host}:${port}` });
        } else {
          res.json({ success: false, error: `连接成功但认证失败: ${result.stderr || result.stdout}` });
        }
      }
    } catch (e) {
      res.json({ success: false, error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/list-databases — list databases with sizes
  router.post('/data-migrations/list-databases', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }
    try {
      const conn = resolveMongoConn(connection);
      const evalScript = `JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))`;
      const cmd = `mongosh --host ${conn.host} --port ${conn.port}${mongoAuthArgs(conn)} --eval "${evalScript}" --quiet 2>/dev/null`;
      const result = await shell.exec(cmd, { timeout: 15000 });
      let databases: Array<{ name: string; sizeOnDisk: number }> = [];
      if (result.exitCode === 0) {
        const lines = result.stdout.trim().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[')) { try { databases = JSON.parse(trimmed); break; } catch { /* */ } }
        }
      }
      // Filter out system databases for cleaner UX
      const userDbs = databases.filter(d => !['admin', 'config', 'local'].includes(d.name));
      const sysDbs = databases.filter(d => ['admin', 'config', 'local'].includes(d.name));
      res.json({ databases: [...userDbs, ...sysDbs] });
    } catch (e) {
      res.json({ databases: [], error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/list-collections — list collections in a database with doc counts
  router.post('/data-migrations/list-collections', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }
    if (!connection.database) { res.status(400).json({ error: '请指定数据库名' }); return; }

    try {
      const conn = resolveMongoConn(connection);
      const db = conn.database!;
      const evalScript = `JSON.stringify(db.getSiblingDB('${db}').getCollectionInfos({type:'collection'}).map(c=>({name:c.name,count:db.getSiblingDB('${db}').getCollection(c.name).estimatedDocumentCount()})))`;
      let cmd = `mongosh --host ${conn.host} --port ${conn.port}${mongoAuthArgs(conn)} --eval "${evalScript}" --quiet 2>/dev/null`;

      const result = await shell.exec(cmd, { timeout: 15000 });
      if (result.exitCode !== 0) {
        res.json({ collections: [], error: result.stderr || 'mongosh 执行失败' });
        return;
      }
      // Parse JSON — mongosh may output extra lines, find the JSON array line
      const lines = result.stdout.trim().split('\n');
      let collections: Array<{ name: string; count: number }> = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          try { collections = JSON.parse(trimmed); break; } catch { /* try next line */ }
        }
      }
      collections.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ collections });
    } catch (e) {
      res.json({ collections: [], error: (e as Error).message });
    }
  });

  // GET /api/data-migrations/:id/log — get migration log
  router.get('/data-migrations/:id/log', (req, res) => {
    const migration = stateService.getDataMigration(req.params.id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    res.json({ log: migration.log || '' });
  });

  // GET /api/self-branches — list git branches of the CDS repo itself
  router.get('/self-branches', async (_req, res) => {
    try {
      const cdsDir = path.join(config.repoRoot, 'cds');
      // Get current branch
      const currentResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: config.repoRoot });
      const currentBranch = currentResult.stdout.trim();

      // Fetch latest (ignore errors if offline)
      await shell.exec('git fetch --all --prune', { cwd: config.repoRoot }).catch(() => {});

      // List all branches (local + remote)
      const localResult = await shell.exec('git branch --format="%(refname:short)"', { cwd: config.repoRoot });
      const localBranches = localResult.stdout.trim().split('\n').filter(Boolean);

      const remoteResult = await shell.exec('git branch -r --format="%(refname:short)"', { cwd: config.repoRoot });
      const remoteBranches = remoteResult.stdout.trim().split('\n')
        .filter(Boolean)
        .filter(b => !b.includes('HEAD'))
        .map(b => b.replace(/^origin\//, ''));

      // Merge and deduplicate
      const allBranches = [...new Set([...localBranches, ...remoteBranches])].sort();

      // Get current commit short hash
      let commitHash = '';
      try {
        const hashResult = await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot });
        commitHash = hashResult.stdout.trim();
      } catch { /* ignore */ }

      res.json({ current: currentBranch, commitHash, branches: allBranches });
    } catch (e) {
      res.status(500).json({ error: '获取分支列表失败: ' + (e as Error).message });
    }
  });

  // POST /api/self-update — switch branch + pull + restart CDS (SSE progress)
  router.post('/self-update', async (req, res) => {
    const { branch } = req.body as { branch?: string };

    initSSE(res);
    const send = (step: string, status: string, title: string) => {
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString() });
    };

    try {
      const repoRoot = config.repoRoot;

      // Step 1: fetch latest
      send('fetch', 'running', '正在拉取远程更新...');
      await shell.exec('git fetch --all --prune', { cwd: repoRoot });
      send('fetch', 'done', '远程更新已拉取');

      // Step 2: switch branch if specified
      if (branch) {
        send('checkout', 'running', `正在切换到分支 ${branch}...`);
        // Use -f to discard tracked-file changes (safe: untracked files like .cds/state.json are untouched)
        const checkoutResult = await shell.exec(`git checkout -f ${branch}`, { cwd: repoRoot });
        if (checkoutResult.exitCode !== 0) {
          // Try creating tracking branch from remote
          const fallbackResult = await shell.exec(`git checkout -f -b ${branch} origin/${branch}`, { cwd: repoRoot });
          if (fallbackResult.exitCode !== 0) {
            const errMsg = (fallbackResult.stderr || fallbackResult.stdout || '未知错误').trim();
            send('checkout', 'error', `切换分支失败: ${errMsg}`);
            sendSSE(res, 'error', { message: `无法切换到 ${branch}: ${errMsg}` });
            res.end();
            return;
          }
        }
        // Verify the checkout actually worked
        const verifyResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
        const actualBranch = verifyResult.stdout.trim();
        if (actualBranch !== branch) {
          send('checkout', 'error', `切换失败: 期望 ${branch}，实际仍在 ${actualBranch}`);
          sendSSE(res, 'error', { message: `分支切换未生效: 仍在 ${actualBranch}` });
          res.end();
          return;
        }
        send('checkout', 'done', `已切换到 ${branch}`);
      }

      // Step 3: pull latest
      send('pull', 'running', '正在拉取最新代码...');
      const pullResult = await shell.exec('git pull', { cwd: repoRoot });
      const pullOutput = pullResult.stdout.trim();
      send('pull', 'done', pullOutput.includes('Already up to date') ? '代码已是最新' : '代码已更新');

      // Step 4: restart CDS via detached process
      send('restart', 'running', '正在重启 CDS...');
      sendSSE(res, 'done', { message: 'CDS 即将重启，页面将在几秒后自动刷新...' });
      res.end();

      // Spawn detached restart script, then exit ourselves.
      // Previous approach relied on exec_cds.sh killing the old process (us),
      // but macOS process group kill behaves differently from Linux.
      // Self-exit is more reliable: we release the port, then exec_cds.sh
      // finds it free and starts the new process cleanly.
      setTimeout(() => {
        const cdsDir = path.join(repoRoot, 'cds');
        const child = spawn('bash', ['./exec_cds.sh', '--background'], {
          cwd: cdsDir,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env },
        });
        child.unref();
        // Exit ourselves after a brief delay to ensure the child is running
        setTimeout(() => process.exit(0), 1000);
      }, 500);
    } catch (err) {
      send('error', 'error', `更新失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
      res.end();
    }
  });

  return router;
}
