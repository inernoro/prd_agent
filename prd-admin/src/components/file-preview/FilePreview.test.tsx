import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DocBrowserEntry } from '@/components/doc-browser/DocBrowser';
import { FilePreview } from './FilePreview';

function pendingAudioEntry(metadata: Record<string, string> = {}): DocBrowserEntry {
  return {
    id: 'recording-1',
    title: '录音 2026-07-31 03-17.m4a',
    contentType: 'audio/mp4',
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

    expect(html).toContain('录音正在安全归档');
    expect(html).toContain('无需重新录音');
    expect(html).not.toContain('暂无可预览的内容');
  });

  it('plays the local insured audio and presents the live transcript while cloud archive continues', () => {
    const html = renderToStaticMarkup(
      <FilePreview
        entry={pendingAudioEntry({ liveTranscript: '这是刚刚录下来的实时原文。' })}
        preview={{ text: null, fileUrl: 'blob:recording-1', contentType: 'audio/mp4' }}
      />,
    );

    expect(html).toContain('本机录音可以立即播放');
    expect(html).toContain('这是刚刚录下来的实时原文');
    expect(html.match(/title="播放"/g)).toHaveLength(1);
  });
});
