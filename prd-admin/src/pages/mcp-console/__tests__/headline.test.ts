import { describe, expect, it } from 'vitest';
import { buildHeadline, type HeadlineInput } from '../headline';
import type { McpCallLogDto, McpClientDto } from '@/services/contracts/mcpConsole';

function client(over: Partial<McpClientDto> = {}): McpClientDto {
  return {
    keyId: 'k1',
    name: '书房的 Claude Code',
    keyPrefix: 'sk-ak-38afea',
    scopes: [],
    scopeMode: 'auto',
    missingCapabilities: [],
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    todayCalls: 0,
    dailyImageQuota: 50,
    dailyWriteQuota: 200,
    rateLimitPerMin: 60,
    todayImages: 0,
    todayWrites: 0,
    ...over,
  };
}

function log(over: Partial<McpCallLogDto> = {}): McpCallLogDto {
  return {
    id: 'l1',
    keyId: 'k1',
    keyName: '书房的 Claude Code',
    toolName: 'map_visual_generate',
    capability: 'visual',
    status: 'success',
    isWrite: true,
    imageCount: 1,
    deduplicated: false,
    durationMs: 900,
    argumentsPreview: null,
    errorMessage: null,
    artifact: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    ...over,
  };
}

function today(over: Partial<NonNullable<HeadlineInput['today']>> = {}) {
  return { calls: 0, images: 0, writes: 0, denied: 0, failed: 0, ...over };
}

