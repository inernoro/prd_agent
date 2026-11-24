import { describe, expect, it } from 'vitest';
import { toFriendlyRewriteError } from '../selectionRewriteError';

/**
 * 判据是「用户看到这句话知不知道下一步做什么」，不是「翻译得像不像」。
 * 所以每条都断言两件事：面上不再出现上游原文里的黑话；原文一个字不丢地留在 raw 里。
 */
describe('划词改写失败：上游原文翻译成人话', () => {
  it('用户实际撞到的那一条：未提供令牌', () => {
    const raw = '未提供令牌 (request id: 2026082514330012ab)';
    const e = toFriendlyRewriteError(raw);
    expect(e.message).toBe('AI 服务没配好：模型平台没收到密钥');
    expect(e.hint).toContain('管理员');
    // 面上不许再出现「令牌」「request id」这种用户无从下手的词
    expect(e.message + (e.hint ?? '')).not.toMatch(/令牌|request id/);
    // 但原文必须原样留着，排查时还得靠它
    expect(e.raw).toBe(raw);
  });

  it('英文 401 / api key 同样认得出', () => {
    expect(toFriendlyRewriteError('401 Unauthorized: invalid api key').message).toContain('密钥');
    expect(toFriendlyRewriteError('Missing API key for provider').message).toContain('密钥');
  });

  it('余额、限流、超时、无可用模型各归各的，且都给下一步', () => {
    const cases: Array<[string, string]> = [
      ['insufficient balance', '余额'],
      ['rate limit exceeded (429)', '排队'],
      ['upstream timeout after 60s', '超时'],
      ['no available model in pool', '没有可用的模型'],
    ];
    for (const [raw, expected] of cases) {
      const e = toFriendlyRewriteError(raw);
      expect(e.message, raw).toContain(expected);
      expect(e.hint, `${raw} 缺少下一步`).toBeTruthy();
    }
  });

  it('密钥类优先于限流类——上游常把两者写在一句里，没密钥是更根上的原因', () => {
    expect(toFriendlyRewriteError('401 unauthorized, rate limit may also apply').message).toContain('密钥');
  });

  it('认不出来的错不硬翻：兜底一句 + 原文带回，不假装知道原因', () => {
    const raw = 'ECONNRESET while reading upstream chunk #7';
    const e = toFriendlyRewriteError(raw);
    expect(e.message).toBe('AI 改写没能完成');
    expect(e.hint).toBeUndefined();
    expect(e.raw).toBe(raw);
  });

  it('空错误也有话说，不出现 undefined', () => {
    expect(toFriendlyRewriteError(undefined).message).toBe('AI 改写没能完成');
    expect(toFriendlyRewriteError('   ').raw).toBe('');
  });
});
