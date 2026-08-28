import { describe, expect, it } from 'vitest';
import { describeFailedTranscription, recoverableBackgroundTranscriptionRunId } from '../recordingVault';

/**
 * 「我不清楚是好了还是坏了」的判据。
 *
 * 三种终局里，在途 run 有后台看护、成功 run 会长出笔记，只有失败 run 两头不沾：
 * 不接住它，关掉抽屉或刷新之后整屏就退回「把录音转成文字」，
 * 用户看不出刚才跑过、更看不出为什么没成。这里逐格钉死，避免哪天又被静默掉。
 */
describe('describeFailedTranscription', () => {
  it('失败 run 给出可读原因', () => {
    const r = describeFailedTranscription({
      status: 'failed',
      errorMessage: '自动尝试 2 个 ASR 方案仍失败：大模型平台额度已用尽或被限额',
      endedAt: '2026-08-07T16:04:30Z',
      updatedAt: '2026-08-07T16:05:00Z',
    });
    expect(r?.reason).toBe('自动尝试 2 个 ASR 方案仍失败：大模型平台额度已用尽或被限额');
    expect(r?.at).toBe('2026-08-07T16:04:30Z');
  });

  it('诊断块是排障细节，不端给用户', () => {
    const r = describeFailedTranscription({
      status: 'failed',
      errorMessage: '转写调用失败：额度不足\n\n[diagnostic]\n{"statusCode":402,"platformId":"platform1"}',
    });
    expect(r?.reason).toBe('转写调用失败：额度不足');
    expect(r?.reason).not.toContain('platformId');
  });

  it('失败但没带原因时也要说话，不能给一个空条', () => {
    expect(describeFailedTranscription({ status: 'failed', errorMessage: '   ' })?.reason).toBe('转录失败，原因未知');
  });

  it('失败码原样透出，上游没给就是 null（不许编一个出来）', () => {
    expect(describeFailedTranscription({
      status: 'failed', errorMessage: '音频编码不受支持', failureCode: 'ERR_CODEC',
    })?.code).toBe('ERR_CODEC');
    expect(describeFailedTranscription({ status: 'failed', errorMessage: 'x' })?.code).toBeNull();
    expect(describeFailedTranscription({
      status: 'failed', errorMessage: 'x', failureCode: '   ',
    })?.code).toBeNull();
  });

  it('自动重试是结构化事实：次数与下一次时刻分开给，界面据此说「第几次、还要多久」', () => {
    const r = describeFailedTranscription({
      status: 'failed', errorMessage: 'x',
      automaticRetryCount: 2, automaticRetryNextAt: '2026-08-25T10:00:08Z',
    });
    expect(r?.automaticRetryCount).toBe(2);
    expect(r?.automaticRetryNextAt).toBe('2026-08-25T10:00:08Z');
  });

  it('没有重试信息时按 0 次 / 无下次计，不是 undefined（界面据此转手动重试卡）', () => {
    const r = describeFailedTranscription({ status: 'failed', errorMessage: 'x' });
    expect(r?.automaticRetryCount).toBe(0);
    expect(r?.automaticRetryNextAt).toBeNull();
  });

  it('在途与成功都不算失败——这两种另有归宿，重复提示等于误报', () => {
    for (const status of ['publishing', 'queued', 'running', 'done']) {
      expect(describeFailedTranscription({ status, errorMessage: 'x' })).toBeNull();
    }
    expect(describeFailedTranscription(null)).toBeNull();
    expect(describeFailedTranscription(undefined)).toBeNull();
  });

  it('与在途看护判据互斥：同一个 run 不会既被接管又被报失败', () => {
    const failed = { id: 'r1', status: 'failed', errorMessage: '炸了' };
    const running = { id: 'r2', status: 'running' };
    const publishing = { id: 'r3', status: 'publishing' };
    expect(recoverableBackgroundTranscriptionRunId(failed)).toBeNull();
    expect(describeFailedTranscription(failed)).not.toBeNull();
    expect(recoverableBackgroundTranscriptionRunId(running)).toBe('r2');
    expect(describeFailedTranscription(running)).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId(publishing)).toBe('r3');
    expect(describeFailedTranscription(publishing)).toBeNull();
  });
});
