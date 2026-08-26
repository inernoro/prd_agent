import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  advanceTranscriptLexicon,
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

    // 这句现在归播放器主体（稿面就画在时间行正下方），文案照稿改成「精准时间轴 · 逐句对齐」。
    // 断言的是「有一句话交代时间轴精度」，不是它此刻的逐字写法。
    expect(html).toMatch(/精准时间轴[^<]*逐句/);
    expect(html).not.toContain('普通播放');
    expect(html).not.toContain('交互式播放');
    expect(html.match(/title="播放"/g)).toHaveLength(1);
  });

  it('renders recording search, word cloud, speaker management and grounded question entry', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        // 词频要拉开档次这条断言才有意义：导入 4 次 / 等待 2 次，
        // 否则云里只有一个词，「多种字号」根本无从谈起。
        noteMd={'## 转录全文\n\n**[00:00 - 00:03]** [说话人1] 导入的时候要等待，导入很慢。\n**[00:03 - 00:06]** [说话人2] 导入失败要等待重来，导入这块最痛。\n**[00:06 - 00:09]** [说话人1] 客户认为报价合理，报价还要再谈。'}
        documentMode
        onSaveNote={async () => true}
        onAskRecording={() => undefined}
      />,
    );

    // 设计稿 P3 是四块同屏并置（词云 / 会议纪要 / 待办 / 提问），不是可切换的分区
    expect(html).toContain('词云');
    expect(html).toContain('会议纪要');
    expect(html).toContain('待办事项');
    expect(html).toContain('问这场录音');
    expect(html).not.toContain('role="tab"');
    // 断言的是「有一个搜关键词的输入口」，不是它此刻的 placeholder 原文——
    // 稿面把它排在原文列表上方（B1），文案随之从「搜索录音里的关键词」变成
    // 「搜索原文关键词」；逐字比对会让这类合规改动无端变红（形状 4a）。
    expect(html).toMatch(/aria-label="搜索[^"]*关键词"/);
    expect(html).toContain('整场录音词云');
    // 词云的权重按频次映射，不按排名。断言的是行为不是某个字面尺寸：
    // 云里必须出现**多种**字号（旧写法 15 - index*0.2 也会多种，所以还要下一条），
    // 且最大的那一档必须落在频次最高的词上。
    // 稿面 B3 的开场结论：一句挂着**真实百分比**的话（含最高频词的句子 ÷ 总句数），
    // 不是从稿面抄一个数字过来。断言口径而不是具体数值——换个样本数值就变。
    expect(html).toContain('最高频主题');
    expect(html).toMatch(/这场有 \d+% 的句子提到/);
    // 只切词云那一块。此前切到文末，把**原文列表**的行内字号也算了进去——
    // 于是「云里有多种字号」这条断言其实在测原文，词云只有一个词也照样绿
    // （形状 6：判据读到的不是它要判的那个值）。原文一挪到词云前面就露馅了。
    const cloudStart = html.indexOf('整场录音词云');
    const cloudHtml = html.slice(cloudStart, html.indexOf('少了某个词', cloudStart));
    const sizes = [...cloudHtml.matchAll(/font-size:([\d.]+)px/g)].map(m => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(1);
    expect(new Set(sizes).size).toBeGreaterThan(1);
    expect(sizes[0]).toBe(Math.max(...sizes));
    // 次数直接写在词上，不再只藏在 title 里
    expect(cloudHtml).toMatch(/报价<span[^>]*>\d+<\/span>/);
    expect(html).toContain('说话人1');
    // 说话人不只给名字，还要给「说了几句、占多少」——光有名字看不出这场是谁在说
    expect(html).toMatch(/说话人1<\/span>\s*<span[^>]*>\s*2 句 · 占 67%/);
    // 词频压成三档，最高频那个词要能一眼跳出来：它用反白大字，和其余两档不同量级。
    // 断言「最大那一档明显大于次档」而不是某个具体像素——稿面的台阶宽度调过一次，
    // 逐字钉死尺寸只会让下次合规调整无端变红。
    // 稿面相邻两档大约差 1.25 倍（24 / 19 / 15），按这个下限卡
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThanOrEqual(1.25);
    expect(cloudHtml).toContain('font-weight:700');
  });

  it('没有任何词被重复提到时不出词云——「反复提到的是 X（1 次）」是句假话', () => {
    const html = renderToStaticMarkup(
      <TranscriptKaraoke
        src="/recording.m4a"
        noteMd={'## 转录全文\n\n**[00:00 - 00:03]** [说话人1] 今天先到这里。'}
        documentMode
      />,
    );

    // 区块还在（产品方定的名字就叫「词云」），只是里面没有词条云、也没有那句结论
    expect(html).toContain('>词云<');
    expect(html).not.toContain('整场录音词云');
    expect(html).not.toContain('的句子提到');
    expect(html).not.toContain('最高频主题');
    // 但**不许是一张空卡**：没有词的时候恰恰最需要说清为什么没有、怎么补
    expect(html).toContain('没有反复出现的词');
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

describe('词典整表替换：连着添加两个词不能把前一个抹掉', () => {
  const base = { terms: ['旧词'], system: ['系统旧词'], mine: ['我的旧词'], muted: ['屏蔽词'], canManageSystem: true };

  it('个人词典连加两次，第二次提交的入参必须带上第一次的词', () => {
    const afterFirst = advanceTranscriptLexicon(base, '甲方', 'mine');
    const afterSecond = advanceTranscriptLexicon(afterFirst, '尾款', 'mine');

    // 第二次真正发出去的是 afterSecond.mine（写端点整表替换）
    expect(afterSecond.mine).toContain('甲方');
    expect(afterSecond.mine).toContain('尾款');
    expect(afterSecond.mine).toContain('我的旧词');
    // 屏蔽词不属于这次改动，必须原样带回去，不能被顺手清空
    expect(afterSecond.muted).toEqual(['屏蔽词']);
  });

  it('系统词典连加两次，第二次不能拿旧表覆盖掉所有人共用的第一个词', () => {
    const afterFirst = advanceTranscriptLexicon(base, '验收单', 'system');
    const afterSecond = advanceTranscriptLexicon(afterFirst, '质保金', 'system');

    expect(afterSecond.system).toContain('验收单');
    expect(afterSecond.system).toContain('质保金');
    expect(afterSecond.system).toContain('系统旧词');
  });

  it('加到哪个作用域就只动哪一张表，另一张原样', () => {
    const afterMine = advanceTranscriptLexicon(base, '甲方', 'mine');
    expect(afterMine.system).toEqual(['系统旧词']);

    const afterSystem = advanceTranscriptLexicon(base, '验收单', 'system');
    expect(afterSystem.mine).toEqual(['我的旧词']);

    // 词云读的是合并后的 terms，两种作用域都要立刻反映，不必等刷新
    expect(afterMine.terms).toContain('甲方');
    expect(afterSystem.terms).toContain('验收单');
  });

  it('重复添加同一个词不产生重复项', () => {
    const once = advanceTranscriptLexicon(base, '甲方', 'mine');
    const twice = advanceTranscriptLexicon(once, '甲方', 'mine');
    expect(twice.mine.filter(x => x === '甲方')).toHaveLength(1);
  });
});

/**
 * 上面那组只证明「算得对」，证明不了「组件真的这么用」——把 setLexicon 那行删掉，
 * 上面四条依然全绿（形状 2：链路只建一半，删掉不会红）。所以这里守的是调用顺序本身。
 */
describe('词典写入接线守卫：顺序不对就等于没修', () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'TranscriptKaraoke.tsx'),
    'utf8',
  );
  const start = source.indexOf('const addLexiconTerm = async');
  const body = source.slice(start, source.indexOf('\n  };', start));

  it('提交入参与本地推进走同一条判据', () => {
    expect(start).toBeGreaterThan(0);
    // 两处各算一遍就会漂移，必须都从 advanceTranscriptLexicon 出
    expect(body.match(/advanceTranscriptLexicon\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('写成功后先把本地表推进到刚提交的那一版，再去刷新', () => {
    const ok = body.indexOf('if (!res.success) return;');
    const advance = body.indexOf('setLexicon(prev =>');
    const refresh = body.indexOf('await getTranscriptLexicon()');
    expect(ok).toBeGreaterThan(0);
    expect(advance).toBeGreaterThan(ok);
    expect(refresh).toBeGreaterThan(advance);
  });

  it('解锁发生在刷新之后，刷新期间不许再提交', () => {
    const refresh = body.indexOf('await getTranscriptLexicon()');
    const unlock = body.indexOf('setSavingLexicon(false)');
    expect(refresh).toBeGreaterThan(0);
    // 刷新还没回来就解锁，用户此刻再加一个词发出去的就是过期的整表
    expect(unlock).toBeGreaterThan(refresh);
  });
});
