import { useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { deleteInitiation } from '@/services/real/productAgent';

/** 列表与详情共用；删除资格由服务端判断，不使用当前筛选后的列表。 */
export function InitiationDeleteAction({ id, code, canDelete, onDeleted }: { id: string; code: string; canDelete?: boolean; onDeleted: () => void | Promise<void> }) {
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
      const result = await deleteInitiation(id);
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
    {open && <Dialog open onOpenChange={(value) => { if (!submitting.current) setOpen(value); }} title={`删除内部版本 ${code}`} tone="danger"
      content={<div className="space-y-3 text-sm text-token-secondary"><p>只允许删除全局最后一条申领成功、且没有正式版本等下游关联的内部版本记录。</p><p>删除后列表不再显示，原始记录和编号占用保留，编号不会回收。</p>{error && <p role="alert">{error}</p>}</div>}
      actions={<><Button size="sm" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button size="sm" disabled={busy} onClick={() => void confirm()}>{busy ? '正在核对并删除…' : '确认删除'}</Button></>} />}
  </>;
}
