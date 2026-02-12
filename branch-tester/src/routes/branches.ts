import { Router } from 'express';
import path from 'node:path';
import { StateService } from '../services/state.js';
import type { WorktreeService } from '../services/worktree.js';
import type { ContainerService } from '../services/container.js';
import type { SwitcherService } from '../services/switcher.js';
import type { BuilderService } from '../services/builder.js';
import type { BtConfig } from '../types.js';

export interface RouterDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  switcherService: SwitcherService;
  builderService: BuilderService;
  config: BtConfig;
}

export function createBranchRouter(deps: RouterDeps): Router {
  const {
    stateService,
    worktreeService,
    containerService,
    switcherService,
    builderService,
    config,
  } = deps;

  const router = Router();

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
    // Redact secrets
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

  // DELETE /branches/:id — remove a branch
  router.delete('/branches/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      // Stop container if running
      if (entry.status === 'running') {
        await containerService.stop(entry.containerName);
      }

      // Remove worktree
      try {
        await worktreeService.remove(entry.worktreePath);
      } catch {
        // worktree may not exist
      }

      // Remove docker image
      try {
        await containerService.removeImage(entry.imageName);
      } catch {
        // image may not exist
      }

      stateService.removeBranch(id);
      stateService.save();

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /branches/:id/build — build branch
  router.post('/branches/:id/build', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      stateService.updateStatus(id, 'building');
      stateService.save();

      const buildsDir = path.join(config.repoRoot, config.deployDir, 'web', 'builds', id);

      // Build API image and admin static in parallel
      const [apiLog, adminLog] = await Promise.all([
        builderService.buildApiImage(entry.worktreePath, entry.imageName),
        builderService.buildAdminStatic(entry.worktreePath, buildsDir),
      ]);

      stateService.updateStatus(id, 'idle');
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

  // POST /branches/:id/start — start branch container
  router.post('/branches/:id/start', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
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

  // POST /branches/:id/stop — stop branch container
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

  // POST /branches/:id/activate — switch active branch
  router.post('/branches/:id/activate', async (req, res) => {
    try {
      const { id } = req.params;
      const entry = stateService.getBranch(id);
      if (!entry) {
        res.status(404).json({ error: `Branch "${id}" not found` });
        return;
      }

      // Pre-check: container must be running
      const running = await containerService.isRunning(entry.containerName);
      if (!running) {
        res.status(400).json({
          error: `Branch "${id}" is not running. Start it first.`,
        });
        return;
      }

      // Backup current config
      switcherService.backup();

      // Sync static files
      const buildsDir = path.join(config.repoRoot, config.deployDir, 'web', 'builds', id);
      const distDir = path.join(config.repoRoot, config.deployDir, 'web', 'dist');
      await switcherService.syncStaticFiles(buildsDir, distDir);

      // Generate and apply new nginx config
      const newConf = switcherService.generateConfig(entry.containerName);
      await switcherService.applyConfig(newConf);

      // Update state
      stateService.activate(id);
      stateService.save();

      res.json({
        success: true,
        activeBranchId: id,
        url: `http://localhost:${config.gateway.port}`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /rollback — rollback to previous branch
  router.post('/rollback', async (_req, res) => {
    try {
      const previousId = stateService.rollback();
      if (!previousId) {
        res.status(400).json({ error: 'No history to rollback to' });
        return;
      }

      const entry = stateService.getBranch(previousId);
      if (!entry) {
        res.status(500).json({ error: `Previous branch "${previousId}" no longer exists` });
        return;
      }

      // Ensure container is running
      const running = await containerService.isRunning(entry.containerName);
      if (!running) {
        await containerService.start(entry);
        stateService.updateStatus(previousId, 'running');
      }

      // Switch nginx
      switcherService.backup();
      const buildsDir = path.join(config.repoRoot, config.deployDir, 'web', 'builds', previousId);
      const distDir = path.join(config.repoRoot, config.deployDir, 'web', 'dist');
      await switcherService.syncStaticFiles(buildsDir, distDir);

      const newConf = switcherService.generateConfig(entry.containerName);
      await switcherService.applyConfig(newConf);
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
