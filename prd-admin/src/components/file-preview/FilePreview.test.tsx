import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DocBrowserEntry } from '@/components/doc-browser/DocBrowser';
import { FilePreview } from './FilePreview';

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
  it('shows a stable archive status instead of an empty preview', () => {
    const html = renderToStaticMarkup(
      <FilePreview entry={pendingAudioEntry()} preview={null} />,
    );

    expect(html).toContain('正在保存云端副本');
    expect(html).toContain('不会自动总结或改写');
    expect(html).toContain('预计几分钟内完成，可以离开本页');
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
  });
});
