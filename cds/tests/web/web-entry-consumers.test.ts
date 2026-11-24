import { describe, expect, it } from 'vitest';
import { resolveWebEntryPresentation } from '../../web/src/lib/previewUrl.js';

describe('Web 入口消费行为', () => {
  it('simple 模式保留真实主域名，并返回用户定义的入口名称', () => {
    const result = resolveWebEntryPresentation(
      'simple',
      'https://app.example.test',
      {
        primaryEntry: { url: 'https://branch.example.test/admin', name: '管理后台' },
        webEntries: [{ url: 'https://help.example.test/guide', name: '帮助中心', subdomain: 'help' }],
      },
    );

    expect(result.primaryEntryUrl).toBe('https://app.example.test/admin');
    expect(result.primaryEntry?.name).toBe('管理后台');
    expect(result.webEntries.map((entry) => entry.name)).toEqual(['帮助中心']);
  });

  it('新字段存在时不混入旧字段；只有旧响应才回退 gatewayUrls', () => {
    const declared = resolveWebEntryPresentation(
      'multi',
      'https://branch.example.test',
      {
        webEntries: [],
        gatewayUrls: [{ url: 'https://legacy.example.test/healthz', name: '旧入口' }],
      },
    );
    const legacy = resolveWebEntryPresentation(
      'multi',
      'https://branch.example.test',
      {
        gatewayUrls: [{ url: 'https://legacy.example.test/help', name: '帮助中心' }],
      },
    );

    expect(declared.webEntries).toEqual([]);
    expect(legacy.webEntries.map((entry) => entry.name)).toEqual(['帮助中心']);
  });
});
