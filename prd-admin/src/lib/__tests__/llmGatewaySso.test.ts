import { describe, expect, it } from 'vitest';
import { resolveLlmGatewaySsoHref } from '@/lib/llmGatewaySso';

describe('resolveLlmGatewaySsoHref', () => {
  const code = 'a'.repeat(43);

  it('生产环境生成同源 Gateway fragment 路由', () => {
    expect(resolveLlmGatewaySsoHref(code, { hostname: 'map.ebcone.net', protocol: 'https:' }))
      .toBe(`/llmgw/auth/map#code=${code}`);
  });

  it('CDS 预览环境生成配对的 LLMGW 服务域名', () => {
    expect(resolveLlmGatewaySsoHref(code, {
      hostname: 'map-sso-codex-prd-agent.miduo.org',
      protocol: 'https:',
    })).toBe(`https://map-sso-codex-prd-agent-llmgw-web.miduo.org/auth/map#code=${code}`);
  });

  it.each([`${'a'.repeat(42)}`, 'unsafe/value', '', null])('拒绝非法一次性 code：%s', (value) => {
    expect(resolveLlmGatewaySsoHref(value, { hostname: 'map.ebcone.net', protocol: 'https:' })).toBeNull();
  });
});
