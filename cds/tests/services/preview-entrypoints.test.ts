import { describe, expect, it } from 'vitest';
import {
  PREVIEW_URL_ENV_KEY,
  SERVICE_URLS_ENV_KEY,
  buildPublishedEntrypoints,
  isPublishableNamedLabel,
  namedServiceLabel,
  publishedEntrypointsEnv,
  resolveBranchEntrypointsEnv,
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
    // 2026-07-29 现场分支：slug 57 + '-llmgw-web' 10 = 67 > 63。
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
    expect(env[SERVICE_URLS_ENV_KEY]).toBe('{"llmgw-web":"https://demo-claude-prd-agent-llmgw-web.miduo.org"}');
    expect(env[PREVIEW_URL_ENV_KEY]).toBe('https://demo-claude-prd-agent.miduo.org');
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
        publishedEntrypoints: { [SERVICE_URLS_ENV_KEY]: '{"llmgw-web":"https://real.miduo.org"}' },
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
});
