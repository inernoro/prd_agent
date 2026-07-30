import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TranscriptKaraoke } from '../TranscriptKaraoke';

describe('TranscriptKaraoke unified playback', () => {
  it('renders one direct player with follow-along guidance and no playback mode switch', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={'## 转录全文\n\n**[00:00 - 00:03]** 第一段\n**[00:03 - 00:06]** 第二段'}
        documentMode
      />,
    );

    expect(html).toContain('播放时原文会自动跟随高亮');
    expect(html).not.toContain('普通播放');
    expect(html).not.toContain('交互式播放');
    expect(html.match(/title="播放"/g)).toHaveLength(1);
  });
});
