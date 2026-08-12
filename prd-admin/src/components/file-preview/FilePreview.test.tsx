import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DocBrowserEntry } from '@/components/doc-browser/DocBrowser';
import { FilePreview, describeArchiveWait, formatBackgroundDuration, isStaleRecordingArchive } from './FilePreview';

function pendingAudioEntry(metadata: Record<string, string> = {}): DocBrowserEntry {
  return {
    id: 'recording-1',
    // .webm 同时出现在视频扩展名注册表中，必须由 audio MIME 覆盖扩展名判断。
    title: '录音 2026-07-31 03-17.webm',
    contentType: 'audio/webm',
    sourceType: 'upload',
    isFolder: false,
    fileSize: 1024,
    metadata: { audioArchiveStatus: 'pending', ...metadata },
  };
}

describe('FilePreview pending recording', () => {
  it('marks a pending archive stale after ten minutes so it can be retried manually', () => {
    const now = Date.parse('2026-08-04T03:00:00.000Z');

    expect(isStaleRecordingArchive('2026-08-04T02:49:59.000Z', now)).toBe(true);
    expect(isStaleRecordingArchive('2026-08-04T02:50:01.000Z', now)).toBe(false);
    expect(isStaleRecordingArchive(undefined, now)).toBe(false);
  });

  it('shows a stable archive status instead of an empty preview', () => {
    const html = renderToStaticMarkup(
      <FilePreview entry={pendingAudioEntry()} preview={null} />,
    );

    expect(html).toContain('正在保存云端副本');
    expect(html).toContain('不会自动总结或改写');
    expect(html).toContain('完成后本页自动更新，可以离开本页');
    expect(html).not.toContain('暂无可预览的内容');
  });

  it('plays the local insured audio and presents the live transcript while cloud archive continues', () => {
    const html = renderToStaticMarkup(
      <FilePreview
        entry={pendingAudioEntry({ liveTranscript: '这是刚刚录下来的实时原文。' })}
        preview={{ text: null, fileUrl: 'blob:recording-1', contentType: 'audio/webm' }}
      />,
    );

    expect(html).toContain('现在可以播放、编辑原文');
    expect(html).toContain('这是刚刚录下来的实时原文');
    expect(html.match(/title="播放"/g)).toHaveLength(1);
    expect(html).not.toContain('<video');
    expect(html).not.toContain('>原文</button>');
  });

  it('turns a failed cloud attempt into an explicit non-blocking retry state', () => {
    const html = renderToStaticMarkup(
      <FilePreview
        entry={pendingAudioEntry({
          liveTranscript: '录音与原文已经可用。',
          audioArchiveNeedsRetry: 'true',
        })}
        preview={{ text: null, fileUrl: 'blob:recording-1', contentType: 'audio/webm' }}
      />,
    );

    expect(html).toContain('云端服务暂时不可用，已排队重试');
    expect(html).toContain('不需要停在本页等待');
    expect(html).toContain('等待自动重试');
    expect(html).not.toContain('正在保存云端副本');
  });

  it('卡了很久的历史归档要改口径：说清它已经不正常，而不是「已排队重试」', () => {
    // 验收实测：07-24 的记录在 08-11 显示「已等待 26573:16」。数字没算错，
    // 但它既读不出「这是 18 天前的事」，措辞还暗示马上就好。
    const html = renderToStaticMarkup(
      <FilePreview
        entry={{ ...pendingAudioEntry(), createdAt: '2026-07-31T03:17:00.000Z' }}
        preview={null}
      />,
    );

    expect(html).toContain('云端副本长时间没有完成，多半要手动重试');
    expect(html).toContain('开始，已经卡了');
    expect(html).toContain('立即重试');
    // mm:ss 不进位是这条缺陷的根：绝不能再出现四位以上的分钟数
    expect(html).not.toMatch(/\d{4,}:\d{2}/);
  });
});

describe('formatBackgroundDuration', () => {
  it('分钟以上会进位，不再堆成四位数分钟', () => {
    expect(formatBackgroundDuration(3 * 60 + 12)).toBe('03:12');
    expect(formatBackgroundDuration(2 * 3600 + 3 * 60)).toBe('2 小时 3 分');
    // 验收现场那条：18 天 + 5 小时，旧实现会输出 26573:16
    expect(formatBackgroundDuration(18 * 86400 + 5 * 3600 + 16)).toBe('18 天 5 小时');
  });
});

describe('describeArchiveWait', () => {
  const now = new Date('2026-08-11T10:00:00.000Z').getTime();

  it('刚开始几分钟的不算卡住，也不报开始时刻', () => {
    const wait = describeArchiveWait('2026-08-11T09:57:00.000Z', now);
    expect(wait.stalled).toBe(false);
    expect(wait.startedLabel).toBeNull();
    expect(wait.seconds).toBe(180);
  });

  it('超过一小时算卡住，并给出开始时刻让人判断是哪天的事', () => {
    const wait = describeArchiveWait('2026-07-24T02:00:00.000Z', now);
    expect(wait.stalled).toBe(true);
    expect(wait.startedLabel).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('没有开始时间时不编一个出来', () => {
    expect(describeArchiveWait(undefined, now)).toEqual({ seconds: 0, stalled: false, startedLabel: null });
  });
});
