/**
 * Admin Daemon Standby 模式 — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 1.5 / 4.1 / 4.6
 * 实现位置:cds/src/index.ts(改造)+ cds/src/middleware/standby-guard.ts(新增)
 *
 * Standby 模式是新 daemon 启动后的初始状态:监听端口,响应 healthz,
 * 但 worker / scheduler / 业务写接口全部禁用,直到 supervisor 调
 * /api/_internal/promote 才"激活"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  StandbyController,
  type StandbyLifecycleHooks,
} from '../../src/services/standby-controller.js';
import {
  decideInitialActive,
  parseActiveColor,
  readActiveColor,
  writeActiveColor,
} from '../../src/services/active-color-store.js';
import { createStandbyGuard } from '../../src/middleware/standby-guard.js';
import { createCdsInternalRouter, INTERNAL_TOKEN_HEADER } from '../../src/routes/cds-internal.js';
import { createInternalTokenStore } from '../../src/services/internal-token-store.js';

// B'.5.1 hotfix:测试夹具固定 token,所有 _internal/* 调用都带这个 header
const TEST_INTERNAL_TOKEN = 'test-internal-token-fixed-for-vitest-' + 'a'.repeat(32);
const tokenStore = createInternalTokenStore({
  tokenPath: '/tmp/cds-test-internal-token-' + Math.random().toString(36).slice(2),
  fixedToken: TEST_INTERNAL_TOKEN,
  skipPersist: true,
});
/** 合法 supervisor 调用必须携带这个 header(模拟生产里读 .cds/internal-token 文件) */
const internalAuth = (): Record<string, string> => ({ [INTERNAL_TOKEN_HEADER]: TEST_INTERNAL_TOKEN });

interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
  json: <T = unknown>() => T;
}

/**
 * 发起 HTTP 请求到测试 server。可选 headers / body / family。
 *
 * 默认走 IPv4 回环(127.0.0.1)。`family=6` 用于触发 ::1 路径,
 * `host` 用于覆盖 Host header(让 X-Forwarded-For 伪造测试不会被绕过)。
 */
async function request(
  server: http.Server,
  opts: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    bindHost?: '127.0.0.1' | '::1';
  },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const bindHost = opts.bindHost || '127.0.0.1';
    const reqOptions: http.RequestOptions = {
      host: bindHost,
      port: addr.port,
      path: opts.path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    if (bindHost === '::1') reqOptions.family = 6;
    const req = http.request(reqOptions, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        resolve({
          status: res.statusCode!,
          contentType: (res.headers['content-type'] || '').toString(),
          body: raw,
          json: <T>() => JSON.parse(raw) as T,
        });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) {
      const payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      req.write(payload);
    }
    req.end();
  });
}

/**
 * 建一个最小 Express 测试 server,模拟 createServer 的关键中间件次序:
 *   1. healthz / self-status(在 standby-guard 之前注册,因为 GET 永远要通)
 *   2. standby-guard
 *   3. /api/_internal 路由
 *   4. 业务路由桩(POST /api/branches / PUT /api/projects/:id / DELETE /api/* 等)
 *
 * 这样既不依赖整个 CDS 宿主,又能以真实 HTTP 走完中间件链。
 */
function buildTestApp(controller: StandbyController): express.Express {
  const app = express();
  app.set('etag', false);
  app.use(express.json());

  // 1. healthz / self-status — 注册在 guard 之前(GET 永远应通)
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      status: controller.mode(), // active | standby
      mode: controller.mode(),
    });
  });
  app.get('/api/self-status', (_req, res) => {
    res.json({
      active: controller.isActive(),
      mode: controller.mode(),
      color: controller.selfColor(),
    });
  });
  // 业务读接口(GET 应放行)
  app.get('/api/projects', (_req, res) => res.json({ projects: [] }));
  app.get('/api/branches', (_req, res) => res.json({ branches: [] }));

  // 2. standby-guard:拦截 standby 模式下所有写入
  app.use(createStandbyGuard({ controller }));

  // 3. /api/_internal 路由 — 控制面
  app.use('/api/_internal', createCdsInternalRouter({ controller, tokenStore }));

  // 4. 业务写接口桩
  app.post('/api/branches', (_req, res) => res.json({ ok: true, created: true }));
  app.put('/api/projects/:id', (req, res) => res.json({ ok: true, updated: req.params.id }));
  app.delete('/api/branches/:id', (req, res) => res.json({ ok: true, deleted: req.params.id }));
  app.post('/api/github/webhook', (_req, res) => res.json({ ok: true, received: true }));
  app.post('/api/bridge/command/:branchId', (req, res) => res.json({ ok: true, branchId: req.params.branchId }));

  return app;
}

