import { describe, expect, it } from 'vitest';
import { formatVideoGenerationError } from './videoGenerationError';

describe('formatVideoGenerationError', () => {
  it('removes provider credit details and links from persisted legacy errors', () => {
    const message = formatVideoGenerationError(
      '大模型平台额度已用尽或被限额。上游信息：Insufficient credits. Add more using https://openrouter.ai/settings/credits',
    );

    expect(message).toContain('上游 AI 服务可用额度已用尽');
    expect(message).not.toContain('上游信息');
    expect(message).not.toContain('http');
  });

  it.each([
    ['LLM_ACCOUNT_OVERDUE', '账户欠费'],
    ['LLM_INSUFFICIENT_BALANCE', '余额不足'],
    ['LLM_PAYMENT_REQUIRED', '账单或费用额度'],
    ['LLM_QUOTA_EXCEEDED', '用量上限'],
  ])('shows the structured billing cause %s without supplier diagnostics', (code, expected) => {
    const text = formatVideoGenerationError('SECRET provider HTTP 403 https://supplier.invalid/key', code);
    expect(text).toContain('上游 AI 服务');
    expect(text).toContain(expected);
    expect(text).toContain('管理员');
    expect(text).not.toMatch(/SECRET|HTTP|supplier/);
  });

  it('keeps a sanitized backend cause when a historical task has only a generic code', () => {
    const text = '上游 AI 服务账户欠费，本次操作未完成。请联系管理员补缴费用或切换可用线路，处理后再重试。';
    expect(formatVideoGenerationError(text)).toBe(text);
  });

  it('keeps a known duration recovery action', () => {
    expect(formatVideoGenerationError(
      'Duration 6s is not supported for this model. Supported durations: 5, 10s',
    )).toBe('当前模型不支持 6 秒视频，仅支持 5, 10 秒。请改用支持的时长后重试。');
  });

  it('hides unknown protocol diagnostics behind a stable recovery action', () => {
    const message = formatVideoGenerationError('HTTP 500 provider token invalid at https://provider.example');
    expect(message).toBe('视频生成未完成，请稍后重试；若持续出现，请联系管理员');
  });
});
