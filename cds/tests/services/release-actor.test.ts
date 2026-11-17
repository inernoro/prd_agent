import { describe, expect, it } from 'vitest';
import { resolveReleaseActorFromRequest } from '../../src/services/release-actor.js';
describe('发布认证责任人', () => {
  it('保存稳定用户ID和当时的显示名', () => {
    expect(resolveReleaseActorFromRequest({cdsUser:{id:'u-1',name:'操作员'}})).toBe(`user:u-1:${encodeURIComponent('操作员')}`);
  });
  it('客户端伪造 header 不能覆盖已认证身份', () => {
    expect(resolveReleaseActorFromRequest({cdsUser:{id:'u-1',username:'alice'},headers:{'x-ai-impersonate':'bob','x-cds-trigger':'webhook'}})).toBe('user:u-1:alice');
  });
  it('项目密钥只标识执行凭据，不伪造持有人', () => {
    expect(resolveReleaseActorFromRequest({cdsProjectKey:{projectId:'p1',keyId:'abc123'},headers:{'x-ai-impersonate':'owner'}})).toBe('ai:key:abc123');
  });
  it('没有认证身份时明确未知，不能信任声明姓名', () => {
    expect(resolveReleaseActorFromRequest({headers:{'x-ai-impersonate':'alice','x-cds-trigger':'webhook'}})).toBe('unknown');
    expect(resolveReleaseActorFromRequest(null)).toBe('unknown');
  });
  it('持久化显示名过滤控制字符', () => {
    expect(resolveReleaseActorFromRequest({cdsUser:{id:'u',name:'a\nb'}})).toBe('user:u:ab');
  });
});
