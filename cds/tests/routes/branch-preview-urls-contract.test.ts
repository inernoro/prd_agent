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

  /*
   * 2026-08-06 review P2-1：主入口 URL 一度写死 `https://${previewSlug}.${primaryRoot}` +
   * 入口路径，完全不看该 profile 真实怎么被路由。于是 `cds.web-entry-primary` 声明在
   * 命名子域或非根前缀的服务上时，URL 指向承载 `/` 的另一个应用，而它自己那条能用的
   * URL 又被下面的命名子域循环跳过——声明 primary 反而比不声明更糟。
   *
   * 判据钉在「主入口 host 与路径都是算出来的」而不是「字面量长什么样」：把 host 改回
   * 无条件的 previewSlug、或把路径改回不经 mainDomainEntryPath，下面必有一条变红。
   */
  it('主入口按该 profile 的真实路由拼，不是一律主域名根', () => {
    // 承载 `/` 的主应用即使也声明了 subdomain，入口仍是主域名（顺序不能反）
    expect(source).toContain('const primaryHandlesRoot = primaryProfile ? handlesRootPath(primaryProfile) : false');
    expect(source).toContain('const primaryUsesNamedHost = !primaryHandlesRoot');
    // 非根路由 + 有可用命名子域 → 走命名 host
    expect(source).toContain('&& Boolean(primarySub)');
    expect(source).toContain('isPublishableNamedLabel(primaryNamedLabel)');
    expect(source).toContain('!occupied.has(`${primaryNamedLabel}.${primaryRoot}`.toLowerCase())');
    expect(source).toContain('const primaryHost = primaryUsesNamedHost');
    // 落主域名时 → 入口路径挂到该 profile 自己的挂载前缀下
    expect(source).toContain('mainDomainEntryPath(primaryProfile, primaryPath)');
    expect(source).toContain('const primaryHostPath = primaryUsesNamedHost || !primaryProfile');
    expect(source).toContain('url: `https://${primaryHost}${primaryHostPath === \'/\' ? \'\' : primaryHostPath}`');
    // 主入口占掉的命名子域要预先登记，否则别的 profile 会在同一个 host 再列一条
    expect(source).toContain('if (primaryUsesNamedHost && primarySub) seenSubdomains.add(primarySub)');
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
