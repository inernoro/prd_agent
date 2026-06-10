/**
 * 产品管理智能体 — 知识库模块共享工具（contentType 展示、时间/大小格式化、来源判定）。
 */
import { FileText, FileCode, FileType, FileSpreadsheet, Image, FileAudio, FileVideo, Presentation, FileArchive, File } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DocumentEntry } from '@/services/contracts/documentStore';

/** contentType → 图标 + 短标签（注册表模式，按类型区分图标与配色，避免组件内 if-else 蔓延） */
const FILE_KIND_REGISTRY: { test: (ct: string) => boolean; icon: LucideIcon; label: string; color: string }[] = [
  { test: (ct) => ct.includes('html'), icon: FileCode, label: 'HTML', color: '#fb923c' },
  { test: (ct) => ct.includes('markdown'), icon: FileText, label: 'Markdown', color: '#22d3ee' },
  { test: (ct) => ct.includes('pdf'), icon: FileType, label: 'PDF', color: '#f87171' },
  { test: (ct) => ct.includes('word') || ct.includes('msword') || ct.includes('officedocument.wordprocessing'), icon: FileText, label: 'Word', color: '#60a5fa' },
  { test: (ct) => ct.includes('presentation') || ct.includes('powerpoint'), icon: Presentation, label: 'PPT', color: '#fb7185' },
  { test: (ct) => ct.includes('sheet') || ct.includes('excel') || ct.includes('csv'), icon: FileSpreadsheet, label: '表格', color: '#34d399' },
  { test: (ct) => ct.includes('json') || ct.includes('javascript') || ct.includes('typescript') || ct.includes('xml'), icon: FileCode, label: '代码', color: '#a78bfa' },
  { test: (ct) => ct.includes('zip') || ct.includes('rar') || ct.includes('tar') || ct.includes('7z') || ct.includes('compressed'), icon: FileArchive, label: '压缩包', color: '#9ca3af' },
  { test: (ct) => ct.startsWith('image/'), icon: Image, label: '图片', color: '#c084fc' },
  { test: (ct) => ct.startsWith('audio/'), icon: FileAudio, label: '音频', color: '#fbbf24' },
  { test: (ct) => ct.startsWith('video/'), icon: FileVideo, label: '视频', color: '#fb923c' },
  { test: (ct) => ct.startsWith('text/'), icon: FileText, label: '文本', color: '#94a3b8' },
];

export function fileKindOf(contentType: string | undefined): { icon: LucideIcon; label: string; color: string } {
  const ct = (contentType ?? '').toLowerCase();
  for (const k of FILE_KIND_REGISTRY) if (k.test(ct)) return k;
  return { icon: File, label: '文件', color: '#9ca3af' };
}

/** 是否 HTML 文档（详情页直接渲染预览 + 代码模式切换） */
export function isHtml(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().includes('html');
}

/** 是否「完整 HTML 网页」（含 doctype/html/head/style）——详情页用沙箱 iframe 按真实网页渲染 */
export function isFullHtmlDocument(content: string | null | undefined): boolean {
  return !!content && /<!doctype html|<html[\s>]|<head[\s>]|<style[\s>]/i.test(content);
}

/** 是否可在线富文本编辑（markdown / 纯文本 / html 走内置编辑器） */
export function isEditableText(contentType: string | undefined): boolean {
  const ct = (contentType ?? '').toLowerCase();
  return ct.includes('markdown') || ct === 'text/plain' || ct.includes('html');
}

/**
 * 是否为「上传的文件」（带附件实体）。
 * 上传的文件才提供「重新上传」替换原文件；在线新建/编辑的文档走「编辑」，不显示重新上传。
 */
export function isUploadedFile(entry: Pick<DocumentEntry, 'attachmentId'>): boolean {
  return !!entry.attachmentId;
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

/** 聚焦容器统一样式：内部 input 加 .no-focus-ring 去掉全局紫色 outline，容器走 focus-within 青色边 */
export const FOCUS_BOX = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 transition-colors focus-within:border-cyan-500/40 focus-within:bg-white/[0.07]';
