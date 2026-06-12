// 划词 AI 局部编辑的纯函数工具：在 Markdown 正文里定位选区、替换选区、在选区后插入块。
//
// 为什么独立成纯函数模块：
// 1. 写回是破坏性操作 —— 定位必须可单测（vitest），不能埋在组件里靠人肉回归
// 2. useContentSelection 的 offset 是"提示"而非保证（blockquote/标题/列表场景可能为 -1
//    或漂移），替换前必须重新校验 offset 与原文一致，校验不过走 indexOf + 上下文消歧，
//    歧义无法消除时返回 null（宁可禁用替换按钮，不可替换错位置）

export interface SelectionAnchor {
  selectedText: string;
  /** useContentSelection 解析的偏移提示；-1 表示未能定位 */
  startOffset: number;
  endOffset: number;
  contextBefore?: string;
  contextAfter?: string;
}

export interface ResolvedRange {
  start: number;
  end: number;
}

/**
 * 在正文中定位选区。分级：offset 精确命中 → 唯一 indexOf → contextBefore 尾部消歧 → null。
 * 返回 null 表示无法安全定位（多处出现且消歧失败 / 原文已变），调用方应禁用"替换"。
 */
export function resolveSelectionRange(body: string, sel: SelectionAnchor): ResolvedRange | null {
  const text = sel.selectedText;
  if (!body || !text) return null;

  // 1) offset 提示精确命中
  if (
    sel.startOffset >= 0 &&
    sel.startOffset + text.length <= body.length &&
    body.slice(sel.startOffset, sel.startOffset + text.length) === text
  ) {
    return { start: sel.startOffset, end: sel.startOffset + text.length };
  }

  // 2) 唯一出现
  const first = body.indexOf(text);
  if (first < 0) return null;
  const second = body.indexOf(text, first + 1);
  if (second < 0) return { start: first, end: first + text.length };

  // 3) 多处出现：用 contextBefore 尾部片段消歧
  const ctx = (sel.contextBefore ?? '').trimEnd();
  if (ctx) {
    const probe = ctx.length > 30 ? ctx.slice(-30) : ctx;
    const joint = body.indexOf(probe + text);
    if (joint >= 0) {
      const start = joint + probe.length;
      return { start, end: start + text.length };
    }
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
