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

const STOP_WORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '然后', '就是', '因为', '所以', '如果', '可以',
  '还是', '没有', '一个', '什么', '怎么', '现在', '觉得', '进行', '已经', '需要', '不是',
  '原文', '录音', '实时', '刚刚', '这是', '下来', '来的', '的实', '时原',
]);

/** 整场录音的轻量词频；不依赖网络，打开结果页即可用。 */
export function buildTranscriptWordCloud(segments: TranscriptSegment[], limit = 18): Array<{ word: string; count: number }> {
  const source = segments.map(segment => segment.text).join(' ');
  const englishTokens = source.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? [];
  const chineseTokens = (source.match(/[\u3400-\u9fff]{2,}/g) ?? []).flatMap((sequence) => {
    const chars = Array.from(sequence);
    return chars.slice(0, -1).map((_, index) => chars.slice(index, index + 2).join(''));
  });
  const tokens = [...englishTokens, ...chineseTokens];
  const counts = new Map<string, number>();
  tokens.forEach((token) => {
    const word = token.toLowerCase();
    if (STOP_WORDS.has(word)) return;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  });
  const ranked = [...counts.entries()]
    // 只出现一次的不叫「反复提到」，是噪音。滤掉它同时也扫掉了大半滑窗碎片。
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));

  // 中文按 2 字滑窗切，必然产出「交付 + 质量 → 付质」这种骑在两个真词中间的碎片。
  // STOP_WORDS 里的 的实 / 时原 / 来的 就是过去一个个手工补进去的同类货——
  // 与其继续按词打补丁，不如把这个形态本身判掉。
  //
  // 碎片的特征是**两头都搭着别人**：首字是某个不更少见的词的尾字，尾字又是另一个
  // 不更少见的词的首字。只判一头会误伤：「付质」和「质量」在频次相同时谁排在前面
  // 由 localeCompare 决定，先被留下的那个会把真词顶掉（实测「质量」就这么被顶掉过）。
  const tailMax = new Map<string, number>();
  const headMax = new Map<string, number>();
  for (const [word, count] of counts) {
    if (word.length !== 2 || word[0] === word[1]) continue;
    tailMax.set(word[1], Math.max(tailMax.get(word[1]) ?? 0, count));
    headMax.set(word[0], Math.max(headMax.get(word[0]) ?? 0, count));
  }
  const isWindowFragment = (word: string, count: number) => word.length === 2
    && word[0] !== word[1]
    && (tailMax.get(word[0]) ?? 0) >= count
    && (headMax.get(word[1]) ?? 0) >= count;

  return ranked
    .filter(([word, count]) => !isWindowFragment(word, count))
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
