import { getDocumentContent } from '@/services/real/documentStore';
import { apiDownload } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { isTextDownloadType, resolveTextExtension, shouldFetchOriginalFile, toPlainText, type DocDownloadFormat } from './downloadFormats';

export const ORIGINAL_DOWNLOAD_FAILURE_MESSAGE = '原始文件下载未完成。请稍后重试，或选择 Markdown / 纯文本导出正文。';

/** 单篇与整库共用的实际导出路径；null 表示没有可导出正文。 */
export async function buildEntryDownload(
  entry: { id: string; title: string; attachmentId?: string },
  format: DocDownloadFormat,
  makeName: (title: string, ext: string) => string,
): Promise<{ name: string; data: Blob | string } | null> {
  const res = await getDocumentContent(entry.id);
  if (!res.success || !res.data) return null;
  const { content, fileUrl, contentType } = res.data;
  const hasText = content != null && content !== '';

  if (format === 'original' && (entry.attachmentId || shouldFetchOriginalFile(format, contentType, fileUrl))) {
    // 复用已鉴权的条目下载端点，不向CDN携带凭据，也不受浏览器跨域读取限制。
    const original = await apiDownload(api.documentStore.entries.download(entry.id), entry.title);
    if (!/^attachment(?:;|$)/i.test(original.headers?.get('content-disposition')?.trim() ?? '')) {
      throw new Error(ORIGINAL_DOWNLOAD_FAILURE_MESSAGE);
    }
    // 沿用现有安全扩展名口径，避免basename限长截掉格式；不把路径字符带入扩展名。
    const extension = /\.[a-zA-Z0-9]{1,8}$/.exec(original.fileName)?.[0] ?? '';
    return { name: makeName(original.fileName.slice(0, original.fileName.length - extension.length), extension), data: original.blob };
  }
  if (format === 'original' && !isTextDownloadType(contentType)) {
    throw new Error(ORIGINAL_DOWNLOAD_FAILURE_MESSAGE);
  }
  if (!hasText) return null;
  const data = format === 'text' ? toPlainText(content!, contentType) : content!;
  if (data === '') return null;
  return { name: makeName(entry.title, resolveTextExtension(format, contentType)), data };
}
