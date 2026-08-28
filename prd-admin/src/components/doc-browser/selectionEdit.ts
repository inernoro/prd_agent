// 划词 AI 局部编辑的纯函数工具：在 Markdown 正文里定位选区、替换选区、在选区后插入块。
//
// 为什么独立成纯函数模块：
// 1. 写回是破坏性操作 —— 定位必须可单测（vitest），不能埋在组件里靠人肉回归
// 2. useContentSelection 的 offset/contextBefore 都来自「全文第一处 indexOf」而非用户真实
//    的 DOM 选区（Bugbot High 2026-06-12）：同样的文字出现多次时，用户选第二处、offset 却
//    指向第一处且"校验恰好通过"。所以多处出现时这两个信号一律不可信，只认 DOM 序号
//    （选区前同文出现次数），序号对不上就返回 null（宁可禁用替换，不可替换错位置）

import { findRenderedTextRanges } from './markdownTextIndex';

export interface SelectionAnchor {
  selectedText: string;
  /** useContentSelection 解析的偏移提示；多处出现时不可信（恒指向第一处），仅唯一出现时是冗余信息 */
  startOffset: number;
  endOffset: number;
  contextBefore?: string;
  contextAfter?: string;
  /** DOM 选区之前同文出现的次数（0-based 序号）。多处出现时唯一可信的"用户选的是第几处" */
  domOccurrenceIndex?: number;
  /** DOM 全文中同文出现总数。与正文统计不一致（评论气泡等副本混入）时拒绝定位 */
  domOccurrenceTotal?: number;
}

export interface ResolvedRange {
  start: number;
  end: number;
}

/**
 * 在正文中定位选区。
 *
 * 匹配走 `findRenderedTextRanges`（渲染文本索引）而不是源码 indexOf ——
 * 选区文本来自渲染后的 DOM，源码里的 `**加粗**`、`` `代码` ``、`[文字](链接)`、
 * 行首 `1. ` / `## ` 在页面上都看不见，拿它去源码里精确匹配必然落空
 * （2026-08-20 对抗审计：这四类选区全部定位失败，逐句修改入口静默消失）。
 *
 * 唯一出现 → 直接命中；多处出现 → 只信 DOM 序号；其余一律 null。
 * 返回 null 表示无法安全定位，调用方应禁用"替换"。
 */
export function resolveSelectionRange(body: string, sel: SelectionAnchor): ResolvedRange | null {
  const text = sel.selectedText;
  if (!body || !text) return null;

  const occurrences = findRenderedTextRanges(body, text);
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) {
    // DOM 里同文出现多处、正文里只有一处，说明页面上另有同文副本（评论气泡 / 浮层引用块）
    // 或另一处带着不同的行内标记 —— 此时无法确认用户选的就是这一处，宁可降级
    if (sel.domOccurrenceTotal != null && sel.domOccurrenceTotal > 1) return null;
    return occurrences[0];
  }

  // 多处出现：offset 提示与 contextBefore 都源自 useContentSelection 的"第一处 indexOf"，
  // 会把"用户选第二处"指认成第一处（Bugbot High），一律不采信。
  // 只有 DOM 序号（捕获自真实 Range）能指认用户选的是第几处；
  // DOM 总数 ≠ 正文总数说明 DOM 里混入了同文副本（评论气泡/浮层引用块），同样拒绝。
  if (
    sel.domOccurrenceIndex != null &&
    sel.domOccurrenceTotal != null &&
    sel.domOccurrenceTotal === occurrences.length &&
    sel.domOccurrenceIndex >= 0 &&
    sel.domOccurrenceIndex < occurrences.length
  ) {
    return occurrences[sel.domOccurrenceIndex];
  }
  return null;
}

/** 块级前缀的种类：同类才算重复 */
type BlockPrefixKind = 'ordered' | 'bullet' | 'heading' | 'quote';

function classifyBlockPrefix(prefix: string): BlockPrefixKind | null {
  if (/(?:^|\s)\d+[.)][ \t]+$/.test(prefix)) return 'ordered';
  if (/(?:^|\s)[-*+][ \t]+$/.test(prefix)) return 'bullet';
  if (/#{1,6}[ \t]+$/.test(prefix)) return 'heading';
  if (/>[ \t]*$/.test(prefix)) return 'quote';
  return null;
}

