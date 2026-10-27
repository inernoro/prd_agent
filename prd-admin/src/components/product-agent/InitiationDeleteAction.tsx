import { useId, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { deleteInitiation, deleteRelease, voidProductVersion } from '@/services/real/productAgent';

type DeleteProps = { id: string; code: string; status?: string; voidReason?: string | null; canDelete?: boolean; showVoid?: boolean; onDeleted: () => void | Promise<void> };
const VARIANTS = {
  initiation: { title: '内部版本', kind: 'T' as const, remove: deleteInitiation },
  release: { title: '正式版本', kind: 'V' as const, remove: deleteRelease },
};
export function InitiationDeleteAction(props: DeleteProps) { return <VersionActions {...props} kind="initiation" />; }
export function ReleaseDeleteAction(props: DeleteProps) { return <VersionActions {...props} kind="release" />; }

/** 作废不限最新；删除资格由服务端按所属应用计算，两个动作分开。 */
function VersionActions({ id, code, status, voidReason, canDelete, showVoid = true, onDeleted, kind }: DeleteProps & { kind: keyof typeof VARIANTS }) {
  const variant = VARIANTS[kind];
  const [mode, setMode] = useState<'void' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const normalizedReason = reason.trim();
  const reasonValid = Array.from(normalizedReason).length > 5;
  const submitting = useRef(false);
  const label = mode === 'delete' ? '删除' : '作废';
  const open = (action: 'void' | 'delete') => { setError(''); setReason(''); setMode(action); };
  const confirm = async () => {
    if (submitting.current || mode == null) return;
    if (!reasonValid) { setError(`请填写${label}理由，去除首尾空白后至少6个字符。`); return; }
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = mode === 'void' ? await voidProductVersion(variant.kind, id, normalizedReason) : await variant.remove(id, normalizedReason);
      if (!result.success) { setError(result.error?.message ?? `${label}未成功，请稍后重试。`); return; }
      setMode(null); await onDeleted();
    } catch { setError(`${label}结果暂未确认，请刷新原记录核对后重试。`); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <span className="inline-flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
    {showVoid && <button type="button" aria-label={`作废 ${code}`} title={voidReason ?? undefined} disabled={status === 'voided'}
      className="text-token-secondary hover:underline disabled:cursor-default disabled:no-underline" onClick={() => open('void')}>{status === 'voided' ? '已作废' : '作废'}</button>}
    {canDelete === true && <button type="button" aria-label={`删除 ${code}`} className="text-token-secondary hover:underline" onClick={() => open('delete')}>删除</button>}
    {mode && <Dialog open onOpenChange={(value) => { if (!submitting.current && !value) setMode(null); }} title={`${label}${variant.title} ${code}`} tone="danger"
      content={<div className="space-y-3 text-sm text-token-secondary">
        {mode === 'void' ? <><p>作废会保留记录、编号和理由，不会删除记录或释放编号，已有下游记录不变。</p><p>申请人或产品管理人员可作废记录，作废后的记录不能继续申领。</p></>
          : <><p>仅申请人本人可删除该应用最新、且没有下游关联的版本记录。</p><p>删除后按所属应用仍保留的最新有效版本发号；删除V保留原T资料。</p></>}
        <label htmlFor={reasonId} className="block font-medium text-token-primary">{label}理由 *</label>
        <textarea id={reasonId} required rows={3} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)}
          placeholder={`请填写${label}理由，至少6个字符`} className="w-full rounded-md border border-token-subtle bg-token-nested p-2 text-token-primary" />
        <p className="text-xs text-token-muted">去除首尾空白后至少6个字符，理由将被保留。</p>
        {error && <p role="alert">{error}</p>}</div>}
      actions={<><Button size="sm" disabled={busy} onClick={() => setMode(null)}>取消</Button><Button size="sm" disabled={busy || !reasonValid} onClick={() => void confirm()}>{busy ? `正在${label}…` : `确认${label}`}</Button></>} />}
  </span>;
}
