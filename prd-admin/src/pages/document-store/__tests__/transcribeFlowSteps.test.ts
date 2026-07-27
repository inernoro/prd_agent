import { describe, expect, it } from 'vitest';
import { deriveTranscribeSteps } from '../transcribeFlowSteps';

/**
 * 录音转录全链路的阶段清单推导：
 * 模拟真实状态机（上传 → 转录 → 生成摘要 → 写入 → 完成 / 各阶段失败），
 * 断言 Notion 式四步清单逐项点亮的行为真的发生。
 */
describe('deriveTranscribeSteps', () => {
  it('快捷录音默认没有 AI 整理步骤', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '识别中', includeSummary: false });
    expect(steps.map(step => step.key)).toEqual(['upload', 'transcribe', 'save']);
    expect(steps.at(-1)?.label).toBe('保存录音和原文');
  });

  const base = { hasFile: true, hasEntry: true, summaryFailed: false } as const;

  it('上传中：第一步 active，其余 pending', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'uploading', phase: '排队中', hasEntry: false });
    expect(steps.map(s => s.state)).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(steps[0].label).toBe('上传音频');
  });

  it('已有条目场景：第一步直接 done，文案为「音频已就绪」', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '排队中', hasFile: false });
    expect(steps[0].state).toBe('done');
    expect(steps[0].label).toBe('音频已就绪');
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

  it('生成摘要阶段：转录 done、摘要 active', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '生成摘要' });
    expect(steps[1].state).toBe('done');
    expect(steps[2].state).toBe('active');
    expect(steps[3].state).toBe('pending');
  });

  it('写入中：摘要 done、保存 active', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'running', phase: '写入中' });
    expect(steps[2].state).toBe('done');
    expect(steps[3].state).toBe('active');
  });

  it('完成：四步全 done', () => {
    const steps = deriveTranscribeSteps({ ...base, status: 'done', phase: '完成' });
    expect(steps.map(s => s.state)).toEqual(['done', 'done', 'done', 'done']);
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
    expect(steps[2].sub).toContain('保留转录全文');
    expect(steps[3].state).toBe('done');
  });
});
