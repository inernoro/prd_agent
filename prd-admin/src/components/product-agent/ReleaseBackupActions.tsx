import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { exportReleaseBackup, restoreReleaseBackup, type ProductReleaseBackupFile, type ProductReleaseRestoreResult } from '@/services/real/productAgent';

export function ReleaseBackupActions({ onRestored }: { onRestored: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<ProductReleaseBackupFile | null>(null);
  const [preview, setPreview] = useState<ProductReleaseRestoreResult | null>(null);
  const [result, setResult] = useState<ProductReleaseRestoreResult | null>(null);

  const download = async () => {
    setBusy(true);
    setMessage('');
    try {
      const response = await exportReleaseBackup();
      if (!response.success) {
        setMessage(response.error?.message ?? '完整备份导出失败，请稍后重试。');
        return;
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(response.data)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `MAP-正式版本完整备份-${response.data.exportedAt.slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`已导出 ${response.data.recordCount} 条正式版本记录。`);
    } catch {
      setMessage('完整备份导出失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  const check = async (selected: File) => {
    setBusy(true); setMessage(''); setFile(null); setPreview(null); setResult(null);
    try {
      const backup = JSON.parse(await selected.text()) as ProductReleaseBackupFile;
      if (backup?.format !== 'map-formal-version-backup-v1' || typeof backup.payload !== 'string') {
        setMessage('请选择从 MAP 下载的正式版本完整备份 JSON。');
        return;
      }
      const response = await restoreReleaseBackup(backup, true);
      if (!response.success) {
        setMessage(response.error?.message ?? '备份校验失败，请重新选择文件。');
        return;
      }
      setFile(backup); setPreview(response.data);
    } catch {
      setMessage('无法读取备份，请选择未修改的 JSON 文件。');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!file || !preview?.toRestore || preview.conflicts || busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await restoreReleaseBackup(file, false);
      if (!response.success) {
        setMessage(response.error?.message ?? '恢复未完成，请重新核对备份后重试。');
        return;
      }
      setResult(response.data);
      if (response.data.restored) await onRestored();
    } catch {
      setMessage('恢复结果暂未确认。请重新选择备份核对，可使用同一文件重试。');
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Button type="button" size="sm" disabled={busy} onClick={() => void download()}><Download size={14} />导出 V 完整备份</Button>
    <Button type="button" size="sm" disabled={busy} onClick={() => {
      setFile(null); setPreview(null); setResult(null); setMessage(''); setOpen(true);
    }}><Upload size={14} />恢复 V 完整备份</Button>
    {!open && message && <span role="status" className="text-xs text-token-muted">{message}</span>}
    {open && <Dialog open onOpenChange={(value) => { if (!busy) setOpen(value); }} title="恢复 V 完整备份" maxWidth={560}
      content={<div className="space-y-3 text-sm text-token-secondary">
        <p>选择从当前环境导出的 JSON。先核对数量，确认后按原记录 ID 恢复缺失版本。</p>
        <input aria-label="正式版本完整备份文件" type="file" accept=".json,application/json" disabled={busy}
          onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void check(selected); }} />
        {preview && !result && <p role="status">备份 {preview.total} 条 · 待恢复 {preview.toRestore} 条 · 原 ID 已存在 {preview.existing} 条 · 冲突 {preview.conflicts} 条</p>}
        {preview && !result && preview.conflicts > 0 && <p role="alert">相同版本号或临时优化名称已被其他记录占用。请先处理冲突。</p>}
        {result && <p role="status">{result.conflicts
          ? `发现 ${result.conflicts} 条冲突，本次未写入。请重新核对。`
          : `已恢复 ${result.restored} 条，保留已有记录 ${result.existing} 条。`}</p>}
        {message && <p role="alert">{message}</p>}
      </div>}
      actions={<>
        <Button type="button" size="sm" disabled={busy} onClick={() => setOpen(false)}>关闭</Button>
        {!result && <Button type="button" size="sm" disabled={busy || !preview?.toRestore || Boolean(preview.conflicts)}
          onClick={() => void restore()}>{busy ? '处理中…' : '确认恢复'}</Button>}
      </>} />}
  </>;
}
