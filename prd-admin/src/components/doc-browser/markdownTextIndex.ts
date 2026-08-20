// 在 Markdown 源码里定位「用户在页面上划选的那段文字」。
//
// 为什么需要它：划词拿到的是**渲染后**的纯文本（`sel.toString()`），而写回要落在**源码**上。
// 两者天差地别——源码里的 `**加粗**`、`` `代码` ``、`[文字](链接)`、行首的 `1. ` / `## ` / `> `
// 在页面上统统看不见。直接拿渲染文本去源码里 indexOf，句子里但凡有一个行内标记就匹配不上
// （2026-08-20 对抗审计：加粗/行内代码/链接/跨段落选择四类全部 range=null，逐句修改入口
// 静默退回旧弹窗，用户完全不知道为什么）。
//
// 做法：把源码扫一遍生成「近似渲染文本 + 逐字符位置映射」，在渲染文本上匹配，再映射回源码区间。
// 保守优先（predicate-and-wiring-discipline.md 形状 1）：映射不出唯一结果就返回空，
// 让调用方降级到只读路径——宁可少一个入口，不可替换错位置。

/** 近似渲染文本 + 逐字符到源码下标的映射 */
export interface PlainTextIndex {
  /** 行内/块级标记已剥离、连续空白折叠成单空格后的文本 */
  plain: string;
  /** map[i] = plain[i] 在源码中的下标 */
  map: number[];
}

export interface SourceRange {
  start: number;
  end: number;
}

