import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_URL_ENV_KEY,
  CONSOLE_URL_ENV_KEY,
  RESERVED_ENTRYPOINT_ENV_KEYS,
  SERVICE_URLS_ENV_KEY,
  buildPublishedEntrypoints,
  isGatewayConsoleEntry,
  isGatewayConsoleSubdomain,
  savedAliasOwners,
  isPublishableNamedLabel,
  namedServiceLabel,
  publishedEntrypointsEnv,
  publishedServiceLabels,
  resolveBranchEntrypointsEnv,
  resolveServiceLandingPath,
  subdomainWithLegacyAliases,
} from '../../src/services/preview-entrypoints.js';
import { resolveProfileRuntimeEnvWithProvenance } from '../../src/services/env-provenance.js';
import type { BranchEntry } from '../../src/types.js';

const HOST = 'miduo.org';

describe('buildPublishedEntrypoints — 只声明真正会发布的入口', () => {
  it('正常长度的命名子域全部声明', () => {
    const r = buildPublishedEntrypoints({
      previewSlug: 'short-claude-prd-agent',
      previewHost: HOST,
      subdomains: ['llmgw-web', 'llmgw-serve'],
    });
    expect(r.previewUrl).toBe('https://short-claude-prd-agent.miduo.org');
    expect(r.serviceUrls).toEqual({
      'llmgw-web': 'https://short-claude-prd-agent-llmgw-web.miduo.org',
      'llmgw-serve': 'https://short-claude-prd-agent-llmgw-serve.miduo.org',
    });
  });

  it('超 63 octet 时截断+摘要,长分支照样拿得到入口', () => {
    // 2026-07-29 现场分支：slug 57 + '-llmgw' 6 = 63 压线，'-llmgw-web' 10 = 67 超限。
    // 旧行为是整条路由跳过不发布，长分支的网关控制台点不开。
    const previewSlug = 'llmgw-self-service-panel-redesign-f4oeh6-claude-prd-agent';
    expect(previewSlug).toHaveLength(57);
    expect(`${previewSlug}-llmgw-web`).toHaveLength(67);

    const label = namedServiceLabel(previewSlug, 'llmgw-web');
    expect(label.length).toBeLessThanOrEqual(63);
    expect(isPublishableNamedLabel(label)).toBe(true);
    // subdomain 必须逐字保留在末尾——它是「这是哪个服务」的唯一可读线索。
    expect(label.endsWith('-llmgw-web')).toBe(true);

    const r = buildPublishedEntrypoints({ previewSlug, previewHost: HOST, subdomains: ['llmgw-web'] });
    expect(r.serviceUrls['llmgw-web']).toBe(`https://${label}.miduo.org`);
  });

  it('截断只在 `-` 段边界下刀,不留半个词的残根', () => {
    // 用户反馈：`...-f4oeh6-cla` 这种半截词「人类不知道怎么拼」。
    const previewSlug = 'llmgw-self-service-panel-redesign-f4oeh6-claude-prd-agent';
    const label = namedServiceLabel(previewSlug, 'llmgw');
    expect(label.length).toBeLessThanOrEqual(63);
    // 摘要与 subdomain 之前的每一段都必须是 slug 里的完整段。
    const head = label.slice(0, label.length - '-llmgw'.length).replace(/-[0-9a-f]{8}$/, '');
    const slugSegments = previewSlug.split('-');
    head.split('-').forEach((segment, i) => expect(segment).toBe(slugSegments[i]));
    expect(head.endsWith('-cla')).toBe(false);
  });

  it('无连字符的超长 slug 仍能产出可发布 host（兜底不返回空串）', () => {
    const label = namedServiceLabel('x'.repeat(70), 'llmgw');
    expect(isPublishableNamedLabel(label)).toBe(true);
    expect(label).not.toContain('--');
    expect(label.startsWith('-')).toBe(false);
  });

  it('截断必须带摘要:前缀相同的两个长分支不许塌成同一个 host', () => {
    const sub = 'llmgw-web';
    const a = `${'same-prefix-'.repeat(4)}branch-alpha`;
    const b = `${'same-prefix-'.repeat(4)}branch-beta`;
    expect(`${a}-${sub}`.length).toBeGreaterThan(63);
    expect(`${b}-${sub}`.length).toBeGreaterThan(63);
    // 裸截断会让这两条塌成同一个 host、互相抢路由 —— 这正是发布器当年宁可跳过的理由。
    expect(namedServiceLabel(a, sub)).not.toBe(namedServiceLabel(b, sub));
  });

  it('同一分支多次计算结果稳定（解析侧靠重算再比，必须确定性）', () => {
    const slug = 'a'.repeat(60);
    expect(namedServiceLabel(slug, 'llmgw-web')).toBe(namedServiceLabel(slug, 'llmgw-web'));
  });

  it('不超限时原样返回，不许无谓改写既有 host', () => {
    expect(namedServiceLabel('short-slug', 'llmgw-web')).toBe('short-slug-llmgw-web');
    // 'llmgw-web' 9 字符：53 + 1 + 9 = 63，正好压线；再多一位就必须截断。
    const slug53 = 'a'.repeat(53);
    expect(`${slug53}-llmgw-web`).toHaveLength(63);
    expect(namedServiceLabel(slug53, 'llmgw-web')).toBe(`${slug53}-llmgw-web`);
    expect(namedServiceLabel(`${slug53}a`, 'llmgw-web')).not.toBe(`${slug53}a-llmgw-web`);
    expect(namedServiceLabel(`${slug53}a`, 'llmgw-web').length).toBeLessThanOrEqual(63);
  });

  it('subdomain 自身长到压不下来时不假装成功，交给发布判据拦下', () => {
    const label = namedServiceLabel('slug', 'x'.repeat(80));
    expect(isPublishableNamedLabel(label)).toBe(false);
  });

  it('同名 subdomain 取第一个（对齐发布端 first-wins）', () => {
    const r = buildPublishedEntrypoints({ previewSlug: 's', previewHost: HOST, subdomains: ['w', 'w'] });
    expect(Object.keys(r.serviceUrls)).toEqual(['w']);
  });

  it('previewHost 缺失时整张表为空（宁可不声明也不猜）', () => {
    const r = buildPublishedEntrypoints({ previewSlug: 's', previewHost: '', subdomains: ['w'] });
    expect(r).toEqual({ serviceUrls: {} });
    expect(publishedEntrypointsEnv(r)).toEqual({});
  });

  it('previewHost 带协议/尾斜杠时归一', () => {
    const r = buildPublishedEntrypoints({ previewSlug: 's', previewHost: 'https://miduo.org/', subdomains: [] });
    expect(r.previewUrl).toBe('https://s.miduo.org');
  });
});

