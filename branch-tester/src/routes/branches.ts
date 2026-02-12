import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { StateService } from '../services/state.js';
import type { WorktreeService } from '../services/worktree.js';
import type { ContainerService } from '../services/container.js';
import type { SwitcherService } from '../services/switcher.js';
import type { BuilderService } from '../services/builder.js';
import type { BtConfig, IShellExecutor } from '../types.js';
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

  // GET /branches — list all
  router.get('/branches', (_req, res) => {
    const state = stateService.getState();
    res.json({
      branches: state.branches,
      activeBranchId: state.activeBranchId,
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

      if (entry.status === 'running') {
        await containerService.stop(entry.containerName);
      }

      try { await worktreeService.remove(entry.worktreePath); } catch { /* may not exist */ }
      try { await containerService.removeImage(entry.imageName); } catch { /* may not exist */ }

      stateService.removeBranch(id);
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

      const headInfo = await worktreeService.pull(entry.branch, entry.worktreePath);
      res.json({ success: true, head: headInfo });
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

  // Helper: perform the activate sequence (sync + nginx switch)
  async function doActivate(id: string): Promise<void> {
    const entry = stateService.getBranch(id)!;

    switcherService.backup();

    const buildsDir = path.join(config.repoRoot, config.deployDir, 'web', 'builds', id);
    const distDir = path.join(config.repoRoot, config.deployDir, 'web', 'dist');
    await switcherService.syncStaticFiles(buildsDir, distDir);

    const newConf = switcherService.generateConfig(entry.containerName);
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

      const running = await containerService.isRunning(entry.containerName);
      if (!running) {
        res.status(400).json({
          error: `Branch "${id}" is not running. Start it first.`,
        });
        return;
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

    const send = (data: Record<string, unknown>) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    const tail = (s: string, n = 3000) =>
      s.length > n ? `...[truncated]\n${s.slice(-n)}` : s;

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
        stateService.save();

        // API image
        send({ step: 'build_api', status: 'running', title: '构建 API 镜像' });
        const apiLog = await builderService.buildApiImage(entry.worktreePath, entry.imageName);
        send({ step: 'build_api', status: 'done', title: '构建 API 镜像', log: tail(apiLog) });

        // Admin static
        send({ step: 'build_admin', status: 'running', title: '构建前端静态文件' });
        const adminLog = await builderService.buildAdminStatic(entry.worktreePath, buildsDir);
        send({ step: 'build_admin', status: 'done', title: '构建前端静态文件', log: tail(adminLog) });

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
      const nginxConf = switcherService.generateConfig(entry.containerName);
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
    } catch (err) {
      const e = stateService.getBranch(id);
      if (e && e.status === 'building') {
        stateService.updateStatus(id, 'error');
        e.buildLog = (err as Error).message;
        stateService.save();
      }
      send({ step: 'error', status: 'error', title: '部署失败', log: (err as Error).message });
    } finally {
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

      const newConf = switcherService.generateConfig(entry.containerName);
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

  return router;
}
