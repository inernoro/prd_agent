/**
 * 视频任务标题净化：剥掉用户从 yuque/notion/markdown 复制时夹带的
 * HTML 注释 / markdown 图片 / 链接 / URL 残渣，保留前 N 字纯文本。
 *
 * 用于：作品列表卡片、详情页顶栏。后端的 articleTitle 可能直接是
 * 文章前 60 字（fallback 路径），所以前端必须再过一遍净化。
 */
export function sanitizeVideoTitle(raw: string | undefined | null, maxLen = 30): string {
  if (!raw) return '';
  let s = String(raw);

  // 剥 HTML 注释 <!-- ... -->（含跨行）
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // 剥 markdown 图片 ![alt](url)
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  // 剥 markdown 链接 [text](url) → 保留 text
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 剥裸 URL
  s = s.replace(/https?:\/\/\S+/g, ' ');
  // 剥 markdown 标题井号 / 列表符号 / 加粗下划线
  s = s.replace(/^[#>\-*]+\s*/gm, ' ').replace(/[*_`]+/g, ' ');
  // 折叠空白
  s = s.replace(/\s+/g, ' ').trim();

  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trim() + '…';
}

/** 列表卡片备用标题：剥后空白时用「视频草稿 · MM-DD HH:mm」 */
export function fallbackVideoTitle(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '视频草稿';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `视频草稿 · ${mm}-${dd} ${hh}:${mi}`;
}

/** 综合：净化后空 → fallback */
export function resolveVideoTitle(raw: string | undefined | null, createdAt: string, maxLen = 30): string {
  const cleaned = sanitizeVideoTitle(raw, maxLen);
  return cleaned || fallbackVideoTitle(createdAt);
}