describe('publishedEntrypointsEnv — 不写空串占位', () => {
  it('有入口才有 key', () => {
    expect(publishedEntrypointsEnv({ previewUrl: 'https://a.b', serviceUrls: {} }))
      .toEqual({ [PREVIEW_URL_ENV_KEY]: 'https://a.b' });
    expect(publishedEntrypointsEnv({ serviceUrls: { w: 'https://w.b' } }))
      .toEqual({ [SERVICE_URLS_ENV_KEY]: '{"w":"https://w.b"}' });
  });
});

describe('resolveBranchEntrypointsEnv — 用已声明拓扑,不看运行时状态', () => {
  const entry = { id: 'b1', projectId: 'p1', branch: 'claude/demo' } as unknown as BranchEntry;

  it('容器都没起来时也能声明入口（首次部署不能误判成「本环境没有网关」）', () => {
    const env = resolveBranchEntrypointsEnv(entry, {
      previewHost: HOST,
      getProject: () => ({ slug: 'prd-agent' }),
      // 注意：没有任何 services 状态，只有声明层的 profile。
      getEffectiveProfilesForBranch: () => [{ subdomain: 'llmgw-web' }, {}],
    });
    expect(env.env[SERVICE_URLS_ENV_KEY]).toBe('{"llmgw-web":"https://demo-claude-prd-agent-llmgw-web.miduo.org"}');
    expect(env.env[PREVIEW_URL_ENV_KEY]).toBe('https://demo-claude-prd-agent.miduo.org');
    expect(env.reservedKeys).toContain(SERVICE_URLS_ENV_KEY);
  });
});

