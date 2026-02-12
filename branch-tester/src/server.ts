import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBranchRouter } from './routes/branches.js';
import type { StateService } from './services/state.js';
import type { WorktreeService } from './services/worktree.js';
import type { ContainerService } from './services/container.js';
import type { SwitcherService } from './services/switcher.js';
import type { BuilderService } from './services/builder.js';
import type { BtConfig, IShellExecutor } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  switcherService: SwitcherService;
  builderService: BuilderService;
  shell: IShellExecutor;
  config: BtConfig;
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express();

  app.use(express.json());

  // API routes
  app.use('/api', createBranchRouter(deps));

  // Dashboard static files
  const webDir = path.resolve(__dirname, '..', 'web');
  app.use(express.static(webDir));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });

  return app;
}
