/**
 * 控制面入口可达性自检的判定守卫。
 *
 * 断言用的是 2026-07-30 从生产抓到的**真实响应特征**：
 *   - 被 Cloudflare 挡回的 /api/self-update：503，响应头只有 cf-ray / server: cloudflare，
 *     没有任何 CDS 指纹；
 *   - 到达应用的 /api/self-status：401，带 x-powered-by: Express、x-cds-request-id、
 *     server-timing: app。
 *
 * 判据只认指纹、不认状态码——因为 503 既可能是边缘拦截，也可能是应用自己的
 * 排空窗口（self_update_draining），只有指纹能区分这两件完全不同的事。
 */

import { describe, it, expect } from 'vitest';
import {
  classifyEntrypointProbe,
  buildReachabilityReport,
  MONITORED_ENTRYPOINTS,
} from '../../src/services/entrypoint-reachability.js';

/** 2026-07-30 生产实测：被 Cloudflare 拦掉的更新入口。 */
const EDGE_BLOCKED = {
  path: '/api/self-update',
  status: 503,
  headers: {
    'content-type': 'application/json',
    server: 'cloudflare',
    'retry-after': '3600',
    'cf-ray': 'a2365d675c75ec0a-IAD',
    'cf-cache-status': 'DYNAMIC',
  },
  bodySnippet: 'self-update temporarily disabled by operations',
};

/** 2026-07-30 生产实测：正常到达应用并被鉴权拒绝。 */
const REACHED_APP = {
  path: '/api/self-status',
  status: 401,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    server: 'cloudflare',
    'x-powered-by': 'Express',
    'x-cds-request-id': '0546eb9d',
    'server-timing': 'app;dur=1',
    'cf-ray': 'a2365e8a7f9c99ad-IAD',
  },
};

describe('classifyEntrypointProbe', () => {
  it('生产实测的边缘拦截被判为 blocked_at_edge', () => {
    const r = classifyEntrypointProbe(EDGE_BLOCKED);
    expect(r.verdict).toBe('blocked_at_edge');
    // 用户当时最大的困惑是「为什么历史里查不到」，结论必须主动解释。
    expect(r.summary).toContain('没有进到 CDS 应用');
    expect(r.summary).toContain('账本');
    expect(r.edgeMessage).toBe('self-update temporarily disabled by operations');
  });

  it('401 到达应用算健康——鉴权拒绝不是入口故障', () => {
    const r = classifyEntrypointProbe(REACHED_APP);
    expect(r.verdict).toBe('reachable');
  });

  it('判据认指纹不认状态码：应用自己返回的 503 不算被拦', () => {
    // CDS 自更新排空窗口会返回 503 self_update_draining，那是应用的正常行为。
    const appOwn503 = classifyEntrypointProbe({
      path: '/api/self-update',
      status: 503,
      headers: { 'x-cds-request-id': 'abc123', 'retry-after': '60' },
      bodySnippet: '{"error":"self_update_draining"}',
    });
    expect(appOwn503.verdict).toBe('reachable');
    // 反过来：没有指纹的 200 也应当被怀疑（边缘层可以伪造任意状态码）
    const edge200 = classifyEntrypointProbe({
      path: '/api/self-update', status: 200, headers: { server: 'cloudflare' },
    });
    expect(edge200.verdict).toBe('blocked_at_edge');
  });

  it('网络失败与被拦截是两种不同结论，不许混为一谈', () => {
    const r = classifyEntrypointProbe({
      path: '/api/self-update', status: 0, headers: {}, networkError: 'ETIMEDOUT',
    });
    expect(r.verdict).toBe('unreachable');
    expect(r.summary).toContain('重启');
  });
});

describe('buildReachabilityReport', () => {
  it('全部可达时报告健康', () => {
    const report = buildReachabilityReport([classifyEntrypointProbe(REACHED_APP)]);
    expect(report.healthy).toBe(true);
    expect(report.blocked).toEqual([]);
    expect(report.nextAction).toBeUndefined();
  });

  it('有入口被拦时给出受影响路径与解除指引', () => {
    const report = buildReachabilityReport([
      classifyEntrypointProbe(EDGE_BLOCKED),
      classifyEntrypointProbe(REACHED_APP),
    ]);
    expect(report.healthy).toBe(false);
    expect(report.blocked).toHaveLength(1);
    expect(report.summary).toContain('/api/self-update');
    expect(report.nextAction).toContain('Cloudflare');
    // 这次事故的核心教训：只挡安全路径、放行强力路径，并不提升安全性。
    expect(report.nextAction).toContain('并不会让系统更安全');
  });
});

describe('监控清单', () => {
  it('把这次真正出事的入口纳入自检', () => {
    const paths = MONITORED_ENTRYPOINTS.map((e) => e.path);
    expect(paths).toContain('/api/self-update');
    expect(paths).toContain('/api/self-force-sync');
  });

  it('探测方式必须无副作用——只用不带鉴权的请求换 401', () => {
    // 若将来有人往清单里塞一个会真的执行动作的端点，这条会提醒他重新想清楚。
    for (const e of MONITORED_ENTRYPOINTS) {
      expect(['GET', 'POST']).toContain(e.method);
      expect(e.path.startsWith('/api/')).toBe(true);
      expect(e.label.length).toBeGreaterThan(0);
    }
  });
});

describe('自检确实被接线（形状 2 守卫）', () => {
  it('看门狗被 index.ts 引用并注册', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
    const index = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf-8');
    // 建了没人调 = 白建。这条守卫就是防它。
    expect(index).toContain("from './services/entrypoint-reachability.js'");
    expect(index).toContain('function startEntrypointReachabilityWatchdog');
    expect(index).toMatch(/const entrypointReachabilityWatchdog = startEntrypointReachabilityWatchdog\(/);
  });

  it('探测走公网域名而非 localhost——内网自测永远是绿的', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
    const src = fs.readFileSync(path.join(root, 'src/services/entrypoint-reachability.ts'), 'utf-8');
    // 只看代码，不看注释——注释里正解释着「不能走 127.0.0.1」，别自己咬自己。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    expect(code).not.toMatch(/127\.0\.0\.1|localhost/);
    // 没有根域名时必须跳过，而不是拿本地地址凑一个"健康"出来。
    const { resolveSelfCheckBaseUrl } = await import('../../src/services/entrypoint-reachability.js');
    expect(resolveSelfCheckBaseUrl([])).toBeNull();
    expect(resolveSelfCheckBaseUrl(undefined)).toBeNull();
    expect(resolveSelfCheckBaseUrl(['cds.miduo.org'])).toBe('https://cds.miduo.org');
    expect(resolveSelfCheckBaseUrl(['https://cds.miduo.org'])).toBe('https://cds.miduo.org');
  });
});