describe('注入是平台事实,项目 env 不得伪造', () => {
  const BRANCH = { branch: 'claude/demo' };
  const PROFILE = { dockerImage: 'node:20-slim', dbScope: 'shared' as const };

  it('项目 customEnv 里写 CDS_SERVICE_URLS 会被平台值覆盖', () => {
    const r = resolveProfileRuntimeEnvWithProvenance(
      BRANCH,
      PROFILE,
      [{ source: 'project', env: { [SERVICE_URLS_ENV_KEY]: '{"llmgw-web":"https://evil.example"}' } }],
      [],
      {
        jwtIssuer: 'cds',
        publishedEntrypoints: {
          reservedKeys: RESERVED_ENTRYPOINT_ENV_KEYS,
          env: { [SERVICE_URLS_ENV_KEY]: '{"llmgw-web":"https://real.miduo.org"}' },
        },
      },
    );
    expect(r.env[SERVICE_URLS_ENV_KEY]).toBe('{"llmgw-web":"https://real.miduo.org"}');
    const p = r.provenance.find((x) => x.key === SERVICE_URLS_ENV_KEY);
    expect(p?.source).toBe('platform-injected');
  });

  it('未传入口表时不注入任何 key（等同「未声明入口」）', () => {
    const r = resolveProfileRuntimeEnvWithProvenance(BRANCH, PROFILE, [], [], { jwtIssuer: 'cds' });
    expect(r.env[SERVICE_URLS_ENV_KEY]).toBeUndefined();
    expect(r.env[PREVIEW_URL_ENV_KEY]).toBeUndefined();
  });

  it('平台说「这里没有任何入口」时，项目留的值必须被清掉而不是留着', () => {
    // Codex P2：只做覆盖是不够的 —— 表为空时 env 里没有那条 key，
    // 项目/profile 的值就原样留下，等于允许项目在 CDS 明确没有这条路由的情况下
    // 伪造一个网关地址。上一条「不得伪造」的用例只覆盖了表非空的路径，正好漏掉这里。
    const r = resolveProfileRuntimeEnvWithProvenance(
      BRANCH,
      PROFILE,
      [{ source: 'project', env: {
        [SERVICE_URLS_ENV_KEY]: '{"llmgw":"https://evil.example"}',
        [PREVIEW_URL_ENV_KEY]: 'https://evil.example',
      } }],
      [],
      {
        jwtIssuer: 'cds',
        // 平台算出来是空表（如 previewHost 缺失 / 该分支没有命名服务）
        publishedEntrypoints: { reservedKeys: RESERVED_ENTRYPOINT_ENV_KEYS, env: {} },
      },
    );
    expect(r.env[SERVICE_URLS_ENV_KEY]).toBeUndefined();
    expect(r.env[PREVIEW_URL_ENV_KEY]).toBeUndefined();
  });

  it('保留 key 之外的项目 env 不受影响（清空只针对平台独占的那两个）', () => {
    const r = resolveProfileRuntimeEnvWithProvenance(
      BRANCH,
      PROFILE,
      [{ source: 'project', env: { MY_APP_URL: 'https://mine.example' } }],
      [],
      { jwtIssuer: 'cds', publishedEntrypoints: { reservedKeys: RESERVED_ENTRYPOINT_ENV_KEYS, env: {} } },
    );
    expect(r.env.MY_APP_URL).toBe('https://mine.example');
  });
});

