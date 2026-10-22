import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { VersionCopyActions } from './VersionCopyActions';
import type { ProductInitiation } from './types';

/** 发号成功后替换原申领表单，不复用大表单的尺寸、进度或填写提示。 */
export function InitiationSuccessDialog({ item, onClose, busy = false }: {
  item: ProductInitiation;
  onClose: () => void;
  busy?: boolean;
}) {
  const attempts = item.reviewAttempts ?? [];
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}
    title="申领成功" description="内部版本号已生成，可复制编号或完整通知。"
    maxWidth={480} contentStyle={{ height: 'auto', maxHeight: 'min(85vh, 640px)' }}
    actions={<Button size="sm" variant="primary" className="mx-auto" disabled={busy} onClick={onClose}>完成</Button>}
    content={<div className="space-y-5 py-2">
      <section aria-label="内部版本申领结果" className="space-y-4 text-center">
        <CheckCircle2 size={28} className="mx-auto" style={{ color: 'var(--accent-fg-success)' }} aria-hidden="true" />
        <div className="space-y-1"><p className="text-xs text-token-muted">立项号</p><p className="break-all font-mono text-2xl font-semibold text-token-primary">{item.tCode}</p></div>
        <div className="flex justify-center"><VersionCopyActions kind="initiation" id={item.id} code={item.tCode ?? ''} /></div>
      </section>
      {attempts.length > 0 && <details className="border-t border-token-subtle pt-3 text-xs text-token-secondary">
        <summary className="cursor-pointer">已保存的评审记录（{attempts.length} 次）</summary>
        <ul className="mt-2 space-y-2 break-words">{attempts.map((attempt) => <li key={attempt.id}>{`第 ${attempt.attemptNo} 次：${attempt.planFileName ?? '方案'}，${attempt.reviewPassed == null ? '待完成' : attempt.reviewPassed ? '通过' : '未通过'}${attempt.reviewScore == null ? '' : `，${attempt.reviewScore} 分`}`}</li>)}</ul>
      </details>}
    </div>}
  />;
}
