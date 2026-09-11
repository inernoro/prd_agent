/*
 * 守卫：项目负责人第一屏的判据。
 *
 * 用户 2026-09-10 的问题原文：「作为项目的负责人，如何直观的看到自己项目、
 * 测试环境正式环境下、主分支的健康状态，如果新增了个性化监控如何直观看到
 * （最好是第一屏）」。
 *
 * 这里断言的就是那一屏说什么话，尤其三条最容易写错的：
 *   1. 被动监控样本为 0 时**不算绿**——那不是正常，是没人用过；
 *   2. 一部分环境坏、另一部分好时要**说出归因**，那是最有价值的一句；
 *   3. 一条业务监控都没有时，绝不能说「一切正常」。
 */
import { describe, expect, it } from 'vitest';

import { MONITOR_ENVIRONMENT_ORDER } from '../../src/services/monitor-environment.js';
import {
  ENVIRONMENT_ORDER,
  assessCell,
  buildAttribution,
  buildBusinessRows,
  buildOwnerBoard,
  describeRow,
} from '../../web/src/lib/ownerBoard.js';
import type { MonitorEnvironment, UptimeTargetSummary } from '../../web/src/lib/monitorCenter.js';

const LABELS: Record<MonitorEnvironment, string> = {
  production: '生产',
  staging: '预发',
  other: '其他',
  preview: '分支预览',
};

function target(over: Partial<UptimeTargetSummary> & { name: string; environment: MonitorEnvironment }): UptimeTargetSummary {
  return {
    id: `monitor@${over.name}-${over.environment}`,
    source: 'custom',
    branchId: '',
    projectId: 'map',
    profileId: 'p',
    probeKind: 'http',
    status: 'up',
    lastSample: null,
    availability24h: 1,
    availability7d: 1,
    avgLatencyMs24h: 120,
    sampleCount24h: 10,
    buckets: [],
    openIncidentSince: null,
    statusSince: null,
    incidentCount: 0,
    probeDescription: '',
    intervalSeconds: 21600,
    timeoutMs: 8000,
    measured: true,
    environmentLabel: LABELS[over.environment],
    observeMode: 'active',
    ...over,
  } as UptimeTargetSummary;
}

function infra(over: Partial<UptimeTargetSummary> = {}): UptimeTargetSummary {
  return target({ name: '容器', environment: 'preview', ...over, source: 'branch' } as never);
}

describe('环境顺序前后端同源', () => {
  it('前端的展示顺序与后端的判定顺序逐项相等', () => {
    // 两边各写一份、各自漂移，同一个目标会在不同页面落进不同的环境组，
    // 而且不会有任何东西变红（predicate-and-wiring-discipline 形状 3）。
    expect([...ENVIRONMENT_ORDER]).toEqual([...MONITOR_ENVIRONMENT_ORDER]);
  });
});

describe('一格的档位判定', () => {
  it('被动监控窗口内 0 次调用不算绿', () => {
    const t = target({ name: '网关稳定度', environment: 'production', observeMode: 'passive', sampleCount: 0 });
    expect(t.status).toBe('up');
    expect(assessCell(t)).toBe('stale');
  });

  it('被动监控有样本时才算绿', () => {
    expect(assessCell(target({ name: 'x', environment: 'production', observeMode: 'passive', sampleCount: 12840 }))).toBe('up');
  });

  it('主动监控不看样本量 —— 它自己就是那次调用', () => {
    expect(assessCell(target({ name: 'x', environment: 'production', sampleCount: 0 }))).toBe('up');
  });

  it('故障优先于一切', () => {
    expect(assessCell(target({ name: 'x', environment: 'production', status: 'down', observeMode: 'passive', sampleCount: 0 }))).toBe('down');
  });

  it('未实测（按容器状态判定）不算绿', () => {
    expect(assessCell(target({ name: 'x', environment: 'production', measured: false }))).toBe('unknown');
  });

  it('暂停的不算故障也不算正常', () => {
    expect(assessCell(target({ name: 'x', environment: 'production', enabled: false }))).toBe('unknown');
  });
});

describe('同名监控按环境并成一行业务', () => {
  const rows = buildBusinessRows([
    target({ name: '视觉创作 · 生图', environment: 'preview' }),
    target({ name: '视觉创作 · 生图', environment: 'production' }),
    target({ name: '视觉创作 · 生图', environment: 'staging', status: 'down', lastSample: { t: 1, up: false, ms: 9100, code: 200, err: 'image.height=512，期望 eq 1024' } }),
    target({ name: '文学创作 · 生成文章', environment: 'production' }),
    infra(),
  ]);

  it('业务只认自定义监控，容器与端口不进这一屏', () => {
    expect(rows.map((r) => r.name)).toEqual(['视觉创作 · 生图', '文学创作 · 生成文章']);
  });

  it('同一条业务的多个环境并排，按关注度排序', () => {
    expect(rows[0].cells.map((c) => c.environment)).toEqual(['production', 'staging', 'preview']);
  });

  it('异常置顶', () => {
    expect(rows[0].worst).toBe('down');
    expect(rows[1].worst).toBe('up');
  });

  it('坏的那一格带得出当时的实际值', () => {
    expect(rows[0].cells.find((c) => c.health === 'down')?.reason).toContain('image.height=512');
  });
});