describe('子域改名不许打断存量链接', () => {
  it('规范名 llmgw 会连同历史别名 llmgw-web 一起发布', () => {
    expect(subdomainWithLegacyAliases('llmgw')).toEqual(['llmgw', 'llmgw-web']);
  });

  it('存量 profile 仍写着旧名时不重复展开（旧名此时自己就是规范名）', () => {
    expect(subdomainWithLegacyAliases('llmgw-web')).toEqual(['llmgw-web']);
  });

  it('没有别名的子域原样返回', () => {
    expect(subdomainWithLegacyAliases('llmgw-serve')).toEqual(['llmgw-serve']);
  });
});

describe('publishedServiceLabels 是「发布了哪些 host」的唯一枚举口径', () => {
  const SLUG = 'demo-claude-prd-agent';

  it('规范名与历史别名都在内（撞名检查与 SSRF 白名单靠它对齐发布结果）', () => {
    expect(publishedServiceLabels(SLUG, 'llmgw')).toEqual([
      `${SLUG}-llmgw`,
      `${SLUG}-llmgw-web`,
    ]);
  });

  it('压不进 63 的名字不算已发布（不能把发不出去的 host 放进白名单）', () => {
    const labels = publishedServiceLabels('s', 'x'.repeat(80));
    expect(labels).toEqual([]);
  });

  it('与发布器实际写出的 host 集合逐条一致', () => {
    // 这条是本轮 Codex P1 的回归点：发布器展开了别名，撞名检查与两处 SSRF 白名单
    // 却只算规范名 —— 于是别的分支能占走别名 host，探测打自己的别名会被 403。
    // 判据只有一份，谁再各拼一遍，这里就对不上。
    const published = new Set(publishedServiceLabels(SLUG, 'llmgw'));
    const enumerated = new Set(
      subdomainWithLegacyAliases('llmgw')
        .map((name) => namedServiceLabel(SLUG, name))
        .filter(isPublishableNamedLabel),
    );
    expect([...published].sort()).toEqual([...enumerated].sort());
  });
});

describe('同一分支内规范名与历史别名撞车（Codex P1）', () => {
  const SLUG = 'demo-claude-prd-agent';

  it('一个 profile 声明 llmgw、另一个声明 llmgw-web 时，显式声明压过兼容别名', () => {
    // 原始 subdomain 去重放行了两者（字符串不同），但 llmgw 展开出的别名 host
    // 与 llmgw-web 的规范 host 完全相同 —— 表和发布器都必须把这个 host 判给
    // 显式声明它的那个 profile，否则两边归属相反、路由指向错的容器。
    const r = buildPublishedEntrypoints({
      previewSlug: SLUG,
      previewHost: HOST,
      subdomains: ['llmgw', 'llmgw-web'],
    });
    expect(Object.keys(r.serviceUrls).sort()).toEqual(['llmgw', 'llmgw-web']);
    expect(r.serviceUrls['llmgw']).toBe(`https://${SLUG}-llmgw.miduo.org`);
    expect(r.serviceUrls['llmgw-web']).toBe(`https://${SLUG}-llmgw-web.miduo.org`);
  });

  it('声明顺序反过来结果一致（两趟法保证与 profile 顺序无关）', () => {
    const a = buildPublishedEntrypoints({ previewSlug: SLUG, previewHost: HOST, subdomains: ['llmgw', 'llmgw-web'] });
    const b = buildPublishedEntrypoints({ previewSlug: SLUG, previewHost: HOST, subdomains: ['llmgw-web', 'llmgw'] });
    expect(b.serviceUrls).toEqual(a.serviceUrls);
  });

  it('只声明 llmgw 时别名照常发布（改名兼容不受影响）', () => {
    const r = buildPublishedEntrypoints({ previewSlug: SLUG, previewHost: HOST, subdomains: ['llmgw'] });
    expect(Object.keys(r.serviceUrls).sort()).toEqual(['llmgw', 'llmgw-web']);
  });
});

