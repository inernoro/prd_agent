/**
 * 失败卡分档判据。
 *
 * 为什么要钉住：三种处境此前共用同一句「上次转文字没成功 / 点重试」——
 * 后台排队一小时被说成坏了，整段没人声也让人去重试同一段音频。
 * 差别是判据不是措辞，只有单测能证明「换一个 failureCode 会走对档」；
 * 截图看不出这件事。
 */
import { describe, it, expect } from 'vitest';
import { describeFailurePresentation, stalledTranscriptionNotice } from '@/pages/document-store/recordingVault';
import type { FailedTranscriptionNotice } from '@/pages/document-store/recordingVault';

const notice = (over: Partial<FailedTranscriptionNotice> = {}): FailedTranscriptionNotice => ({
  reason: '模型请求超时。', at: null, code: null, automaticRetryCount: 0, automaticRetryNextAt: null, partialTranscript: [], ...over,
});

describe('describeFailurePresentation', () => {
  it('自动重试期间压过一切类别——正在自愈时不该让用户做任何事', () => {
    const p = describeFailurePresentation(
      notice({ code: 'RUN_STALLED', automaticRetryCount: 2 }),
      { waitingAutoRetry: true, retryLabel: '8 秒后' },
    );
    expect(p.title).toBe('转录失败，正在自动重试');
    expect(p.nextStep).toContain('第 3 / 3 次');
    expect(p.nextStep).toContain('8 秒后');
  });

  it('后台失联一小时：说仍在排队、可以走开，而不是说坏了', () => {
    const p = describeFailurePresentation(notice({ code: 'RUN_STALLED' }), { waitingAutoRetry: false });
    expect(p.title).toBe('处理已超过一小时');
    expect(p.subtitle).toContain('还在排队');
    /*
     * 「可以走开」要保留，但不能承诺「关掉这一页也行」：通知是这一屏观察到 run 转终态
     * 时发的，没有 service worker 也没有服务端订阅，页面一关就没人看着了
     * （Codex 第十三轮 P1）。此前这条断言逐字钉着那句兑现不了的承诺——
     * 它把缺陷锁死成了「改就变红」（predicate-and-wiring-discipline 形状 4a）。
     */
    expect(p.nextStep).toContain('走开');
    expect(p.nextStep).toContain('先别关');
    expect(p.nextStep).not.toContain('就可以关掉这一页');
    // 产品方裁定：重试仍是唯一恢复出口，文案不能把它拿掉
    expect(p.nextStep).toContain('重试');
  });

  it('已经生成了半篇原文时，告诉用户那半篇现在就能读', () => {
    const p = describeFailurePresentation(
      notice({ code: 'RUN_STALLED' }),
      { waitingAutoRetry: false, hasPartialTranscript: true },
    );
    expect(p.nextStep).toContain('部分原文');
  });

  it.each(['ASR_NO_SPEECH', 'ASR_ALL_CANDIDATES_NO_SPEECH', 'asr_no_speech'])(
    '整段没人声（%s）：让用户先播一遍确认，别让他重试同一段音频',
    (code) => {
      const p = describeFailurePresentation(notice({ code }), { waitingAutoRetry: false });
      expect(p.title).toBe('没有检测到有效语音');
      expect(p.nextStep).toContain('播');
      expect(p.nextStep).toContain('重试不会有别的结果');
    },
  );

  it('其余真失败维持原样', () => {
    const p = describeFailurePresentation(notice({ code: 'ERR_CODEC' }), { waitingAutoRetry: false });
    expect(p.title).toBe('转录失败');
    expect(p.nextStep).toContain('转码');
  });
});

describe('四种处境必须长得不一样', () => {
  const cases = [
    ['ERR_CODEC', false, 'danger', 'alert'],
    ['ASR_NO_SPEECH', false, 'neutral', 'mic-off'],
    ['RUN_STALLED', false, 'queued', 'clock'],
    ['ERR_TIMEOUT', true, 'retrying', 'retry'],
  ] as const;

  it.each(cases)('%s → 色调 %s、图标 %s', (code, waiting, tone, icon) => {
    const p = describeFailurePresentation(notice({ code }), { waitingAutoRetry: waiting, retryLabel: '8 秒后' });
    expect(p.tone).toBe(tone);
    expect(p.icon).toBe(icon);
  });

  it('四种处境两两不同色不同图标——共用一套壳就等于没分档', () => {
    const seen = cases.map(([code, waiting]) =>
      describeFailurePresentation(notice({ code }), { waitingAutoRetry: waiting, retryLabel: '8 秒后' }));
    expect(new Set(seen.map(p => p.tone)).size).toBe(4);
    expect(new Set(seen.map(p => p.icon)).size).toBe(4);
  });

  it('排队那一档的原因不许把等待说成故障', () => {
    expect(stalledTranscriptionNotice(null).reason).not.toContain('不能确认');
    expect(stalledTranscriptionNotice(null).reason).toContain('排队');
  });
});
