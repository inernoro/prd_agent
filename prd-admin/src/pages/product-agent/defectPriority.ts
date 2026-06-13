import type { ItemGrade } from './types';

const GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];

function isGrade(v: string): v is ItemGrade {
  return (GRADES as string[]).includes(v);
}

/**
 * TAPD「优先级」列 → 实体 Grade（p0–p3）。只读本列；无法识别或为空时返回 undefined。
 */
export function normalizeTapdPriorityToGrade(raw?: string | null): ItemGrade | undefined {
  const text = raw?.trim();
  if (!text) return undefined;

  const lower = text.toLowerCase();
  if (isGrade(lower)) return lower;

  const compact = lower.replace(/\s/g, '');
  if (compact === 'p0' || compact === 'p1' || compact === 'p2' || compact === 'p3') return compact;

  const upper = text.toUpperCase();
  if (upper.startsWith('P')) {
    const digits = upper.slice(1).replace(/\s/g, '');
    const level = digits.length === 0 ? 0 : Number.parseInt(digits, 10);
    if (!Number.isNaN(level)) {
      if (level <= 0) return 'p0';
      if (level === 1) return 'p1';
      if (level === 2) return 'p2';
      return 'p3';
    }
  }

  switch (text) {
    case '紧急':
      return 'p0';
    case '高':
      return 'p1';
    case '中':
      return 'p2';
    case '低':
    case '无关紧要':
      return 'p3';
    default:
      return undefined;
  }
}
