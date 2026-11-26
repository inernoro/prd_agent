import type { AttachmentKind, QcAttachment } from './types';

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 预计时间：不足一分钟写秒，否则写「约 N 分 M 秒」 */
export function formatRemain(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `约 ${s} 秒`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `约 ${m} 分 ${r} 秒` : `约 ${m} 分钟`;
}

/** 时长：「14 分 16 秒」，不足一分钟写秒；避免和时刻（14:16）混淆 */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m} 分${r ? ` ${r} 秒` : '钟'}` : `${r} 秒`;
}

export function formatChars(n: number): string {
  return n.toLocaleString('zh-CN');
}

export const KIND_LABEL: Record<AttachmentKind, string> = { doc: '稿件', kb: '知识库文档', image: '图片' };

/** 附件排序：失败在前，读取中其次，同状态按类型（稿件 → 知识库 → 图片） */
export function sortAttachments(items: QcAttachment[]): QcAttachment[] {
  const s = { failed: 0, reading: 1, ready: 2 } as const;
  const k = { doc: 0, kb: 1, image: 2 } as const;
  return [...items].sort((a, b) => s[a.status] - s[b.status] || k[a.kind] - k[b.kind]);
}

export function summarizeAttachments(items: QcAttachment[]) {
  const failed = items.filter(a => a.status === 'failed').length;
  const reading = items.filter(a => a.status === 'reading').length;
  const chars = items.reduce((n, a) => n + (a.status === 'ready' ? a.chars ?? 0 : 0), 0);
  const images = items.filter(a => a.kind === 'image').length;
  return { total: items.length, failed, reading, chars, images };
}

/** 一次创作的附件上限与文字预算 */
export const MAX_ATTACHMENTS = 8;
export const CHAR_BUDGET = 20000;
