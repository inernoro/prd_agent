import { describe, expect, it } from 'vitest';
import {
  advanceLiveSentenceLog,
  capturedUploadPercent,
  describeCaptureChips,
  isUploadKeepingUp,
  UPLOAD_LAG_TOLERANCE_BYTES,
  describeLiveTranscriptTitle,
  describeRetryCountdown,
  formatCapturedSize,
  liveTranscriptionRetryDelayMs,
  splitLiveSentences,
} from '../recordingCaptureView';

describe('splitLiveSentences', () => {
  it('按中文句读切句，保留句号', () => {
    expect(splitLiveSentences('先说结论。我们看了 312 个新账号，第 7 天只剩 41%。'))
      .toEqual(['先说结论。', '我们看了 312 个新账号，第 7 天只剩 41%。']);
  });

  it('没有句读的长段落算一句，不按长度硬截', () => {
    const long = '这一段话很长但是从头到尾没有任何句读所以它只能算一句不能被切成两句';
    expect(splitLiveSentences(long)).toEqual([long]);
  });

  it('空文本没有句子', () => {
    expect(splitLiveSentences('')).toEqual([]);
    expect(splitLiveSentences('   \n ')).toEqual([]);
  });
});

describe('advanceLiveSentenceLog', () => {
  it('新出现的句子盖上当前录音时刻', () => {
    const first = advanceLiveSentenceLog([], '先说结论。', 12);
    expect(first).toEqual([{ text: '先说结论。', atSec: 12 }]);
    const second = advanceLiveSentenceLog(first, '先说结论。第二句来了。', 30);
    expect(second[0].atSec).toBe(12);
    expect(second[1]).toEqual({ text: '第二句来了。', atSec: 30 });
  });

  it('最后一句还在长时，沿用它最早出现的时刻', () => {
    const a = advanceLiveSentenceLog([], '我们打算把导入', 40);
    const b = advanceLiveSentenceLog(a, '我们打算把导入拆成两步', 55);
    expect(b).toEqual([{ text: '我们打算把导入拆成两步', atSec: 40 }]);
  });

  it('同一位置换成另一句话时重新计时', () => {
    const a = advanceLiveSentenceLog([], '识别错的那句。', 10);
    const b = advanceLiveSentenceLog(a, '完全不同的一句。', 20);
    expect(b[0].atSec).toBe(20);
  });
});

describe('capturedUploadPercent', () => {
  it('分母是本机已录字节，不是录制上限', () => {
    expect(capturedUploadPercent(960, 1000)).toBe(96);
  });

  it('未收尾时封顶 99%，不出现「100% 还在传」', () => {
    expect(capturedUploadPercent(1000, 1000)).toBe(99);
    expect(capturedUploadPercent(1200, 1000)).toBe(99);
  });

  it('还没录到东西时是 0', () => {
    expect(capturedUploadPercent(0, 0)).toBe(0);
  });
});

describe('formatCapturedSize', () => {
  it('MB 档给一位小数', () => {
    expect(formatCapturedSize(19.1 * 1024 * 1024)).toBe('19.1 MB');
  });

  it('不足 1MB 时给 KB，不显示 0.0 MB', () => {
    expect(formatCapturedSize(300 * 1024)).toBe('300 KB');
  });
});

describe('describeCaptureChips', () => {
  const base = { localBytes: 19.1 * 1024 * 1024, uploadedBytes: 18.4 * 1024 * 1024, protection: 'active' as const, paused: false };

  it('录音中给出「已保护 / 本机已存 / 实时上传百分比」三块', () => {
    const chips = describeCaptureChips(base);
    expect(chips.map(c => c.key)).toEqual(['guarded', 'local', 'upload']);
    expect(chips[0].label).toContain('无丢失');
    expect(chips[1].label).toBe('本机已存 19.1 MB');
    expect(chips[2].label).toBe('实时上传 18.4 MB · 96%');
  });

  it('上传通道不可用时说「上传等待中」，但仍然声明已保护', () => {
    const chips = describeCaptureChips({ ...base, protection: 'local' });
    expect(chips[0].label).toContain('已保护');
    expect(chips.at(-1)).toMatchObject({ label: '上传等待中', tone: 'warning', icon: 'clock' });
  });

  it('暂停且队列追平后才敢说「已全部上传」', () => {
    const flushed = { ...base, uploadedBytes: base.localBytes, paused: true };
    expect(describeCaptureChips(flushed).at(-1)).toMatchObject({ label: '已全部上传', icon: 'check' });
    // 录音中即便字节数追平，也还有在途分片，不许说全部传完
    expect(describeCaptureChips({ ...flushed, paused: false }).at(-1)?.label).toContain('实时上传');
  });

  it('还没录到字节时不摆一个「本机已存 0 B」', () => {
    const chips = describeCaptureChips({ ...base, localBytes: 0, uploadedBytes: 0, protection: 'pending' });
    expect(chips.map(c => c.key)).toEqual(['guarded', 'upload']);
  });
});

