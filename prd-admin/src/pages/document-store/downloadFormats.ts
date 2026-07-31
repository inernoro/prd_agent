/** 下载范围：当前正在读的这一篇 / 整个知识库（打包 ZIP） */
export type DocDownloadScope = 'entry' | 'store';
/** 下载格式：markdown = 统一 .md；text = 统一 .txt 纯文本；original = 尽量保持上传时的原始文件 */
export type DocDownloadFormat = 'markdown' | 'text' | 'original';

export const DOC_DOWNLOAD_FORMATS: { value: DocDownloadFormat; label: string; hint: string }[] = [
  { value: 'markdown', label: 'Markdown (.md)', hint: '正文按 Markdown 保存，拿去继续编辑最方便' },
  { value: 'text', label: '纯文本 (.txt)', hint: '只留文字内容，任何设备都能打开' },
  { value: 'original', label: '原始文件', hint: 'PDF / Word / 图片等按上传时的格式下载' },
];

/**
 * 是否为「文字类」内容（与 DocBrowser 同口径）：text/*、markdown、html、空 contentType。
 * 上传的 pdf/docx 等即使抽取出了正文，contentType 仍是 application/*，按二进制处理。
 */
export function isTextDownloadType(contentType?: string | null): boolean {
  const c = (contentType ?? '').toLowerCase();
  return c === '' || c.startsWith('text/') || c.includes('markdown') || c.includes('html');
}

/** 正文落盘时的扩展名：只有「原始文件」格式才保留 html，其余按所选格式统一。 */
export function resolveTextExtension(format: DocDownloadFormat, contentType?: string | null): string {
  if (format === 'text') return '.txt';
  if (format === 'original' && (contentType ?? '').toLowerCase().includes('html')) return '.html';
  return '.md';
}

/** 是否应该先去取原始二进制文件（只有「原始文件」格式 + 非文字类条目 + 有 fileUrl 才值得试）。 */
export function shouldFetchOriginalFile(
  format: DocDownloadFormat,
  contentType: string | null | undefined,
  fileUrl: string | null | undefined,
): boolean {
  return format === 'original' && !!fileUrl && !isTextDownloadType(contentType);
}

/**
 * 把 Markdown / HTML 正文转成真正的纯文本。
 *
 * 「纯文本 (.txt)」的文案承诺「只留文字内容」，但只改后缀的话，标题井号、链接语法、代码围栏、
 * HTML 标签都还在，等于骗人（Codex P2）。这里做一次保守的去标记：
 * 只删「标记符号」，不重排、不丢正文——宁可留一点符号，也不能吃掉用户的字。
 */
export function toPlainText(content: string, contentType?: string | null): string {
  let text = content;
  const isHtml = (contentType ?? '').toLowerCase().includes('html');

  if (isHtml) {
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')      // 整块丢弃：脚本/样式不是正文
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  } else {
    text = text
      .replace(/^```.*$/gm, '')                              // 代码围栏行（保留围栏内的代码正文）
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')                    // 标题井号
      .replace(/^\s{0,3}>\s?/gm, '')                         // 引用符号
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')             // 列表标记
      .replace(/^\s{0,3}([-*_]\s?){3,}$/gm, '')               // 分隔线
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')              // 图片 → alt
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')               // 链接 → 文字
      .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')      // wikilink → 文字
      .replace(/`([^`]+)`/g, '$1')                           // 行内代码
      .replace(/(\*\*|__)(.*?)\1/g, '$2')                    // 粗体
      .replace(/(\*|_)(?!\s)(.*?)(?<!\s)\1/g, '$2');         // 斜体
  }

  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 下载弹窗打开时的默认范围：有正在读的文章就默认只下这一篇。
 * 用户 2026-07-31 明确要求默认当前文章——不该为了一篇文章去下整库 ZIP。
 */
export function resolveInitialDownloadScope(hasCurrentEntry: boolean): DocDownloadScope {
  return hasCurrentEntry ? 'entry' : 'store';
}
