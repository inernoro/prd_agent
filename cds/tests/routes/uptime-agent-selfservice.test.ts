/**
 * Agent 用项目级 Key 自助登记监控（2026-09-09，规则 degradation-must-alarm）。
 *
 * 背景：自定义监控的写接口原本对项目级 Key 一律 403，理由是两个具体风险——
 * 借 CDS 主机扫内网（SSRF）、关键字探测把响应内容当 oracle 透出来。
 * 现在开一条同时堵死这两个风险的窄路，让 Agent 能登记自己项目、自己分支的
 * health-json 监控。这个文件守的就是「那条路确实是窄的」。
 *
 * 每一条用例对应一种绕过尝试：换 kind、换地址、换项目、改别人的、删别人的、
 * 用「试探」绕开写路由。少一条，那条路就通了而且没人会发现。
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createUptimeRouter } from '../../src/routes/uptime.js';
import type { UptimeCustomMonitor } from '../../src/types.js';

const PROJECT = 'proj-a';
const OWN_HOST = 'feat-x-proj-a.preview.test';
const OWN_GATEWAY_HOST = 'feat-x-proj-a-llmgw.preview.test';
const OTHER_HOST = 'evil.example.com';

function fakeMonitor() {
  return {
    getSummary: () => ({ overall: {}, targets: [] }),
    getTargetProjectId: () => PROJECT,
    refreshTarget: () => undefined,
    forgetTarget: () => undefined,
    config: { timeoutMs: 5000 },
  } as unknown as Parameters<typeof createUptimeRouter>[0]['monitor'];
}

function makeApp(opts: { projectId?: string; withHosts?: boolean; seed?: UptimeCustomMonitor[] } = {}) {
  const store = new Map<string, UptimeCustomMonitor>();
  for (const m of opts.seed || []) store.set(m.id, m);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.projectId) {
      (req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey = { projectId: opts.projectId, keyId: 'key-1' };
    } else {
      (req as unknown as { cdsUser?: unknown }).cdsUser = { username: 'alice' };
    }
    next();
  });
  app.use('/api', createUptimeRouter({
    monitor: fakeMonitor(),
    ...(opts.withHosts === false ? {} : {
      listProjectPreviewHosts: (projectId: string) => projectId === PROJECT
        ? [
            { branchId: 'branch-feat-x', host: OWN_HOST },
            { branchId: 'branch-feat-x', host: OWN_GATEWAY_HOST },
          ]
        : [],
    }),
    store: {
      listUptimeMonitors: (projectId?: string) =>
        [...store.values()].filter((m) => !projectId || m.projectId === projectId),
      getUptimeMonitor: (id: string) => store.get(id),
      upsertUptimeMonitor: (m: UptimeCustomMonitor) => { store.set(m.id, m); return m; },
      removeUptimeMonitor: (id: string) => store.delete(id),
      getProject: (id: string) => ({ id }) as never,
    },
  }));
  return { app, store };
}

async function call(app: express.Express, method: string, url: string, body?: unknown) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const healthJsonOn = (host: string) => ({
  kind: 'health-json',
  url: `https://${host}/gw/v1/healthz/deep`,
  healthComponentId: 'serving.unhandled-exceptions',
  healthField: 'observedValue',
  healthOp: 'eq',
  healthValue: '0',
  projectId: PROJECT,
});

describe('项目级 Key 自助登记：允许的那条窄路', () => {
  it('登记自己项目、自己分支的 health-json：通过，并盖上审计与分支绑定', async () => {
    const { app, store } = makeApp({ projectId: PROJECT });
    const res = await call(app, 'POST', '/api/uptime/monitors', healthJsonOn(OWN_HOST));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const saved = [...store.values()][0];
    expect(saved.createdByKind).toBe('project-key');
    expect(saved.createdBy).toBe('key:key-1');
    expect(saved.origin).toBe('agent-api');
    // 寿命跟着分支走——这是「临时分支留下死地址」的解药
    expect(saved.boundBranchId).toBe('branch-feat-x');
  });

  it('命名子域（llmgw）也算自己的地址：serving 自检端点正在那儿', async () => {
    const { app } = makeApp({ projectId: PROJECT });
    const res = await call(app, 'POST', '/api/uptime/monitors', healthJsonOn(OWN_GATEWAY_HOST));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('项目级 Key 自助登记：每一种绕过都要堵住', () => {
  it('换成 keyword 探测 → 403（它能把任意响应体当 oracle 透出来）', async () => {
    const { app } = makeApp({ projectId: PROJECT });
    const res = await call(app, 'POST', '/api/uptime/monitors', {
      kind: 'keyword', url: `https://${OWN_HOST}/`, keyword: 'secret', projectId: PROJECT,
    });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('health-json');
  });

  it('换成外部地址 → 403（借 CDS 主机扫内网 / 别人的服务）', async () => {
    const { app } = makeApp({ projectId: PROJECT });
    const res = await call(app, 'POST', '/api/uptime/monitors', healthJsonOn(OTHER_HOST));
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('不属于本项目');
  });

  it('回环地址同样被拒（它不在本项目入口台账里）', async () => {
    const { app } = makeApp({ projectId: PROJECT });
    const res = await call(app, 'POST', '/api/uptime/monitors', healthJsonOn('127.0.0.1:9000'));
    expect(res.status).toBe(403);
  });

  it('声称属于别的项目 → 403', async () => {
    const { app } = makeApp({ projectId: PROJECT });
    const res = await call(app, 'POST', '/api/uptime/monitors', {
      ...healthJsonOn(OWN_HOST), projectId: 'proj-b',
    });
    expect(res.status).toBe(403);
  });

  it('用「试探」绕开写路由 → 同样被闸住', async () => {
    const { app } = makeApp({ projectId: PROJECT });
    const res = await call(app, 'POST', '/api/uptime/monitors/test', healthJsonOn(OTHER_HOST));
    // 不落库不等于没有 SSRF 面：试探真的会让 CDS 主机去连那个地址
    expect(res.status).toBe(403);
  });

  it('改别人项目的监控 → 403', async () => {
    const foreign: UptimeCustomMonitor = {
      id: 'm-foreign', name: '别人的', kind: 'http', url: 'https://x.test/', projectId: 'proj-b',
      enabled: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const { app } = makeApp({ projectId: PROJECT, seed: [foreign] });
    const res = await call(app, 'PUT', '/api/uptime/monitors/m-foreign', healthJsonOn(OWN_HOST));
    expect(res.status).toBe(403);
  });

  it('删别人项目的监控 → 403', async () => {
    const foreign: UptimeCustomMonitor = {
      id: 'm-foreign', name: '别人的', kind: 'http', url: 'https://x.test/', projectId: 'proj-b',
      enabled: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const { app, store } = makeApp({ projectId: PROJECT, seed: [foreign] });
    const res = await call(app, 'DELETE', '/api/uptime/monitors/m-foreign');
    expect(res.status).toBe(403);
    expect(store.has('m-foreign')).toBe(true);
  });

  it('删管理员手动加的监控 → 403（自助登记不等于替管理员做主）', async () => {
    // 这条是既有用例 uptime-codex-r1514 在本次改动中变红抓出来的：
    // 只判「同项目」会让一把项目 Key 删掉管理员盯着的东西，那是权限扩大。
    const manual: UptimeCustomMonitor = {
      id: 'm-manual', name: '管理员加的', kind: 'http', url: `https://${OWN_HOST}/`,
      projectId: PROJECT, enabled: true, origin: 'manual', createdBy: 'alice', createdByKind: 'human',
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const { app, store } = makeApp({ projectId: PROJECT, seed: [manual] });
    const res = await call(app, 'DELETE', '/api/uptime/monitors/m-manual');
    expect(res.status).toBe(403);
    expect(store.has('m-manual')).toBe(true);
  });

  it('改管理员手动加的监控 → 403（改判据等于变相让它不报警）', async () => {
    const manual: UptimeCustomMonitor = {
      id: 'm-manual', name: '管理员加的', kind: 'http', url: `https://${OWN_HOST}/`,
      projectId: PROJECT, enabled: true, origin: 'manual',
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const { app } = makeApp({ projectId: PROJECT, seed: [manual] });
    const res = await call(app, 'PUT', '/api/uptime/monitors/m-manual', healthJsonOn(OWN_HOST));
    expect(res.status).toBe(403);
  });

  it('自己登记的可以改、可以删（收得回自己放出去的）', async () => {
    const mine: UptimeCustomMonitor = {
      id: 'm-mine', name: '自己登记的', ...healthJsonOn(OWN_HOST),
      enabled: true, origin: 'agent-api', createdBy: 'key:key-1', createdByKind: 'project-key',
      boundBranchId: 'branch-feat-x',
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    } as UptimeCustomMonitor;
    const { app, store } = makeApp({ projectId: PROJECT, seed: [mine] });

    const put = await call(app, 'PUT', '/api/uptime/monitors/m-mine', {
      ...healthJsonOn(OWN_GATEWAY_HOST), name: '改过名',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const del = await call(app, 'DELETE', '/api/uptime/monitors/m-mine');
    expect(del.status).toBe(200);
    expect(store.has('m-mine')).toBe(false);
  });

  it('实例没接地址台账时退回 403，而不是放行', async () => {
    // 拿不到台账就等于「地址必须属于本项目」这条规则没法判——
    // 此时放行等于把规则悄悄跳过（形状 2：链路只建一半）。
    const { app } = makeApp({ projectId: PROJECT, withHosts: false });
    const res = await call(app, 'POST', '/api/uptime/monitors', healthJsonOn(OWN_HOST));
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('未启用');
  });
});

describe('管理员身份行为不变', () => {
  it('管理员仍可加 keyword、任意地址，并记为人类来源', async () => {
    const { app, store } = makeApp({});
    const res = await call(app, 'POST', '/api/uptime/monitors', {
      kind: 'keyword', url: `https://${OTHER_HOST}/`, keyword: 'ok',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const saved = [...store.values()][0];
    expect(saved.createdBy).toBe('alice');
    expect(saved.createdByKind).toBe('human');
    expect(saved.origin).toBe('manual');
    // 管理员加的不绑分支：那是人明确要盯的东西，不该因为某条分支没了就替他删掉
    expect(saved.boundBranchId).toBeUndefined();
  });
});
