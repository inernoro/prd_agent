import { Router } from 'express';
import path from 'node:path';
import { StateService } from '../services/state.js';
import type { WorktreeService } from '../services/worktree.js';
import type { ContainerService } from '../services/container.js';
import type { SwitcherService } from '../services/switcher.js';
import type { BuilderService } from '../services/builder.js';
import type { BtConfig, IShellExecutor } from '../types.js';

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

  // GET /remote-branches — list remote branches available to add
  router.get('/remote-branches', async (_req, res) => {
    try {
      // Use git ls-remote to query all remote branches directly.
      // This works regardless of shallow clone or --single-branch refspec,
      // unlike "git branch -r" which only shows locally-tracked refs.
      const result = await shell.exec(
        'GIT_TERMINAL_PROMPT=0 git ls-remote --heads origin',
        { cwd: config.repoRoot, timeout: 15_000 },
      );

      if (result.exitCode !== 0) {
        res.status(502).json({ error: `git ls-remote failed: ${result.stderr}` });
        return;
      }

      const existing = new Set(
        Object.values(stateService.getState().branches).map((b) => b.branch),
      );
      // Output format: "<sha>\trefs/heads/<branch-name>"
      const branches = result.stdout
        .split('\n')
        .map((line) => line.replace(/^[0-9a-f]+\trefs\/heads\//, '').trim())
        .filter((b) => b && !existing.has(b));

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

  // POST /branches/:id/deploy — ONE-CLICK: build (if needed) + start (if needed) + activate
  router.post('/branches/:id/deploy', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      // Step 1: Build if not yet built
      if (entry.status === 'idle' || entry.status === 'error') {
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
      }

      // Step 2: Start if not running
      if (stateService.getBranch(id)!.status !== 'running') {
        await containerService.start(stateService.getBranch(id)!);
        stateService.updateStatus(id, 'running');
        stateService.save();
      }

      // Step 3: Activate
      await doActivate(id);

      res.json({
        success: true,
        activeBranchId: id,
        url: `http://localhost:${config.gateway.port}`,
      });
    } catch (err) {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (entry && entry.status === 'building') {
        stateService.updateStatus(id, 'error');
        entry.buildLog = (err as Error).message;
        stateService.save();
      }
      res.status(500).json({ error: (err as Error).message });
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
