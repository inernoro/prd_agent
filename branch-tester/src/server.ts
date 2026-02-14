import express from 'express';
import crypto from 'node:crypto';
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

/** Generate a token from username + password */
function makeToken(user: string, pass: string): string {
  return crypto.createHash('sha256').update(`bt:${user}:${pass}`).digest('hex');
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express();
  app.use(express.json());

  const webDir = path.resolve(__dirname, '..', 'web');

  // ── Auth middleware (enabled if BT_USERNAME + BT_PASSWORD are set) ──
  const btUser = process.env.BT_USERNAME;
  const btPass = process.env.BT_PASSWORD;
  const authEnabled = !!(btUser && btPass);
  const validToken = authEnabled ? makeToken(btUser!, btPass!) : '';

  if (authEnabled) {
    // Login endpoint (always accessible)
    app.post('/api/login', (req, res) => {
      const { username, password } = req.body || {};
      if (username === btUser && password === btPass) {
        res.json({ success: true, token: validToken });
      } else {
        res.status(401).json({ error: '用户名或密码错误' });
      }
    });

    // Auth guard
    app.use((req, res, next) => {
      // Allow login page assets
      if (req.path === '/login.html' || req.path === '/api/login') {
        return next();
      }
      // Allow static assets (css/js) without auth
      if (/\.(css|js|ico|png|svg|woff2?)$/i.test(req.path)) {
        return next();
      }
      // Check auth token from cookie or header
      const cookieToken = parseCookie(req.headers.cookie || '', 'bt_token');
      const headerToken = req.headers['x-bt-token'] as string | undefined;
      const token = cookieToken || headerToken;
      if (token === validToken) {
        return next();
      }
      // Not authenticated — redirect to login page or return 401
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: '未登录' });
      } else {
        res.sendFile(path.join(webDir, 'login.html'));
      }
    });

    console.log('  Auth: enabled (BT_USERNAME / BT_PASSWORD)');
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
