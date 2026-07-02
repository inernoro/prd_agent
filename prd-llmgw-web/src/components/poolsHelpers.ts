// 健康状态 chip 注册表（模型池 / 影子共用）。颜色走固定语义色，弱底跟随主题。
export function healthChip(status: number): { label: string; color: string; bg: string } {
  switch (status) {
    case 0:
      return { label: 'Healthy', color: '#3fb950', bg: 'rgba(63,185,80,0.14)' };
    case 1:
      return { label: 'Degraded', color: '#d29922', bg: 'rgba(210,153,34,0.14)' };
    case 2:
      return { label: 'Unavailable', color: '#f85149', bg: 'rgba(248,81,73,0.14)' };
    default:
      return { label: 'Unknown', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' };
  }
}

export function boolChip(v: boolean, onLabel: string, offLabel: string): { label: string; color: string; bg: string } {
  return v
    ? { label: onLabel, color: '#3fb950', bg: 'rgba(63,185,80,0.14)' }
    : { label: offLabel, color: 'var(--text-muted)', bg: 'var(--bg-elevated)' };
}
