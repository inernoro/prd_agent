import { describe, expect, it } from 'vitest';
import { deriveTranscribeSteps } from '../transcribeFlowSteps';

/**
 * 录音转录全链路的阶段清单推导：
 * 模拟真实状态机（保存录音 → 生成原文 → 整理并保存 / 各阶段失败），
 * 断言移动端三步横向标志逐项点亮的行为真的发生。
 */
describe('deriveTranscribeSteps', () => {
  it('快捷录音默认没有 AI 整理步骤', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '识别中', includeSummary: false });
    expect(steps.map(step => step.key)).toEqual(['audio', 'transcribe', 'finish']);
    expect(steps.at(-1)?.label).toBe('保存到本页');
  });

  const base = { hasFile: true, hasEntry: true, summaryFailed: false } as const;

  it('上传中：第一步 active，其余 pending', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'uploading', phase: '排队中', hasEntry: false });
    expect(steps.map(s => s.state)).toEqual(['active', 'pending', 'pending']);
    expect(steps[0].label).toBe('保存录音');
  });

  it('已有条目场景：第一步直接 done，文案为「录音已就绪」', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '排队中', hasFile: false });
    expect(steps[0].state).toBe('done');
    expect(steps[0].label).toBe('录音已就绪');
  });

  it('转录阶段（识别中）：第二步 active 且副标题透出后端 phase', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '识别中' });
    expect(steps[1].state).toBe('active');
    expect(steps[1].sub).toBe('识别中');
    expect(steps[2].state).toBe('pending');
  });

  it('自动切换识别方案时：第二步保持 active 并展示当前方案', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '识别中（方案 2/3）' });
    expect(steps[1].state).toBe('active');
    expect(steps[1].sub).toBe('识别中（方案 2/3）');
    expect(steps[2].state).toBe('pending');
  });

  it('生成摘要阶段：原文 done、整理并保存 active', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '生成摘要' });
    expect(steps[1].state).toBe('done');
    expect(steps[2].state).toBe('active');
    expect(steps[2].label).toBe('整理并保存');
  });

  it('写入中：第三步仍保持 active', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '写入中' });
    expect(steps[2].state).toBe('active');
  });

  it('完成：三步全 done', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'done', phase: '完成' });
    expect(steps.map(s => s.state)).toEqual(['done', 'done', 'done']);
  });

  it('上传失败：第一步 failed，后续 pending', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'failed', phase: '排队中', hasEntry: false });
    expect(steps[0].state).toBe('failed');
    expect(steps[1].state).toBe('pending');
  });

  it('转录失败：第一步 done、第二步 failed', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'failed', phase: '识别中' });
    expect(steps[0].state).toBe('done');
    expect(steps[1].state).toBe('failed');
  });

  it('摘要降级失败：整链继续，摘要步 failed 且带说明，保存步仍可 done', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'done', phase: '完成', summaryFailed: true });
    expect(steps[2].state).toBe('failed');
    expect(steps[2].sub).toContain('原文已保留');
    expect(steps[2].state).toBe('failed');
  });
});
