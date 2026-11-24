/*
 * 守卫：演练视图。
 *
 * 它要守的东西比别的守卫更绕一层——演练**本身就是一个取证工具**，所以这里断言的不是
 * 「演练代码会返回什么」，而是「把演练造的输入喂给真实判据，真实判据会说哪句话」。
 * 只测前者就等于给一份假证据发了一张假证书。
 *
 * 五档正好是 headline 的优先级阶梯（停摆 > 故障 > 逾期 > 零样本 > 全部正常），
 * 所以这一组用例顺带也是那条阶梯的回归。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildOwnerBoard } from '../../web/src/lib/ownerBoard.js';
import { REHEARSALS, applyRehearsal, rehearsalById } from '../../web/src/lib/rehearsal.js';
import type { MonitorEnvironment, UptimeTargetSummary } from '../../web/src/lib/monitorCenter.js';

const NOW = 1_700_000_000_000;
const LABELS: Record<MonitorEnvironment, string> = {
  production: '生产', staging: '预发', other: '其他', preview: '分支预览',
};

function target(over: Partial<UptimeTargetSummary> & { name: string; environment: MonitorEnvironment }): UptimeTargetSummary {
  return {
    id: `monitor@${over.name}-${over.environment}`,
    source: 'custom',
    branchId: '', projectId: 'map', profileId: 'p', probeKind: 'http',
    status: 'up',
    lastSample: { t: NOW - 10_000, up: true, ms: 80 },
    availability24h: 1, availability7d: 1, avgLatencyMs24h: 120, sampleCount24h: 10,
    buckets: [], openIncidentSince: null, statusSince: null, incidentCount: 0,
    probeDescription: '', intervalSeconds: 600, timeoutMs: 8000, measured: true,
    environmentLabel: LABELS[over.environment], observeMode: 'active',
    ...over,
  } as UptimeTargetSummary;
}

const HEALTHY = [
  target({ name: 'MAP 后端', environment: 'production' }),
  target({ name: 'MAP 数据库', environment: 'production' }),
];
const LIVE_CTX = { now: NOW, prober: { stalled: false, lastCycleAt: NOW - 20_000 } };

function boardOf(id: Parameters<typeof applyRehearsal>[0], targets = HEALTHY): ReturnType<typeof buildOwnerBoard> {
  const stage = applyRehearsal(id, { targets, ctx: LIVE_CTX });
  return buildOwnerBoard(stage.targets, stage.targets, stage.ctx);
}

describe('演练：判据不变，只换输入', () => {
  it('真实档不动任何东西', () => {
    const stage = applyRehearsal('live', { targets: HEALTHY, ctx: LIVE_CTX });
    expect(stage.targets).toBe(HEALTHY);
    expect(stage.ctx).toBe(LIVE_CTX);
    expect(stage.changed).toBeUndefined();
    expect(boardOf('live').tone).toBe('ok');
  });

  // 这一档是整个功能的存在理由：健康系统上它演示不出来，而它恰恰盖过其余全部结论。
  it('停摆档让面板收回下面所有绿灯', () => {
    const board = boardOf('prober-stalled');
    expect(board.headline).toContain('探测器停摆');
    expect(board.tone).toBe('danger');
    // 它必须**盖过**别的结论：这批目标本身全绿，绿的那句话不许出现。
    expect(board.headline).not.toContain('都正常');
  });

  it('故障档置顶那一条，并说出是哪个环境', () => {
    const board = boardOf('down');
    expect(board.tone).toBe('danger');
    expect(board.headline).toContain('MAP 后端');
    expect(board.headline).toContain('生产');
    expect(board.rows[0]?.worst).toBe('down');
  });

  // 第二个演示不出来的档：探针健康时单条监控在数学上够不到 3 个间隔那条线。
  it('逾期档说绿灯不作数，且不被停摆盖住', () => {
    const board = boardOf('overdue');
    expect(board.headline).toContain('早该被检查');
    expect(board.headline).not.toContain('探测器停摆');
    expect(board.tone).toBe('warn');
    expect(board.rows[0]?.worst).toBe('overdue');
  });

  it('零样本档不算绿', () => {
    const board = boardOf('stale');
    expect(board.headline).toContain('没有真实调用');
    expect(board.rows[0]?.worst).toBe('stale');
  });

  it('五档的顺序就是 headline 的优先级阶梯', () => {
    expect(REHEARSALS.map((r) => r.id)).toEqual(['live', 'prober-stalled', 'down', 'overdue', 'stale']);
  });

  it('每一档都说得出自己动了什么', () => {
    for (const item of REHEARSALS) {
      const stage = item.apply({ targets: HEALTHY, ctx: LIVE_CTX });
      if (item.id === 'live') expect(stage.changed).toBeUndefined();
      else expect(stage.changed && stage.changed.length > 0).toBe(true);
      expect(item.proves.length).toBeGreaterThan(8);
    }
  });

  // 「演不了」必须说出来。静默退回真实数据会让人对着一屏真实的绿灯以为看的是演练结果。
  it('没有业务监控时明说演不了，而不是静默退回真实', () => {
    const infraOnly = [target({ name: '容器', environment: 'production', source: 'branch' as never })];
    for (const item of REHEARSALS) {
      const stage = item.apply({ targets: infraOnly, ctx: LIVE_CTX });
      if (item.id === 'live') continue;
      expect(stage.blocked).toContain('还没有业务监控');
      expect(stage.changed).toBeUndefined();
    }
  });

  it('未知档位退回真实，不抛错', () => {
    expect(rehearsalById('nope' as never).id).toBe('live');
  });
});

/**
 * 扫源码前先把注释去掉。
 *
 * 第一版忘了这一步，于是文件顶部那句「不许出现 fetch / apiRequest」的说明**自己**
 * 撞红了守卫——判据读的不是真正生效的那个值（形状 6），只是这次读到的是它自己的说明书。
 * 块注释只认行首那种，否则字符串里的 `'/api/*'` 会把后面整段吃掉（同一个坑上次也踩过）。
 */
