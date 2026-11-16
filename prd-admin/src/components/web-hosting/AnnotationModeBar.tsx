import { MousePointer2, X } from 'lucide-react';
import type { HostedAnnotations } from './useHostedAnnotations';

export function AnnotationModeBar({ annotations, onCancel }: { annotations: HostedAnnotations; onCancel: () => void }) {
  if (!annotations.enabled) return null;
  return <div style={{ background: 'var(--bg-elevated)' }} className="pointer-events-none absolute left-3 right-3 top-3 z-30 mx-auto flex max-w-md items-center gap-2 rounded-xl border border-amber-500/40 bg-token-card px-3 py-2.5 text-xs text-token-primary shadow-lg" role="status">
    <MousePointer2 size={16} className="shrink-0 text-amber-500" />
    <div className="min-w-0 flex-1"><span className="font-semibold">批注模式</span><span className="ml-2 text-token-secondary">点击元素，或拖选一段文字</span></div>
    <button type="button" onClick={() => { annotations.setEnabled(false); onCancel(); }} aria-label="退出批注模式" className="pointer-events-auto p-1"><X size={16} /></button>
  </div>;
}