describe('接入台第一屏那句判断', () => {
  it('一台都没接：说清下一步，不摆数字', () => {
    const h = buildHeadline({ clients: [], today: today(), recentCalls: [] });
    expect(h.verdict).toContain('还没有客户端');
    expect(h.detail).toContain('接入新的');
  });

  it('昨天用过、今天之前撤掉的：不许说成「从来没接过」', () => {
    // clients 空 + 今天 0 次，但记录里还有昨天那些 —— overview 的 today 只覆盖今天，
    // 而 recentCalls 是按条数取最近 N 次、天然跨天的（跨天显示正是 eventClock 的由来）。
    // 「今天没调用」和「从来没接过」是两件事，用现成数据就分得开，不必改后端契约。
    const h = buildHeadline({
      clients: [],
      today: today(),
      recentCalls: [log({ createdAt: '2026-09-04T15:01:00.000Z' })],
    });
    expect(h.verdict).not.toContain('还没有客户端接进来');
    expect(h.verdict).toContain('没连着');
    expect(h.detail).toContain('它干了什么');
  });

  it('撤掉最后一把钥匙之后，不许把当天的活动一起抹掉', () => {
    // clients 空了但 today 还留着它的调用 —— 先看 today 再看名单。
    // 反过来会把「今天用过、刚断开」说成「还没有客户端接进来」。
    const h = buildHeadline({ clients: [], today: today({ calls: 31, images: 4 }), recentCalls: [] });
    expect(h.verdict).toContain('31 次');
    expect(h.verdict).not.toContain('还没有客户端接进来');
  });

  it('全断开了：说的是「现在没人能调」，不是「你还没接过」', () => {
    const h = buildHeadline({
      clients: [client({ isActive: false }), client({ keyId: 'k2', isActive: false })],
      today: today(),
      recentCalls: [],
    });
    expect(h.verdict).toContain('2 台');
    expect(h.verdict).toContain('断开');
  });

  it('接着但今天没动过：不说成失败', () => {
    const h = buildHeadline({ clients: [client()], today: today(), recentCalls: [] });
    expect(h.verdict).toContain('一次都还没调过');
  });

  it('没有失败时：判断句挂着真实次数，且不宣称这些调用「都成了」', () => {
    const h = buildHeadline({
      clients: [client()],
      today: today({ calls: 47, images: 12, writes: 9 }),
      recentCalls: [log()],
    });
    expect(h.verdict).toContain('47 次');
    expect(h.detail).toContain('12 张');
    expect(h.detail).toContain('1 台客户端');

    // today 的三个计数出自 log.Status（纯传输层）：一个还在排队、甚至已经失败的生图 run，
    // 它的轮询回的是 HTTP 200，在这里算成功。所以判断句只能说「没被挡下、没报错」，
    // 不能说「都成了」——同一屏的事件行会把那个 run 标成「还没出结果」，两句话对不上。
    expect(h.verdict).not.toContain('全都成了');
    // today.images 是入队时占下的额度（McpUsageCounter），不是真做出来的图。
    // 说「出图 N 张」会跟事件行里那句「还没出结果」当场打架。
    expect(h.detail).not.toContain('出图');
    expect(h.detail).toContain('发起生图');
    expect(h.verdict).toMatch(/没有被挡下|没报错|没有报错/);
    // 有出图时要指路到真正说得清结果的地方
    expect(h.detail).toContain('它干了什么');
  });

  it('「被挡下」和「执行失败」分开说 —— 两者的下一步完全不同', () => {
    const h = buildHeadline({
      clients: [client()],
      today: today({ calls: 20, denied: 3, failed: 1 }),
      recentCalls: [],
    });
    expect(h.verdict).toContain('3 次被挡下');
    expect(h.verdict).toContain('1 次执行失败');
  });

  it('有失败明细时给出那句人话原因', () => {
    const h = buildHeadline({
      clients: [client()],
      today: today({ calls: 20, failed: 1 }),
      recentCalls: [log({ status: 'error', errorMessage: '模型被下架了' })],
    });
    expect(h.detail).toContain('模型被下架了');
  });

  it('算不出原因就说去哪看，不编一个', () => {
    const h = buildHeadline({
      clients: [client()],
      today: today({ calls: 20, failed: 1 }),
      recentCalls: [log({ status: 'success' })],
    });
    expect(h.detail).toContain('它干了什么');
  });

  it('判断句不许把「还连着几台」当成「调了多少次」的主语', () => {
    // 两个数来自不同人口：active 只算还在的，today 含当天被撤销的那些。
    // 一把用过 46 次的钥匙刚被撤掉、只剩一台没用过的还连着时，
    // 「1 台客户端今天替你调了 47 次」是把别人的账算到它头上。
    // 这一类在这块面板上出过四次，所以钉的是「整类不许出现」，不是某个分支的措辞。
    const cases: HeadlineInput[] = [
      { clients: [client()], today: today({ calls: 47, images: 12 }), recentCalls: [log()] },
      { clients: [client()], today: today({ calls: 47, denied: 3 }), recentCalls: [] },
    ];
    for (const input of cases) {
      const h = buildHeadline(input);
      expect(h.verdict).not.toMatch(/\d+\s*台客户端[^。]*调了\s*\d+\s*次/);
    }
  });

  it('有调用时判断句必须挂着数字，不许出现放到任何账号都成立的空话', () => {
    // 「整体表现良好」这类句子放到任何账号都成立，等于没说（conclusion-before-numbers）
    const cases: HeadlineInput[] = [
      { clients: [client()], today: today({ calls: 5 }), recentCalls: [log()] },
      { clients: [client()], today: today({ calls: 5, failed: 5 }), recentCalls: [] },
      { clients: [client()], today: today({ calls: 5, denied: 2 }), recentCalls: [] },
    ];
    for (const input of cases) {
      const h = buildHeadline(input);
      expect(h.verdict).toMatch(/\d/);
      expect(h.verdict).not.toMatch(/一切正常|整体表现良好|运行良好|状态良好/);
    }
  });

  /**
   * 不变量（而不是又一条分支的措辞）：今天有过调用，任何一条分支都必须把这个数说出来。
   *
   * 这一条是被同一个根因连着抓五次之后加的：合计条按 clients 求和、混合人口满格、
   * clients 空了抹掉当天活动、把别人的账算到还在的那台头上、名单非空但全不可用又吞掉。
   * 每次都是补一条分支，然后在下一个边界复发 —— 因为判据分散在各分支里，
   * 没有任何一处在断言「这件事对所有分支都成立」。所以这里穷举分支形状，钉性质。
   */
  it('今天有过调用时，没有任何一条分支能把这个数吞掉', () => {
    const withCalls = { calls: 47, denied: 0, failed: 0, images: 3, writes: 5 };
    const shapes: Array<[string, Parameters<typeof buildHeadline>[0]]> = [
      ['一台都没有（都删了）', { clients: [], today: withCalls, recentCalls: [] }],
      ['名单非空但全不可用', { clients: [client({ isActive: false }), client({ isActive: false })], today: withCalls, recentCalls: [] }],
      ['有能用的、全成功', { clients: [client({ isActive: true })], today: withCalls, recentCalls: [] }],
      ['有能用的、有失败', {
        clients: [client({ isActive: true })],
        today: { ...withCalls, denied: 2, failed: 1 },
        recentCalls: [],
      }],
    ];
    for (const [name, input] of shapes) {
      const h = buildHeadline(input);
      expect(`${name}: ${h.verdict} ${h.detail}`).toContain('47');
    }
  });

});
