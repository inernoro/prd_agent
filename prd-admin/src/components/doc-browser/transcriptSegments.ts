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
  /** 标题是原文里真有的（而不是按内容截出来的）；决定后续段落能否并入本模块 */
  fromHeading?: boolean;
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
 * 说话人名字写进 Markdown 标记之前的规范化。
 *
 * 标记的形状是 `**[00:00 - 00:03]** [名字] 正文`，所以名字里出现 `[` `]` 或换行
 * 都会把这一行拆坏：重新解析时 `TS_LINE_RE` 只把第一个 `]` 之前当名字，剩下的挤进正文，
 * 严重时整行不再被认成一句（Codex P2）。改名那一路早就规范化了，指派这一路没有——
 * 同一件事两份写法必然漂移（形状 3），所以抽成这一个，两处共用。
 */
export function normalizeSpeakerName(raw: string): string {
  return raw
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .replace(/[\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

/**
 * 给第 index 条句子指定说话人（设计稿 cap-S11「手动标记说话人」的落点）。
 *
 * 上游没能区分说话人时，原文里那一段是「时间戳 + 正文」，中间没有 `[名字]`。
 * 这个函数把名字补进去；传空名字则是把已有的标签去掉。只动那一行，
 * 时间戳与全文之外的摘要一个字都不碰（与 replaceTranscriptSegmentText 同一套口径）。
 */
export function assignTranscriptSegmentSpeaker(md: string, index: number, speaker: string): string {
  if (index < 0) return md;
  const marker = '## 转录全文';
  const markerIdx = md.indexOf(marker);
  const bodyStart = markerIdx >= 0 ? markerIdx + marker.length : 0;
  const head = md.slice(0, bodyStart);
  const lines = md.slice(bodyStart).split('\n');
  const name = normalizeSpeakerName(speaker);
  let cursor = -1;

  const updated = lines.map((raw) => {
    const line = raw.trim();
    const timed = TS_LINE_RE.exec(line);
    if (!timed) return raw;
    cursor += 1;
    if (cursor !== index) return raw;
    const label = name ? ` [${name}]` : '';
    return `**[${timed[1]} - ${timed[2]}]**${label} ${timed[4].trim()}`;
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
  const next = normalizeSpeakerName(nextName);
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

/**
 * 纪要里那些「整段就是一张任务清单」的模块要摘出去。
 * 待办已经单独成区渲染，纪要再原样列一遍，同一份内容就在同屏出现了两次——
 * 用户会以为那是两批不同的事。判据是**结构**（这一段除了勾选项没有别的内容），
 * 不是标题里有没有「待办」二字：换个模板叫「行动项」「Next steps」照样成立。
 */
export function isTodoOnlyModule(markdown: string): boolean {
  const lines = markdown.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const meaningful = lines.filter(line => !/^#{1,6}\s/.test(line));
  if (meaningful.length === 0) return false;
  return meaningful.every(line => /^[-*+]\s+\[[ xX]\]\s+/.test(line));
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
/**
 * 给待办找它的出处（设计稿每条待办下面那行「14:22 · 主持人」，以及标题右侧的
 * 「来自 N 处原文」）。
 *
 * 整理结果本身不带出处，只能回到原文里找。判据是**双字词重合**：
 * 待办文本与某句原文共享的双字片段最多的那一句，且至少要重合两个片段才算数。
 * 一个都不够就**不给出处**——宁可这条待办没有时间戳，也不能随便挂一句原文上去，
 * 那等于伪造溯源（no-rootless-tree）。
 */
export type TodoSource = { start: number; speaker?: string };

function bigrams(text: string): Set<string> {
  const clean = text.replace(/[\s\p{P}]/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 2 <= clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
}

export function findTodoSource(
  todoText: string,
  segments: TranscriptSegment[],
): TodoSource | null {
  const needle = bigrams(todoText);
  if (needle.size === 0) return null;
  let best: { overlap: number; segment: TranscriptSegment } | null = null;
  for (const segment of segments) {
    if (segment.start < 0) continue;
    let overlap = 0;
    for (const gram of bigrams(segment.text)) if (needle.has(gram)) overlap++;
    if (overlap > (best?.overlap ?? 0)) best = { overlap, segment };
  }
  if (!best || best.overlap < 2) return null;
  return { start: best.segment.start, speaker: best.segment.speaker };
}

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
      if (body) modules.push({ title: heading[2].trim(), markdown: body, fromHeading: true });
      else pendingTitle = heading[2].trim();
      return;
    }
    // 标题之下的连续段落同属这个标题：一段结论加两条要点是**一个**模块。
    // 各自成模块的话，要点那块会被自动编一个截断出来的标题
    //（「拆分导入为「上传 / 解析」两步，解」），既不是人写的也读不通。
    if (pendingTitle === null && modules.length > 0 && modules[modules.length - 1].fromHeading) {
      const last = modules[modules.length - 1];
      last.markdown = `${last.markdown}\n\n${block}`;
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
      fromHeading: pendingTitle !== null,
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

/**
 * 把问答的回答拆成「结论 + 引用」两块（稿面 B4）。
 *
 * 稿面把引用从正文里**提出来**做成卡片：一句原文 + 时间 + 说话人 + 一个播放键。
 * 之前的做法是在正文里内联一颗时间药丸——点得到，但读者看不出被引用的那句话是什么，
 * 得自己跳过去看。提出来之后「凭什么这么说」和「结论」并排摆着。
 *
 * 引用必须能在时间轴上找到对应句子才算数：模型报了一个原文里没有的时间，
 * 那是幻觉，不能给它做一张像模像样的卡（no-rootless-tree）。找不到的原样留在正文里。
 */
export function resolveAnswerCitations(
  answer: string,
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>,
): {
  conclusion: string;
  citations: Array<{ label: string; start: number; text: string; speaker?: string }>;
} {
  const parts = parseRecordingAnswerParts(answer);
  const citations: Array<{ label: string; start: number; text: string; speaker?: string }> = [];
  const conclusionPieces: string[] = [];
  const seen = new Set<number>();

  for (const part of parts) {
    if (part.kind === 'text') { conclusionPieces.push(part.text); continue; }
    const hit = segments.find(seg => (
      seg.start >= 0 && part.start >= seg.start && part.start <= Math.max(seg.start, seg.end)
    ));
    // 找不到对应句子的引用留在正文里，由既有的「时间轴中没有这个位置」分支处理
    if (!hit) { conclusionPieces.push(part.label); continue; }
    if (seen.has(hit.start)) continue;
    seen.add(hit.start);
    citations.push({ label: part.label, start: hit.start, text: hit.text, speaker: hit.speaker });
  }

  return { conclusion: conclusionPieces.join('').trim(), citations };
}

/**
 * 这次回答是不是「原文里没有」。
 *
 * 判据来自我们自己给模型的硬约束——提示词写明「如果原文不足以回答，明确说无法从录音确认」，
 * 所以这里认的是那句话的几种说法，不是去猜模型的语气。
 * 稿面 B4 顶部那条琥珀提示要的就是这件事：**上一问没答上来，而且是如实说的**。
 * 把它显式记下来，用户才知道系统没有替他编一个答案。
 */
export function isUnansweredByTranscript(answer: string): boolean {
  const text = answer.replace(/\s+/g, '');
  return ['无法从录音确认', '原文无相关内容', '原文中没有', '录音中没有提到', '未提及']
    .some(phrase => text.includes(phrase.replace(/\s+/g, '')));
}

/** 琥珀提示条的状态：记着哪一问没答上来，以及它是否已经露过面。 */
export type UnansweredNotice = {
  /** 上一问「原文里没有」的那个问题；空串表示现在没有这种情况 */
  question: string;
  /** 已经陪着一轮「答得上来」的问答同屏露过面了 */
  shown: boolean;
};

export const NO_UNANSWERED_NOTICE: UnansweredNotice = { question: '', shown: false };

/**
 * 一问答完之后，琥珀提示条该变成什么样。
 *
 * 抽成纯函数是因为**留多久**这件事只有驱到「先问一个答不上来的、再问一个答得上来的」
 * 才看得出来：早先的写法在后一问答完时顺手把它清掉，于是它只存在于两次提问之间的空档，
 * 屏幕上永远等不到——代码在、界面上没有，测试也不会红。稿面 B4 画的正是
 * 「琥珀条 + 一条答得上来的问答」同屏，所以它必须陪满下一轮再退场。
 */
export function advanceUnansweredNotice(
  prev: UnansweredNotice,
  input: { question: string; answer: string },
): UnansweredNotice {
  // 又一次没答上来：换成最近这一条，重新开始计它的寿命
  if (isUnansweredByTranscript(input.answer)) return { question: input.question, shown: false };
  // 这一轮答得上来：让它跟着露一次面；已经露过就退场
  if (!prev.question) return NO_UNANSWERED_NOTICE;
  return prev.shown ? NO_UNANSWERED_NOTICE : { question: prev.question, shown: true };
}

/**
 * 词云为空时该说哪一句 —— 稿面 cap-S12 要求把「太短」和「词没被认出来」分开说。
 *
 * 一个诚实性约束：稿面写的是「超过 50 句时会自动出现主题与关键词」，
 * 但实现的门槛从来不是句数，是**同一个词出现两次以上**（buildTranscriptWordCloud 的
 * count>=2）。照抄稿面那句就是承诺一条不存在的规则——录满 60 句但没有任何重复词时
 * 词云照样是空的，那句话当场变成谎话（no-rootless-tree）。
 *
 * 所以这里只用句数判「哪一句更可能是真原因」，措辞回到真实门槛上：
 * 短到没机会重复 → 说太短；够长却仍为空 → 说词没被分词器认出来。
 */
export const WORD_CLOUD_SHORT_SENTENCES = 50;

export function describeWordCloudEmptyState(sentenceCount: number): string {
  if (sentenceCount > 0 && sentenceCount < WORD_CLOUD_SHORT_SENTENCES) {
    return `这段录音只有 ${sentenceCount} 句，还太短。一个词要在原文里出现两次以上才会进词云，录长一点自然就有了。`;
  }
  return '没有反复出现的词。人名、产品名、团队黑话通用分词器不认识，会被切成单字丢掉——补进词典后就能统计到。';
}

/**
 * 一份转录笔记「产出了什么」的清点（设计稿 v2-S3 / cap-S5 那条绿卡的口径）。
 *
 * 四个数全部数自这份 markdown 本身：句数、区分出来的说话人数、有没有整理出纪要、
 * 有没有待办。没有第五个来源，也不接受调用方传一个「示例值」进来。
 */
export function describeTranscriptOutcome(noteMd: string): {
  sentences: number;
  speakers: number;
  hasSummary: boolean;
  hasTodos: boolean;
} {
  const segments = parseTranscriptSegments(noteMd);
  const summary = extractTranscriptSummary(noteMd);
  return {
    sentences: segments.length,
    speakers: buildSpeakerStats(segments).length,
    hasSummary: summary.trim().length > 0,
    hasTodos: extractTranscriptTodos(summary).length > 0,
  };
}
