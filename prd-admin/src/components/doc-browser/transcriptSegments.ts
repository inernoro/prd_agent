/**
 * 转录笔记时间戳解析（纯函数，单测覆盖）。
 * 数据源：后端 SubtitleFormatter.FormatSegmentsBody 产出的
 *   **[mm:ss - mm:ss]** 文本   或   **[hh:mm:ss - hh:mm:ss]** 文本
 * 行；chat-audio 转写路径无时间戳（纯段落），此时退化为无同步的静态行。
 */

export type TranscriptSegment = {
  /** 起始秒；无时间戳的纯段落行为 -1 */
  start: number;
  /** 结束秒；无时间戳为 -1 */
  end: number;
  text: string;
  /** ASR 说话人标签；旧录音或单人录音为空。 */
  speaker?: string;
};

export type SummaryModule = {
  /** 稳定的展示标题；没有 Markdown 标题时按内容顺序生成。 */
  title: string;
  /** 保留模块内 Markdown，交互播放器可复用知识库正文渲染。 */
  markdown: string;
};

export type RecordingAnswerPart =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; label: string; start: number };

const TS_LINE_RE = /^\*\*\[(\d{1,2}(?::\d{2}){1,2})\s*-\s*(\d{1,2}(?::\d{2}){1,2})\]\*\*\s*(?:\[([^\]]+)\]\s*)?(.+)$/;

function toSeconds(t: string): number {
  const parts = t.split(':').map(Number);
  if (parts.some(Number.isNaN)) return -1;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** 把智能问答中的 [00:12-00:18] 引用变为播放器可跳转的结构。 */
export function parseRecordingAnswerParts(answer: string): RecordingAnswerPart[] {
  const citation = /\[(\d{1,2}(?::\d{2}){1,2})(?:\s*-\s*(\d{1,2}(?::\d{2}){1,2}))?\]/g;
  const parts: RecordingAnswerPart[] = [];
  let cursor = 0;
  for (const match of answer.matchAll(citation)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: 'text', text: answer.slice(cursor, index) });
    parts.push({ kind: 'citation', label: match[0], start: toSeconds(match[1]) });
    cursor = index + match[0].length;
  }
  if (cursor < answer.length) parts.push({ kind: 'text', text: answer.slice(cursor) });
  return parts;
}

/**
 * 从转录笔记 markdown 解析逐句段落。
 * 只看「## 转录全文」之后的内容（笔记结构固定：摘要在上、全文在下）；
 * 整篇没有该标记时（如字幕文档）对全文行解析。
 */
export function parseTranscriptSegments(md: string): TranscriptSegment[] {
  if (!md) return [];
  const marker = '## 转录全文';
  const idx = md.indexOf(marker);
  const body = idx >= 0 ? md.slice(idx + marker.length) : md;

  const timed: TranscriptSegment[] = [];
  const plain: TranscriptSegment[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = TS_LINE_RE.exec(line);
    if (m) {
      timed.push({
        start: toSeconds(m[1]),
        end: toSeconds(m[2]),
        speaker: m[3]?.trim() || undefined,
        text: m[4].trim(),
      });
      continue;
    }
    // 纯段落行（无时间戳路径）：跳过标题/引用/占位斜体
    if (line.startsWith('#') || line.startsWith('>')) continue;
    if (/^_.*_$/.test(line)) continue;
    plain.push({ start: -1, end: -1, text: line });
  }
  return timed.length > 0 ? timed : plain;
}

