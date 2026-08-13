import { describe, expect, it } from 'vitest';
import { formatVideoGenerationError } from './videoGenerationError';

describe('formatVideoGenerationError', () => {
  it('removes provider credit details and links from persisted legacy errors', () => {
    const message = formatVideoGenerationError(
      '大模型平台额度已用尽或被限额。上游信息：Insufficient credits. Add more using https://openrouter.ai/settings/credits',
    );

    expect(message).toBe('当前可用额度不足，请联系管理员补充额度或切换可用配置后重试。');
    expect(message).not.toContain('上游信息');
    expect(message).not.toContain('http');
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
