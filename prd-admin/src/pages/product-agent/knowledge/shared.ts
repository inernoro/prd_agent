/**
 * 产品管理智能体 — 知识库模块共享工具（contentType 展示、时间/大小格式化）。
 */
import { FileText, Image, FileAudio, FileVideo, File, FileSpreadsheet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** contentType → 图标 + 短标签（注册表模式，避免组件内 if-else 蔓延） */
const FILE_KIND_REGISTRY: { test: (ct: string) => boolean; icon: LucideIcon; label: string; color: string }[] = [
  { test: (ct) => ct.includes('markdown') || ct.startsWith('text/'), icon: FileText, label: '文档', color: '#22d3ee' },
  { test: (ct) => ct.includes('pdf'), icon: FileText, label: 'PDF', color: '#f87171' },
  { test: (ct) => ct.startsWith('image/'), icon: Image, label: '图片', color: '#a78bfa' },
  { test: (ct) => ct.startsWith('audio/'), icon: FileAudio, label: '音频', color: '#fbbf24' },
  { test: (ct) => ct.startsWith('video/'), icon: FileVideo, label: '视频', color: '#fb923c' },
  { test: (ct) => ct.includes('sheet') || ct.includes('excel') || ct.includes('csv'), icon: FileSpreadsheet, label: '表格', color: '#34d399' },
];

export function fileKindOf(contentType: string | undefined): { icon: LucideIcon; label: string; color: string } {
  const ct = (contentType ?? '').toLowerCase();
  for (const k of FILE_KIND_REGISTRY) if (k.test(ct)) return k;
  return { icon: File, label: '文件', color: '#9ca3af' };
}

/** 是否可在线编辑（markdown / 纯文本走内置编辑器） */
export function isEditableText(contentType: string | undefined): boolean {
  const ct = (contentType ?? '').toLowerCase();
  return ct.includes('markdown') || ct === 'text/plain' || ct === 'text/html';
}

export function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(s: string | undefined): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 未分类的过滤值（与后端 ListEntries 的 category=__none__ 约定一致） */
export const NO_CATEGORY = '__none__';