/** 替换第 index 条转录文字，保留该句时间戳与全文外的摘要内容。 */
export function replaceTranscriptSegmentText(md: string, index: number, nextText: string): string {
  if (index < 0 || !nextText.trim()) return md;
  const marker = '## 转录全文';
  const markerIdx = md.indexOf(marker);
  const bodyStart = markerIdx >= 0 ? markerIdx + marker.length : 0;
  const head = md.slice(0, bodyStart);
  const lines = md.slice(bodyStart).split('\n');
  const hasTimed = lines.some(raw => TS_LINE_RE.test(raw.trim()));
  let cursor = -1;

  const updated = lines.map((raw) => {
    const line = raw.trim();
    const timed = TS_LINE_RE.exec(line);
    const eligible = hasTimed
      ? !!timed
      : !!line && !line.startsWith('#') && !line.startsWith('>') && !/^_.*_$/.test(line);
    if (!eligible) return raw;
    cursor += 1;
    if (cursor !== index) return raw;
    if (timed) {
      const speaker = timed[3] ? ` [${timed[3]}]` : '';
      return `**[${timed[1]} - ${timed[2]}]**${speaker} ${nextText.trim()}`;
    }
    const indent = raw.match(/^\s*/)?.[0] ?? '';
    return indent + nextText.trim();
  });
  return head + updated.join('\n');
}

/**
 * 说话人来源（后端 SubtitleFormatter.FormatSpeakerSourceNote 写进笔记的那一行）。
 * key 用来决定展示口吻，text 直接来自笔记——文案只有后端一份，前端不再抄一遍。
 */
export type SpeakerSourceNote = {
  /** native=上游原生识别 / model=音频模型重听 / local=本地声纹估算 */
  key: 'native' | 'model' | 'local';
  /** 给人读的说明，原样来自笔记 */
  text: string;
  /** 是否属于「估算」——本地声纹的逐句归属是按语速比例推的，必须提醒 */
  estimated: boolean;
};

const SPEAKER_SOURCE_RE = /^>\s*说话人来源：(native|model|local)\s*·\s*(.+)$/m;

/**
 * 读出笔记里的说话人来源。没有这一行 = 单人录音或旧笔记，返回 null（不猜、不兜底）。
 */
export function parseSpeakerSourceNote(md: string): SpeakerSourceNote | null {
  if (!md) return null;
  const match = SPEAKER_SOURCE_RE.exec(md);
  if (!match) return null;
  const key = match[1] as SpeakerSourceNote['key'];
  return { key, text: match[2].trim(), estimated: key !== 'native' };
}

/** 批量修改说话人显示名，保留时间戳和正文。 */
export function renameTranscriptSpeaker(md: string, currentName: string, nextName: string): string {
  const current = currentName.trim();
  const next = nextName
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .replace(/[\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  if (!current || !next || current === next) return md;
  return md.split('\n').map((raw) => {
    const match = TS_LINE_RE.exec(raw.trim());
    if (!match || match[3]?.trim() !== current) return raw;
    return `**[${match[1]} - ${match[2]}]** [${next}] ${match[4].trim()}`;
  }).join('\n');
}

/**
 * 虚词字：这些字几乎不会出现在「值得进词云的双字实词」里。
 *
 * 由来：2026-08-10 拿真实转写的词云一看，18 个词里 6 个是半截词
 * （个东 / 的就 / 个动 / 个就 / 后呢 / 它是）。它们躲过滑窗碎片规则的原因很具体——
 * 那条规则要靠左右两侧的真词当锚点，而「一个 / 这个 / 就是」这些锚点本身是停用词，
 * 早在建索引前就被删了，碎片于是变成无锚点的孤儿活了下来。
 * 与其继续给锚点打补丁，不如直接判字：含虚词字的双字组合本来就没有进词云的价值。
 *
 * 刻意不收的字：在（存在/实在）、上下（下单/上线）、会能要给对到最更再去看好说，
 * 它们都能组成真实实词，收进来会误伤。宁可漏掉几个噪音，不可吃掉真词。
 */
const FUNCTION_CHARS = new Set(Array.from(
  '的了是就都而与或着也很呢吧吗啊嗯哦把被让但又才只已之其此该每些什么嘛哈呀咯个们我你他她它这那不没咱',
));

const STOP_WORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '然后', '就是', '因为', '所以', '如果', '可以',
  '还是', '没有', '一个', '什么', '怎么', '现在', '觉得', '进行', '已经', '需要', '不是',
  '原文', '录音', '实时', '刚刚', '这是', '下来', '来的', '的实', '时原',
]);

