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
