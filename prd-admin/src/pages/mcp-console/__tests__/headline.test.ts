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

  it('全成了：判断句里挂着真实次数', () => {
    const h = buildHeadline({
      clients: [client()],
      today: today({ calls: 47, images: 12, writes: 9 }),
      recentCalls: [log()],
    });
    expect(h.verdict).toContain('47 次');
    expect(h.verdict).toContain('全都成了');
    expect(h.detail).toContain('12 张');
    expect(h.detail).toContain('1 台客户端');
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
});
