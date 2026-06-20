import { describe, expect, it } from 'vitest';
import { getAutomationPrimaryActionLabel } from './DefectAutomationPanel';

describe('getAutomationPrimaryActionLabel', () => {
  it('prompts initial setup when no active authorization exists', () => {
    expect(getAutomationPrimaryActionLabel(false)).toBe('生成并复制每日任务配置');
  });

  it('makes regeneration explicit when an active authorization already exists', () => {
    expect(getAutomationPrimaryActionLabel(true)).toBe('重新生成并复制配置');
  });
});
