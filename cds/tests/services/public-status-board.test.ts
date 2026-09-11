/*
 * 守卫：公开面板不许把内部东西带出去。
 *
 * 用户 2026-09-10 的第三条需求：「允许公开一些面板，让大家看得见」。
 * 这条需求的风险全在一个地方——**对外载荷是白名单构造的，还是把内部对象删几个字段**。
 * 两种写法平时看不出差别，区别只在「日后有人给内部结构加了一个字段」的那一刻：
 * 删字段的写法会把新字段一路透出去，而且不会有任何东西变红。
 *
 * 所以这里除了逐项断言，还有一条兜底：把一堆内部字段塞进输入，
 * 深度遍历输出，任何一个都不许出现。
 */
import { describe, expect, it } from 'vitest';

import {
  buildPublicStatusBoard,
  publicStatusOf,
  type PublicBoardSourceItem,
} from '../../src/services/public-status-board.js';

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 8, 11, 0, 0, 0);

function item(over: Partial<PublicBoardSourceItem> & { name: string }): PublicBoardSourceItem {
  return {
    status: 'up',
    measured: true,
    days: [
      { day: '2026-09-09', up: 4, down: 0 },
      { day: '2026-09-10', up: 4, down: 0 },
    ],
    ...over,
  };
}

describe('对外状态收敛', () => {
  it('故障就是故障', () => {
    expect(publicStatusOf(item({ name: 'a', status: 'down' }))).toBe('down');
  });

  it('被动监控零样本对外说「暂无数据」，不说正常', () => {
    // 判据确实通过了，但那只证明「没人用坏」，证明不了「还能用」。
    // 对内叫「绿灯不作数」，对外就叫暂无数据——不吓人，也不撒谎。
    expect(publicStatusOf(item({ name: 'a', observeMode: 'passive', sampleCount: 0 }))).toBe('unknown');
    expect(publicStatusOf(item({ name: 'a', observeMode: 'passive', sampleCount: 12 }))).toBe('ok');
  });

  it('未实测（按容器状态推的）不算正常', () => {
    expect(publicStatusOf(item({ name: 'a', measured: false }))).toBe('unknown');
  });

  it('暂停的对外是未知，不是故障', () => {
    expect(publicStatusOf(item({ name: 'a', status: 'paused' }))).toBe('unknown');
  });
});

describe('对外载荷', () => {
  it('用对外叫法替代内部名', () => {
    const board = buildPublicStatusBoard({
      title: 'MAP', now: T0, refreshHintSeconds: 60,
      items: [item({ name: 'llmgw serving 未处理异常', publicName: '图片生成' })],
    });
    expect(board.items[0].name).toBe('图片生成');
  });

  it('没有对外叫法时退回内部名 —— 不留空白条目', () => {
    const board = buildPublicStatusBoard({
      title: 'MAP', now: T0, refreshHintSeconds: 60,
      items: [item({ name: '文章生成', publicName: '   ' })],
    });
    expect(board.items[0].name).toBe('文章生成');
  });

  it('先给结论再给条带，异常置顶', () => {
    const board = buildPublicStatusBoard({
      title: 'MAP', now: T0, refreshHintSeconds: 60,
      items: [item({ name: 'B' }), item({ name: 'A', status: 'down' })],
    });
    expect(board.headline).toBe('1 项服务异常，其余 1 项正常');
    expect(board.status).toBe('down');
    expect(board.items.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('一项都没公开时照实说，不冒充「全部正常」', () => {
    const board = buildPublicStatusBoard({ title: 'MAP', now: T0, refreshHintSeconds: 60, items: [] });
    expect(board.headline).toContain('还没有公开任何服务');
    expect(board.status).toBe('unknown');
  });

  it('条带逐日给状态：有失败判降级，全失败判故障，无采样判未知', () => {
    const board = buildPublicStatusBoard({
      title: 'MAP', now: T0, refreshHintSeconds: 60,
      items: [item({
        name: 'A',
        days: [
          { day: '2026-09-08', up: 0, down: 0 },
          { day: '2026-09-09', up: 3, down: 1 },
          { day: '2026-09-10', up: 0, down: 4 },
          { day: '2026-09-11', up: 4, down: 0 },
        ],
      })],
    });
    expect(board.items[0].days.map((d) => d.status)).toEqual(['unknown', 'degraded', 'down', 'ok']);
  });
});

describe('脱敏：内部字段一个都不许出去', () => {
  /** 深度遍历所有字符串值与键名。 */
  function allText(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => allText(v, out));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) { out.push(k); allText(v, out); }
    }
    return out;
  }

  it('把一堆内部字段塞进输入，输出里一个都找不到', () => {
    // 这些正是用户点名不许出去的：地址、判据、实际值、产物、日志、分支、提交号。
    const leaky = {
      ...item({ name: '图片生成', status: 'down' }),
      url: 'https://feat-x-proj.preview.internal/gw/v1/healthz/deep',
      probeUrl: 'https://feat-x-proj.preview.internal/gw/v1/healthz/deep',
      assertions: [{ path: 'image.height', op: 'eq', value: '1024' }],
      lastObservation: { err: 'image.height=512，期望 eq 1024', artifactUrl: 'https://cdn.internal/a.png' },
      branchName: 'claude/basic-error-solution-btq0os',
      commitSha: 'a038859af05c777d1390d30c4fb46da04fe0e70b',
      projectId: 'prd-agent',
      monitorId: 'mon-mtvlixrjztdfy6',
      intervalSeconds: 21600,
      sampleCountPath: 'checks.serving:requests.0.observedValue',
    } as unknown as PublicBoardSourceItem;

    const text = allText(buildPublicStatusBoard({
      title: 'MAP', now: T0, refreshHintSeconds: 60, items: [leaky],
    })).join('\n');

    for (const secret of [
      'preview.internal', 'healthz', 'image.height', '512', 'artifactUrl', 'cdn.internal',
      'claude/basic-error-solution', 'a038859a', 'prd-agent', 'mon-mtvlixrjztdfy6',
      '21600', 'sampleCountPath', 'observedValue', 'assertions', 'probeUrl',
    ]) {
      expect(text, `「${secret}」不该出现在对外载荷里`).not.toContain(secret);
    }
  });

  it('对外载荷的顶层键是固定的一组 —— 加字段必须先改这条用例', () => {
    // 这条用例就是「我确认它可以给陌生人看」的签名：谁要多带一个字段出去，
    // 先得在这里写下它的名字。
    const board = buildPublicStatusBoard({
      title: 'MAP', now: T0, refreshHintSeconds: 60, items: [item({ name: 'A' })],
    });
    expect(Object.keys(board).sort()).toEqual(
      ['headline', 'items', 'refreshHintSeconds', 'status', 'title', 'updatedAt'],
    );
    expect(Object.keys(board.items[0]).sort()).toEqual(['days', 'name', 'status']);
    expect(Object.keys(board.items[0].days[0]).sort()).toEqual(['day', 'status']);
  });

  it('日期只到天，不带时刻 —— 精确到秒的时间戳能拼出探测节奏', () => {
    const board = buildPublicStatusBoard({
      title: 'MAP', now: T0 + DAY, refreshHintSeconds: 60, items: [item({ name: 'A' })],
    });
    for (const d of board.items[0].days) {
      expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
