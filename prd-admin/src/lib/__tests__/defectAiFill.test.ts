import { describe, expect, it } from 'vitest';
import { firstSentenceOf, mergeAiScreenshotDescription } from '../defectAiFill';

describe('firstSentenceOf', () => {
  it('takes the first sentence ended by CJK or latin punctuation', () => {
    expect(firstSentenceOf('登录页按钮错位。点击无响应。')).toBe('登录页按钮错位。');
    expect(firstSentenceOf('Button misaligned. No response.')).toBe('Button misaligned.');
  });

  it('falls back to whole text and truncates overlong sentences', () => {
    expect(firstSentenceOf('无标点短句')).toBe('无标点短句');
    const long = '这是一个非常长的句子'.repeat(20);
    expect(firstSentenceOf(long).length).toBeLessThanOrEqual(63);
    expect(firstSentenceOf(long).endsWith('...')).toBe(true);
  });

  it('returns empty for blank input', () => {
    expect(firstSentenceOf('   ')).toBe('');
  });
});

describe('mergeAiScreenshotDescription', () => {
  const desc = '登录页提交按钮溢出屏幕右侧。页面底部出现横向滚动条。';

  it('seeds empty content with a title line plus labeled block', () => {
    const merged = mergeAiScreenshotDescription('', desc);
    const lines = merged.split('\n');
    expect(lines[0]).toBe('登录页提交按钮溢出屏幕右侧。');
    expect(merged).toContain(`【AI 截图识别】${desc}`);
  });

  it('appends to existing content without touching user input', () => {
    const user = '首页白屏\n\n复现步骤：打开首页';
    const merged = mergeAiScreenshotDescription(user, desc);
    expect(merged.startsWith(user)).toBe(true);
    expect(merged).toContain(`\n\n【AI 截图识别】${desc}`);
  });

  it('does not duplicate an already-merged description', () => {
    const once = mergeAiScreenshotDescription('首页白屏', desc);
    const twice = mergeAiScreenshotDescription(once, desc);
    expect(twice).toBe(once);
  });

  it('ignores blank descriptions', () => {
    expect(mergeAiScreenshotDescription('原文', '  ')).toBe('原文');
  });

  it('supports multiple distinct screenshot descriptions', () => {
    const d2 = '设置页头像加载失败，显示裂图占位。';
    const merged = mergeAiScreenshotDescription(mergeAiScreenshotDescription('原文', desc), d2);
    expect(merged).toContain(desc);
    expect(merged).toContain(d2);
    expect(merged.startsWith('原文')).toBe(true);
  });
});