function startServer(app: express.Express, host = '127.0.0.1'): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, host, () => resolve(s));
  });
}

function closeServer(server: http.Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('Standby 启动行为', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-standby-init-'));
    fs.mkdirSync(path.join(tmpDir, '.cds'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[C-1.5] daemon 启动时若 .cds/active-color 已存在且自身颜色 != active → 进 standby', () => {
    // active-color 文件 = blue,我自己是 green → 应进 standby
    writeActiveColor(tmpDir, 'blue');
    const fileColor = readActiveColor(tmpDir).color;
    expect(fileColor).toBe('blue');

    const initialActive = decideInitialActive({
      disableBlueGreen: false,
      standbyFlag: false,
      selfColor: 'green',
      activeColorFile: fileColor,
    });
    expect(initialActive).toBe(false);

    // 反向:文件 = blue, 我也是 blue → active
    const matched = decideInitialActive({
      disableBlueGreen: false,
      standbyFlag: false,
      selfColor: 'blue',
      activeColorFile: fileColor,
    });
    expect(matched).toBe(true);
  });

  it('[C-1.5] 命令行 --standby 强制 standby', () => {
    // --standby flag 优先级高于"颜色匹配"判断:
    // 即使 active-color 文件颜色 == 自己颜色,只要传了 --standby 仍进 standby
    const initialActive = decideInitialActive({
      disableBlueGreen: false,
      standbyFlag: true,
      selfColor: 'blue',
      activeColorFile: 'blue', // 颜色相符,但因 --standby 仍 standby
    });
    expect(initialActive).toBe(false);
  });

  it('[C-1.5] standby 模式下 /healthz 返回 200 + status=standby', async () => {
    const controller = new StandbyController({ initialActive: false });
    const app = buildTestApp(controller);
    const server = await startServer(app);
    try {
      const res = await request(server, { path: '/healthz' });
      expect(res.status).toBe(200);
      const body = res.json<{ ok: boolean; status: string }>();
      expect(body.status).toBe('standby');
    } finally {
      await closeServer(server);
    }
  });

  it('[C-1.5] standby 模式下 /api/self-status 返回 active=false', async () => {
    const controller = new StandbyController({ initialActive: false });
    const app = buildTestApp(controller);
    const server = await startServer(app);
    try {
      const res = await request(server, { path: '/api/self-status' });
      expect(res.status).toBe(200);
      const body = res.json<{ active: boolean; mode: string }>();
      expect(body.active).toBe(false);
      expect(body.mode).toBe('standby');
    } finally {
      await closeServer(server);
    }
  });

  it('[C-1.5] standby 启动时**不**调用 schedulerService.start() / janitorService.start()', async () => {
    let promoteHookRan = 0;
    const hooks: StandbyLifecycleHooks = {
      onPromote: () => {
        promoteHookRan++;
      },
    };
    const controller = new StandbyController({ initialActive: false, hooks });
    // 默认 standby:promote 钩子不应被触发
    expect(promoteHookRan).toBe(0);
    expect(controller.isActive()).toBe(false);

    // 主动 promote 后才会跑 hook(下面 promote 用例里继续断言)
    await controller.promote();
    expect(promoteHookRan).toBe(1);
  });

  it('[C-1.5] standby 启动时**不**注册 SSE event bus 写入(只读)', async () => {
    // 这一条契约是"standby 实例的 SSE / event bus 监听器不应该自己往 mongo 写状态"。
    // 在 controller 层我们用 hook 表达:onPromote 之前不要让 daemon 跑任何"会修改持久 state"的
    // 后台任务。这里断言:
    //   - controller 在 standby 状态下,不应该把任何 hook 当成"已经跑过"
    //   - 业务 SSE 写入 endpoint 在 standby 模式下应该被 standby-guard 拦下
    let writeBackgroundRan = 0;
    const controller = new StandbyController({
      initialActive: false,
      hooks: {
        onPromote: () => { writeBackgroundRan++; },
      },
    });
    expect(controller.isActive()).toBe(false);
    expect(writeBackgroundRan).toBe(0);

    // 即使外部对实例发 POST(模拟 SSE 上的 event bus 端点),也会被 guard 503
    const app = buildTestApp(controller);
    const server = await startServer(app);
    try {
      const res = await request(server, {
        method: 'POST',
        path: '/api/branches',
        headers: { 'Content-Type': 'application/json' },
        body: { foo: 'bar' },
      });
      expect(res.status).toBe(503);
      const body = res.json<{ error: string }>();
      expect(body.error).toBe('standby');
    } finally {
      await closeServer(server);
    }
    expect(writeBackgroundRan).toBe(0); // 全程没真正激活
  });
});

