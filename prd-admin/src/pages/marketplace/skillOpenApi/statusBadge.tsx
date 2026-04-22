import type { AgentApiKeyStatus } from '@/services/contracts/agentApiKeys';

const STATUS_META: Record<
  AgentApiKeyStatus,
  { label: string; color: string; bg: string; border: string }
> = {
  active: {
    label: '有效',
    color: 'rgba(134, 239, 172, 0.98)',
    bg: 'rgba(34, 197, 94, 0.14)',
    border: 'rgba(34, 197, 94, 0.4)',
  },
  'expiring-soon': {
    label: '30 天内过期',
    color: 'rgba(253, 224, 71, 0.98)',
    bg: 'rgba(234, 179, 8, 0.15)',
    border: 'rgba(234, 179, 8, 0.45)',
  },
  grace: {
    label: '已过期（宽限期内）',
    color: 'rgba(251, 191, 36, 0.98)',
    bg: 'rgba(217, 119, 6, 0.16)',
    border: 'rgba(217, 119, 6, 0.5)',
  },
  expired: {
    label: '已过期',
    color: 'rgba(252, 165, 165, 0.98)',
    bg: 'rgba(239, 68, 68, 0.15)',
    border: 'rgba(239, 68, 68, 0.4)',
  },
  disabled: {
    label: '已禁用',
    color: 'rgba(203, 213, 225, 0.9)',
    bg: 'rgba(148, 163, 184, 0.15)',
    border: 'rgba(148, 163, 184, 0.35)',
  },
  revoked: {
    label: '已撤销',
    color: 'rgba(252, 165, 165, 0.98)',
    bg: 'rgba(239, 68, 68, 0.18)',
    border: 'rgba(239, 68, 68, 0.45)',
  },
};

export function StatusBadge({ status }: { status: AgentApiKeyStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.active;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium"
      style={{
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.border}`,
      }}
    >
      {meta.label}
    </span>
  );
}

export function formatDaysLeft(daysLeft: number | null | undefined): string {
  if (daysLeft === null || daysLeft === undefined) return '永不过期';
  if (daysLeft < 0) return `已过期 ${Math.abs(daysLeft)} 天`;
  if (daysLeft === 0) return '今天到期';
  return `剩余 ${daysLeft} 天`;
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}
