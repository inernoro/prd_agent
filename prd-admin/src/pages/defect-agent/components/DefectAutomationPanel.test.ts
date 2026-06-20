import { describe, expect, it } from 'vitest';
import { getAutomationPrimaryActionLabel, statusLabel } from './DefectAutomationPanel';

describe('getAutomationPrimaryActionLabel', () => {
  it('prompts initial setup when no active authorization exists', () => {
    expect(getAutomationPrimaryActionLabel(false)).toBe('生成并复制每日任务配置');
  });

  it('makes regeneration explicit when an active authorization already exists', () => {
    expect(getAutomationPrimaryActionLabel(true)).toBe('重新生成并复制配置');
  });

  it('labels single defect automation item lifecycle states', () => {
    expect(statusLabel('fetched')).toBe('已拉取');
    expect(statusLabel('commented')).toBe('已评论');
    expect(statusLabel('commit_written')).toBe('已回写提交');
    expect(statusLabel('fixed')).toBe('已修复');
  });
});