const OUTPUT_PREFIX_PATTERNS: Record<BlockPrefixKind, RegExp> = {
  ordered: /^[ \t]*\d+[.)][ \t]+/,
  bullet: /^[ \t]*[-*+][ \t]+/,
  heading: /^[ \t]*#{1,6}[ \t]+/,
  quote: /^[ \t]*>[ \t]?/,
};

/**
 * 剥掉模型输出里与原文重复的块级前缀。
 *
 * 为什么必须有：选区文本来自渲染后的 DOM，页面上看不到 `1. ` / `## `，所以定位出来的区间
 * 只覆盖列表项/标题的**内容部分**；而系统提示词要求模型「保持同样的块级结构」，模型多半会
 * 把序号或井号补回来。两边一拼就是 `1. 1. 新条目` / `## ## 新标题`——把正文写坏
 * （2026-08-20 对抗审计实测必现）。
 *
 * 判据是硬的、不猜：区间起点前面那一截**恰好只是一个块级标记**，且模型输出以**同类**标记开头。
 */
export function stripDuplicatedBlockPrefix(body: string, range: ResolvedRange, output: string): string {
  if (!output) return output;
  const lineStart = body.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1;
  const prefix = body.slice(lineStart, range.start);
  if (!prefix || prefix.trim() === '') return output;
  const kind = classifyBlockPrefix(prefix);
  if (!kind) return output;
  const stripped = output.replace(OUTPUT_PREFIX_PATTERNS[kind], '');
  // 剥完什么都不剩，说明模型只吐了个标记，保持原样交给用户判断
  return stripped.trim() ? stripped : output;
}

/** 用 newText 替换已定位的选区，返回新正文 */
export function replaceSelectionInBody(body: string, range: ResolvedRange, newText: string): string {
  return body.slice(0, range.start) + newText + body.slice(range.end);
}

// 替换会拼坏语法的"标记结构"：选区文本来自渲染后的 DOM（如双链只显示显示名），
// 在源码里往往是 [[...]] / [文本](链接) 内部的子串——把 AI 结果拼进括号中间会破坏语法
// （Bugbot Medium 2026-06-12）。选区与这些结构相交但不整体覆盖时，原则上禁止替换。
//
// 例外是「纯显示文字」那一段：链接的 [文字] 与双链的 |显示名，改它既不断链也不坏语法，
// 而「把某个链接的措辞改一改」恰恰是很自然的划词诉求（2026-08-20 对抗审计：这类选区
// 此前一律被拒，用户只能整句重选）。所以每个结构额外声明一个可安全改写的内部区间。
interface MarkerStructure {
  /** 结构整体在正文中的区间 */
  start: number;
  end: number;
  /** 结构内部「改了也不坏语法」的显示文字区间；没有则为 null */
  editable: { start: number; end: number } | null;
}

function collectMarkerStructures(body: string): MarkerStructure[] {
  const out: MarkerStructure[] = [];
  // wikilink [[目标]] / [[目标|显示名]]：只有显示名可改，改目标会断链
  const wiki = /\[\[([^\][\n|]+)(?:\|([^\]\n]+))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wiki.exec(body)) !== null) {
    const alias = m[2];
    const aliasStart = alias != null ? m.index + m[0].lastIndexOf(alias) : -1;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      editable: alias != null ? { start: aliasStart, end: aliasStart + alias.length } : null,
    });
  }
  // markdown 链接 [文字](地址) / 图片 ![alt](地址)：图片的 alt 不是正文，不给改
  const link = /(!?)\[([^\]\n]*)\]\([^()\n]*\)/g;
  while ((m = link.exec(body)) !== null) {
    const isImage = m[1] === '!';
    const textStart = m.index + m[1].length + 1;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      editable: isImage || !m[2] ? null : { start: textStart, end: textStart + m[2].length },
    });
  }
  return out;
}

