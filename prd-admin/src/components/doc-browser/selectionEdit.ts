// 划词 AI 局部编辑的纯函数工具：在 Markdown 正文里定位选区、替换选区、在选区后插入块。
//
// 为什么独立成纯函数模块：
// 1. 写回是破坏性操作 —— 定位必须可单测（vitest），不能埋在组件里靠人肉回归
// 2. useContentSelection 的 offset/contextBefore 都来自「全文第一处 indexOf」而非用户真实
//    的 DOM 选区（Bugbot High 2026-06-12）：同样的文字出现多次时，用户选第二处、offset 却
//    指向第一处且"校验恰好通过"。所以多处出现时这两个信号一律不可信，只认 DOM 序号
//    （选区前同文出现次数），序号对不上就返回 null（宁可禁用替换，不可替换错位置）

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

/** 非重叠地列出 needle 在 body 中的全部出现位置 */
function findAllOccurrences(body: string, needle: string): number[] {
  const out: number[] = [];
  let i = body.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = body.indexOf(needle, i + needle.length);
  }
  return out;
}

/**
 * 在正文中定位选区。唯一出现 → 直接命中；多处出现 → 只信 DOM 序号（且要求 DOM 总数与
 * 正文总数一致）；其余一律 null。返回 null 表示无法安全定位，调用方应禁用"替换"。
 */
export function resolveSelectionRange(body: string, sel: SelectionAnchor): ResolvedRange | null {
  const text = sel.selectedText;
  if (!body || !text) return null;

  const occurrences = findAllOccurrences(body, text);
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) {
    return { start: occurrences[0], end: occurrences[0] + text.length };
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
    const start = occurrences[sel.domOccurrenceIndex];
    return { start, end: start + text.length };
  }
  return null;
}

/** 用 newText 替换已定位的选区，返回新正文 */
export function replaceSelectionInBody(body: string, range: ResolvedRange, newText: string): string {
  return body.slice(0, range.start) + newText + body.slice(range.end);
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

/** 生成插入文档的图片 markdown */
export function buildImageMarkdown(url: string, alt?: string): string {
  const safeAlt = (alt ?? '').replace(/[[\]\n]/g, ' ').trim() || '配图';
  return `![${safeAlt}](${url})`;
}