/**
 * 整场录音的轻量词频。
 *
 * 分词用 V8 自带的 Intl.Segmenter（词典分词，零依赖、零网络）。
 *
 * 为什么不再用 2 字滑窗：滑窗必然产出骑在词缝上的半截词（交付+质量→付质，
 * 参考+图→考图，看+一下→看一）。前后改过三版判据——按词形猜锚点、按位置抢座、
 * 按上下文多样性——每一版都被真实语料打回来：
 *   「看一」在真实转写里两侧都有变化（你看一下 / 我看一下、看一下 / 看一眼），
 *   靠频次和上下文统计根本区分不出它和真词。这是方法的天花板，不是参数没调好。
 * Intl.Segmenter 查的是词典，直接不产生这类切分：
 *   我们看一下常规优化 → 我们 | 看一下 | 常规 | 优 | 化
 *   交付质量重要      → 交付 | 质量 | 重要
 *
 * 已知边界：Segmenter 也会切出单字（常规优化 → 常规|优|化），单字一律不进词云；
 * 极旧浏览器没有 Intl.Segmenter 时中文词云会退化为空，英文词仍然统计
 * （详见 doc/debt.knowledge-base.md）。
 */
export function buildTranscriptWordCloud(
  segments: TranscriptSegment[],
  limit = 18,
  /**
   * 词典：通用分词器不认识、但必须完整保留的词（人名、产品名、团队黑话）。
   * 它只做「加」不做「猜」——先把词典命中的整词切走，剩下的才交给 Segmenter，
   * 所以不会引入新的边界猜测，也就不会把已经治好的半截词问题带回来。
   */
  dictionary: readonly string[] = [],
): Array<{ word: string; count: number }> {
  const source = segments.map(segment => segment.text).join(' ');
  const counts = new Map<string, number>();
  const bump = (word: string) => counts.set(word, (counts.get(word) ?? 0) + 1);
  // 词典命中的词单独记一份：下面那两道通用过滤（停用词 / 二字虚词）是给「猜出来的词」用的，
  // 不该盖过用户或说话人标签**显式指定**的词。真实会踩到的例子：产品名「个推」带了虚词字「个」，
  // 人名「那英」带了「那」——两者都会被通用过滤悄悄丢掉，而 L0 说话人层的全部意义
  // 就是零配置把这类人名捞回来。加了词却看不见，等于这个入口是假的。
  const dictionaryWords = new Set<string>();

  // 三条通道（词典 / 英文 / Segmenter）必须依次从**剩下的**文本里取词，词典排在最前。
  // 顺序反了同一段字会被数两遍：英文词典项先被英文通道数一次、再被词典数一次，次数翻倍；
  // 大小写不一致时还会裂成两个词条（kubernetes 与 Kubernetes 各占一格，谁都不显眼）。
  //
  // 说话人名也算词典的一部分，但那是调用方拼进来的：这里只认收到的这一份。
  // 长词优先，避免「张三丰」被更短的「张三」抢先切走。
  const terms = [...new Set(dictionary.map(x => x.trim()).filter(x => x.length >= 2))]
    .sort((a, b) => b.length - a.length);
  let remainder = source;
  for (const term of terms) {
    // 纯 ASCII 词按词边界匹配并忽略大小写：正文写 kubernetes、词典写 Kubernetes 是同一个词，
    // 而「rate」不该从「rateLimit」中间挖走一块（中文没有词边界，仍走逐个吃掉）。
    const asciiTerm = /^[A-Za-z0-9-]+$/.test(term);
    let hits = 0;
    if (asciiTerm) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      remainder = remainder.replace(
        new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, 'gi'),
        () => { hits += 1; return ' '; },
      );
      if (hits > 0) dictionaryWords.add(term.toLowerCase());
      for (let i = 0; i < hits; i += 1) bump(term.toLowerCase());
      continue;
    }
    // 逐个吃掉，同时统计次数；切走之后那段字不再参与后续分词
    for (;;) {
      const at = remainder.indexOf(term);
      if (at < 0) break;
      hits += 1;
      remainder = `${remainder.slice(0, at)}\u0000${remainder.slice(at + term.length)}`;
    }
    if (hits > 0) dictionaryWords.add(term);
    for (let i = 0; i < hits; i += 1) bump(term);
  }

  // 英文词：扫的是词典切剩下的文本，不是原文——词典命中的那几段已经被换成占位符了
  for (const token of remainder.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? []) bump(token.toLowerCase());

  const SegmenterCtor = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor('zh-Hans', { granularity: 'word' });
    for (const piece of segmenter.segment(remainder)) {
      if (!piece.isWordLike) continue;
      const word = piece.segment.trim();
      // 单字进不了词云：它既没有语义信息量，也是 Segmenter 切不准时的残渣。
      // 英文已在上面按单独规则统计过，这里只收中文。
      if (word.length < 2 || !/^[\u3400-\u9fff]+$/.test(word)) continue;
      bump(word);
    }
  }

  return [...counts.entries()]
    // 「只出现一次的不叫反复提到」对谁都成立，词典词也不例外——词云讲的是这场反复提到什么，
    // 不是把词典列一遍。但停用词与二字虚词这两道是**猜词**的护栏，显式指定的词不受它们管。
    .filter(([word, count]) => count >= 2
      && (dictionaryWords.has(word)
        || (!STOP_WORDS.has(word)
          && !(word.length === 2 && Array.from(word).some(char => FUNCTION_CHARS.has(char))))))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

