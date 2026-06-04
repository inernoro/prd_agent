import { describe, it, expect } from 'vitest';
import { genPhaseText } from '../VisualCreationMiniPanel';

// 断言「生图等待期分级状态文案」的可见行为（CLAUDE.md §6 禁止空白等待 + ai-model-visibility.md 展示模型名）。
// 这是用户在 30s+ 等待中"屏幕持续变化"的核心内容，必须：随时间跨档、始终带 elapsed、有模型名时带出模型名。
describe('genPhaseText — 生图等待分级文案', () => {
  const MODEL = 'gpt-image-2-all';

  it('0-15s：早期阶段，带 elapsed + 模型名', () => {
    const t = genPhaseText(3, MODEL);
    expect(t).toContain('正在绘制');
    expect(t).toContain('已 3s');
    expect(t).toContain(MODEL);
  });

  it('15-40s：中期阶段，给出常规耗时预期', () => {
    const t = genPhaseText(25, MODEL);
    expect(t).toContain('模型绘制中');
    expect(t).toContain('已 25s');
    expect(t).toContain('20-40s');
    expect(t).toContain(MODEL);
  });

  it('40s+：后期阶段，提示可取消重试', () => {
    const t = genPhaseText(52, MODEL);
    expect(t).toContain('已 52s');
    expect(t).toContain('取消重试');
    expect(t).toContain(MODEL);
  });

  it('三档之间随秒数严格切换（14→15、39→40 为分界）', () => {
    expect(genPhaseText(14, MODEL)).toContain('正在绘制');
    expect(genPhaseText(15, MODEL)).toContain('模型绘制中');
    expect(genPhaseText(39, MODEL)).toContain('模型绘制中');
    expect(genPhaseText(40, MODEL)).toContain('仍在绘制');
  });

  it('无模型名时不输出悬空的「· 」分隔符，仍保留 elapsed', () => {
    const t = genPhaseText(8, '');
    expect(t).toContain('已 8s');
    expect(t).not.toContain('·  ');
    expect(t).not.toContain('· ·');
  });
});