describe('Standby 写入隔离', () => {
  let server: http.Server | null = null;
  let controller: StandbyController;

  beforeEach(async () => {
    controller = new StandbyController({ initialActive: false });
    server = await startServer(buildTestApp(controller));
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
  });

  it('[C-4.6] standby 实例收到 POST /api/branches → 返回 503 + JSON { error: "standby" }', async () => {
    const res = await request(server!, {
      method: 'POST',
      path: '/api/branches',
      headers: { 'Content-Type': 'application/json' },
      body: { name: 'feat/foo' },
    });
    expect(res.status).toBe(503);
    expect(res.contentType).toContain('application/json');
    const body = res.json<{ error: string; mode: string }>();
    expect(body.error).toBe('standby');
    expect(body.mode).toBe('standby');
  });

  it('[C-4.6] standby 实例收到 PUT /api/projects/:id → 拒绝', async () => {
    const res = await request(server!, {
      method: 'PUT',
      path: '/api/projects/abc',
      headers: { 'Content-Type': 'application/json' },
      body: { name: 'X' },
    });
    expect(res.status).toBe(503);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('standby');
  });

  it('[C-4.6] standby 实例收到 DELETE /api/* → 拒绝', async () => {
    const res = await request(server!, {
      method: 'DELETE',
      path: '/api/branches/foo',
    });
    expect(res.status).toBe(503);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('standby');
  });

  it('[C-4.6] standby 仍允许只读 GET(self-status / projects / branches)', async () => {
    const r1 = await request(server!, { path: '/api/self-status' });
    expect(r1.status).toBe(200);
    const r2 = await request(server!, { path: '/api/projects' });
    expect(r2.status).toBe(200);
    const r3 = await request(server!, { path: '/api/branches' });
    expect(r3.status).toBe(200);
    const r4 = await request(server!, { path: '/healthz' });
    expect(r4.status).toBe(200);
  });

  it('[C-4.6] standby 收到 webhook(/api/github/webhook)→ 拒绝并提示用 active', async () => {
    const res = await request(server!, {
      method: 'POST',
      path: '/api/github/webhook',
      headers: { 'Content-Type': 'application/json' },
      body: { zen: 'hello' },
    });
    expect(res.status).toBe(503);
    const body = res.json<{ error: string; message: string; hint: string }>();
    expect(body.error).toBe('standby');
    // 文案明确提示 active / supervisor,让 webhook 来源能区分"实例没起来"vs"还没轮到我"
    expect(body.message + body.hint).toMatch(/active|supervisor|promote/i);
  });

  it('[C-4.6] standby 收到 Bridge command 调用 → 拒绝', async () => {
    const res = await request(server!, {
      method: 'POST',
      path: '/api/bridge/command/branch-1',
      headers: { 'Content-Type': 'application/json' },
      body: { action: 'click', params: { index: 0 }, description: 'test' },
    });
    expect(res.status).toBe(503);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('standby');
  });
});

