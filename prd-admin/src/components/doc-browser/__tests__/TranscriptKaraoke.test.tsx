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
        noteMd={'## 转录全文\n\n**[00:00 - 00:03]** [说话人1] 客户认为报价合理，报价还要再谈。\n**[00:03 - 00:06]** [说话人2] 交付质量需要保证，报价我们再看。'}
        documentMode
        onSaveNote={async () => true}
        onAskRecording={() => undefined}
      />,
    );

    expect(html).toContain('录音理解');
    expect(html).toContain('搜索录音里的关键词');
    expect(html).toContain('整场录音词云');
    // 词云的权重按频次映射，不按排名。断言的是行为不是某个字面尺寸：
    // 云里必须出现**多种**字号（旧写法 15 - index*0.2 也会多种，所以还要下一条），
    // 且最大的那一档必须落在频次最高的词上。
    expect(html).toContain('这场反复提到的是');
    const cloudHtml = html.slice(html.indexOf('整场录音词云'));
    const sizes = [...cloudHtml.matchAll(/font-size:([\d.]+)px/g)].map(m => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(1);
    expect(new Set(sizes).size).toBeGreaterThan(1);
    expect(sizes[0]).toBe(Math.max(...sizes));
    // 次数直接写在词上，不再只藏在 title 里
    expect(cloudHtml).toMatch(/报价<span[^>]*>\d+<\/span>/);
    expect(html).toContain('说话人1');
    expect(html).toContain('问这场录音');
  });

  it('没有任何词被重复提到时不出词云——「反复提到的是 X（1 次）」是句假话', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={'## 转录全文\n\n**[00:00 - 00:03]** [说话人1] 今天先到这里。'}
        documentMode
      />,
    );

    expect(html).toContain('录音理解');
    expect(html).not.toContain('整场录音词云');
    expect(html).not.toContain('这场反复提到的是');
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

  // ── 说话人来源：用户第一眼看到的诚实度，删掉不会报错，只会悄悄变回「看不出真假」 ──

  const noteWithSource = (line: string) =>
    `## 转录全文\n\n${line}\n\n**[00:00 - 00:03]** [说话人1] 甲。\n\n**[00:03 - 00:06]** [说话人2] 乙。`;

  it('本地声纹兜底：把「这是估算」当着用户的面说出来，并用警示色区分', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={noteWithSource('> 说话人来源：local · 声纹估算 · 本地按声纹分出几种声音是真实声学结果，但每句归谁是按语速比例推算的，可能与实际不符')}
        documentMode
      />,
    );

    expect(html).toContain('按语速比例推算');
    // 估算必须用警示色，和原生识别在视觉上分得开
    expect(html).toContain('var(--semantic-warning-text)');
    // 机器判定用的 key 是给程序看的，不该出现在用户眼前
    expect(html).not.toContain('说话人来源：local');
  });

  it('上游原生识别：如实说明来源，但不摆出警示色吓人', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={noteWithSource('> 说话人来源：native · 原生识别 · 由语音识别服务直接返回，逐句归属可信')}
        documentMode
      />,
    );

    expect(html).toContain('逐句归属可信');
    expect(html).not.toContain('var(--semantic-warning-text)');
  });

  it('旧笔记没有来源行：不渲染任何来源说明，也不影响逐句展示', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={'## 转录全文\n\n**[00:00 - 00:03]** [说话人1] 甲。\n\n**[00:03 - 00:06]** [说话人2] 乙。'}
        documentMode
      />,
    );

    expect(html).not.toContain('来源');
    expect(html).not.toContain('var(--semantic-warning-text)');
    // 存量数据的正常能力不能受影响
    expect(html).toContain('说话人1');
    expect(html).toContain('说话人2');
  });

  it('来源行不会被当成一句转录混进歌词轮', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={noteWithSource('> 说话人来源：local · 声纹估算 · 每句归谁按语速比例推算')}
        documentMode
      />,
    );
    // 正文里只有两句真转录，来源行不该以「一句话」的形态出现在可点击行里
    expect(html).not.toContain('>&gt; 说话人来源');
  });
});
