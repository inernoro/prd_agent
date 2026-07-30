import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveLlmGatewaySso, resolveLlmGatewaySsoHref } from '@/lib/llmGatewaySso';

const code = 'a'.repeat(43);

describe('resolveLlmGatewaySsoHref', () => {
  it('服务端未下发落点（正式环境同源）时走 /llmgw/', () => {
    expect(resolveLlmGatewaySsoHref(code)).toBe(`/llmgw/auth/map#code=${code}`);
    expect(resolveLlmGatewaySsoHref(code, {})).toBe(`/llmgw/auth/map#code=${code}`);
    expect(resolveLlmGatewaySsoHref(code, { baseUrl: null })).toBe(`/llmgw/auth/map#code=${code}`);
  });

  it('服务端下发独立控制台基址时原样使用', () => {
    expect(resolveLlmGatewaySsoHref(code, { baseUrl: 'https://demo-claude-prd-agent-llmgw-web.miduo.org/' }))
      .toBe(`https://demo-claude-prd-agent-llmgw-web.miduo.org/auth/map#code=${code}`);
  });

  it('基址缺尾斜杠时补齐，不产生 //auth 或 xxxauth', () => {
    expect(resolveLlmGatewaySsoHref(code, { baseUrl: 'https://gw.example.org' }))
      .toBe(`https://gw.example.org/auth/map#code=${code}`);
  });

  it('可携带受控的 Gateway 页面回跳路径', () => {
    expect(resolveLlmGatewaySsoHref(code, null, '/logs?requestId=req-1'))
      .toBe(`/llmgw/auth/map?returnTo=${encodeURIComponent('/logs?requestId=req-1')}#code=${code}`);
  });

  it.each(['//attacker.example', 'https://attacker.example', '/logs\ninvalid'])('拒绝不安全回跳路径：%s', (returnTo) => {
    expect(resolveLlmGatewaySsoHref(code, null, returnTo)).toBe(`/llmgw/auth/map#code=${code}`);
  });

  it.each([`${'a'.repeat(42)}`, 'unsafe/value', '', null])('拒绝非法一次性 code：%s', (value) => {
    expect(resolveLlmGatewaySsoHref(value)).toBeNull();
  });
});

describe('落点只能来自服务端，前端不得推算域名', () => {
  it('入口未发布时报真实原因，不得说成凭据问题', () => {
    // 2026-07-29 现场：分支 slug 57 + '-llmgw-web' 10 = 67 > 63，平台不发布该子域。
    // 此前前端自己拼域名并把失败笼统报成「凭据未通过安全校验」，把人引向错误方向。
    const reason = '本环境未发布模型网关控制台入口：预览分支名过长时，网关子域会超出 DNS 63 字符上限，平台不会发布这条路由。';
    const resolution = resolveLlmGatewaySso(code, { baseUrl: null, unavailableReason: reason });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('console-entry-unpublished');
    expect(resolution.message).toBe(reason);
    expect(resolution.message).not.toContain('凭据');
  });

  it('入口未发布时不得回退成同源地址（那会静默跳到一个不存在的控制台）', () => {
    const resolution = resolveLlmGatewaySso(code, { unavailableReason: '未发布' });
    expect(resolution.ok).toBe(false);
  });

  it('code 非法时才报凭据未通过校验', () => {
    const resolution = resolveLlmGatewaySso('too-short');
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('invalid-code');
    expect(resolution.message).toBe('登录凭据未通过安全校验');
  });

  it('模块源码里不得再出现域名推算的痕迹', () => {
    // 守卫：这条链路的正确性建立在「前端没有第二份域名实现」上（根 CLAUDE.md 规则 #11）。
    // 谁把 hostname 拼接搬回来，这条就红 —— 行为断言测不到「有没有人重新造轮子」。
    const source = readFileSync(new URL('../llmGatewaySso.ts', import.meta.url), 'utf-8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toContain('miduo.org');
    expect(code).not.toContain('hostname');
    expect(code).not.toContain('63');
  });
});
