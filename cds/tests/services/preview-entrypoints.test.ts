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

  it('超 63 octet 的命名子域不声明,主入口仍在', () => {
    // 2026-07-29 现场分支：slug 57 + '-llmgw-web' 10 = 67 > 63。
    // 这正是 MAP 前端自己拼域名时拼出一个 CDS 根本没发布的 host 的那条分支。
    const previewSlug = 'llmgw-self-service-panel-redesign-f4oeh6-claude-prd-agent';
    expect(previewSlug).toHaveLength(57);
    const r = buildPublishedEntrypoints({ previewSlug, previewHost: HOST, subdomains: ['llmgw-web'] });
    expect(namedServiceLabel(previewSlug, 'llmgw-web')).toHaveLength(67);
    expect(r.previewUrl).toBe(`https://${previewSlug}.miduo.org`);
    // 关键回归点：缺席必须是「表里没有」，不能退化成空串 / 猜一个截断地址。
    expect(r.serviceUrls).toEqual({});
    expect(r.serviceUrls['llmgw-web']).toBeUndefined();
  });

  it('恰好 63 发布、64 不发布（边界不许偏一位）', () => {
    const sub = 'x';
    const slug61 = 'a'.repeat(61);
    expect(isPublishableNamedLabel(namedServiceLabel(slug61, sub))).toBe(true);
    expect(isPublishableNamedLabel(namedServiceLabel(`${slug61}a`, sub))).toBe(false);
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