describe('/api/_internal/promote 激活', () => {
  let tmpDir: string;
  let server: http.Server | null = null;
  let controller: StandbyController;
  let promoteHookCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-standby-promote-'));
    fs.mkdirSync(path.join(tmpDir, '.cds'), { recursive: true });
    promoteHookCount = 0;
    controller = new StandbyController({
      initialActive: false,
      selfColor: 'green',
      repoRoot: tmpDir,
      hooks: {
        onPromote: () => { promoteHookCount++; },
      },
    });
    server = await startServer(buildTestApp(controller));
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[C-1.5] 携带合法 token 的 POST /api/_internal/promote → 200 + 解禁写入', async () => {
    expect(controller.isActive()).toBe(false);
    const res = await request(server!, {
      method: 'POST',
      path: '/api/_internal/promote',
      headers: internalAuth(),
      bindHost: '127.0.0.1',
    });
    expect(res.status).toBe(200);
    const body = res.json<{ ok: boolean; mode: string }>();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('active');
    expect(controller.isActive()).toBe(true);

    // promote 后业务写入应放行
    const writeRes = await request(server!, {
      method: 'POST',
      path: '/api/branches',
      headers: { 'Content-Type': 'application/json' },
      body: { name: 'foo' },
    });
    expect(writeRes.status).toBe(200);
  });

  it('[C-4.1] 缺 token header → 403(模拟外网公网请求)', async () => {
    // B'.5.1 hotfix:nginx 反代场景下 socket.remoteAddress 永远是 127.0.0.1,
    // IP 校验失效。改用 token 双因子,缺 header 即拒。
    const res = await request(server!, {
      method: 'POST',
      path: '/api/_internal/promote',
      // 不传 internalAuth() — 模拟外网调用
    });
    expect(res.status).toBe(403);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe('forbidden');
    expect(controller.isActive()).toBe(false);
  });

  it('[C-4.1] 错误 token → 403,即使来源是回环', async () => {
    const res = await request(server!, {
      method: 'POST',
      path: '/api/_internal/promote',
      headers: { [INTERNAL_TOKEN_HEADER]: 'wrong-token-pretender' },
    });
    expect(res.status).toBe(403);
    expect(controller.isActive()).toBe(false);
  });

  it('[C-4.1] 同长度但不匹配的 token → 403(timing-safe 比对)', async () => {
    const sameLen = 'X'.repeat(TEST_INTERNAL_TOKEN.length);
    const res = await request(server!, {
      method: 'POST',
      path: '/api/_internal/promote',
      headers: { [INTERNAL_TOKEN_HEADER]: sameLen },
    });
    expect(res.status).toBe(403);
    expect(controller.isActive()).toBe(false);
  });

  it('[C-4.1] 即便伪造 X-Forwarded-For 为 127.0.0.1,缺 token 仍 403(IP 校验已废弃)', async () => {
    // 历史:B'.2 用 socket.remoteAddress IP 校验,nginx 反代下永远 true 形同虚设。
    // B'.5.1 hotfix 改用 token,X-F-F 完全无关。
    const res = await request(server!, {
      method: 'POST',
      path: '/api/_internal/promote',
      headers: {
        'X-Forwarded-For': '127.0.0.1',
        'X-Real-IP': '127.0.0.1',
        'Forwarded': 'for=127.0.0.1',
      },
    });
    expect(res.status).toBe(403);
    expect(controller.isActive()).toBe(false);
  });

  it('[C-1.5] promote 后启动 schedulerService + janitorService', async () => {
    expect(promoteHookCount).toBe(0);
    const res = await request(server!, {
      method: 'POST',
      path: '/api/_internal/promote',
      headers: internalAuth(),
    });
    expect(res.status).toBe(200);
    expect(promoteHookCount).toBe(1); // onPromote(模拟 scheduler/janitor.start)被调一次
  });

  it('[C-1.5] promote 后写 .cds/active-color 为自身颜色', async () => {
    const colorFile = path.join(tmpDir, '.cds', 'active-color');
    expect(fs.existsSync(colorFile)).toBe(false);
    const res = await request(server!, {
      method: 'POST',
      path: '/api/_internal/promote',
      headers: internalAuth(),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(colorFile)).toBe(true);
    const content = fs.readFileSync(colorFile, 'utf8').trim();
    expect(content).toBe('green'); // 自身颜色 = green
  });

  it('[C-1.5] 重复调用 promote → 200 但幂等(不重复启动 scheduler)', async () => {
    const r1 = await request(server!, { method: 'POST', path: '/api/_internal/promote', headers: internalAuth() });
    expect(r1.status).toBe(200);
    expect(promoteHookCount).toBe(1);

    const r2 = await request(server!, { method: 'POST', path: '/api/_internal/promote', headers: internalAuth() });
    expect(r2.status).toBe(200);
    const body = r2.json<{ ok: boolean; mode: string; wasActive: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('active');
    expect(body.wasActive).toBe(true); // 第二次调 wasActive=true 表示已经是 active

    // hook 没再跑(幂等)
    expect(promoteHookCount).toBe(1);
  });
});

