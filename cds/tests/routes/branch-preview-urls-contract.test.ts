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

  it('每条命名入口都带平台判定的 isConsole（前端不得自己按子域名字判）', () => {
    // 接线守卫：这个字段一旦消失，BranchDetailDrawer 会静默退回按名字判的兜底，
    // 而那正是 2026-07-29 子域改名当天失效的那套判定（形状 2：链路只建到一半）。
    expect(source).toContain('isConsole: isGatewayConsoleSubdomain(sub)');
    expect(source).toContain('isConsole: boolean');
  });

  it('不枚举可能包含隐藏或备用域名的 rootDomains', () => {
    expect(source).toContain('rootDomains 可能包含隐藏、备用或内部路由域名');
    expect(source).not.toContain('previewHosts.flatMap');
  });
});
