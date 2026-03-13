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

  // ── Switch domain middleware (before auth) ──
  // When request comes from the switch domain, delegate to ProxyService
  const switchDomain = deps.config.switchDomain?.toLowerCase();
  if (switchDomain) {
    app.use((req, res, next) => {
      const host = (req.headers.host || '').split(':')[0].toLowerCase();
      if (host === switchDomain) {
        // Delegate to proxy service's switch handler
        deps.proxyService.handleSwitchFromExpress(req, res);
        return;
      }
      next();
    });
  }

  // ── Auth middleware ──
  const cdsUser = process.env.CDS_USERNAME || process.env.BT_USERNAME;
  const cdsPass = process.env.CDS_PASSWORD || process.env.BT_PASSWORD;
  const authEnabled = !!(cdsUser && cdsPass);
  const validToken = authEnabled ? makeToken(cdsUser!, cdsPass!) : '';

  if (authEnabled) {
    app.post('/api/login', (req, res) => {
      const { username, password } = req.body || {};
      if (username === cdsUser && password === cdsPass) {
        // 服务端设置 cookie，比客户端 document.cookie 更可靠（尤其是 HTTPS / 隐私模式）
        res.setHeader('Set-Cookie', `cds_token=${validToken}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax; HttpOnly`);
        res.json({ success: true });
      } else {
        res.status(401).json({ error: '用户名或密码错误' });
      }
    });

    app.post('/api/logout', (_req, res) => {
      res.setHeader('Set-Cookie', 'cds_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
      res.json({ success: true });
    });

    app.use((req, res, next) => {
      if (req.path === '/login.html' || req.path === '/api/login' || req.path === '/api/logout') return next();
      if (/\.(css|js|ico|png|svg|woff2?)$/i.test(req.path)) return next();

      const cookieToken = parseCookie(req.headers.cookie || '', 'cds_token');
      const headerToken = req.headers['x-cds-token'] as string | undefined;
      const token = cookieToken || headerToken;
      if (token === validToken) return next();

      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: '未登录' });
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
