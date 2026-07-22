import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/src/routes/branches.ts'),
  'utf8',
);

describe('分支预览地址 API 契约', () => {
  it('同时下发主入口和可路由 profile 的命名入口', () => {
    expect(source).toContain("const previewHost = (config.previewDomain || config.rootDomains?.[0] || '')");
    expect(source).toContain('const mainUrls = b.previewSlug');
    expect(source).toContain('computeBranchGatewayUrls(b, previewHost)');
    expect(source).toContain('new Set([...mainUrls, ...namedServiceUrls])');
    expect(source).toContain('b.previewUrl = b.previewUrls[0]');
  });

  it('不枚举可能包含隐藏或备用域名的 rootDomains', () => {
    expect(source).toContain('rootDomains 可能包含隐藏、备用或内部路由域名');
    expect(source).not.toContain('previewHosts.flatMap');
  });
});
