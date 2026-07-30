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
    // 判据必须与落点同源：只按子域名字判会把「叫 llmgw 的存量 API profile」
    // 标成控制台（落点已正确落到 /gw/healthz，标签却说是控制台）。
    expect(source).toContain("isConsole: isGatewayConsoleEntry(sub, profile?.readinessProbe?.path)");
    expect(source).toContain('isConsole: boolean');
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