describe('/api/_internal/standby 反向降级(运维手动触发)', () => {
  let server: http.Server | null = null;
  let controller: StandbyController;
  let standbyHookCount = 0;

  beforeEach(async () => {
    standbyHookCount = 0;
    controller = new StandbyController({
      initialActive: true, // 起步就是 active
      hooks: {
        onEnterStandby: () => { standbyHookCount++; },
      },
    });
    server = await startServer(buildTestApp(controller));
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
  });

  it('[C-1.5] 携带合法 token 的 POST /api/_internal/standby → 进入 standby + 停 scheduler', async () => {
    expect(controller.isActive()).toBe(true);
    const res = await request(server!, { method: 'POST', path: '/api/_internal/standby', headers: internalAuth() });
    expect(res.status).toBe(200);
    const body = res.json<{ ok: boolean; mode: string }>();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('standby');
    expect(controller.isActive()).toBe(false);
    expect(standbyHookCount).toBe(1); // onEnterStandby 跑了一次(模拟 scheduler.stop)

    // 再发业务写入应被拦
    const writeRes = await request(server!, {
      method: 'POST',
      path: '/api/branches',
      headers: { 'Content-Type': 'application/json' },
      body: { name: 'x' },
    });
    expect(writeRes.status).toBe(503);
  });

  it('[C-4.1] 缺 token → 403,即使经过 nginx 反代回环 socket(B\'.5.1 hotfix)', async () => {
    const res = await request(server!, {
      method: 'POST',
      path: '/api/_internal/standby',
      // 不带 internalAuth() — 模拟外网公网请求经 nginx 反代到 daemon
      headers: { 'X-Forwarded-For': '127.0.0.1' },
    });
    expect(res.status).toBe(403);
    expect(controller.isActive()).toBe(true);
    expect(standbyHookCount).toBe(0);
  });
});

// 额外 sanity:active-color 文件 IO 正交校验,与上面 17 条用例独立。
// 这一段只是开发期顺手写的边界覆盖,不属于硬契约,放在最后避免影响契约总数。
describe('active-color-store 边界(辅助)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-active-color-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parseActiveColor 接受 trim/case-insensitive,拒绝其它字符串', () => {
    expect(parseActiveColor('blue')).toBe('blue');
    expect(parseActiveColor(' BLUE\n')).toBe('blue');
    expect(parseActiveColor('Green')).toBe('green');
    expect(parseActiveColor('')).toBe(null);
    expect(parseActiveColor(null)).toBe(null);
    expect(parseActiveColor(undefined)).toBe(null);
    expect(parseActiveColor('purple')).toBe(null);
  });

  it('readActiveColor 文件不存在 → color=null,无 error', () => {
    const r = readActiveColor(tmpDir);
    expect(r.color).toBe(null);
    expect(r.error).toBe(null);
  });

  it('readActiveColor 文件内容空 → color=null', () => {
    fs.mkdirSync(path.join(tmpDir, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cds', 'active-color'), '');
    const r = readActiveColor(tmpDir);
    expect(r.color).toBe(null);
  });

  it('writeActiveColor 原子写入(tmp + rename)', () => {
    writeActiveColor(tmpDir, 'green');
    const content = fs.readFileSync(path.join(tmpDir, '.cds', 'active-color'), 'utf8');
    expect(content).toBe('green');
    // tmp 文件应该已被 rename 掉
    expect(fs.existsSync(path.join(tmpDir, '.cds', 'active-color.tmp'))).toBe(false);
  });

  it('decideInitialActive: CDS_DISABLE_BLUE_GREEN=1 永远 active', () => {
    expect(decideInitialActive({
      disableBlueGreen: true,
      standbyFlag: true,
      selfColor: 'blue',
      activeColorFile: 'green',
    })).toBe(true);
  });

  it('decideInitialActive: 无颜色 selfColor 永远 active(单进程旧路径)', () => {
    expect(decideInitialActive({
      disableBlueGreen: false,
      standbyFlag: false,
      selfColor: null,
      activeColorFile: 'blue',
    })).toBe(true);
  });

  it('decideInitialActive: 文件未初始化(null)默认 active', () => {
    expect(decideInitialActive({
      disableBlueGreen: false,
      standbyFlag: false,
      selfColor: 'blue',
      activeColorFile: null,
    })).toBe(true);
  });
});
