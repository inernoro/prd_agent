import { describe, expect, it } from 'vitest';
import { resolveGatewayConsoleHref } from './CompatibilityStack';

describe('resolveGatewayConsoleHref', () => {
  it('生产同域入口继续使用 /llmgw/', () => {
    expect(resolveGatewayConsoleHref({ hostname: 'map.ebcone.net', protocol: 'https:' })).toBe('/llmgw/');
  });

  it('CDS 主预览入口跳到同一分支的 Gateway Web 子域', () => {
    expect(resolveGatewayConsoleHref({
      hostname: 'llmgw-authoritative-tutorial-codex-prd-agent.miduo.org',
      protocol: 'https:',
    })).toBe('https://llmgw-authoritative-tutorial-codex-prd-agent-llmgw-web.miduo.org/');
  });

  it('Gateway Web 子域内不重复追加子域后缀', () => {
    expect(resolveGatewayConsoleHref({
      hostname: 'llmgw-authoritative-tutorial-codex-prd-agent-llmgw-web.miduo.org',
      protocol: 'https:',
    })).toBe('/');
  });

  it('超长预览分支不生成超过 DNS 上限的失效入口', () => {
    expect(resolveGatewayConsoleHref({
      hostname: `${'a'.repeat(54)}.miduo.org`,
      protocol: 'https:',
    })).toBeNull();
  });
});
