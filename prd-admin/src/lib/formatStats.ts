/**
 * 格式化时间（ms → 150s / 2m30s），并返回颜色级别
 */
export function formatDuration(ms: number | null | undefined): {
  text: string;
  color: string;
  level: 'fast' | 'medium' | 'slow';
} {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return { text: '—', color: 'var(--text-muted)', level: 'medium' };
  }

  const seconds = Math.round(ms / 1000);
  
  // 级别判定（可根据实际调整阈值）
  let level: 'fast' | 'medium' | 'slow';
  let color: string;
  if (seconds < 5) {
    level = 'fast';
    color = 'rgba(34,197,94,0.95)'; // green
  } else if (seconds < 30) {
    level = 'medium';
    color = 'rgba(245,158,11,0.95)'; // amber
  } else {
    level = 'slow';
    color = 'rgba(239,68,68,0.95)'; // red
  }

  // 格式化文本
  if (seconds < 60) {
    return { text: `${seconds}s`, color, level };
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (remainingSeconds === 0) {
    return { text: `${minutes}m`, color, level };
  }
  
  return { text: `${minutes}m${remainingSeconds}s`, color, level };
}

/**
 * 格式化数字（中文单位：万/亿）
 */
export function formatCompactZh(n: number): string {
  if (!Number.isFinite(n)) return '';
  const v = Math.floor(n);
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}

/**
 * 计算成功率（基于成功数和总数）
 */
export function calculateSuccessRate(successCount: number, totalCount: number): {
  rate: number | null;
  text: string;
  color: string;
} {
  if (!Number.isFinite(totalCount) || totalCount <= 0) {
    return { rate: null, text: '—', color: 'var(--text-muted)' };
  }
  
  const success = Math.max(0, Math.min(successCount, totalCount));
  const rate = (success / totalCount) * 100;
  
  let color: string;
  if (rate >= 95) {
    color = 'rgba(34,197,94,0.95)'; // green
  } else if (rate >= 80) {
    color = 'rgba(245,158,11,0.95)'; // amber
  } else {
    color = 'rgba(239,68,68,0.95)'; // red
  }
  
  return { rate, text: `${rate.toFixed(1)}%`, color };
}


