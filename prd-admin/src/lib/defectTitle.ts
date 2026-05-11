const MAX_TITLE_LENGTH = 100;

const LABEL_PREFIX_RE = /^#{0,6}\s*(?:[*_`~\s]*)?(?:缺陷标题|问题标题|标题)(?:[*_`~\s]*)?\s*[：:]\s*/i;
const SECTION_LABEL_RE = /^#{0,6}\s*(?:[*_`~\s]*)?(?:用户描述|缺陷描述|问题描述|复现步骤|实际结果|期望结果|预期结果|截图|截图信息|日志|评论|备注|影响范围)(?:[*_`~\s]*)?\s*(?:[：:]?\s*)$/i;
const IMAGE_LABEL_RE = /^(?:图|图片|截图)\s*\d+\s*(?:[：:].*)?$/i;
const IMAGE_MARKDOWN_RE = /^!\[[^\]]*]\([^)]+\)$/;
const IMAGE_FILE_RE = /^[\w.-]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i;
const URL_ONLY_RE = /^https?:\/\/\S+$/i;

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripMarkup(value: string): string {
  return decodeBasicEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateTitle(value: string, maxLength = MAX_TITLE_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function cleanCandidate(line: string): string {
  const raw = line.trim();
  if (!raw) return '';

  const withoutLabel = raw.replace(LABEL_PREFIX_RE, '');
  const cleaned = stripMarkup(withoutLabel);
  if (!cleaned) return '';
  if (SECTION_LABEL_RE.test(cleaned)) return '';
  if (IMAGE_LABEL_RE.test(cleaned)) return '';
  if (IMAGE_MARKDOWN_RE.test(raw)) return '';
  if (IMAGE_FILE_RE.test(cleaned)) return '';
  if (URL_ONLY_RE.test(cleaned)) return '';
  return truncateTitle(cleaned);
}

export function extractDefectTitle(content: string | null | undefined): string {
  const lines = String(content ?? '').split(/\r?\n/);
  for (const line of lines) {
    const title = cleanCandidate(line);
    if (title) return title;
  }
  return '';
}

export function formatDefectTitle(
  title: string | null | undefined,
  content: string | null | undefined,
  fallback = '无标题'
): string {
  return cleanCandidate(String(title ?? '')) || extractDefectTitle(content) || fallback;
}
