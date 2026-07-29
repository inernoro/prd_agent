import { describe, expect, it } from 'vitest';
import { resolveLlmGatewaySso, resolveLlmGatewaySsoHref } from '@/lib/llmGatewaySso';

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

  it('可携带受控的 Gateway 页面回跳路径', () => {
    expect(resolveLlmGatewaySsoHref(code, { hostname: 'map.ebcone.net', protocol: 'https:' }, '/logs?requestId=req-1'))
      .toBe(`/llmgw/auth/map?returnTo=${encodeURIComponent('/logs?requestId=req-1')}#code=${code}`);
  });

  it.each(['//attacker.example', 'https://attacker.example', '/logs\ninvalid'])('拒绝不安全回跳路径：%s', (returnTo) => {
    expect(resolveLlmGatewaySsoHref(code, { hostname: 'map.ebcone.net', protocol: 'https:' }, returnTo))
      .toBe(`/llmgw/auth/map#code=${code}`);
  });

  it.each([`${'a'.repeat(42)}`, 'unsafe/value', '', null])('拒绝非法一次性 code：%s', (value) => {
    expect(resolveLlmGatewaySsoHref(value, { hostname: 'map.ebcone.net', protocol: 'https:' })).toBeNull();
  });
});

describe('resolveLlmGatewaySso 的失败原因必须可分辨', () => {
  const code = 'a'.repeat(43);
  // 2026-07-29 现场遇到的真实预览主机名：slug 57 + '-llmgw-web' 10 = 67 > 63。
  const longPreview = {
    hostname: 'llmgw-self-service-panel-redesign-f4oeh6-claude-prd-agent.miduo.org',
    protocol: 'https:',
  };

  it('预览分支名过长时报主机名问题，不得说成凭据问题', () => {
    const resolution = resolveLlmGatewaySso(code, longPreview);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('preview-host-too-long');
    // 关键回归点：这条路径下票据本身是好的，提示里绝不能出现「凭据」二字。
    expect(resolution.message).not.toContain('凭据');
    expect(resolution.message).toContain('超出 DNS 63 字符上限 4 个字符');
  });

  it('code 非法时才报凭据未通过校验', () => {
    const resolution = resolveLlmGatewaySso('too-short', { hostname: 'map.ebcone.net', protocol: 'https:' });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('invalid-code');
    expect(resolution.message).toBe('登录凭据未通过安全校验');
  });

  it('正常情况返回可跳转地址', () => {
    const resolution = resolveLlmGatewaySso(code, { hostname: 'map.ebcone.net', protocol: 'https:' });
    expect(resolution).toEqual({ ok: true, href: `/llmgw/auth/map#code=${code}` });
  });
});
