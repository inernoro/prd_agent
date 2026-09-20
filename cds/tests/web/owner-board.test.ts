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
  ENVIRONMENT_SHORT,
  assessCell,
  assessFreshness,
  buildAttribution,
  buildBusinessRows,
  buildOwnerBoard,
  buildGlobalBoard,
  buildProjectRows,
  defaultEnvironments,
  describeEvidence,
  describeRow,
  shortPredicate,
  shouldDrawBar,
  latestEvidence,
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
    // 默认「刚刚检查过」：这些用例测的是健康档位，不是新鲜度。
    // 留 null 会让每条都落进「还没有检查记录」，把它们要测的东西盖掉。
    lastSample: { t: 1_700_000_000_000 - 10_000, up: true, ms: 80 },
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

/**
 * 旧用例的包装：它们测的是健康档位与归因，不是新鲜度。
 * 统一按「刚刚检查过」喂进去，这样新鲜度判据的边界只由它自己那组用例负责，
 * 不会因为签名多了一个参数就把二十条无关用例的意图搅浑。
 */
const NOW = 1_700_000_000_000;
const assessCellAt = (t: UptimeTargetSummary): ReturnType<typeof assessCell> =>
  assessCell(t, assessFreshness(t, NOW));
const buildBusinessRowsAt = (ts: ReadonlyArray<UptimeTargetSummary>): ReturnType<typeof buildBusinessRows> =>
  buildBusinessRows(ts, NOW);
const buildOwnerBoardAt = (
  ts: ReadonlyArray<UptimeTargetSummary>,
  unfiltered?: ReadonlyArray<UptimeTargetSummary>,
): ReturnType<typeof buildOwnerBoard> =>
  buildOwnerBoard(ts, unfiltered ?? ts, { now: NOW, prober: { stalled: false, lastCycleAt: NOW } });

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
    expect(assessCellAt(t)).toBe('stale');
  });

  it('被动监控有样本时才算绿', () => {
    expect(assessCellAt(target({ name: 'x', environment: 'production', observeMode: 'passive', sampleCount: 12840 }))).toBe('up');
  });

  it('主动监控不看样本量 —— 它自己就是那次调用', () => {
    expect(assessCellAt(target({ name: 'x', environment: 'production', sampleCount: 0 }))).toBe('up');
  });

  it('故障优先于一切', () => {
    expect(assessCellAt(target({ name: 'x', environment: 'production', status: 'down', observeMode: 'passive', sampleCount: 0 }))).toBe('down');
  });

  it('未实测（按容器状态判定）不算绿', () => {
    expect(assessCellAt(target({ name: 'x', environment: 'production', measured: false }))).toBe('unknown');
  });

  it('暂停的不算故障也不算正常', () => {
    expect(assessCellAt(target({ name: 'x', environment: 'production', enabled: false }))).toBe('unknown');
  });
});