/**
 * 替换无时间戳原文经「按语速估算」拆出的第 index 句。
 * 拆句规则与 estimateTranscriptSegments 保持一致，避免估算跟随开启后只能编辑第一大段。
 */
export function replaceEstimatedTranscriptSentenceText(
  md: string,
  index: number,
  nextText: string,
): string {
  if (index < 0 || !nextText.trim()) return md;
  const marker = '## 转录全文';
  const markerIdx = md.indexOf(marker);
  const bodyStart = markerIdx >= 0 ? markerIdx + marker.length : 0;
  const head = md.slice(0, bodyStart);
  let cursor = -1;
  const lines = md.slice(bodyStart).split('\n').map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>') || /^_.*_$/.test(line)) return raw;
    const indent = raw.match(/^\s*/)?.[0] ?? '';
    const sentences = line.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [line];
    const updated = sentences.map((sentence) => {
      cursor += 1;
      return cursor === index ? nextText.trim() : sentence;
    });
    return indent + updated.join('');
  });
  return head + lines.join('\n');
}

/** 提取「摘要」与「转录全文」之间的整理结果，供音频原文页原地展示。 */
export function extractTranscriptSummary(md: string): string {
  if (!md) return '';
  const summaryMarker = '## 摘要';
  const transcriptMarker = '## 转录全文';
  const summaryIdx = md.indexOf(summaryMarker);
  if (summaryIdx < 0) return '';
  const start = summaryIdx + summaryMarker.length;
  const transcriptIdx = md.indexOf(transcriptMarker, start);
  return md.slice(start, transcriptIdx >= 0 ? transcriptIdx : undefined).trim();
}

/**
 * 每位说话人说了多少句、占全场多大比例（设计稿 P3/D1 的「71 句 · 占 58%」）。
 * 只给句数与占比这两件**数得出来**的事；「谁更重要」之类的判断不在这里编。
 *
 * 占比按有说话人标签的句子算，不按总句数——没标签的句子既不属于任何人，
 * 拿它当分母会让所有人的占比都无缘无故变小，加起来也凑不满 100%。
 */
export type TranscriptSpeakerStat = {
  speaker: string;
  count: number;
  /** 0-100 的整数百分比；无标签句子不计入分母 */
  percent: number;
};

export function buildSpeakerStats(segments: TranscriptSegment[]): TranscriptSpeakerStat[] {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const speaker = segment.speaker?.trim();
    if (!speaker) continue;
    counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
  }
  const labelled = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (labelled === 0) return [];
  return [...counts.entries()]
    .map(([speaker, count]) => ({ speaker, count, percent: Math.round((count / labelled) * 100) }))
    .sort((a, b) => b.count - a.count || a.speaker.localeCompare(b.speaker, 'zh'));
}

