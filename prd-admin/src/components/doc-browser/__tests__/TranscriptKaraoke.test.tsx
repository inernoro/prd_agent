import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildRecordingQuestionPrompt,
  buildRecordingQuestionTranscript,
  recordingCitationMatchesTimeline,
  TranscriptKaraoke,
} from '../TranscriptKaraoke';

describe('TranscriptKaraoke unified playback', () => {
  it('renders one direct player with follow-along guidance and no playback mode switch', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={'## 转录全文\n\n**[00:00 - 00:03]** 第一段\n**[00:03 - 00:06]** 第二段'}
        documentMode
      />,
    );

    expect(html).toContain('精准时间轴，播放时逐句高亮');
    expect(html).not.toContain('普通播放');
    expect(html).not.toContain('交互式播放');
    expect(html.match(/title="播放"/g)).toHaveLength(1);
  });

  it('renders recording search, word cloud, speaker management and grounded question entry', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={'## 转录全文\n\n**[00:00 - 00:03]** [说话人1] 客户认为报价合理。\n**[00:03 - 00:06]** [说话人2] 交付质量需要保证。'}
        documentMode
        onSaveNote={async () => true}
        onAskRecording={() => undefined}
      />,
    );

    expect(html).toContain('录音理解');
    expect(html).toContain('搜索录音里的关键词');
    expect(html).toContain('整场录音词云');
    expect(html).toContain('说话人1');
    expect(html).toContain('问这场录音');
  });

  it('问答提示保留超过四万字录音的开头和结尾，不偷偷截成局部', () => {
    const note = `开头证据${'中'.repeat(40_000)}结尾证据`;
    const prompt = buildRecordingQuestionPrompt(note, '客户态度是什么');

    expect(prompt).toContain('开头证据');
    expect(prompt).toContain('结尾证据');
    expect(prompt).toContain('[问题]\n客户态度是什么');
  });

  it('旧录音的估算时间轴也会写入问答上下文，并拒绝不存在的引用位置', () => {
    const timeline = [
      { start: 0, end: 5, text: '第一段', speaker: '客户' },
      { start: 5, end: 12, text: '第二段' },
    ];
    const transcript = buildRecordingQuestionTranscript(timeline, '旧原文');

    expect(transcript).toContain('**[00:00 - 00:05]** [客户] 第一段');
    expect(recordingCitationMatchesTimeline(7, timeline)).toBe(true);
    expect(recordingCitationMatchesTimeline(20, timeline)).toBe(false);
  });
});
