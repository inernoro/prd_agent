import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/src/routes/branches.ts'),
  'utf8',
);

describe('分支预览地址 API 契约', () => {
  it('同时下发带用户名称的主入口和 Web 页面入口', () => {
    expect(source).toContain("const previewHost = (config.previewDomain || config.rootDomains?.[0] || '')");
    expect(source).toContain('computeBranchWebEntries(b, previewHost)');
    expect(source).toContain('b.previewEntries = entries');
    expect(source).toContain('new Set(entries.map((entry) => entry.url))');
    expect(source).toContain('b.previewUrl = b.previewUrls[0]');
  });

  it('入口只读 webEntry，主 profile 不以 subdomain 重复列出', () => {
    expect(source).toContain('const webEntry = profile?.webEntry');
    expect(source).toContain('profileId === primaryProfile?.id');
    expect(source).not.toContain('resolveServiceLandingPath(sub, profile?.readinessProbe?.path)');
  });

  it('保存子域别名时也查命名服务 host（helper 建了没接线 = 白建）', () => {
    // 形状 2：computeBranchPublishedServiceHosts 一度只接进 PUT /custom-domains，
    // 别名保存那条路径从头到尾没查过，别的分支的 `<slug>-llmgw` 可以被直接占走。
    expect(source).toContain('const serviceHostCollisions = findAliasServiceHostCollisions(normalized)');
    expect(source).toContain('...customDomainCollisions, ...serviceHostCollisions]');
    // 错误文案分支必须排在通用的 `'domain' in c` 之前，否则会被说成「自定义域名占用」。
    const msgIdx = source.indexOf("if (c.reason === 'service-subdomain') return");
    const genericIdx = source.indexOf("if ('domain' in c) return");
    expect(msgIdx).toBeGreaterThan(-1);
    expect(msgIdx).toBeLessThan(genericIdx);
  });

  it('不枚举可能包含隐藏或备用域名的 rootDomains', () => {
    expect(source).toContain('rootDomains 可能包含隐藏、备用或内部路由域名');
    expect(source).not.toContain('previewHosts.flatMap');
  });
});
