import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBranchRouter } from './routes/branches.js';
import type { StateService } from './services/state.js';
import type { WorktreeService } from './services/worktree.js';
import type { ContainerService } from './services/container.js';
import type { ProxyService } from './services/proxy.js';
import type { CdsConfig, IShellExecutor } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  proxyService: ProxyService;
  shell: IShellExecutor;
  config: CdsConfig;
}

function makeToken(user: string, pass: string): string {
  return crypto.createHash('sha256').update(`cds:${user}:${pass}`).digest('hex');
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express();
  app.use(express.json());

  const webDir = path.resolve(__dirname, '..', 'web');

  // ── Auth middleware ──
  const btUser = process.env.BT_USERNAME || process.env.CDS_USERNAME;
  const btPass = process.env.BT_PASSWORD || process.env.CDS_PASSWORD;
  const authEnabled = !!(btUser && btPass);
  const validToken = authEnabled ? makeToken(btUser!, btPass!) : '';

  if (authEnabled) {
    app.post('/api/login', (req, res) => {
      const { username, password } = req.body || {};
      if (username === btUser && password === btPass) {
        res.json({ success: true, token: validToken });
      } else {
        res.status(401).json({ error: 'Invalid credentials' });
      }
    });

    app.use((req, res, next) => {
      if (req.path === '/login.html' || req.path === '/api/login') return next();
      if (/\.(css|js|ico|png|svg|woff2?)$/i.test(req.path)) return next();

      const cookieToken = parseCookie(req.headers.cookie || '', 'cds_token');
      const headerToken = req.headers['x-cds-token'] as string | undefined;
      const token = cookieToken || headerToken;
      if (token === validToken) return next();

      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'Not authenticated' });
      } else {
        res.sendFile(path.join(webDir, 'login.html'));
      }
    });

    console.log('  Auth: enabled');
  }

  // API routes
  app.use('/api', createBranchRouter(deps));

  // Dashboard static files
  app.use(express.static(webDir));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });

  return app;
}

function parseCookie(cookieStr: string, name: string): string | undefined {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}
