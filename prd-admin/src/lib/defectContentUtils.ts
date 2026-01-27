/**
 * 缺陷内容工具函数
 * 处理 [IMG] 标签的解析和构建，用于在文本中嵌入图片引用
 */

// 匹配 [IMG src=... name=...] 格式
const IMG_TAG_RX = /\[IMG([^\]]*)\]/g;
const IMG_TAG_SINGLE_RX = /\[IMG([^\]]*)\]/;

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseImgTagKv(body: string): { src?: string; name?: string } {
  const out: Record<string, string> = {};
  const parts = String(body ?? '')
    .trim()
    .split(/\s+/g)
    .filter(Boolean);
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim().toLowerCase();
    const v = p.slice(idx + 1).trim();
    if (!k || !v) continue;
    out[k] = safeDecodeURIComponent(v);
  }
  return { src: out.src, name: out.name };
}

export interface ParsedImgTag {
  src: string;
  name?: string;
  fullMatch: string;
  index: number;
}

/**
 * 从文本中提取所有 [IMG] 标签
 */
export function extractAllImgTags(content: string): ParsedImgTag[] {
  const results: ParsedImgTag[] = [];
  const text = String(content ?? '');
  let match: RegExpExecArray | null;
  const rx = new RegExp(IMG_TAG_RX.source, 'g');
  while ((match = rx.exec(text))) {
    const body = String(match[1] ?? '');
    const kv = parseImgTagKv(body);
    const src = String(kv.src ?? '').trim();
    if (src) {
      results.push({
        src,
        name: kv.name || undefined,
        fullMatch: match[0],
        index: match.index,
      });
    }
  }
  return results;
}

/**
 * 提取第一个 [IMG] 标签
 */
export function extractFirstImgTag(content: string): { src: string; name?: string; clean: string } | null {
  const text = String(content ?? '');
  const match = IMG_TAG_SINGLE_RX.exec(text);
  if (!match) return null;
  const body = String(match[1] ?? '');
  const kv = parseImgTagKv(body);
  const src = String(kv.src ?? '').trim();
  if (!src) return null;
  const clean = text.replace(match[0], '').trim();
  return { src, name: kv.name || undefined, clean };
}

/**
 * 构建 [IMG] 标签
 */
export function buildImgTag(src: string, name?: string): string {
  const s = String(src ?? '').trim();
  if (!s) return '';
  // 不支持 data: 和 blob: URL（太长且不持久化）
  if (s.startsWith('data:') || s.startsWith('blob:')) return '';
  const safeSrc = encodeURIComponent(s);
  const safeName = name ? encodeURIComponent(String(name).trim()) : '';
  return safeName ? `[IMG src=${safeSrc} name=${safeName}]` : `[IMG src=${safeSrc}]`;
}

/**
 * 移除文本中所有 [IMG] 标签，返回纯文本
 */
export function stripImgTags(content: string): string {
  return String(content ?? '').replace(IMG_TAG_RX, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 渲染内容：将 [IMG] 标签替换为占位符，返回分段内容
 */
export interface ContentSegment {
  type: 'text' | 'image';
  content: string; // text: 文本内容, image: 图片URL
  name?: string; // image: 图片名称
}

export function parseContentToSegments(content: string): ContentSegment[] {
  const text = String(content ?? '');
  const segments: ContentSegment[] = [];
  const tags = extractAllImgTags(text);

  if (tags.length === 0) {
    if (text.trim()) {
      segments.push({ type: 'text', content: text.trim() });
    }
    return segments;
  }

  let lastIndex = 0;
  for (const tag of tags) {
    // 添加标签前的文本
    if (tag.index > lastIndex) {
      const beforeText = text.slice(lastIndex, tag.index).trim();
      if (beforeText) {
        segments.push({ type: 'text', content: beforeText });
      }
    }
    // 添加图片
    segments.push({ type: 'image', content: tag.src, name: tag.name });
    lastIndex = tag.index + tag.fullMatch.length;
  }

  // 添加最后一个标签后的文本
  if (lastIndex < text.length) {
    const afterText = text.slice(lastIndex).trim();
    if (afterText) {
      segments.push({ type: 'text', content: afterText });
    }
  }

  return segments;
}