describe('归因：坏的与好的并排能说出什么', () => {
  const cell = (environment: MonitorEnvironment, health: 'up' | 'down') => ({
    environment, label: LABELS[environment], short: '?', health, targetId: 't',
  } as never);

  it('一部分坏一部分好时指出问题在哪一侧的配置', () => {
    const text = buildAttribution([cell('production', 'up'), cell('staging', 'down'), cell('preview', 'up')]);
    expect(text).toContain('只有预发坏');
    expect(text).toContain('配置');
  });

  it('全都坏时说不出归因就不说 —— 不硬凑一句', () => {
    expect(buildAttribution([cell('production', 'down'), cell('staging', 'down')])).toBeUndefined();
  });

  it('全都好时也不说', () => {
    expect(buildAttribution([cell('production', 'up')])).toBeUndefined();
  });
});

describe('第一屏说什么', () => {
  it('一条业务监控都没有时绝不说「一切正常」', () => {
    const board = buildOwnerBoard([infra(), infra({ name: '端口' })]);
    expect(board.tone).toBe('empty');
    expect(board.headline).toContain('还没有一条业务监控');
    expect(board.detail).toContain('不说明业务还能用');
    expect(board.headline).not.toContain('正常');
  });

  it('有故障时第一句指名道姓，并带上归因', () => {
    const board = buildOwnerBoard([
      target({ name: '视觉创作 · 生图', environment: 'production' }),
      target({ name: '视觉创作 · 生图', environment: 'staging', status: 'down', lastSample: { t: 1, up: false, ms: 9100, err: 'image.height=512，期望 eq 1024' } }),
      target({ name: '文学创作 · 生成文章', environment: 'production' }),
    ]);
    expect(board.tone).toBe('danger');
    expect(board.headline).toBe('视觉创作 · 生图 在「预发」挂了，其余 1 项业务正常');
    expect(board.detail).toContain('image.height=512');
    expect(board.detail).toContain('只有预发坏');
  });

  it('没有故障但有零样本时，第一句说的是「绿灯不作数」', () => {
    const board = buildOwnerBoard([
      target({ name: '网关 · 稳定程度', environment: 'production', observeMode: 'passive', sampleCount: 0 }),
      target({ name: '文学创作 · 生成文章', environment: 'production' }),
    ]);
    expect(board.tone).toBe('warn');
    expect(board.headline).toContain('绿灯不作数');
    expect(board.detail).toContain('网关 · 稳定程度');
  });

  it('全好时给出业务数与环境数，并单独提醒基础设施的异常', () => {
    const board = buildOwnerBoard([
      target({ name: 'A', environment: 'production' }),
      target({ name: 'A', environment: 'staging' }),
      infra({ status: 'down' }),
    ]);
    expect(board.headline).toBe('1 项业务在 2 个环境都正常');
    expect(board.detail).toContain('基础设施有 1 项异常');
    expect(board.tone).toBe('warn');
  });

  it('基础设施折叠成一行：项数、覆盖环境数，以及其中多少是分支预览', () => {
    const board = buildOwnerBoard([
      target({ name: 'A', environment: 'production' }),
      infra({ environment: 'preview' }),
      infra({ name: '端口', environment: 'production' }),
    ]);
    expect(board.infra).toEqual({ total: 2, down: 0, environments: 2, preview: 1 });
  });

  it('基础设施可以统计到环境筛选之外 —— 被挡掉的分支预览不许凭空消失', () => {
    // 业务视角只看生产（默认不含分支预览），但「塌了要知道」这件事不该被业务视角过滤掉：
    // 否则用户会问「我明明有 170 个目标，这里怎么只剩 2 个」。
    const all = [
      target({ name: 'A', environment: 'production' }),
      infra({ name: '端口', environment: 'production' }),
      infra({ name: '容器1', environment: 'preview' }),
      infra({ name: '容器2', environment: 'preview' }),
    ];
    const scoped = all.filter((t) => t.environment === 'production');
    const board = buildOwnerBoard(scoped, all);
    expect(board.rows).toHaveLength(1);
    expect(board.infra.total).toBe(3);
    expect(board.infra.preview).toBe(2);
  });
});

/**
 * 卡片文案与判据必须用同一个样本量。
 *
 * 2026-09-11 真视觉验收在截图上抓到的：一张卡片写着「窗口内 0 次真实调用」，
 * 判据却判它正常。因为文案用 `sampleCount ?? 0` 兜底，把「这一轮没读到」
 * 显示成了 0，而判据把 undefined 当「没读到」——页面上的数和系统认的数
 * 不是同一个（predicate-and-wiring-discipline 形状 6）。
 */
describe('卡片读数与判据同源', () => {
  const row = (sampleCount: number | undefined) => {
    const t = target({ name: 'X', environment: 'production', observeMode: 'passive', ...(sampleCount === undefined ? {} : { sampleCount }) });
    return buildBusinessRows([t])[0];
  };

  it('读不到样本量时照实说读不到，绝不显示成 0', () => {
    const r = row(undefined);
    expect(describeRow(r)).toBe('被动观测，这一轮没读到样本量');
    expect(describeRow(r)).not.toContain('0 次');
  });

  it('读到 0 时既显示 0，也判「绿灯不作数」—— 两边同一个值', () => {
    const r = row(0);
    expect(r.worst).toBe('stale');
    expect(describeRow(r)).toContain('0 次真实调用，绿灯不作数');
  });

  it('读到正数时显示那个数', () => {
    expect(describeRow(row(13))).toContain('窗口内 13 次真实调用');
  });
});
