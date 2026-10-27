import { useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { deleteInitiation, deleteRelease } from '@/services/real/productAgent';

type DeleteProps = { id: string; code: string; canDelete?: boolean; onDeleted: () => void | Promise<void> };
const VARIANTS = {
  initiation: { title: '内部版本', remove: (id: string) => deleteInitiation(id), description: '仅申请人本人可删除全局最后一条申领成功、且没有正式版本等下游关联的内部版本记录。', effect: '记录及对应方案申领关联会删除，方案可重新申领；已发编号的防重记录保留，编号不会回收。' },
  release: { title: '正式版本', remove: (id: string) => deleteRelease(id), description: '仅申请人本人可删除全局最后一条申领成功、且没有后续版本等下游关联的正式版本记录。', effect: '删除正式版本记录后，对应T可重新申领V；原T资料保留，已发V编号不会回收。' },
};

export function InitiationDeleteAction(props: DeleteProps) { return <VersionDeleteAction {...props} kind="initiation" />; }
export function ReleaseDeleteAction(props: DeleteProps) { return <VersionDeleteAction {...props} kind="release" />; }

/** 列表与详情共用；删除资格由服务端判断，不使用当前筛选后的列表。 */
function VersionDeleteAction({ id, code, canDelete, onDeleted, kind }: DeleteProps & { kind: keyof typeof VARIANTS }) {
  const variant = VARIANTS[kind];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const confirm = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await variant.remove(id);
      if (!result.success) { setError(result.error.message); return; }
      setOpen(false);
      await onDeleted();
    } catch {
      setError('删除结果暂未确认，请刷新原记录核对后重试。');
    } finally { submitting.current = false; setBusy(false); }
  };
  if (canDelete !== true) return null;
  return <>
    <button type="button" className="text-token-secondary hover:underline" onClick={() => { setError(''); setOpen(true); }}>删除</button>
    {open && <Dialog open onOpenChange={(value) => { if (!submitting.current) setOpen(value); }} title={`删除${variant.title} ${code}`} tone="danger"
      content={<div className="space-y-3 text-sm text-token-secondary"><p>{variant.description}</p><p>{variant.effect}</p>{error && <p role="alert">{error}</p>}</div>}
      actions={<><Button size="sm" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button size="sm" disabled={busy} onClick={() => void confirm()}>{busy ? '正在核对并删除…' : '确认删除'}</Button></>} />}
  </>;
}