describe('describeLiveTranscriptTitle', () => {
  const base = { state: 'live' as const, paused: false, expanded: false, sentenceCount: 28 };

  it('正常、暂停、展开、降级各是一句不同的话', () => {
    expect(describeLiveTranscriptTitle(base)).toBe('实时原文 · 正常');
    expect(describeLiveTranscriptTitle({ ...base, paused: true })).toBe('实时原文 · 已停在 28 句');
    expect(describeLiveTranscriptTitle({ ...base, expanded: true })).toBe('实时原文 · 全部 28 句');
    expect(describeLiveTranscriptTitle({ ...base, state: 'degraded' })).toBe('实时原文暂时不可用');
  });

  it('降级优先于暂停：断线时不能显示成「已停在 N 句」', () => {
    expect(describeLiveTranscriptTitle({ ...base, state: 'degraded', paused: true }))
      .toBe('实时原文暂时不可用');
  });
});

describe('liveTranscriptionRetryDelayMs', () => {
  it('退避递增，后两次落在网络可能恢复的窗口里', () => {
    expect(liveTranscriptionRetryDelayMs(1)).toBe(800);
    expect(liveTranscriptionRetryDelayMs(2)).toBe(4_000);
    expect(liveTranscriptionRetryDelayMs(3)).toBe(15_000);
  });

  it('越界取最后一档，不会返回 undefined', () => {
    expect(liveTranscriptionRetryDelayMs(9)).toBe(15_000);
    expect(liveTranscriptionRetryDelayMs(0)).toBe(800);
  });
});

describe('describeRetryCountdown', () => {
  it('没有已排期的重连就不许显示倒计时', () => {
    expect(describeRetryCountdown(null, 1_000)).toBeNull();
  });

  it('有排期时给剩余秒数，到点后改说「正在重连」', () => {
    expect(describeRetryCountdown(15_000, 1_000)).toBe('14s 后重试');
    expect(describeRetryCountdown(1_000, 1_200)).toBe('正在重连');
  });
});

/*
 * 「已保护 · 无丢失」是拿本机保险箱换来的凭据。写不进去时它就是假话——
 * 分片只在内存里，刷新、崩溃、关标签页全没（Codex P1）。
 */
describe('本机保险箱写不进去时的凭据', () => {
  const base = {
    localBytes: 5 * 1024 * 1024,
    uploadedBytes: 1 * 1024 * 1024,
    protection: 'active' as const,
    paused: false,
  };

  it('落不住盘就不说「无丢失」，改成让用户别关页', () => {
    const chips = describeCaptureChips({ ...base, vaultPersisted: false });
    expect(chips[0].tone).toBe('warning');
    expect(chips[0].label).toContain('请勿关闭本页');
    expect(chips.map(c => c.label).join('')).not.toContain('无丢失');
  });

  it('落不住盘就不摆「本机已存 X」——那份「已存」并不存在', () => {
    const chips = describeCaptureChips({ ...base, vaultPersisted: false });
    expect(chips.some(c => c.key === 'local')).toBe(false);
  });

  it('上传那条链路照常展示：这一档里它才是真正的活路', () => {
    const chips = describeCaptureChips({ ...base, vaultPersisted: false });
    expect(chips.some(c => c.key === 'upload')).toBe(true);
  });

  it('拿不到这个信号时行为与此前一致（按落住处理）', () => {
    expect(describeCaptureChips(base)[0].label).toContain('无丢失');
    expect(describeCaptureChips({ ...base, vaultPersisted: true })[0].label).toContain('无丢失');
  });
});


/*
 * 真实缺陷（用户在真机上报的）：录音每秒产生一个分片，localBytes 每秒跳一格、上传随即追平，
 * 于是 `uploadedBytes >= localBytes` 这个**瞬时**比较每秒翻一次。它在采集屏被消费三处
 * （凭据措辞、进度条满条还是百分比、那句「录音还在继续，新片段会接着传」出不出现），
 * 一屏每秒抖三下；窄屏上那句话进出还会把下面整块顶上顶下一行。
 * 判据必须带迟滞：落后不到几个分片仍算跟上，真的堆积了才翻。
 */
describe('上传「跟上了没有」带迟滞', () => {
  it('刚落下一个分片、还没传完，仍然算跟上（否则每秒翻一次）', () => {
    const local = 5 * 1024 * 1024;
    expect(isUploadKeepingUp(local - 8 * 1024, local)).toBe(true);
    expect(isUploadKeepingUp(local, local)).toBe(true);
  });

  it('真的堆积了就不算跟上——不许按比例判', () => {
    // 19MB 里落后 700KB 只有 3.7%，听着很小，其实落后约一分半
    expect(isUploadKeepingUp(18.4 * 1024 * 1024, 19.1 * 1024 * 1024)).toBe(false);
  });

  it('容忍量是分片量级，不是随手一个大数', () => {
    expect(UPLOAD_LAG_TOLERANCE_BYTES).toBeGreaterThanOrEqual(16 * 1024);
    expect(UPLOAD_LAG_TOLERANCE_BYTES).toBeLessThanOrEqual(64 * 1024);
  });

  it('还没开始录时不该判成掉队', () => {
    expect(isUploadKeepingUp(0, 0)).toBe(true);
  });
});
