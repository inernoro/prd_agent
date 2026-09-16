/**
 * 自检端点列表里的「上一轮结果」只摆本项目端点那几条（Codex #1543 P2）。
 *
 * 对账一轮是全实例一起跑的；以前原样下发，项目 A 的芯片会把项目 B 打不通的端点、
 * 项目 B 发现的监控数都算进自己头上——健康的项目显示成警告，数字也是别人的。
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createUptimeRouter } from '../../src/routes/uptime.js';

const SHARED = 'https://shared.example.test/api/self-check';
const ENDPOINTS: Record<string, string[]> = {
  'proj-a': ['https://a.example.test/api/self-check', SHARED],
  'proj-b': ['https://b.example.test/api/self-check', 'https://b2.example.test/api/self-check', SHARED],
};

const lastRun = {
  at: '2026-09-16T14:00:00.000Z',
  orphansRemoved: 0,
  endpoints: [
    { projectId: 'proj-a', url: 'https://a.example.test/api/self-check', reachable: true, discovered: 3, rejected: [], added: 0, updated: 3, removed: 0, heldBecauseUnreachable: false },
    // 同一个 URL 被两个项目各登记一次：各有各的一条结果，A 那次通、B 那次没通
    { projectId: 'proj-a', url: SHARED, reachable: true, discovered: 2, rejected: [], added: 0, updated: 2, removed: 0, heldBecauseUnreachable: false },
    { projectId: 'proj-b', url: 'https://b.example.test/api/self-check', reachable: false, err: 'ECONNREFUSED', discovered: 0, rejected: [], added: 0, updated: 0, removed: 0, heldBecauseUnreachable: true },
    { projectId: 'proj-b', url: 'https://b2.example.test/api/self-check', reachable: true, discovered: 5, rejected: [], added: 0, updated: 5, removed: 0, heldBecauseUnreachable: false },
    { projectId: 'proj-b', url: SHARED, reachable: false, err: 'timeout', discovered: 0, rejected: [], added: 0, updated: 0, removed: 0, heldBecauseUnreachable: true },
  ],
};

function app(): express.Express {
  const a = express();
  a.use('/api', createUptimeRouter({
    monitor: {} as never,
    store: {} as never,
    listMonitorEndpoints: (projectId) => ENDPOINTS[projectId] || [],
    lastDiscoveryRun: () => lastRun as never,
  }));
  return a;
}

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app().listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe('GET /api/projects/:id/monitor-endpoints 的 lastRun 按项目收窄', () => {
  it('项目 A 只看到自己那几条端点的结果：不带 B 打不通的端点，发现数也不是 B 的', async () => {
    const res = await get('/api/projects/proj-a/monitor-endpoints');
    expect(res.status).toBe(200);
    const run = res.body.lastRun as typeof lastRun;
    expect(run.endpoints.map((e) => e.url)).toEqual(ENDPOINTS['proj-a']);
    expect(run.endpoints.every((e) => e.projectId === 'proj-a')).toBe(true);
    expect(run.endpoints.every((e) => e.reachable)).toBe(true);
    expect(run.endpoints.reduce((n, e) => n + e.discovered, 0)).toBe(5);
    expect(run.at).toBe(lastRun.at);
  });

  it('项目 B 看到自己三条（含两条打不通的），看不到 A 的；共用的那个 URL 只认 B 自己那次（Codex #1543 P2）', async () => {
    const res = await get('/api/projects/proj-b/monitor-endpoints');
    const run = res.body.lastRun as typeof lastRun;
    expect(run.endpoints.map((e) => e.url).sort()).toEqual([...ENDPOINTS['proj-b']].sort());
    expect(run.endpoints).toHaveLength(3);
    expect(run.endpoints.filter((e) => !e.reachable)).toHaveLength(2);
    // 只认 URL 会把 A 那次通的结果也算给 B（双算）：这里必须是 B 自己那条 timeout
    expect(run.endpoints.find((e) => e.url === SHARED)).toMatchObject({ projectId: 'proj-b', reachable: false, err: 'timeout' });
  });

  it('没插过端点的项目：清单空、上一轮结果也是空的，不是别人的', async () => {
    const res = await get('/api/projects/proj-none/monitor-endpoints');
    expect(res.body.endpoints).toEqual([]);
    expect((res.body.lastRun as typeof lastRun).endpoints).toEqual([]);
  });
});
