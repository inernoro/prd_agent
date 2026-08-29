/**
 * 收起态那枚播放键的状态必须**说到做到**：图标翻了，title 与 aria-label 也要跟着翻。
 *
 * 此前 title 写死「播放」而图标跟着 playing 变——正在播的时候，鼠标提示和读屏念出来的
 * 都是「播放」，与眼睛看到的暂停图标相反。发布门禁里「点完之后 title 变暂停」这条
 * 在收起态因此永远不成立（CI 红）。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordingSegmentBar } from '../RecordingSegmentBar';

describe('收起态播放键', () => {
  it('未播放时说「播放」', () => {
    const html = renderToStaticMarkup(<RecordingSegmentBar text="第一句" startSec={0} playing={false} />);
    expect(html).toContain('title="播放"');
    expect(html).toContain('aria-label="播放这段录音"');
  });

  it('正在播时说「暂停」，不再和图标互相矛盾', () => {
    const html = renderToStaticMarkup(<RecordingSegmentBar text="第一句" startSec={0} playing />);
    expect(html).toContain('title="暂停"');
    expect(html).toContain('aria-label="暂停这段录音"');
    expect(html).not.toContain('title="播放"');
  });
});
