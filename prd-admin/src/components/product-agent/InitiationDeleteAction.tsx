import { useId, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { deleteInitiation, deleteRelease } from '@/services/real/productAgent';

type DeleteProps = { id: string; code: string; canDelete?: boolean; onDeleted: () => void | Promise<void> };
const VARIANTS = {
  initiation: { title: '内部版本', remove: deleteInitiation, description: '仅申请人本人可作废全局最后一条申领成功、且没有正式版本等下游关联的内部版本记录。', effect: '记录及对应方案申领关联会删除，方案可重新申领；后续按所属应用仍保留的最新有效版本发号，不计入本次已删除的记录。' },
  release: { title: '正式版本', remove: deleteRelease, description: '仅申请人本人可作废全局最后一条申领成功、且没有后续版本等下游关联的正式版本记录。', effect: '删除正式版本记录后，对应T可重新申领V；原T资料保留，后续按所属应用仍保留的最新有效版本发号，不计入本次已删除的记录。' },
};

export function InitiationDeleteAction(props: DeleteProps) { return <VersionDeleteAction {...props} kind="initiation" />; }
export function ReleaseDeleteAction(props: DeleteProps) { return <VersionDeleteAction {...props} kind="release" />; }

/** 列表与详情共用；删除资格由服务端判断，不使用当前筛选后的列表。 */
function VersionDeleteAction({ id, code, canDelete, onDeleted, kind }: DeleteProps & { kind: keyof typeof VARIANTS }) {
  const variant = VARIANTS[kind];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const normalizedReason = reason.trim();
  const reasonValid = Array.from(normalizedReason).length > 5;
  const submitting = useRef(false);
  const confirm = async () => {
    if (submitting.current) return;
    if (!reasonValid) { setError('请填写作废理由，去除首尾空白后至少6个字符。'); return; }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await variant.remove(id, normalizedReason);
      if (!result.success) { setError(result.error?.message ?? '作废未成功，请稍后重试。'); return; }
      setOpen(false);
      await onDeleted();
    } catch {
      setError('作废结果暂未确认，请刷新原记录核对后重试。');
    } finally { submitting.current = false; setBusy(false); }
  };
  if (canDelete !== true) return null;
  return <span onClick={(event) => event.stopPropagation()}>
    <button type="button" aria-label={`作废 ${code}`} className="text-token-secondary hover:underline" onClick={() => { setError(''); setReason(''); setOpen(true); }}>作废</button>
    {open && <Dialog open onOpenChange={(value) => { if (!submitting.current) setOpen(value); }} title={`作废${variant.title} ${code}`} tone="danger"
      content={<div className="space-y-3 text-sm text-token-secondary"><p>{variant.description}</p><p>{variant.effect}</p>
        <label htmlFor={reasonId} className="block font-medium text-token-primary">作废理由 *</label>
        <textarea id={reasonId} required rows={3} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)}
          placeholder="请填写作废理由，至少6个字符" className="w-full rounded-md border border-token-subtle bg-token-nested p-2 text-token-primary" />
        <p className="text-xs text-token-muted">去除首尾空白后至少6个字符，作废理由将被保留。</p>
        {error && <p role="alert">{error}</p>}</div>}
      actions={<><Button size="sm" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button size="sm" disabled={busy || !reasonValid} onClick={() => void confirm()}>{busy ? '正在作废…' : '确认作废'}</Button></>} />}
  </span>;
}
