/**
 * 存活监控的项目作用域守卫（Codex PR #1273 P1）。
 *
 * 存活监控是跨项目运维面板，人类/全局 Key 看全量；但项目级 cdsp_/cdsg_ Key
 * 只能看自己项目——否则一把项目 Key 就能枚举全实例每个项目的分支名、服务名、
 * 故障原因与时间线。
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createUptimeRouter } from '../../src/routes/uptime.js';

type Json = Record<string, unknown>;

function fakeMonitor() {
  const targets = [
    { id: 'a::api', projectId: 'proj-a', name: 'main / api', status: 'up', excluded: false },
    { id: 'b::api', projectId: 'proj-b', name: 'main / api', status: 'down', excluded: false },
  ];
  return {
    getSummary: () => ({ overall: { total: 2, up: 1, down: 1, paused: 0, unknown: 0, excluded: 0, ok: false }, targets }),
    getIncidents: () => [
      { projectId: 'proj-a', targetName: 'main / api', cause: 'a-cause' },
      { projectId: 'proj-b', targetName: 'main / api', cause: 'b-cause' },
    ],
    getRecord: (id: string) => targets.find((t) => t.id === id),
    getHistory: () => ({ points: [] }),
  } as unknown as Parameters<typeof createUptimeRouter>[0]['monitor'];
}

function appWith(projectId?: string) {
  const app = express();
  app.use((req, _res, next) => {
    if (projectId) (req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey = { projectId, keyId: 'k' };
    next();
  });
  app.use('/api', createUptimeRouter({ monitor: fakeMonitor() }));
  return app;
}

async function get(app: express.Express, url: string) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, body: (await res.json()) as Json };
  } finally {
    server.close();
  }
}

describe('存活监控项目作用域', () => {
  it('无 cdsProjectKey（人类/全局 Key）看全量', async () => {
    const res = await get(appWith(), '/api/uptime/summary');
    expect((res.body.targets as unknown[]).length).toBe(2);
  });

  it('项目级 Key 只看得到本项目目标，且总览计数按收窄后重算', async () => {
    const res = await get(appWith('proj-a'), '/api/uptime/summary');
    const targets = res.body.targets as Array<{ projectId: string }>;
    expect(targets).toHaveLength(1);
    expect(targets[0]!.projectId).toBe('proj-a');
    expect(res.body.overall).toMatchObject({ total: 1, up: 1, down: 0, ok: true });
  });

  it('项目级 Key 的故障时间线不含别的项目', async () => {
    const res = await get(appWith('proj-a'), '/api/uptime/incidents');
    const list = res.body.incidents as Array<{ projectId: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.projectId).toBe('proj-a');
  });

  it('项目级 Key 读别的项目的 target 详情必须 403', async () => {
    const res = await get(appWith('proj-a'), '/api/uptime/targets/b%3A%3Aapi/history');
    expect(res.status).toBe(403);
  });
});
