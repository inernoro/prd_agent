/**
 * 首页脉搏：「取不到」必须和「真的是零」分得开。
 *
 * 混作一谈的后果不是少显示点东西，是**当着老用户的面说他什么都没干过**：
 * 服务挂了 → stats 留 null → 页面把它读成 0，四个格子全零；feed 留空 →
 * 渲染"用过知识库、周报之后动态会出现在这里"。用户看到的不是故障，是一句谎话。
 *
 * 判据放在纯函数上（而不是靠渲染层的 if），这样它能被真的断言，
 * 而不是靠通读代码相信它成立。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETIRED_ROUTES, formatCompactNumber, resolveHomePulse } from '../homePulse';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = path.resolve(TEST_DIR, '../../app/App.tsx');
const FEED_CONTROLLER_PATH = path.resolve(TEST_DIR, '../../../../prd-api/src/PrdAgent.Api/Controllers/Api/MobileDashboardController.cs');
const LAUNCHER_PATH = path.resolve(TEST_DIR, '../../pages/AgentLauncherPage.tsx');
const MOBILE_HOME_PATH = path.resolve(TEST_DIR, '../../pages/MobileHomePage.tsx');

const STATS = { aiCalls: 12, imageGenerations: 3, defects: 1, totalTokens: 45678 } as MobileStats;
const ITEMS = [{ id: 'a', type: 'document', title: '一条动态', updatedAt: '2026-08-01T00:00:00Z', navigateTo: '/x' }] as unknown as FeedItem[];

const ok = <T,>(data: T) => ({ status: 'fulfilled' as const, value: { success: true, data } });
const failed = () => ({ status: 'fulfilled' as const, value: { success: false, data: undefined } });
const threw = () => ({ status: 'rejected' as const, reason: new Error('network down') });

describe('首页脉搏：失败态不许伪装成空态', () => {
  it('两路都成功：数据照收，不打失败标记', () => {
    const r = resolveHomePulse(ok(STATS), ok({ items: ITEMS }));
    expect(r.stats).toEqual(STATS);
    expect(r.feed).toEqual(ITEMS);
    expect(r.statsFailed).toBe(false);
    expect(r.feedFailed).toBe(false);
  });

  it('真的没有数据时，是空态不是失败态', () => {
    // 新用户：接口成功返回、内容为空。这时候说"用过之后动态会出现在这里"才是对的。
    const r = resolveHomePulse(ok({ aiCalls: 0, imageGenerations: 0, defects: 0, totalTokens: 0 } as MobileStats), ok({ items: [] }));
    expect(r.statsFailed).toBe(false);
    expect(r.feedFailed).toBe(false);
    expect(r.feed).toEqual([]);
  });

  it('success:false 算没取到，不算零', () => {
    const r = resolveHomePulse(failed(), failed());
    expect(r.statsFailed).toBe(true);
    expect(r.feedFailed).toBe(true);
    // 关键：stats 是 null 而不是一份零值对象——渲染层据此显示「--」而不是 0
    expect(r.stats).toBeNull();
  });

  it('请求直接 reject 也算没取到（不是让整页停在骨架上）', () => {
    const r = resolveHomePulse(threw(), threw());
    expect(r.statsFailed).toBe(true);
    expect(r.feedFailed).toBe(true);
  });

  it('两路各记各的成败，一路挂掉不牵连另一路', () => {
    const r = resolveHomePulse(failed(), ok({ items: ITEMS }));
    expect(r.statsFailed).toBe(true);
    expect(r.feedFailed).toBe(false);
    expect(r.feed).toEqual(ITEMS);
  });

  it('后端 200 但某个来源查挂了：算降级，不算完整', () => {
    // GetFeed 逐来源 try/catch，单个来源挂掉不整体 500。只看 HTTP 成不成功的话，
    // 「两个来源都查挂了」会以 200 + 空列表回来，被读成「你还没用过」。
    const r = resolveHomePulse(ok(STATS), ok({ items: [], degradedSources: ['visual-workspace', 'defect'] }));
    expect(r.feedFailed).toBe(false);
    expect(r.feedDegraded).toBe(true);
  });

  it('部分来源挂掉时，拿到的那部分照常给，但标记不完整', () => {
    const r = resolveHomePulse(ok(STATS), ok({ items: ITEMS, degradedSources: ['defect'] }));
    expect(r.feed).toEqual(ITEMS);
    expect(r.feedDegraded).toBe(true);
  });

  it('没有降级来源时不误报', () => {
    expect(resolveHomePulse(ok(STATS), ok({ items: ITEMS, degradedSources: [] })).feedDegraded).toBe(false);
    // 旧构建的后端不带这个字段，不能因为字段缺失就报降级
    expect(resolveHomePulse(ok(STATS), ok({ items: ITEMS })).feedDegraded).toBe(false);
  });

  it('success:true 但 data 缺失，同样按没取到处理', () => {
    // 契约破了的时候宁可说"取不到"，也不要把 undefined 读成零。
    const r = resolveHomePulse({ status: 'fulfilled', value: { success: true, data: undefined } }, ok({ items: undefined }));
    expect(r.statsFailed).toBe(true);
    expect(r.stats).toBeNull();
    // feed 的 data 在、items 缺 → 属于成功但为空，走空态
    expect(r.feedFailed).toBe(false);
    expect(r.feed).toEqual([]);
  });
});

describe('动态流不许出现点了没反应的死链', () => {
  const feedOf = (items: unknown[]) => resolveHomePulse(ok({} as MobileStats), ok({ items: items as FeedItem[] })).feed;

  it('指向已下线路由的条目直接不列', () => {
    // 后端仍会吐 PRD 会话（那个 Web 端已下线），navigateTo 是 /prd-agent，
    // 而 App.tsx 把它整条重定向回 /：点一下只是把首页重刷一遍。
    const items = [
      { id: 'prd', type: 'prd-session', title: 'PRD 会话', updatedAt: '2026-08-01T00:00:00Z', navigateTo: '/prd-agent' },
      { id: 'ok', type: 'defect', title: '缺陷', updatedAt: '2026-08-01T00:00:00Z', navigateTo: '/defect-agent' },
    ];
    expect(feedOf(items).map((i) => i.id)).toEqual(['ok']);
  });

  it('子路由 / 带 query 的变体同样算死链', () => {
    const items = [
      { id: 'a', navigateTo: '/prd-agent/123' },
      { id: 'b', navigateTo: '/prd-agent?tab=x' },
      { id: 'c', navigateTo: '/prd-agent/' },
      { id: 'd', navigateTo: '/visual-agent/9' },
    ];
    expect(feedOf(items).map((i) => i.id)).toEqual(['d']);
  });

  it('前缀相同但不是同一条路由的，不许误杀', () => {
    expect(feedOf([{ id: 'keep', navigateTo: '/prd-agent-archive' }]).map((i) => i.id)).toEqual(['keep']);
  });

  it('先过滤再截断：死链不许占掉可见名额', () => {
    // 服务端是「合并所有来源 → 排序 → Take(limit)」。若客户端先截断再过滤，
    // 最新的几条恰好都是已下线入口时列表会被清空，页面转头去说"你还没用过"——
    // 修死链反而制造了新的谎话。
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `dead-${i}`, navigateTo: '/prd-agent' })),
      { id: 'live-1', navigateTo: '/defect-agent' },
      { id: 'live-2', navigateTo: '/visual-agent/7' },
    ];
    const { feed } = resolveHomePulse(ok({} as MobileStats), ok({ items: items as unknown as FeedItem[] }), 8);
    expect(feed.map((i) => i.id)).toEqual(['live-1', 'live-2']);
  });

  it('可见上限只截断存活条目', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `x-${i}`, navigateTo: '/defect-agent' }));
    const { feed } = resolveHomePulse(ok({} as MobileStats), ok({ items: items as unknown as FeedItem[] }), 5);
    expect(feed).toHaveLength(5);
    expect(feed[0].id).toBe('x-0');
  });

  it('hook 真的多要了几条并把可见上限传下去（接线，不然纯函数白写）', () => {
    const source = fs.readFileSync(path.resolve(TEST_DIR, '../homePulse.ts'), 'utf8');
    expect(source).toMatch(/getMobileFeed\(\{ limit: Math\.min\(feedLimit \* FEED_OVERFETCH/);
    expect(source).toMatch(/resolveHomePulse\(statsRes, feedRes, feedLimit\)/);
  });

  it('清单与 App.tsx 的重定向路由对账（漏一条就会重新长出死链）', () => {
    // 两处各写各的必然漂移：App.tsx 下线第二个页面时，这里不跟就又有死链
    // （predicate-and-wiring 形状 3）。
    const app = fs.readFileSync(APP_PATH, 'utf8');
    const redirected = [...app.matchAll(/<Route\s+path="([^"*]+)"\s+element=\{<Navigate to="\/" replace \/>\}/g)]
      .map((m) => `/${m[1].replace(/^\//, '')}`);
    expect(redirected.length, 'App.tsx 里没解析到重定向路由，判据已经失效').toBeGreaterThan(0);
    for (const route of new Set(redirected)) {
      expect(RETIRED_ROUTES, `App.tsx 把 ${route} 重定向回首页，但动态流还会把它当可点条目`).toContain(route);
    }
  });
});

describe('空态文案不许许下端点兑现不了的承诺', () => {
  /** 后端真正会产出的动态类型 → 空态文案里对应的说法 */
  const SOURCE_COPY: Record<string, string> = {
    'visual-workspace': '配图',
    defect: '缺陷',
  };
  /** 端点不产出、但历史文案点过名的来源——出现在文案里就是空头支票 */
  const NOT_A_SOURCE = ['知识库', '周报'];

  it('端点产出的类型与这里登记的一致', () => {
    const controller = fs.readFileSync(FEED_CONTROLLER_PATH, 'utf8');
    const feedBody = controller.slice(controller.indexOf('GetFeed'), controller.indexOf('GetStats'));
    const emitted = new Set([...feedBody.matchAll(/type = "([a-z-]+)"/g)].map((m) => m[1]));
    expect(emitted.size, 'GetFeed 里没解析到 type，判据已经失效').toBeGreaterThan(0);
    // 端点加了新来源却没更新文案登记表，这条会先红，提醒去把空态文案一起改
    expect([...emitted].sort()).toEqual(Object.keys(SOURCE_COPY).sort());
  });

  it('两端空态文案只承诺端点真的会返回的东西', () => {
    // 「用过知识库、周报、生图或缺陷之后，动态会出现在这里」——用户照做两件，
    // 动态照旧空着。空态文案是一句承诺，兑现不了就是骗人，和显示 0 同源。
    for (const [name, file] of [['桌面首页', LAUNCHER_PATH], ['移动首页', MOBILE_HOME_PATH]] as const) {
      const source = fs.readFileSync(file, 'utf8');
      // 限定不跨行：否则会从某个早先的引号一路吃到注释里那句同名文案
      const empty = source.match(/'[^'\n]*动态会出现在这里[^'\n]*'/)?.[0];
      expect(empty, `${name}没找到空态文案，判据失效`).toBeTruthy();
      for (const word of NOT_A_SOURCE) {
        expect(empty, `${name}空态文案承诺了「${word}」，但 GetFeed 根本不查这个来源`).not.toContain(word);
      }
      // 至少点名一个真来源，别改成一句什么都没说的空话
      expect(Object.values(SOURCE_COPY).some((word) => empty!.includes(word)), `${name}空态文案没告诉用户做什么才会有动态`).toBe(true);
    }
  });
});

describe('紧凑计数只有一份实现', () => {
  it('万 / 亿 分档与去尾零', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(10_000)).toBe('1万');
    expect(formatCompactNumber(45_678)).toBe('4.6万');
    expect(formatCompactNumber(100_000_000)).toBe('1亿');
    expect(formatCompactNumber(Number.NaN)).toBe('0');
  });
});
