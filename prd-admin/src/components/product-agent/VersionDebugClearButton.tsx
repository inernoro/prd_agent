import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { clearVersionDebugRecords, previewVersionDebugClear, type VersionDebugClearKind,
  type VersionDebugClearPreview, type VersionDebugClearResult } from '@/services/real/productAgent';

/** 临时管理员入口；用户要求移除时连同后端两条专用端点一并移除。 */
export function VersionDebugClearButton({ kind, onChanged }: { kind: VersionDebugClearKind; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const code = kind === 'internal' ? 'T' : 'V';
  return <>
    <Button size="sm" variant="danger" onClick={() => setOpen(true)}><Trash2 size={14} />调试清空{code}记录</Button>
    {open && <VersionDebugClearDialog key={kind} kind={kind} onClose={() => setOpen(false)} onChanged={onChanged} />}
  </>;
}

function VersionDebugClearDialog({ kind, onClose, onChanged }: {
  kind: VersionDebugClearKind; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<VersionDebugClearPreview | null>(null);
  const [phrase, setPhrase] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VersionDebugClearResult | null>(null);
  const submitting = useRef(false);
  const code = kind === 'internal' ? 'T' : 'V';
  useEffect(() => {
    let active = true;
    void previewVersionDebugClear(kind).then((response) => {
      if (!active) return;
      if (response.success && response.data.kind === kind) setPreview(response.data);
      else setError(response.error?.message ?? '清理范围未确认，请关闭后重试。');
    }).catch(() => { if (active) setError('清理范围读取失败，请关闭后重试。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind]);

  const clear = async () => {
    if (submitting.current || !preview || preview.recordCount === 0 || phrase.trim() !== preview.confirmPhrase || result) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const response = await clearVersionDebugRecords({ kind, token: preview.token, confirmPhrase: phrase.trim() });
      if (!response.success) { setError(response.error?.message ?? '清理未确认，请刷新核对。'); return; }
      setResult(response.data); setPhrase('');
      try { await onChanged(); } catch { setError('清理已执行，但列表刷新失败，请刷新页面核对。'); }
    } catch { setError('清理结果暂未确认，请刷新列表核对后再操作，不要重复点击。'); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <Dialog open onOpenChange={(value) => { if (!value && !submitting.current) onClose(); }}
    title={`调试清空${code}记录`} tone="danger" maxWidth={560}
    content={<div className="space-y-3 text-sm text-token-secondary" style={{ minHeight: 0, maxHeight: '65vh', overflowY: 'auto', overscrollBehavior: 'contain' }}>
      <p>这是临时调试功能。仅清空产品管理的{code}记录，包含草稿、历史导入和已申领记录；不受当前产品、人员或状态筛选影响。</p>
      <p>另一类型版本、产品、需求、功能、评审及权限不清空。旧独立版本登记与历史备份保留；编号不会回收或从头重置。</p>
      {loading && <p className="flex items-center gap-2"><MapSpinner size={14} />正在核对清理范围…</p>}
      {preview && <>
        <p>将清理：{preview.kindLabel} {preview.recordCount} 条。旧独立登记保留，可能仍显示在列表。</p>
        <p>调试模式不生成备份；全局版本记录及对应申领关联会物理删除，无法撤销，编号不回收。</p>
        {!result && <label className="block"><span className="mb-2 block">输入“{preview.confirmPhrase}”以确认</span>
          <input aria-label="清理确认语" value={phrase} disabled={busy} onChange={(event) => setPhrase(event.target.value)}
            className="w-full rounded-md border border-token-subtle bg-token-nested px-3 py-2 text-token-primary" autoComplete="off" /></label>}
      </>}
      {result && <div role="status"><p>已清理 {result.clearedCount} 条，跳过已变更记录 {result.skippedCount} 条。</p>
        {result.backupId && <p className="break-all">备份编号：{result.backupId}</p>}</div>}
      {error && <p role="alert">{error}</p>}
    </div>}
    actions={<>
      <Button size="sm" disabled={busy} onClick={onClose}>{result ? '关闭' : '取消'}</Button>
      {!result && <Button size="sm" variant="danger" disabled={busy || loading || !preview || preview.recordCount === 0 || phrase.trim() !== preview.confirmPhrase}
        onClick={() => void clear()}>{busy ? <><MapSpinner size={14} />正在清理…</> : `确认清空${code}记录`}</Button>}
    </>} />;
}
