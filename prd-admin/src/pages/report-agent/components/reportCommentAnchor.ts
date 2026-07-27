// 周报划词评论的锚点纯逻辑（无 DOM 依赖，可在 node 环境单测）。
// 定位/匹配算法复用知识库 SSOT：
//   - locateInSegments / findTextRange（components/doc-browser/InlineCommentOverlay.tsx）
// 本文件只负责：从"段落纯文本 + 选区偏移"构造锚点，以及黄色下划线的主题配色。

export interface ReportCommentAnchor {
  /** 被选中的原文片段（空白折叠为单空格） */
  selectedText: string;
  /** 选中片段前上下文（约 50 字符，同段多处命中时消歧） */
  contextBefore: string;
  /** 选中片段后上下文（约 50 字符） */
  contextAfter: string;
  /** 相对段落纯文本的起始字符偏移（定位 hint） */
  startOffset: number;
  /** 结束字符偏移（定位 hint） */
  endOffset: number;
}

/** 选区文本存储上限：超长选区截断保存，下划线按截断后的片段定位 */
export const MAX_SELECTED_TEXT = 500;
/** 前后上下文截取长度 */
export const CONTEXT_LEN = 50;

/** 折叠空白：换行/连续空格归一为单空格，两端去空白（与 doc-browser groupKey 同口径） */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 由段落纯文本与选区偏移构造锚点。
 * 选区过短（去空白后 < 2 字符）或偏移非法时返回 null。
 */
export function buildAnchorFromText(fullText: string, start: number, end: number): ReportCommentAnchor | null {
  if (start < 0 || end > fullText.length || end <= start) return null;
  const selected = collapseWhitespace(fullText.slice(start, end));
  if (selected.length < 2) return null;
  return {
    selectedText: selected.slice(0, MAX_SELECTED_TEXT),
    contextBefore: collapseWhitespace(fullText.slice(Math.max(0, start - CONTEXT_LEN), start)),
    contextAfter: collapseWhitespace(fullText.slice(end, end + CONTEXT_LEN)),
    startOffset: start,
    endOffset: end,
  };
}

// ---------- 黄色下划线配色（双主题，随主题微调保证协调） ----------
// 暗色底用亮黄（yellow-500 系），浅色暖纸底用深金黄（yellow-600/700 系）保对比度。

/** 下划线描边色 */
export function underlineStroke(isLight: boolean, emphasized = false): string {
  if (isLight) return emphasized ? 'rgba(161, 98, 7, 0.95)' : 'rgba(202, 138, 4, 0.8)';
  return emphasized ? 'rgba(250, 204, 21, 0.95)' : 'rgba(234, 179, 8, 0.75)';
}

/** hover/激活时的柔和底色提示（常态不铺底色，保持"下划线"而非"高亮块"） */
export function underlineTint(isLight: boolean): string {
  return isLight ? 'rgba(202, 138, 4, 0.10)' : 'rgba(234, 179, 8, 0.12)';
}