describe('resolveServiceLandingPath — 落点看 profile 的声明，不看子域名字（Codex P2）', () => {
  it('声明了就绪路径就照抄：叫 llmgw 的 API 子域不会被改判成落根', () => {
    // 这正是回归本体：2026-07-29 把 llmgw 改判成控制台后，存量项目里仍把 llmgw
    // 当后端 API 用的 profile 被一起改成落 `/`，而那些服务在根路径 404。
    expect(resolveServiceLandingPath('llmgw', '/gw/healthz')).toBe('/gw/healthz');
    expect(resolveServiceLandingPath('llmgw-serve', '/gw/v1/healthz')).toBe('/gw/v1/healthz');
    expect(resolveServiceLandingPath('anything', '/health/ready')).toBe('/health/ready');
  });

  it('本仓库的控制台 profile 声明 /，落点即根（改名前后都成立）', () => {
    expect(resolveServiceLandingPath('llmgw', '/')).toBe('/');
    expect(resolveServiceLandingPath('llmgw-web', '/')).toBe('/');
  });

  it('没声明就绪路径时才走名字表兜底', () => {
    expect(resolveServiceLandingPath('llmgw')).toBe('/');
    expect(resolveServiceLandingPath('llmgw-web')).toBe('/');
    expect(resolveServiceLandingPath('LLMGW-Serve')).toBe('/gw/v1/healthz');
    expect(resolveServiceLandingPath('some-app')).toBe('/');
  });

  it('脏就绪路径（空串 / 不以 / 开头）不当落点用', () => {
    expect(resolveServiceLandingPath('llmgw-serve', '   ')).toBe('/gw/v1/healthz');
    expect(resolveServiceLandingPath('llmgw-serve', 'gw/v1/healthz')).toBe('/gw/v1/healthz');
    expect(resolveServiceLandingPath('some-app', 'health')).toBe('/');
  });
});

describe('isGatewayConsoleSubdomain — 控制台判定挂在别名表上（Codex P2）', () => {
  it('规范名与历史别名都认（改名当天两个名字同时在跑）', () => {
    expect(isGatewayConsoleSubdomain('llmgw')).toBe(true);
    expect(isGatewayConsoleSubdomain('llmgw-web')).toBe(true);
    expect(isGatewayConsoleSubdomain('LLMGW-Web')).toBe(true);
    expect(isGatewayConsoleSubdomain('  llmgw  ')).toBe(true);
  });

  it('引擎与其它服务不是控制台', () => {
    expect(isGatewayConsoleSubdomain('llmgw-serve')).toBe(false);
    expect(isGatewayConsoleSubdomain('docs')).toBe(false);
    expect(isGatewayConsoleSubdomain('')).toBe(false);
  });

  it('判定与别名表同源：别名表列出的每个名字都算控制台', () => {
    // 这条锁的是「同源」而不是某几个字面量：将来删掉 llmgw-web 别名时，
    // 这里跟着收敛，不会留下一处只认旧名的判定（形状 3：判据分裂）。
    for (const name of subdomainWithLegacyAliases('llmgw')) {
      expect(isGatewayConsoleSubdomain(name)).toBe(true);
    }
  });
});

describe('isGatewayConsoleEntry — 判据与落点同源（Codex P2）', () => {
  it('声明 / 的控制台 profile 算控制台', () => {
    expect(isGatewayConsoleEntry('llmgw', '/')).toBe(true);
    expect(isGatewayConsoleEntry('llmgw-web', '/')).toBe(true);
    expect(isGatewayConsoleEntry('llmgw')).toBe(true); // 未声明就绪路径 → 名字表兜底给 /
  });

  it('叫 llmgw 但声明健康端点的存量 API profile 不算控制台', () => {
    // 落点已按声明正确落到 /gw/healthz，isConsole 若仍为 true，面板会把它排最前
    // 并标成「网关控制台」，点开是一串 JSON —— 两个判据必须同源。
    expect(isGatewayConsoleEntry('llmgw', '/gw/healthz')).toBe(false);
    expect(resolveServiceLandingPath('llmgw', '/gw/healthz')).toBe('/gw/healthz');
  });

  it('引擎与其它服务一律不是控制台', () => {
    expect(isGatewayConsoleEntry('llmgw-serve', '/gw/v1/healthz')).toBe(false);
    expect(isGatewayConsoleEntry('docs', '/')).toBe(false);
  });
});

