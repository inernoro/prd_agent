import { describe, expect, it } from 'vitest';
import { ASK_REFUSAL_REGISTRY, resolveAskRefusal } from './askRefusal';
import { ASK_ERROR_CODES } from './askTypes';

describe('提问被拒时该说哪一句', () => {
  it('能问的时候不摆拒绝卡', () => {
    expect(resolveAskRefusal({ isAuthenticated: true, allowAnonymous: false, gateErrorCode: null })).toBeNull();
    expect(resolveAskRefusal({ isAuthenticated: false, allowAnonymous: true })).toBeNull();
  });

  it('未登录压过服务端错误码——让人去等一个不需要等的额度是最糟的引导', () => {
    expect(resolveAskRefusal({
      isAuthenticated: false,
      allowAnonymous: false,
      gateErrorCode: ASK_ERROR_CODES.quotaVisitor,
    })).toBe('need-login');
  });

  it('每种拒绝各自映射到自己那一张卡，不混成一句「问不了」', () => {
    const base = { isAuthenticated: true, allowAnonymous: true };
    expect(resolveAskRefusal({ ...base, gateErrorCode: ASK_ERROR_CODES.noContent })).toBe('no-content');
    expect(resolveAskRefusal({ ...base, gateErrorCode: ASK_ERROR_CODES.disabled })).toBe('disabled');
  });

  it('两种额度必须分开——后端算得出维度，压成一张卡就是把信息又丢一次', () => {
    const base = { isAuthenticated: true, allowAnonymous: true };
    // 访客维度：等一会儿会自己恢复，登录还能换更宽的额度 → 给得出下一步
    expect(resolveAskRefusal({ ...base, gateErrorCode: ASK_ERROR_CODES.quotaVisitor })).toBe('quota-visitor');
    // 站点维度：是别人问光的，你等到明天，登录也没用 → 不该给「去登录」
    expect(resolveAskRefusal({ ...base, gateErrorCode: ASK_ERROR_CODES.quotaSiteDaily })).toBe('quota-site');
    expect(ASK_REFUSAL_REGISTRY['quota-visitor'].action).toBe('login');
    expect(ASK_REFUSAL_REGISTRY['quota-site'].action).toBeUndefined();
  });

  it('不带维度的旧码只能落到笼统那一档，不许冒充成其中某一种', () => {
    expect(resolveAskRefusal({
      isAuthenticated: true, allowAnonymous: true, gateErrorCode: ASK_ERROR_CODES.quotaExceeded,
    })).toBe('quota-exceeded');
  });

  it('读不到正文要给重试——后端读不到会退额度，重试不烧钱', () => {
    expect(ASK_REFUSAL_REGISTRY['no-content'].action).toBe('retry');
  });

  it('服务端 401 也归到需登录，用户看到的是「去登录」而不是错误码', () => {
    expect(resolveAskRefusal({
      isAuthenticated: true, allowAnonymous: true, gateErrorCode: ASK_ERROR_CODES.unauthorized,
    })).toBe('need-login');
  });

  it('认不出的错误码不冒充成某一种拒绝——那会把网络抖动说成「额度用完」', () => {
    expect(resolveAskRefusal({ isAuthenticated: true, allowAnonymous: true, gateErrorCode: 'SOMETHING_ELSE' })).toBeNull();
  });

  it('每一种拒绝的文案都必须互不相同，否则「视觉可区分」就是假的', () => {
    const entries = Object.values(ASK_REFUSAL_REGISTRY);
    expect(new Set(entries.map((c) => c.title)).size).toBe(entries.length);
    expect(new Set(entries.map((c) => c.body)).size).toBe(entries.length);
    // 占位文案也不许都写「暂不可用」——那等于把拒绝理由又藏回去
    expect(new Set(entries.map((c) => c.placeholder)).size).toBe(entries.length);
  });

  it('给了动作按钮的，动作必须真的能解决它那一档', () => {
    const withAction = Object.entries(ASK_REFUSAL_REGISTRY).filter(([, c]) => c.action);
    expect(withAction.map(([k]) => k).sort()).toEqual(['need-login', 'no-content', 'quota-visitor']);
    // 每个动作按钮都得有自己的字：四档都写「去登录」等于没分档
    const labels = withAction.map(([, c]) => c.actionLabel);
    expect(labels.every(Boolean)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