function stripComments(source: string): string {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/\/\/.*$/gm, '');
}

describe('演练是只读的', () => {
  const src = stripComments(readFileSync(fileURLToPath(new URL('../../web/src/lib/rehearsal.ts', import.meta.url)), 'utf8'));

  // 纯函数是这个工具敢被信任的前提：它只造给屏幕看的输入，绝不碰真实世界。
  it('不发任何请求、不写任何东西', () => {
    for (const forbidden of ['apiRequest', 'fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage']) {
      expect(src.includes(forbidden), `rehearsal.ts 不该出现 ${forbidden}`).toBe(false);
    }
  });

  it('不自己算结论——判据只许从 ownerBoard 来', () => {
    // 出现这些名字就说明演练开始自己判了，那正是形状 3（判据分裂）的长相。
    for (const forbidden of ['buildOwnerBoard', 'buildGlobalBoard', 'assessCell', 'headline']) {
      expect(src.includes(forbidden), `rehearsal.ts 不该出现 ${forbidden}`).toBe(false);
    }
  });
});

describe('演练接上线了', () => {
  const src = readFileSync(fileURLToPath(new URL('../../web/src/pages/status/OwnerBoard.tsx', import.meta.url)), 'utf8');

  // 形状 2：建好了没人调用，删掉也不会红。
  it('面板真的调了 applyRehearsal 并渲染了档位', () => {
    expect(src).toMatch(/applyRehearsal\(rehearsal/);
    expect(src).toMatch(/REHEARSALS\.map/);
  });

  it('演练期间仍然算并展示真实结论', () => {
    // 少了这一句，演练就成了一块能盖住真实故障的幕布。
    expect(src).toMatch(/rehearsing \? buildBundle\(targets/);
    expect(src).toContain('此刻真实结论');
  });

  it('演练期间禁用真实写操作', () => {
    expect(src).toContain('disabled={rehearsing}');
    expect(src).toContain('statusPageBusy || rehearsing');
  });

  it('卡片带演练标，横幅也挂牌', () => {
    expect(src).toContain('rehearsing ? <RehearsalMark /> : null');
    expect(src).toContain('演练中 —— 下面这一屏的数据是假的');
  });
});
