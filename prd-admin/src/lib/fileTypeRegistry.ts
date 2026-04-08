/**
 * 文件类型注册表 — 按扩展名/MIME 类型映射到图标 + 颜色 + 标签
 *
 * 遵循 `*_REGISTRY` 约定（参考 `marketplaceTypes.tsx` 的 CONFIG_TYPE_REGISTRY）。
 * 所有消费端必须通过 `getFileTypeConfig()` 获取配置，禁止在组件内硬编码 switch。
 *
 * 扩展方式：向 FILE_TYPE_REGISTRY 新增 key 即可，`getFileTypeConfig()` 自动适配。
 */

import type { LucideIcon } from 'lucide-react';
import {
  File,
  FileText,
  FileCode,
  FileSpreadsheet,
  FileImage,
  FileJson,
  FileAudio,
  FileVideo,
  Presentation,
  Archive,
} from 'lucide-react';

/** 预览类型枚举 */
export type FilePreviewKind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'none';

export interface FileTypeConfig {
  /** 标准扩展名列表（含点，小写） */
  extensions: string[];
  /** MIME 类型关键字（用于扩展名缺失时兜底识别） */
  mimeKeywords: string[];
  /** Lucide 图标组件 */
  icon: LucideIcon;
  /** 图标颜色（rgba） */
  color: string;
  /** 人类可读标签 */
  label: string;
  /** 预览方式（用于右侧预览面板渲染） */
  preview: FilePreviewKind;
  /** 是否支持在线编辑（仅文本类） */
  editable?: boolean;
}

/** 文件类型注册表 — 新增类型在此处添加 */
export const FILE_TYPE_REGISTRY: Record<string, FileTypeConfig> = {
  markdown: {
    extensions: ['.md', '.markdown', '.mdx'],
    mimeKeywords: ['markdown'],
    icon: FileText,
    color: 'rgba(59,130,246,0.8)',
    label: 'Markdown',
    preview: 'text',
    editable: true,
  },
  pdf: {
    extensions: ['.pdf'],
    mimeKeywords: ['pdf'],
    icon: FileText,
    color: 'rgba(239,68,68,0.8)',
    label: 'PDF',
    preview: 'pdf',
  },
  word: {
    extensions: ['.doc', '.docx'],
    mimeKeywords: ['wordprocessing', 'msword'],
    icon: FileText,
    color: 'rgba(37,99,235,0.85)',
    label: 'Word',
    preview: 'text',
  },
  powerpoint: {
    extensions: ['.ppt', '.pptx'],
    mimeKeywords: ['presentation', 'powerpoint'],
    icon: Presentation,
    color: 'rgba(234,88,12,0.85)',
    label: 'PowerPoint',
    preview: 'text',
  },
  excel: {
    extensions: ['.xls', '.xlsx'],
    mimeKeywords: ['spreadsheet', 'ms-excel'],
    icon: FileSpreadsheet,
    color: 'rgba(34,197,94,0.85)',
    label: 'Excel',
    preview: 'text',
  },
  csv: {
    extensions: ['.csv'],
    mimeKeywords: ['csv'],
    icon: FileSpreadsheet,
    color: 'rgba(34,197,94,0.7)',
    label: 'CSV',
    preview: 'text',
    editable: true,
  },
  code: {
    extensions: ['.js', '.ts', '.tsx', '.jsx', '.py', '.cs', '.go', '.rs', '.java', '.cpp', '.c', '.sh', '.rb', '.php'],
    mimeKeywords: ['javascript', 'typescript', 'python', 'csharp'],
    icon: FileCode,
    color: 'rgba(168,85,247,0.8)',
    label: 'Code',
    preview: 'text',
    editable: true,
  },
  json: {
    extensions: ['.json'],
    mimeKeywords: ['json'],
    icon: FileJson,
    color: 'rgba(234,179,8,0.8)',
    label: 'JSON',
    preview: 'text',
    editable: true,
  },
  yaml: {
    extensions: ['.yaml', '.yml'],
    mimeKeywords: ['yaml'],
    icon: FileJson,
    color: 'rgba(234,179,8,0.7)',
    label: 'YAML',
    preview: 'text',
    editable: true,
  },
  xml: {
    extensions: ['.xml', '.html', '.htm'],
    mimeKeywords: ['xml', 'html'],
    icon: FileCode,
    color: 'rgba(168,85,247,0.7)',
    label: 'Markup',
    preview: 'text',
    editable: true,
  },
  image: {
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'],
    mimeKeywords: ['image/'],
    icon: FileImage,
    color: 'rgba(236,72,153,0.8)',
    label: 'Image',
    preview: 'image',
  },
  video: {
    extensions: ['.mp4', '.mov', '.avi', '.mkv', '.webm'],
    mimeKeywords: ['video/'],
    icon: FileVideo,
    color: 'rgba(168,85,247,0.85)',
    label: 'Video',
    preview: 'video',
  },
  audio: {
    extensions: ['.mp3', '.wav', '.flac', '.ogg', '.m4a'],
    mimeKeywords: ['audio/'],
    icon: FileAudio,
    color: 'rgba(236,72,153,0.7)',
    label: 'Audio',
    preview: 'audio',
  },
  archive: {
    extensions: ['.zip', '.rar', '.tar', '.gz', '.7z'],
    mimeKeywords: ['zip', 'compressed'],
    icon: Archive,
    color: 'rgba(148,163,184,0.8)',
    label: 'Archive',
    preview: 'none',
  },
  text: {
    extensions: ['.txt', '.log'],
    mimeKeywords: ['text/plain'],
    icon: FileText,
    color: 'rgba(148,163,184,0.85)',
    label: 'Text',
    preview: 'text',
    editable: true,
  },
};

/** 默认文件类型（未匹配时的兜底） */
export const DEFAULT_FILE_TYPE: FileTypeConfig = {
  extensions: [],
  mimeKeywords: [],
  icon: File,
  color: 'rgba(148,163,184,0.7)',
  label: 'File',
  preview: 'text',
};

/** 从文件名提取扩展名（小写，含点；无扩展名返回空串） */
export function getFileExtension(filename: string): string {
  if (!filename) return '';
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === filename.length - 1) return '';
  const ext = filename.slice(dotIdx).toLowerCase();
  // 防止误匹配过长"扩展名"（常见扩展名不超过 10 字符）
  if (ext.length > 10) return '';
  return ext;
}

/**
 * 根据文件名 + MIME 类型查找文件类型配置。
 * 优先级：扩展名 > MIME 关键字 > 默认。
 */
export function getFileTypeConfig(filename: string, mimeType?: string): FileTypeConfig {
  const ext = getFileExtension(filename);
  if (ext) {
    for (const config of Object.values(FILE_TYPE_REGISTRY)) {
      if (config.extensions.includes(ext)) return config;
    }
  }
  if (mimeType) {
    const mime = mimeType.toLowerCase();
    for (const config of Object.values(FILE_TYPE_REGISTRY)) {
      if (config.mimeKeywords.some(kw => mime.includes(kw))) return config;
    }
  }
  return DEFAULT_FILE_TYPE;
}

/** 文件扩展名的显示用标签（大写去点） */
export function getFileExtensionLabel(filename: string, mimeType?: string): string {
  const ext = getFileExtension(filename);
  if (ext) return ext.slice(1).toUpperCase();
  // 扩展名缺失时从 MIME 推断
  const config = getFileTypeConfig(filename, mimeType);
  return config.label.toUpperCase();
}
