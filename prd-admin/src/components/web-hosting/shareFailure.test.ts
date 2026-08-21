import { describe, expect, it } from 'vitest';
import { SHARE_FAILURE_REGISTRY, resolveShareFailure } from './shareFailure';

describe('访客打不开链接时该说哪一句', () => {
  it('两种大小写的可见性拒绝码都要认——后端两层给的写法不一样', () => {
    // 控制器兜底给大写 VISIBILITY_DENIED，服务层给小写 visibility_denied
    expect(resolveShareFailure('VISIBILITY_DENIED')).toBe('visibility-denied');
    expect(resolveShareFailure('visibility_denied')).toBe('visibility-denied');
  });

  it('过期与失效分开——一个能续期复活，一个只能重新分享', () => {
    expect(resolveShareFailure('EXPIRED')).toBe('expired');
    expect(resolveShareFailure('NOT_FOUND')).toBe('not-found');
    expect(SHARE_FAILURE_REGISTRY.expired.body).toContain('续期');
    expect(SHARE_FAILURE_REGISTRY['not-found'].body).toContain('新链接');
  });

  it('密码试太频繁是「等一会儿」，不能和「链接没救了」同一种语气', () => {
    expect(resolveShareFailure('RATE_LIMITED')).toBe('rate-limited');
    expect(SHARE_FAILURE_REGISTRY['rate-limited'].tone).toBe('wait');
  });

  it('限流文案要说清真实口径（每分钟 10 次），不写「请稍后再试」了事', () => {
    const body = SHARE_FAILURE_REGISTRY['rate-limited'].body;
    expect(body).toContain('每分钟最多试 10 次');
  });

  it('认不出的码落到 unknown，不冒充成某一种具体失败', () => {
    expect(resolveShareFailure('SOMETHING')).toBe('unknown');
    expect(resolveShareFailure(null)).toBe('unknown');
    expect(resolveShareFailure(undefined)).toBe('unknown');
  });

  it('只有登录可能解决的那一档才给「去登录」', () => {
    const withAction = Object.entries(SHARE_FAILURE_REGISTRY).filter(([, c]) => c.action);
    expect(withAction.map(([k]) => k)).toEqual(['visibility-denied']);
  });

  it('每一档的标题和正文互不相同，否则「视觉可区分」就是假的', () => {
    const all = Object.values(SHARE_FAILURE_REGISTRY);
    expect(new Set(all.map((c) => c.title)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.body)).size).toBe(all.length);
  });
});