describe('savedAliasOwners / 入口表与发布器口径一致（Codex P1）', () => {
  it('枚举全部分支的已保存别名，first-wins', () => {
    const owners = savedAliasOwners([
      { id: 'b1', subdomainAliases: ['Foo', ' bar '] },
      { id: 'b2', subdomainAliases: ['foo'] },
      { id: 'b3' },
    ]);
    expect(owners.get('foo')).toBe('b1');
    expect(owners.get('bar')).toBe('b1');
    expect(owners.size).toBe(2);
  });

  it('被别名占走的 host 不进入口表（发布器会跳过它，表不能还声明）', () => {
    const previewSlug = 'demo-claude-prd-agent';
    const canonical = namedServiceLabel(previewSlug, 'llmgw');
    const withAlias = buildPublishedEntrypoints({
      previewSlug, previewHost: HOST, subdomains: ['llmgw'],
      aliasOwnedLabels: new Set([canonical]),
    });
    // 规范名被占 → 不声明；兼容别名没被占 → 照常声明。
    expect(withAlias.serviceUrls['llmgw']).toBeUndefined();
    expect(withAlias.serviceUrls['llmgw-web']).toBe(`https://${namedServiceLabel(previewSlug, 'llmgw-web')}.${HOST}`);
    // 不传别名集合时行为不变（旧调用方不受影响）。
    const plain = buildPublishedEntrypoints({ previewSlug, previewHost: HOST, subdomains: ['llmgw'] });
    expect(plain.serviceUrls['llmgw']).toBe(`https://${canonical}.${HOST}`);
  });

  it('resolveBranchEntrypointsEnv 会把已保存别名占走的 host 排除掉', () => {
    const entry = { id: 'b1', projectId: 'p1', branch: 'claude/demo' } as unknown as BranchEntry;
    const slug = 'demo-claude-prd-agent';
    const occupied = namedServiceLabel(slug, 'llmgw');
    const env = resolveBranchEntrypointsEnv(entry, {
      previewHost: HOST,
      getProject: () => ({ slug: 'prd-agent' }),
      getEffectiveProfilesForBranch: () => [{ subdomain: 'llmgw' }],
      getAllBranches: () => [{ id: 'other', subdomainAliases: [occupied] }],
    });
    const table = JSON.parse(env.env[SERVICE_URLS_ENV_KEY]);
    expect(table['llmgw']).toBeUndefined();
    expect(table['llmgw-web']).toBeDefined();
  });
});

describe('别名抑制决定的全部消费方都接线了（形状 2 守卫）', () => {
  // 这条守卫存在的理由：同一个「被已保存别名占走则不算本分支的 host」决定，
  // 连续四轮 review 每次只被接进一半消费方（发布器 → 入口表 → 面板/API → 白名单）。
  // 逐个文件断言它确实传了别名集合，漏掉任何一个就红。
  const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

  it('发布器在 emit 单点按完整 host 查占位（别名 + 自定义域名，两趟都过它）', () => {
    const src = read('src/services/forwarder-route-publisher.ts');
    // 判定必须按完整 host：自定义域名存的是整条 host，只按标签判会漏掉它。
    expect(src).toContain('occupiedHostOwners(this.opts.state.getAllBranches(), this.opts.rootDomains)');
    expect(src).toContain('const hostOwner = occupiedHosts.get(host);');
    // 标签级那份别名检查已被按-host 检查完全包含，不许再留第二份判据。
    expect(src).not.toContain('aliasOwners.get(namedLabel)');
  });

  it('面板 / GET /api/branches 的网关入口清单过滤了被占走的 host', () => {
    const src = read('src/routes/branches.ts');
    expect(src).toContain('const gwAliasOwned = new Set(savedAliasOwners(stateService.getAllBranches()).keys())');
    expect(src).toContain('if (gwAliasOwned.has(namedLabel)) continue;');
  });

  it('两处 SSRF 白名单都传了别名集合（否则允许探测别人的应用）', () => {
    for (const rel of ['src/services/replica-loadtest.ts', 'src/routes/replica-sets.ts']) {
      const src = read(rel);
      expect(src).toContain('savedAliasOwners(');
      // 参数里含 `String(sub).toLowerCase()`，不能用 [^)]* —— 会被内层括号截断。
      expect(src).toMatch(/publishedServiceLabels\([\s\S]{0,120}?aliasOwned\)/);
    }
  });

  it('撞名占位刻意**不**过滤 —— 它要的是已声明拓扑占了哪些 host', () => {
    // 反向断言：这一处若也开始过滤，新的重复别名就会被放行（与其余四处相反的语义）。
    const src = read('src/routes/branches.ts');
    expect(src).toContain('for (const host of computeBranchPublishedServiceHosts(other, root))');
    expect(src).toContain('for (const label of publishedServiceLabels(slug, sub))');
  });
});

