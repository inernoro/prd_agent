import { AlertTriangle } from 'lucide-react';
import type { ModelReferenceState } from '@/services/contracts/modelReferences';

const STATUS_LABELS = { unavailable: '模型暂不可用', legacy: '模型引用需修复', unknown: '模型状态未确认' };

export function ModelReferenceStatus({ reference }: { reference: ModelReferenceState }) {
  if (reference.modelReferenceStatus === 'available') return null;
  const status = reference.modelReferenceStatus ?? 'unknown';
  return <span className="flex items-start gap-1 text-xs mt-1" role="status" style={{ color: 'var(--semantic-danger-text)' }}>
    <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
    <span>{STATUS_LABELS[status]}{reference.modelReferenceReason ? `：${reference.modelReferenceReason}` : '，请重新选择授权模型。'}</span>
  </span>;
}
