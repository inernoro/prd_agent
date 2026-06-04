/** 资料模块共享工具：Markdown 摘要、日期格式化、相对时间。 */

/** 把 Markdown 粗略压成纯文本摘要（用于卡片预览，不做完整解析）。 */
export function mdExcerpt(md: string | null | undefined, max = 110): string {
  if (!md) return '';
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接保留文字
    .replace(/^[#>\-*+]\s*/gm, '')              // 标题/引用/列表前缀
    .replace(/[*_`~#>]/g, '')                   // 行内标记
    .replace(/\|/g, ' ')                         // 表格竖线
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export function fmtDate(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDateTime(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 简易相对时间（中文）。 */
export function relTime(s?: string | null): string {
  if (!s) return '';
  const diff = Date.now() - new Date(s).getTime();
  const day = 86400000;
  if (diff < 0) return fmtDate(s);
  if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return fmtDate(s);
}

/** 资料筛选栏共享的 input/select 类与样式。 */
export const filterInputCls = 'text-[12px] rounded-md px-2.5 py-1.5 outline-none border';
export const filterInputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' } as const;