describe('CDS_CONSOLE_URL — 控制台入口由平台声明，不让消费方按名字猜（Codex P2）', () => {
  const entry = { id: 'b1', projectId: 'p1', branch: 'claude/demo' } as unknown as BranchEntry;
  const base = {
    previewHost: HOST,
    getProject: () => ({ slug: 'prd-agent' }),
  };

  it('控制台 profile（声明 /）下发 CDS_CONSOLE_URL', () => {
    const env = resolveBranchEntrypointsEnv(entry, {
      ...base,
      getEffectiveProfilesForBranch: () => [{ subdomain: 'llmgw', readinessProbe: { path: '/' } }],
    });
    expect(env.env[CONSOLE_URL_ENV_KEY]).toBe('https://demo-claude-prd-agent-llmgw.miduo.org');
    expect(env.reservedKeys).toContain(CONSOLE_URL_ENV_KEY);
  });

  it('存量布局：llmgw 是后端 API（声明 /gw/healthz）、llmgw-web 才是控制台', () => {
    // 这是本仓库 prd-agent 项目当前的真实布局。按 key 名猜会挑到 API host，
    // 把管理员的 SSO 票据送到一个只返回健康 JSON 的服务上。
    const env = resolveBranchEntrypointsEnv(entry, {
      ...base,
      getEffectiveProfilesForBranch: () => [
        { subdomain: 'llmgw', readinessProbe: { path: '/gw/healthz' } },
        { subdomain: 'llmgw-web', readinessProbe: { path: '/' } },
      ],
    });
    expect(env.env[CONSOLE_URL_ENV_KEY]).toBe('https://demo-claude-prd-agent-llmgw-web.miduo.org');
    // 两个 key 都在表里 —— 正说明按 key 集合无法区分两种布局。
    const table = JSON.parse(env.env[SERVICE_URLS_ENV_KEY]);
    expect(Object.keys(table).sort()).toEqual(['llmgw', 'llmgw-web']);
  });

  it('没有控制台 profile 时不下发该 key（可声明的缺席）', () => {
    const env = resolveBranchEntrypointsEnv(entry, {
      ...base,
      getEffectiveProfilesForBranch: () => [{ subdomain: 'llmgw-serve', readinessProbe: { path: '/gw/v1/healthz' } }],
    });
    expect(env.env[CONSOLE_URL_ENV_KEY]).toBeUndefined();
  });

  it('控制台 host 被别名占走时也不下发（表里没有就不声明）', () => {
    const occupied = namedServiceLabel('demo-claude-prd-agent', 'llmgw');
    const env = resolveBranchEntrypointsEnv(entry, {
      ...base,
      getEffectiveProfilesForBranch: () => [{ subdomain: 'llmgw', readinessProbe: { path: '/' } }],
      getAllBranches: () => [{ id: 'other', subdomainAliases: [occupied] }],
    });
    expect(env.env[CONSOLE_URL_ENV_KEY]).toBeUndefined();
  });
});
