import { describe, expect, it } from 'vitest';
import { literaryGenerationError } from './literaryGenerationError';

describe('文学配图失败提示', () => {
  it('真实无可用线路错误不把模型和路由诊断透给用户，保留恢复动作', () => {
    const result = literaryGenerationError(new Error('逻辑模型没有可用上游 Offering: gpt-5.6-sol'));
    expect(result).toContain('请稍后重试');
    expect(result).not.toMatch(/Offering|gpt|上游/);
  });
  it('刷新回读的历史错误和流式异常遵守相同脱敏边界', () => {
    const raw = 'HTTP 403 https://example.test/private?api_key=secret-example';
    expect(literaryGenerationError(raw)).toBe(literaryGenerationError(new Error(raw)));
    expect(literaryGenerationError(raw)).not.toMatch(/secret-example|example.test|403/);
  });
});
