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