/**
 * 选区内部的行内标记是否落单（起点或终点卡在加粗 / 斜体 / 行内代码 / 删除线中间）。
 *
 * 为什么必须查（2026-08-21 code review 抓到，可复现的静默破坏）：
 * 定位改用渲染文本索引之后，用户在页面上选「加粗的句子。」是一次再自然不过的拖选，
 * 但它在源码里对应 `加粗**的句子。` —— 范围里只有半个 `**`。替换掉这段，
 * 剩下的那半个 `**` 会和后文的下一个 `**` 配上对，从此整段变粗，且采纳时无声发生。
 *
 * 判据是「范围内某种标记的个数为奇数」。这会顺带拒掉「a * b」这类把星号当乘号的选区，
 * 属于保守误判：结果只是退回老浮层（还能插入 / 复制），不会写坏文档。
 * 下划线强调（`_x_`）不查——`some_var` 这类标识符会误伤，且本仓库正文一律用星号。
 */
function hasUnbalancedInlineMarks(text: string): boolean {
  // 反引号优先：代码里的星号是代码，不是标记
  if (((text.match(/`/g) ?? []).length) % 2 === 1) return true;
  const noCode = text.replace(/`[^`]*`/g, '');
  if (((noCode.match(/~~/g) ?? []).length) % 2 === 1) return true;
  const noStrike = noCode.replace(/~~/g, '');
  if (((noStrike.match(/\*\*/g) ?? []).length) % 2 === 1) return true;
  return ((noStrike.replace(/\*\*/g, '').match(/\*/g) ?? []).length) % 2 === 1;
}

/**
 * 已定位的选区能否安全整段替换：与 wikilink / markdown 链接（图片）结构相交
 * 但既不整体覆盖、也不落在其显示文字内部时返回 false；
 * 选区把某个行内标记劈成两半时同样返回 false。
 */
export function isReplaceSafe(body: string, range: ResolvedRange): boolean {
  if (hasUnbalancedInlineMarks(body.slice(range.start, range.end))) return false;
  for (const s of collectMarkerStructures(body)) {
    const overlaps = range.start < s.end && range.end > s.start;
    if (!overlaps) continue;
    const coversWhole = range.start <= s.start && range.end >= s.end;
    if (coversWhole) continue;
    const insideEditable = s.editable != null
      && range.start >= s.editable.start && range.end <= s.editable.end;
    if (!insideEditable) return false;
  }
  return true;
}

/**
 * 在选区所在段落之后插入一个块级片段（如配图 markdown），自成段落。
 * 插入点 = 选区结束后的第一个空行（段落边界）；选区在最后一段时追加到文末。
 */
export function insertBlockAfterSelection(body: string, range: ResolvedRange, block: string): string {
  const trimmedBlock = block.trim();
  if (!trimmedBlock) return body;
  const boundary = body.indexOf('\n\n', range.end);
  if (boundary < 0) {
    const sep = body.endsWith('\n') ? '\n' : '\n\n';
    return body + sep + trimmedBlock + '\n';
  }
  return body.slice(0, boundary) + '\n\n' + trimmedBlock + body.slice(boundary);
}

/**
 * 取 raw 内容的 frontmatter 前缀。
 * 约束：parseFrontmatter(raw).body 是 raw 的尾缀（frontmatter 只会出现在头部），
 * 所以 prefix = raw 去掉 body 后的头部。选区 offset 基于 body，写回时必须把前缀拼回去。
 */
export function frontmatterPrefixOf(raw: string, body: string): string {
  if (raw === body) return '';
  if (raw.endsWith(body)) return raw.slice(0, raw.length - body.length);
  // body 不是 raw 尾缀（理论不该发生）：放弃拼接，调用方应整体使用 body
  return '';
}

/**
 * 模型偶发把整段输出包进 ``` 围栏；只剥最外层成对围栏，不动内部代码块。
 * 两个改写入口（就地 diff / 兜底浮层）共用，避免一处剥、一处没剥。
 */
export function stripOuterFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z-]*\r?\n([\s\S]*?)\r?\n```$/);
  return m ? m[1] : t;
}

/** 生成插入文档的图片 markdown */
export function buildImageMarkdown(url: string, alt?: string): string {
  const safeAlt = (alt ?? '').replace(/[[\]\n]/g, ' ').trim() || '配图';
  return `![${safeAlt}](${url})`;
}
