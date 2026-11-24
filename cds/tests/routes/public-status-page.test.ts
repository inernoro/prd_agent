/*
 * 守卫：公开状态页的那条匿名通道是窄的。
 *
 * 三件事必须成立，少一件这条通道就变成一个洞：
 *   1. 撤销之后旧链接当即 404（用户明确要求的判据）；
 *   2. 匿名放行**只覆盖读取**——开关（开/关/查状态）仍然要登录；
 *   3. 白名单的正则只认 32 位 hex，不能被 `/api/public/status/../..` 这类路径绕开。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { createPublicStatusRouter, createStatusPageAdminRouter, type PublicStatusDeps } from '../../src/routes/public-status.js';
import type { Project, UptimeCustomMonitor } from '../../src/types.js';

const TOKEN = 'a'.repeat(32);

function makeDeps(over: { token?: string | null; monitors?: UptimeCustomMonitor[] } = {}): PublicStatusDeps {
  let token = over.token === undefined ? TOKEN : over.token;
  const project = { id: 'proj-a', name: 'MAP', statusPageToken: token } as unknown as Project;
  const monitors = over.monitors || [];
  return {
    state: {
      getProjectByStatusPageToken: (t) => (token && t === token ? { ...project, statusPageToken: token } as Project : undefined),
      getProject: () => project,
      listUptimeMonitors: () => monitors,
      openProjectStatusPage: () => { token = token || TOKEN; return { ...project, statusPageToken: token } as Project; },
      closeProjectStatusPage: () => { token = null; return { ...project, statusPageToken: null } as Project; },
    },
    monitor: {
      getSummary: () => ({
        generatedAt: 0,
        targets: monitors.map((m) => ({
          id: `monitor@${m.id}`, status: 'up' as const, measured: true,
        })),
      }),
      getHistory: () => ({ points: [{ from: Date.UTC(2026, 8, 10), up: 4, down: 0 }] }),
    },
    refreshHintSeconds: 60,
    now: () => Date.UTC(2026, 8, 11),
  };
}

function makeApp(deps: PublicStatusDeps) {
  const app = express();
  app.use(express.json());
  app.use('/api', createPublicStatusRouter(deps));
  app.use('/api', createStatusPageAdminRouter(deps));
  return app;
}

async function call(app: express.Express, method: string, url: string) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const monitor = (over: Partial<UptimeCustomMonitor> = {}) => ({
  id: 'mon-1', name: '视觉创作 · 生图', kind: 'functional', enabled: true,
  publicVisible: true, publicName: '图片生成', projectId: 'proj-a',
  createdAt: 'now', updatedAt: 'now', ...over,
} as unknown as UptimeCustomMonitor);

describe('匿名读取', () => {
  it('带对的 token 能拿到对外载荷', async () => {
    const res = await call(makeApp(makeDeps({ monitors: [monitor()] })), 'GET', `/api/public/status/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('MAP');
    expect((res.body.items as Array<{ name: string }>)[0].name).toBe('图片生成');
  });

  it('撤销之后同一个链接当即 404', async () => {
    const deps = makeDeps({ monitors: [monitor()] });
    const app = makeApp(deps);
    expect((await call(app, 'GET', `/api/public/status/${TOKEN}`)).status).toBe(200);
    await call(app, 'DELETE', '/api/projects/proj-a/status-page');
    expect((await call(app, 'GET', `/api/public/status/${TOKEN}`)).status).toBe(404);
  });

  it('没开公开页时任何 token 都不命中（空串不许匹配到「没开的项目」）', async () => {
    const res = await call(makeApp(makeDeps({ token: null })), 'GET', `/api/public/status/${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('响应不许被中间缓存留副本 —— 否则撤销之后旧链接还能打开', async () => {
    const res = await call(makeApp(makeDeps({ monitors: [monitor()] })), 'GET', `/api/public/status/${TOKEN}`);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('只有显式公开、且在跑的监控才出去', () => {
  it('没勾公开的不出现', async () => {
    const res = await call(makeApp(makeDeps({ monitors: [monitor({ publicVisible: false })] })), 'GET', `/api/public/status/${TOKEN}`);
    expect(res.body.items).toHaveLength(0);
  });

  it('暂停的不出现 —— 对外是一条永远灰着的条带，只会让人以为坏了', async () => {
    const res = await call(makeApp(makeDeps({ monitors: [monitor({ enabled: false })] })), 'GET', `/api/public/status/${TOKEN}`);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('鉴权白名单只放行读取', () => {
  const repoFile = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
  /**
   * 扫的是**代码**不是注释：白名单旁边的注释里本来就会提到开关路径
   * （「那几个开关仍然要登录」），连注释一起扫会把一条解释判成一次放行。
   */
  const codeOf = (rel: string) => repoFile(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('两处白名单都登记了读取路径，且只认 32 位 hex', () => {
    // 两处必须同步：github 模式走 middleware，basic-auth 模式走 server.ts。
    // 只加一处，另一种部署模式下这条公开页就是 401 —— 一个只在一半环境里成立的功能。
    const pattern = String.raw`\/api\\?\/public\\?\/status\\?\/\[a-f0-9\]\{32\}`;
    expect(repoFile('src/middleware/github-auth.ts')).toMatch(new RegExp(pattern));
    expect(repoFile('src/server.ts')).toMatch(new RegExp(pattern));
  });

  it('开关那几条路径没有被放进任何白名单', () => {
    // `/api/projects/:id/status-page` 是管理动作。一旦混进公开白名单，
    // 任何人都能开别人项目的公开页 —— 这条守卫就是防那一手滑。
    for (const file of ['src/middleware/github-auth.ts', 'src/server.ts']) {
      expect(codeOf(file), `${file} 不该放行开关路径`).not.toContain('status-page');
    }
  });

  it('SPA 入口 /s/:token 同样只认 32 位 hex', () => {
    expect(repoFile('src/server.ts')).toMatch(/\\\/s\\\/\[a-f0-9\]\{32\}/);
  });
});