const FENCE_RE = /^ {0,3}(?:```|~~~)/;

/** 行首块级标记：引用 > / 列表 -*+ 或 1. / 任务框 / 标题 #。这些在页面上不作为文字出现 */
const LEAD_MARKER_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:\[[ xX]\][ \t]+)?(?:#{1,6}[ \t]+)?/;

/** markdown 转义序列 */
const ESCAPABLE_RE = /[\\`*_{}[\]()#+\-.!~|>]/;

/** 与 plain 同口径地折叠空白：连续空白 → 单空格，首尾去空 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

let lastSource: string | null = null;
let lastIndex: PlainTextIndex | null = null;

/**
 * 扫描 Markdown 源码，产出近似渲染文本与位置映射。
 *
 * 剥离：行首块级标记、强调 `**` `*` `__` `_` `~~`、代码反引号、图片整体、
 * 链接的方括号与 URL（保留链接文字）、双链的方括号与目标（保留显示名）。
 * 保留：代码围栏内部原样（页面上代码就是原样显示的）。
 */
export function buildPlainTextIndex(source: string): PlainTextIndex {
  // 单条缓存：同一篇正文会在一次交互里被反复扫（浮层每次渲染都要重算"能不能替换"），
  // 而正文在会话期间是不变的。纯函数 + 按内容判等，不存在串档风险。
  if (lastSource === source && lastIndex) return lastIndex;
  const built = buildPlainTextIndexUncached(source);
  lastSource = source;
  lastIndex = built;
  return built;
}

function buildPlainTextIndexUncached(source: string): PlainTextIndex {
  const plain: string[] = [];
  const map: number[] = [];
  let pendingSpaceAt = -1; // 有待输出的折叠空白在源码里的起点

  const pushChar = (ch: string, idx: number) => {
    if (/\s/.test(ch)) {
      if (pendingSpaceAt < 0) pendingSpaceAt = idx;
      return;
    }
    if (pendingSpaceAt >= 0) {
      // 开头的空白直接丢掉（等价 trim），中间的折叠成一个空格
      if (plain.length > 0) {
        plain.push(' ');
        map.push(pendingSpaceAt);
      }
      pendingSpaceAt = -1;
    }
    plain.push(ch);
    map.push(idx);
  };

  /** 链接/双链的显示文字里可能还嵌着强调标记，页面上同样看不见，顺手剥掉 */
  const pushDisplayText = (text: string, baseIdx: number) => {
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (c === '*' || c === '`' || c === '~') continue;
      pushChar(c, baseIdx + k);
    }
  };

  let offset = 0;
  let inFence = false;
  for (const line of source.split('\n')) {
    if (FENCE_RE.test(line)) {
      // 围栏行本身在页面上不显示
      inFence = !inFence;
      pushChar('\n', offset + line.length);
      offset += line.length + 1;
      continue;
    }
    if (inFence) {
      for (let i = 0; i < line.length; i++) pushChar(line[i], offset + i);
      pushChar('\n', offset + line.length);
      offset += line.length + 1;
      continue;
    }

    let i = LEAD_MARKER_RE.exec(line)?.[0].length ?? 0;
    let inInlineCode = false;
    while (i < line.length) {
      const ch = line[i];

      if (ch === '\\' && i + 1 < line.length && ESCAPABLE_RE.test(line[i + 1])) {
        pushChar(line[i + 1], offset + i + 1);
        i += 2;
        continue;
      }

      if (ch === '`') {
        let n = 0;
        while (line[i + n] === '`') n += 1;
        inInlineCode = !inInlineCode;
        i += n;
        continue;
      }
      if (inInlineCode) {
        pushChar(ch, offset + i);
        i += 1;
        continue;
      }

      const rest = line.slice(i);

      // 图片：页面上只有图，没有文字
      const img = /^!\[[^\]\n]*\]\([^()\n]*\)/.exec(rest);
      if (img) {
        i += img[0].length;
        continue;
      }

      // 双链 [[目标]] / [[目标|显示名]]：页面上显示的是显示名（无别名时是目标）
      const wiki = /^\[\[([^\][\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(rest);
      if (wiki) {
        const shown = wiki[2] ?? wiki[1];
        const shownOffsetInMatch = wiki[0].lastIndexOf(shown);
        pushDisplayText(shown, offset + i + shownOffsetInMatch);
        i += wiki[0].length;
        continue;
      }

      // 链接 [文字](地址)：页面上只有文字
      const link = /^\[([^\]\n]*)\]\([^()\n]*\)/.exec(rest);
      if (link) {
        pushDisplayText(link[1], offset + i + 1);
        i += link[0].length;
        continue;
      }

      // 强调标记
      if (ch === '*' || ch === '~') {
        let n = 0;
        while (line[i + n] === ch) n += 1;
        i += n;
        continue;
      }
      if (ch === '_') {
        // 词内下划线（snake_case）是真文字，不能剥；只有落在词边界的才是强调标记
        const prev = line[i - 1];
        const next = line[i + 1];
        const wordInside = prev != null && /[A-Za-z0-9]/.test(prev) && next != null && /[A-Za-z0-9]/.test(next);
        if (!wordInside) {
          let n = 0;
          while (line[i + n] === '_') n += 1;
          i += n;
          continue;
        }
      }

      pushChar(ch, offset + i);
      i += 1;
    }

    pushChar('\n', offset + line.length);
    offset += line.length + 1;
  }

  return { plain: plain.join(''), map };
}

/**
 * 在源码里找出「这段渲染文本」的全部出现位置（非重叠）。
 * 返回的区间是源码区间，可直接用于替换。
 */
export function findRenderedTextRanges(source: string, renderedText: string): SourceRange[] {
  const needle = collapseWhitespace(renderedText);
  if (!source || !needle) return [];
  const { plain, map } = buildPlainTextIndex(source);
  const out: SourceRange[] = [];
  let i = plain.indexOf(needle);
  while (i >= 0) {
    const start = map[i];
    const end = map[i + needle.length - 1] + 1;
    // 映射异常（理论不该发生）时整体放弃，不产出可疑区间
    if (start == null || end == null || end <= start) return [];
    out.push({ start, end });
    i = plain.indexOf(needle, i + needle.length);
  }
  return out;
}
