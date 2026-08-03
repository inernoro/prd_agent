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
import { describe, expect, it } from 'vitest';
import { formatCompactNumber, resolveHomePulse } from '../homePulse';
import type { FeedItem, MobileStats } from '@/services/contracts/mobile';

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

describe('紧凑计数只有一份实现', () => {
  it('万 / 亿 分档与去尾零', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(10_000)).toBe('1万');
    expect(formatCompactNumber(45_678)).toBe('4.6万');
    expect(formatCompactNumber(100_000_000)).toBe('1亿');
    expect(formatCompactNumber(Number.NaN)).toBe('0');
  });
});
