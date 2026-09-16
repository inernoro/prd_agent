/*
 * 守卫：环境判定认「地址指着谁」，不认「谁登记的」。
 *
 * 用户 2026-09-10 的担忧原话：「我怕有些临时分支把自己的错误的预览地址添加进去，
 * 导致出现一些失效的问题」。落到第一屏上就是：一条指着临时分支的监控绝不能
 * 被算成生产、混进项目负责人的第一屏。
 *
 * 这条判据此前只在 Agent 自助登记那条路上成立（靠 boundBranchId），
 * 管理员手动加的、以及这个字段出现之前登记的存量监控，全都漏。
 * 拿一条只在单条路径上成立的证据当契约成立 —— predicate-and-wiring-discipline 形状 8。
 */
import { describe, expect, it } from 'vitest';

import {
  MONITOR_ENVIRONMENT_ORDER,
  monitorEnvironmentLabel,
  normalizeMonitorEnvironment,
  resolveMonitorEnvironment,
} from '../../src/services/monitor-environment.js';
import { UptimeMonitorService } from '../../src/services/uptime-monitor.js';
import type { UptimeCustomMonitor } from '../../src/types.js';

describe('环境归一', () => {
  it('只认四个字面量，其余一律生产（与发布中心同口径）', () => {
    expect(normalizeMonitorEnvironment('staging')).toBe('staging');
    expect(normalizeMonitorEnvironment('preview')).toBe('preview');
    expect(normalizeMonitorEnvironment(undefined)).toBe('production');
    expect(normalizeMonitorEnvironment('随便写的')).toBe('production');
  });

  it('展示顺序 = 关注度顺序，分支预览垫底', () => {
    expect([...MONITOR_ENVIRONMENT_ORDER]).toEqual(['production', 'staging', 'other', 'preview']);
    expect(monitorEnvironmentLabel('preview')).toBe('分支预览');
    expect(monitorEnvironmentLabel('production')).toBe('生产');
  });
});

describe('结构性证据优先于声明', () => {
  it('地址指着分支预览时，自称 production 也算分支预览', () => {
    expect(resolveMonitorEnvironment({
      source: 'custom', declared: 'production', previewBranchId: 'branch-x',
    })).toBe('preview');
  });

  it('存量数据只有 boundBranchId 时同样算数', () => {
    expect(resolveMonitorEnvironment({
      source: 'custom', declared: 'production', boundBranchId: 'branch-x',
    })).toBe('preview');
  });

  it('分支来源的探测目标恒为分支预览，不看别的字段', () => {
    expect(resolveMonitorEnvironment({ source: 'branch', declared: 'production' })).toBe('preview');
  });

  it('发布目标读发布中心配好的环境，不读监控自己的声明', () => {
    expect(resolveMonitorEnvironment({
      source: 'release', declared: 'preview', releaseEnvironment: 'staging',
    })).toBe('staging');
  });

  it('没有任何结构性证据时才用声明值', () => {
    expect(resolveMonitorEnvironment({ source: 'custom', declared: 'staging' })).toBe('staging');
  });
});

/** 摘要层的接线：没有它，上面那些判定一条都到不了页面。 */
describe('摘要按地址反查分支预览（存量监控没有戳也要判对）', () => {
  const PREVIEW_HOST = 'feat-x-proj-a.preview.test';

  function serviceWith(monitor: UptimeCustomMonitor, wired: boolean) {
    return new UptimeMonitorService({
      state: {
        getAllBranches: () => [],
        getProject: () => undefined as never,
        getUptimeMonitors: () => [monitor],
      } as never,
      config: {
        enabled: true, intervalMs: 60_000, timeoutMs: 5_000, failureThreshold: 3,
        excludePatterns: [], repoRoot: '/tmp', statePath: '/tmp/uptime-test.json',
      } as never,
      ...(wired ? {
        listProjectPreviewHosts: (projectId: string) => (projectId === 'proj-a'
          ? [{ branchId: 'branch-feat-x', host: PREVIEW_HOST }]
          : []),
      } : {}),
    });
  }

  const monitor = {
    id: 'mon-1', name: '网关 · 稳定程度', kind: 'functional',
    url: `https://${PREVIEW_HOST}/gw/v1/healthz/deep`,
    projectId: 'proj-a', environment: 'production', observeMode: 'passive',
    enabled: true, createdAt: 'now', updatedAt: 'now',
  } as unknown as UptimeCustomMonitor;

  function environmentOf(svc: UptimeMonitorService): string | undefined {
    // 造一条 custom 台账记录，走真实的 getSummary 而不是直接调私有方法。
    const records = (svc as unknown as { records: Map<string, unknown> }).records;
    records.set('monitor@mon-1', {
      id: 'monitor@mon-1', source: 'custom', branchId: '', projectId: 'proj-a',
      profileId: 'mon-1', name: '网关 · 稳定程度', probeKind: 'url',
      status: 'up', consecutiveFailures: 0, consecutiveSuccesses: 1,
      samples: [], daily: [], incidents: [], lastSample: null, firstSeenAt: 0,
    });
    return svc.getSummary(10).targets.find((t) => t.id === 'monitor@mon-1')?.environment;
  }

  it('接上地址台账时，自称 production 的监控被判成分支预览', () => {
    expect(environmentOf(serviceWith(monitor, true))).toBe('preview');
  });

  it('没接台账时如实退回声明值 —— 不猜，但这是已知退化', () => {
    expect(environmentOf(serviceWith(monitor, false))).toBe('production');
  });

  it('地址不在台账上的监控保持声明值', () => {
    const prod = { ...monitor, url: 'https://prod.example.com/healthz' } as UptimeCustomMonitor;
    expect(environmentOf(serviceWith(prod, true))).toBe('production');
  });
});

/**
 * 接线守卫。上面的判定全对，也可能一条都到不了页面——
 * 把 index.ts 里那一行注入删掉，编译照样过、全量测试照样绿
 * （predicate-and-wiring-discipline 形状 2：链路只建一半）。
 */
describe('index.ts 真的把地址台账注给了监控服务', () => {
  it('UptimeMonitorService 的构造块里有 listProjectPreviewHosts', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    const start = src.indexOf('new UptimeMonitorService({');
    expect(start, '找不到 UptimeMonitorService 的构造点').toBeGreaterThan(-1);
    // 扫整个构造块而不是一个固定长度的窗口：窗口写死之后，任何人在前面插几行
    // 都会把要守的那一行挤出去，守卫静默失效（2026-09-09 notice-ledger 守卫的教训）。
    const end = src.indexOf('\n  });', start);
    expect(end, '找不到构造块的收尾').toBeGreaterThan(start);
    expect(
      src.slice(start, end),
      '少了这一行，环境判定拿不到地址台账，指着临时分支的监控会被当成生产',
    ).toContain('listProjectPreviewHosts,');
  });

  it('地址台账只有一份定义 —— 写入门与环境判定不许各拼各的', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    const definitions = src.match(/const listProjectPreviewHosts\s*=/g) || [];
    expect(definitions).toHaveLength(1);
  });
});