/** 整理结果里的一条待办。 */
export type TranscriptTodo = {
  text: string;
  done: boolean;
};

/**
 * 从整理结果里提取待办（设计稿 P3「待办事项」）。
 * 判据是 Markdown 任务列表 `- [ ]` / `- [x]`——那是**结构**，不是措辞；
 * 靠「标题里有没有『待办』两个字」去猜，换一套整理模板就失灵。
 * 没有任务列表就返回空数组，界面据此如实说「这次整理没有产出待办」，不编。
 */
export function extractTranscriptTodos(summaryMd: string): TranscriptTodo[] {
  if (!summaryMd) return [];
  const todos: TranscriptTodo[] = [];
  for (const raw of summaryMd.split('\n')) {
    const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    todos.push({ text, done: m[1].toLowerCase() === 'x' });
  }
  return todos;
}

/** 是否具备可用于播放跟随的时间戳（至少两句、且时间在涨） */
export function hasUsableTimestamps(segments: TranscriptSegment[]): boolean {
  const timed = segments.filter(s => s.start >= 0);
  if (timed.length < 2) return false;
  return timed.some(s => s.start > 0 || s.end > 0);
}

/** 播放到 currentSec 时应高亮的句子下标（取 start <= t 的最后一句；无命中取 0） */
export function activeSegmentIndex(segments: TranscriptSegment[], currentSec: number): number {
  let active = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start <= currentSec) active = i;
    else break;
  }
  return active;
}

/**
 * 无时间戳转录的可用性兜底：按句子文字量把音频时长等比例分配。
 * 这不是 ASR 对齐结果，调用方必须明确展示「智能估算」，禁止冒充精准时间戳。
 */
export function estimateTranscriptSegments(
  segments: TranscriptSegment[],
  durationSec: number,
): TranscriptSegment[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const source = segments.map(s => s.text.trim()).filter(Boolean).join('\n');
  if (!source) return [];

  const sentences = (source.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [source])
    .map(text => text.trim())
    .filter(Boolean);
  const weights = sentences.map(text => Math.max(1, Array.from(text).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return sentences.map((text, index) => {
    const start = cursor;
    cursor = index === sentences.length - 1
      ? durationSec
      : cursor + durationSec * (weights[index] / totalWeight);
    return { start, end: cursor, text };
  });
}

/** 把整理结果拆成可随时间轴高亮的语义模块，不硬编码任何整理方式或标题映射。 */
export function parseSummaryModules(md: string): SummaryModule[] {
  if (!md.trim()) return [];
  const blocks = md.trim().split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
  const modules: SummaryModule[] = [];
  let pendingTitle: string | null = null;

  blocks.forEach((block) => {
    const heading = /^(#{1,6})\s+(.+?)(?:\n([\s\S]*))?$/.exec(block);
    if (heading) {
      const body = heading[3]?.trim();
      if (body) modules.push({ title: heading[2].trim(), markdown: body });
      else pendingTitle = heading[2].trim();
      return;
    }
    const fallbackTitle = block
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+[.)]\s+/gm, '')
      .replace(/[*_`>#]/g, '')
      .replace(/\[|\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    modules.push({
      title: (pendingTitle ?? fallbackTitle.slice(0, 18)) || `第 ${modules.length + 1} 段`,
      markdown: block,
    });
    pendingTitle = null;
  });

  if (pendingTitle) modules.push({ title: pendingTitle, markdown: '暂无内容' });
  return modules;
}

/** 整理结果没有逐项时间戳时，按模块顺序映射到播放进度。 */
export function activeSummaryModuleIndex(moduleCount: number, currentSec: number, durationSec: number): number {
  if (moduleCount <= 1 || durationSec <= 0) return 0;
  const ratio = Math.min(0.999999, Math.max(0, currentSec / durationSec));
  return Math.floor(ratio * moduleCount);
}