describe('同名监控按环境并成一行业务', () => {
  const rows = buildBusinessRowsAt([
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

describe('被动观测读不到样本数（Codex #1543 P1）', () => {
  it('sampleCount 缺失 → unknown 而不是 up；0 → stale；有数 → up', () => {
    const passive = (sampleCount: number | undefined): UptimeTargetSummary =>
      target({ name: 'p', environment: 'production', observeMode: 'passive', ...(sampleCount === undefined ? {} : { sampleCount }) });
    expect(assessCellAt(passive(undefined))).toBe('unknown');
    expect(assessCellAt(passive(0))).toBe('stale');
    expect(assessCellAt(passive(12))).toBe('up');
    const board = buildOwnerBoardAt([passive(undefined)]);
    expect(board.tone).not.toBe('ok');
    expect(board.rows[0].cells[0].reason).toContain('没读到样本量');
  });
});

describe('单项目视角：有业务还没有检查记录时不许说都正常（Codex #1543 P1）', () => {
  it('新建 / 暂停的业务单独一档警告', () => {
    const board = buildOwnerBoardAt([
      target({ name: 'ok', environment: 'production' }),
      target({ name: 'new', environment: 'production', lastSample: null, status: 'unknown' }),
    ]);
    expect(board.headline).not.toContain('都正常');
    expect(board.headline).toContain('还没有任何检查记录');
    expect(board.tone).toBe('warn');
    expect(board.detail).toContain('new');
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
    const board = buildOwnerBoardAt([infra(), infra({ name: '端口' })]);
    expect(board.tone).toBe('empty');
    expect(board.headline).toContain('还没有一条业务监控');
    expect(board.detail).toContain('不说明业务还能用');
    expect(board.headline).not.toContain('正常');
  });

  it('有故障时第一句指名道姓，并带上归因', () => {
    const board = buildOwnerBoardAt([
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
    const board = buildOwnerBoardAt([
      target({ name: '网关 · 稳定程度', environment: 'production', observeMode: 'passive', sampleCount: 0 }),
      target({ name: '文学创作 · 生成文章', environment: 'production' }),
    ]);
    expect(board.tone).toBe('warn');
    expect(board.headline).toContain('绿灯不作数');
    expect(board.detail).toContain('网关 · 稳定程度');
  });

  it('全好时给出业务数与环境数，并单独提醒基础设施的异常', () => {
    const board = buildOwnerBoardAt([
      target({ name: 'A', environment: 'production' }),
      target({ name: 'A', environment: 'staging' }),
      infra({ status: 'down' }),
    ]);
    expect(board.headline).toContain('1 项业务在 2 个环境都正常');
    // 「正常」这句话必须自带证据：什么时候检查的。少了这半句，
    // 它和「探针三天没跑、页面照样绿」长得一模一样。
    expect(board.headline).toContain('检查过');
    expect(board.detail).toContain('基础设施有 1 项异常');
    expect(board.tone).toBe('warn');
  });

  it('基础设施折叠成一行：项数、覆盖环境数，以及其中多少是分支预览', () => {
    const board = buildOwnerBoardAt([
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
    const board = buildOwnerBoardAt(scoped, all);
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
    return buildBusinessRowsAt([t])[0];
  };

  it('读不到样本量时照实说读不到，绝不显示成 0；而且判据也不判它正常（Codex #1543 P1）', () => {
    const r = row(undefined);
    expect(describeRow(r)).toContain('这一轮没读到样本量');
    expect(describeRow(r)).not.toContain('0 次');
    expect(r.worst).toBe('unknown');
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

/*
 * 以下两组守卫来自 2026-09-11 的角色化人类验收（四个角色各走一遍真实路径）。
 * 两个洞都是「编译过、测试绿、通读也挑不出」的形状，只有真人冷启动才撞得到。
 */

describe('默认环境集数的是业务监控，不是全部目标', () => {
  // 现场：一个项目有两百多个基础设施容器（含生产实例），而 6 条业务监控全在
  // 分支预览。defaultEnvironments 按全部目标数 → present=['production'] 非空 →
  // 默认只勾生产 → 第一屏空白，还写着「还没有一条业务监控」，
  // 而同一页的「全部目标」正列着这 6 条。判据读的人口不是画面渲染的人口
  // （predicate-and-wiring-discipline 形状 6）。
  it('业务监控只在分支预览时，默认就该勾分支预览（哪怕基础设施有生产实例）', () => {
    const targets = [
      target({ name: 'MAP 数据库往返耗时', environment: 'preview' }),
      target({ name: '网关 serving 近期未处理异常数', environment: 'preview' }),
      infra({ name: '容器 A', environment: 'production' } as never),
      infra({ name: '容器 B', environment: 'production' } as never),
      infra({ name: '容器 C', environment: 'preview' } as never),
    ];
    expect(defaultEnvironments(targets)).toEqual(['preview']);
  });

  it('业务监控有生产时照旧不勾分支预览', () => {
    const targets = [
      target({ name: '图片生成', environment: 'production' }),
      target({ name: '图片生成', environment: 'preview' }),
      infra({ name: '容器 A', environment: 'preview' } as never),
    ];
    expect(defaultEnvironments(targets)).toEqual(['production']);
  });

  it('一条业务监控都没有时退回全部目标，不许返回空集', () => {
    const targets = [infra({ name: '容器 A', environment: 'production' } as never)];
    expect(defaultEnvironments(targets)).toEqual(['production']);
  });
});

describe('空白第一屏必须分清「真没有」和「被筛选挡住」', () => {
  const hiddenOnes = [
    target({ name: 'MAP 数据库往返耗时', environment: 'preview' }),
    target({ name: '网关 serving 近期未处理异常数', environment: 'preview' }),
  ];

  it('业务监控全被环境筛选挡住时，不许说「还没有一条业务监控」', () => {
    const board = buildOwnerBoardAt([], hiddenOnes);
    expect(board.headline).not.toContain('还没有');
    expect(board.headline).toContain('2');
    expect(board.hiddenEnvironments).toEqual(['preview']);
    // 只说「它们在分支预览」不够，得让 UI 给得出一键切换的那个值。
    expect(board.tone).toBe('warn');
  });

  it('真的一条业务监控都没有时才说「还没有一条业务监控」', () => {
    const board = buildOwnerBoardAt([], [infra({ name: '容器 A', environment: 'production' } as never)]);
    expect(board.headline).toBe('还没有一条业务监控');
    expect(board.hiddenEnvironments).toBeUndefined();
  });

  it('有行可画时永远不带 hiddenEnvironments（不留半态）', () => {
    const rows = [target({ name: '图片生成', environment: 'production' })];
    const board = buildOwnerBoardAt(rows, [...rows, ...hiddenOnes]);
    expect(board.rows).toHaveLength(1);
    expect(board.hiddenEnvironments).toBeUndefined();
  });
});

/*
 * 以下是「面板四问」的判据守卫。来源是用户 2026-09-14 的原话：
 *
 *   「满足我一眼知道，他干活了，干了什么活，哪些活出现了问题，当然：我天生谨慎，
 *     我还得看到没有出现问题的证据，避免因为程序没有跑，而跳过了。」
 *
 * 判定口诀：**把探测器关掉，面板会不会照样说「全部正常」？**
 * 会 —— 那就是这一组守卫要拦的东西。
 */

const HOUR = 3_600_000;
const probed = (ageMs: number, intervalSeconds: number): Partial<UptimeTargetSummary> => ({
  lastSample: { t: NOW - ageMs, up: true, ms: 50 },
  intervalSeconds,
});

describe('Q1/Q4 检查有没有真的发生过（新鲜度）', () => {
  it('间隔之内算新鲜', () => {
    expect(assessFreshness({ lastSample: { t: NOW - 60_000, up: true, ms: 1 }, intervalSeconds: 300 }, NOW)).toBe('fresh');
  });

  it('超过 1.5 个间隔算迟到，超过 3 个算逾期', () => {
    const iv = 300; // 5 分钟
    expect(assessFreshness({ lastSample: { t: NOW - 300_000 * 1.2, up: true, ms: 1 }, intervalSeconds: iv }, NOW)).toBe('fresh');
    expect(assessFreshness({ lastSample: { t: NOW - 300_000 * 2, up: true, ms: 1 }, intervalSeconds: iv }, NOW)).toBe('late');
    expect(assessFreshness({ lastSample: { t: NOW - 300_000 * 4, up: true, ms: 1 }, intervalSeconds: iv }, NOW)).toBe('overdue');
  });

  it('阈值按每条自己的间隔算，不是固定秒数', () => {
    // 同样「4 小时没消息」：5 分钟一探的早该逾期，6 小时一探的还很新鲜。
    // 用固定秒数做判据，这两条必有一条判错。
    expect(assessFreshness({ lastSample: { t: NOW - 4 * HOUR, up: true, ms: 1 }, intervalSeconds: 300 }, NOW)).toBe('overdue');
    expect(assessFreshness({ lastSample: { t: NOW - 4 * HOUR, up: true, ms: 1 }, intervalSeconds: 21600 }, NOW)).toBe('fresh');
  });

  it('没有间隔声明时不许说它新鲜（存疑往保守一侧倒）', () => {
    expect(assessFreshness({ lastSample: { t: NOW - 1000, up: true, ms: 1 }, intervalSeconds: 0 }, NOW)).toBe('never');
  });

  it('逾期的绿灯不算正常', () => {
    const t = target({ name: '图片生成', environment: 'production', ...probed(4 * HOUR, 300) });
    expect(t.status).toBe('up');
    expect(assessCell(t, assessFreshness(t, NOW))).toBe('overdue');
  });

  it('刚建、还没探过第一次的不判逾期（那是「等第一次判定」，不是「跑着跑着停了」）', () => {
    const t = target({ name: '新监控', environment: 'production', lastSample: null, measured: false });
    expect(assessFreshness(t, NOW)).toBe('never');
    expect(assessCell(t, assessFreshness(t, NOW))).toBe('unknown');
  });
});

describe('Q4 第一屏不许在没有证据时说「正常」', () => {
  it('有业务逾期时，headline 说的是「绿灯不作数」，不是「都正常」', () => {
    const board = buildOwnerBoard(
      [target({ name: '图片生成', environment: 'production', ...probed(4 * HOUR, 300) })],
      undefined as never,
      { now: NOW, prober: { stalled: false, lastCycleAt: NOW } },
    );
    expect(board.headline).not.toContain('都正常');
    expect(board.headline).toContain('绿灯不作数');
    expect(board.tone).toBe('warn');
  });

  it('探测器停摆时，盖过下面一切结论——包括本来是绿的', () => {
    const board = buildOwnerBoard(
      [target({ name: '图片生成', environment: 'production', ...probed(10_000, 300) })],
      undefined as never,
      { now: NOW, prober: { stalled: true, lastCycleAt: NOW - HOUR } },
    );
    expect(board.headline).toContain('探测器停摆');
    expect(board.headline).not.toContain('都正常');
    expect(board.tone).toBe('danger');
  });

  it('证据取最旧的那一条，不拿最好看的那条给整屏背书', () => {
    const rows = buildBusinessRows([
      target({ name: 'A', environment: 'production', ...probed(10_000, 21600) }),
      target({ name: 'B', environment: 'production', ...probed(2 * HOUR, 21600) }),
    ], NOW);
    const ev = latestEvidence(rows, NOW);
    expect(ev?.name).toBe('B');
    expect(ev?.at).toBe(NOW - 2 * HOUR);
    expect(ev?.checked).toBe(2);
  });

  it('一条都没检查过时不编时间，明说没有记录', () => {
    const rows = buildBusinessRows([target({ name: 'A', environment: 'production', lastSample: null })], NOW);
    expect(latestEvidence(rows, NOW)).toBeUndefined();
    expect(describeEvidence(rows[0], NOW)).toBe('还没有检查记录');
  });

  it('卡片的证据行说清「什么时候查的 + 多久查一次」', () => {
    const rows = buildBusinessRows([target({ name: 'A', environment: 'production', ...probed(180_000, 300) })], NOW);
    const line = describeEvidence(rows[0], NOW);
    expect(line).toContain('检查过');
    expect(line).toContain('每');
  });
});

describe('Q2 卡片要说清这条业务检查的是什么', () => {
  it('probeDescription 透到行上，不再只有「N 个环境都通过判据」这种空话', () => {
    const rows = buildBusinessRows([
      target({ name: 'A', environment: 'production', probeDescription: 'GET /api/healthz/deep · 断言 db.roundtrip < 500', ...probed(10_000, 300) }),
    ], NOW);
    expect(rows[0].probe).toContain('db.roundtrip');
  });
});

describe('卡片上的判据短句', () => {
  it('把开头那条长地址摘掉，留下真正要看的断言', () => {
    const full = 'GET https://basic-error-solution-btq0os-claude-prd-agent.miduo.org/api/healthz/deep · 状态 200-399 且 check「db.roundtrip」的 observedValue lt 2000';
    const short = shortPredicate(full);
    expect(short).not.toContain('https://');
    expect(short).not.toContain('状态 200-399');
    expect(short).toContain('db.roundtrip');
    expect(short).toContain('lt 2000');
  });

  it('格式对不上就原样返回 —— 宁可长，不可截错', () => {
    expect(shortPredicate('断言 checks.serving.0.observedValue eq 0')).toBe('断言 checks.serving.0.observedValue eq 0');
    expect(shortPredicate('')).toBe('');
  });

  it('只有一条地址、没有别的内容时不许返回空串', () => {
    // 摘完什么都不剩的话，读者拿到一个空格子比拿到长地址更糟。
    expect(shortPredicate('GET https://x/y')).toBe('GET https://x/y');
  });
});

describe('格子带上真实数字（卡片「专业感」的来源）', () => {
  it('可用率 / 平均响应 / 采样次数 / 柱条都透到格子上', () => {
    const rows = buildBusinessRows([
      target({
        name: 'A', environment: 'production',
        availability24h: 0.9987, avgLatencyMs24h: 94, sampleCount24h: 17,
        buckets: [{ from: 1, to: 2, up: 3, down: 0 }] as never,
        lastSample: { t: NOW - 10_000, up: true, ms: 90 }, intervalSeconds: 300,
      }),
    ], NOW);
    const cell = rows[0].cells[0];
    expect(cell.availability24h).toBeCloseTo(0.9987);
    expect(cell.avgLatencyMs24h).toBe(94);
    expect(cell.sampleCount24h).toBe(17);
    expect(cell.buckets).toHaveLength(1);
  });

  it('算不出来时是 null，不是 0 —— 0 的意思是「全挂」不是「不知道」', () => {
    const rows = buildBusinessRows([
      target({ name: 'A', environment: 'production', availability24h: null, avgLatencyMs24h: null }),
    ], NOW);
    expect(rows[0].cells[0].availability24h).toBeNull();
    expect(rows[0].cells[0].avgLatencyMs24h).toBeNull();
  });
});

describe('柱条：会误导就不画', () => {
  const bucket = (up: number, down = 0): { from: number; to: number; up: number; down: number } =>
    ({ from: 0, to: 0, up, down });

  it('样本铺得开就画', () => {
    expect(shouldDrawBar([bucket(1), bucket(1), bucket(1), bucket(0)])).toBe(true);
  });

  it('48 格里只有 4 格有样本就不画 —— 那张图第一眼给出的印象是错的', () => {
    const sparse = [...Array(44)].map(() => bucket(0)).concat([bucket(1), bucket(1), bucket(1), bucket(1)]);
    expect(shouldDrawBar(sparse)).toBe(false);
  });

  it('一格都没有时不画', () => {
    expect(shouldDrawBar([])).toBe(false);
    expect(shouldDrawBar([bucket(0), bucket(0)])).toBe(false);
  });

  it('有故障的格子也算「有样本」——不能因为它是红的就当成没采到', () => {
    expect(shouldDrawBar([bucket(0, 3), bucket(0, 2), bucket(0), bucket(0)])).toBe(true);
  });
});

describe('环境缩写要认得出来', () => {
  it('预发与分支预览不能都缩成「预」', () => {
    expect(ENVIRONMENT_SHORT.staging).not.toBe(ENVIRONMENT_SHORT.preview);
    // 两个字是下限：单字的「支」「他」没人认得
    for (const v of Object.values(ENVIRONMENT_SHORT)) expect(v.length).toBeGreaterThanOrEqual(2);
  });
});

/*
 * W6 全局面板：跨项目一屏。
 *
 * 它要回答的是单项目视角永远给不出的那个问题——**哪些项目根本没人盯**。
 * 站在某一个项目里，你看不见另外十个项目的业务没有任何监控。
 */
describe('全局面板', () => {
  const ctx = { now: NOW, prober: { stalled: false, lastCycleAt: NOW } };
  const biz = (project: string, name: string, over: Partial<UptimeTargetSummary> = {}): UptimeTargetSummary =>
    target({ name, environment: 'production', projectId: project, projectName: project,
      lastSample: { t: NOW - 10_000, up: true, ms: 50 }, intervalSeconds: 300, ...over });
  const infraOf = (project: string): UptimeTargetSummary =>
    infra({ name: `${project} 容器`, environment: 'production', projectId: project, projectName: project } as never);

  it('没有业务监控的项目算 unknown，不算正常', () => {
    const rows = buildProjectRows([infraOf('P空')], NOW);
    expect(rows[0].businessCount).toBe(0);
    // 「没人盯」被渲染成绿色，等于用一个假绿把最该管的项目藏起来
    expect(rows[0].worst).not.toBe('up');
    expect(rows[0].worst).toBe('unknown');
  });

  it('把没人盯的项目单独拎出来，并在每一档结论里都说一次', () => {
    const board = buildGlobalBoard([biz('A', 'a1'), infraOf('B'), infraOf('C')], ctx);
    expect(board.unwatched.map((r) => r.id).sort()).toEqual(['B', 'C']);
    expect(board.projectsWithBusiness).toBe(1);
    expect(board.detail).toContain('2 个项目还没有业务监控');
    expect(board.detail).toContain('不会红');
  });

  it('一个项目都没装业务监控时，结论直说这件事', () => {
    const board = buildGlobalBoard([infraOf('A'), infraOf('B')], ctx);
    expect(board.headline).toContain('还没有任何一个项目装了业务监控');
    expect(board.tone).toBe('empty');
  });

  it('有故障时先说故障，但仍然带着「没人盯」那句', () => {
    const board = buildGlobalBoard([biz('A', 'a1', { status: 'down' }), infraOf('B')], ctx);
    expect(board.headline).toContain('挂了');
    expect(board.tone).toBe('danger');
    expect(board.detail).toContain('还没有业务监控');
  });

  it('登记表里有、目标里没有的项目也算没人盯：一个只有空项目的实例不会被说成「没有任何项目」（Codex #1543 P2）', () => {
    const registry = [{ id: 'A', name: 'A' }, { id: 'NEW', name: '刚建的项目' }];
    const board = buildGlobalBoard([biz('A', 'a1')], ctx, [biz('A', 'a1')], registry);
    expect(board.unwatched.map((r) => r.id)).toEqual(['NEW']);
    expect(board.unwatched[0].worst).toBe('unknown');
    expect(board.detail).toContain('刚建的项目');
    // 只有空项目：不是「没有任何项目」，是「都没人盯」
    const empty = buildGlobalBoard([], ctx, [], [{ id: 'NEW', name: '刚建的项目' }]);
    expect(empty.headline).toContain('还没有任何一个项目装了业务监控');
    expect(empty.detail).toContain('1 个项目');
    expect(empty.detail).not.toContain('还没有任何项目');
  });

  it('有业务还没有任何检查记录时不许说「都正常」（Codex #1543 P1）', () => {
    // 新建 / 暂停 / 未实测的监控：格子是 unknown，既不坏也不算好
    const fresh = buildGlobalBoard([biz('A', 'a1'), biz('B', 'b-new', { lastSample: null, status: 'unknown' })], ctx);
    expect(fresh.headline).not.toContain('都正常');
    expect(fresh.headline).toContain('还没有任何检查记录');
    expect(fresh.tone).toBe('warn');
    expect(fresh.detail).toContain('B');
    expect(fresh.rows.find((r) => r.id === 'B')?.unknown).toBe(1);
    // 对照：都检查过才说都正常
    expect(buildGlobalBoard([biz('A', 'a1')], ctx).headline).toContain('都正常');
  });

  it('探测器停摆盖过一切，包括故障', () => {
    const board = buildGlobalBoard([biz('A', 'a1', { status: 'down' })],
      { now: NOW, prober: { stalled: true, lastCycleAt: NOW - 3_600_000 } });
    expect(board.headline).toContain('探测器停摆');
    expect(board.headline).not.toContain('挂了');
  });

  it('全好时结论带证据，而且只要还有项目没人盯就不判 ok', () => {
    const withBlind = buildGlobalBoard([biz('A', 'a1'), infraOf('B')], ctx);
    expect(withBlind.headline).toContain('检查过');
    expect(withBlind.tone).toBe('warn');

    const clean = buildGlobalBoard([biz('A', 'a1')], ctx);
    expect(clean.tone).toBe('ok');
    expect(clean.detail).toBeUndefined();
  });

  it('有事的项目排前面', () => {
    const rows = buildProjectRows([
      biz('好', 'ok1'), biz('好', 'ok2'),
      biz('坏', 'bad1', { status: 'down' }),
    ], NOW);
    expect(rows[0].id).toBe('坏');
  });

  describe('覆盖按全环境判，读数按环境筛选算（Codex #1543 P2）', () => {
    // 混合实例：A 在生产装了业务监控；B 只在分支预览装了；C 什么都没装。
    // 默认环境集会筛掉分支预览——用筛过的那批判覆盖，B 要么整个消失，要么被判成没人盯。
    const all = [
      biz('A', 'a1'),
      biz('B', 'b1', { environment: 'preview' }),
      infraOf('C'),
    ];
    const scoped = all.filter((t) => t.environment !== 'preview');

    it('只在分支预览上有业务监控的项目不从卡片上消失，也不被算成没人盯', () => {
      const board = buildGlobalBoard(scoped, ctx, all);
      expect(board.rows.map((r) => r.id).sort()).toEqual(['A', 'B']);
      expect(board.unwatched.map((r) => r.id)).toEqual(['C']);
      expect(board.projectsWithBusiness).toBe(2);
      expect(board.businessTotal).toBe(2);
      // B 摆的是它全环境那份读数：分支预览那一格在
      expect(board.rows.find((r) => r.id === 'B')?.environments).toEqual(['preview']);
    });

    it('B 还有生产容器时也一样：不因为筛选后只剩容器就被判成「没人盯」', () => {
      const withInfra = [...all, infraOf('B')];
      const board = buildGlobalBoard(withInfra.filter((t) => t.environment !== 'preview'), ctx, withInfra);
      expect(board.unwatched.map((r) => r.id)).toEqual(['C']);
      expect(board.rows.map((r) => r.id).sort()).toEqual(['A', 'B']);
    });

    it('红绿闭环：不传全环境那份（旧行为）时 B 就消失了、只剩 C 没人盯', () => {
      const board = buildGlobalBoard(scoped, ctx);
      expect(board.rows.map((r) => r.id)).toEqual(['A']);
      expect(board.unwatched.map((r) => r.id)).toEqual(['C']);
    });

    it('筛选后有读数的项目用筛选后的读数：A 分支预览挂了不该在默认视图里把 A 标红', () => {
      const mixed = [...all, biz('A', 'a-preview', { environment: 'preview', status: 'down' })];
      const board = buildGlobalBoard(mixed.filter((t) => t.environment !== 'preview'), ctx, mixed);
      expect(board.rows.find((r) => r.id === 'A')?.down).toBe(0);
      expect(board.rows.find((r) => r.id === 'A')?.businessCount).toBe(1);
    });
  });
});
