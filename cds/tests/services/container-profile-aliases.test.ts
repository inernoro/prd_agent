import { describe, it, expect } from 'vitest';
import { computeProfileAliases } from '../../src/services/container.js';

describe('computeProfileAliases', () => {
  it('剥离带连字符的项目 slug 后缀,产出裸 <svc>(核心回归:llmgw)', () => {
    const aliases = computeProfileAliases('llmgw-prd-agent', ['prd-agent']);
    expect(aliases).toContain('llmgw-prd-agent'); // profile.id 永远在
    expect(aliases).toContain('llmgw');           // ← nginx 反代 http://llmgw:8090 依赖此裸名
  });

  it('多段服务名 + 带连字符 slug: llmgw-serve-prd-agent → llmgw-serve', () => {
    const aliases = computeProfileAliases('llmgw-serve-prd-agent', ['prd-agent']);
    expect(aliases).toContain('llmgw-serve-prd-agent');
    expect(aliases).toContain('llmgw-serve');
    expect(aliases).not.toContain('llmgw'); // 只到服务名边界,不过度剥离
  });

  it('单段服务名 + 带连字符 slug: api-prd-agent → api', () => {
    expect(computeProfileAliases('api-prd-agent', ['prd-agent'])).toContain('api');
    expect(computeProfileAliases('admin-prd-agent', ['prd-agent'])).toContain('admin');
  });

  it('marker 是 projectId(随机后缀)时也剥离: llmgw-defd4695ab5f → llmgw', () => {
    const aliases = computeProfileAliases('llmgw-defd4695ab5f', ['defd4695ab5f', 'prd-agent']);
    expect(aliases).toContain('llmgw');
  });

  it('保留旧单段启发式: mysql-mdimp → mysql(marker 传 [id, slug])', () => {
    const aliases = computeProfileAliases('mysql-mdimp', ['defd4695ab5f', 'mdimp']);
    expect(aliases).toContain('mysql-mdimp');
    expect(aliases).toContain('mysql');
  });

  it('服务名恰好等于项目名时不产生空/裸别名', () => {
    expect(computeProfileAliases('prd-agent', ['prd-agent'])).toEqual(['prd-agent']);
  });

  it('无项目后缀时只有自己一个别名', () => {
    expect(computeProfileAliases('redis', ['prd-agent'])).toEqual(['redis']);
    expect(computeProfileAliases('web-2', ['prd-agent'])).toEqual(['web-2']);
  });

  it('歧义短 marker(prd) 不误命中: llmgw-serve-prd-agent 仍只到 llmgw-serve', () => {
    const aliases = computeProfileAliases('llmgw-serve-prd-agent', ['prd-agent', 'prd']);
    expect(aliases).toContain('llmgw-serve');
    // 不存在 profileId 上「-prd」结尾的切点,故不会误剥出 llmgw-serve-agent 之类
    expect(aliases).not.toContain('llmgw-serve-agent');
  });

  it('profileId 为空数组 marker 时安全', () => {
    expect(computeProfileAliases('llmgw-prd-agent', [])).toEqual(['llmgw-prd-agent']);
  });

  it('llmgw-web-prd-agent → llmgw-web(前端站裸别名)', () => {
    const aliases = computeProfileAliases('llmgw-web-prd-agent', ['prd-agent']);
    expect(aliases).toContain('llmgw-web-prd-agent');
    expect(aliases).toContain('llmgw-web');
  });
});
