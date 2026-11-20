import { useEffect, useState } from 'react';
import { Button } from '@/components/design/Button';
import { readZipEntryOptions } from './zipEntryOptions';

export type ZipEntryChoice = { mode: 'auto' | 'directory' } | { mode: 'manual'; entryFile: string };

export function getZipEntryFile(choice: ZipEntryChoice): string | undefined {
  if (choice.mode === 'manual') return choice.entryFile;
  if (choice.mode === 'directory') return '';
  return undefined;
}

export function ZipEntrySelector({ file, choice, onChange }: {
  file: File;
  choice: ZipEntryChoice;
  onChange: (choice: ZipEntryChoice) => void;
}) {
  const manual = choice.mode === 'manual';
  const [inspection, setInspection] = useState<{
    file: File;
    entries: Awaited<ReturnType<typeof readZipEntryOptions>> | null;
  }>();
  const inspectedFile = inspection?.file;
  const entries = inspection?.file === file ? inspection.entries : undefined;

  useEffect(() => {
    if (!manual || inspectedFile === file) return;
    let current = true;
    void readZipEntryOptions(file).then(
      entries => { if (current) setInspection({ file, entries }); },
      () => { if (current) setInspection({ file, entries: null }); },
    );
    return () => { current = false; };
  }, [file, manual, inspectedFile]);

  const field = 'w-full min-w-0 rounded-lg border border-token-subtle bg-token-nested px-2 py-1.5 text-sm text-token-primary';
  return <div className="flex min-w-0 flex-col gap-2 text-left">
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-token-secondary">打开站点时</span>
      <select className={field} value={choice.mode} onChange={event => {
        const mode = event.currentTarget.value;
        onChange(mode === 'manual' ? { mode, entryFile: '' } : { mode: mode === 'directory' ? 'directory' : 'auto' });
      }}>
        <option value="auto">系统查找</option>
        <option value="directory">文件目录</option>
        <option value="manual">手动选择</option>
      </select>
    </label>
    {choice.mode === 'auto' && <span className="text-xs text-token-muted">找不到 HTML 首页时，打开文件目录。</span>}
    {manual && (entries === undefined ? <p role="status" className="text-xs text-token-muted">正在读取 ZIP 文件列表…</p>
      : entries === null ? <p role="alert" className="text-xs text-token-secondary">无法读取文件列表。请重新选择 ZIP，或改用系统查找。</p>
      : <div className="flex min-w-0 flex-col gap-1">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-token-secondary">首页文件</span>
          <select className={field} size={Math.max(2, Math.min(5, entries.length + 1))} value={choice.entryFile}
            onChange={event => onChange({ mode: 'manual', entryFile: event.currentTarget.value })}>
            <option value="" disabled>选择首页文件</option>
            {entries.map(({ name, path, selectable }) => <option key={name} value={name} disabled={!selectable} title={path}>{path}</option>)}
          </select>
        </label>
        <span className="text-xs text-token-muted">{entries.some(entry => entry.selectable)
          ? '可选 HTML 或 Markdown 文件。' : '包内没有可作首页的文件，请选择文件目录。'}</span>
      </div>)}
  </div>;
}

export function QuickZipUploadOptions({ file, onUpload, onCancel }: {
  file: File;
  onUpload: (entryFile?: string) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<ZipEntryChoice>({ mode: 'auto' });
  return <div className="flex w-full min-w-0 flex-col gap-2 p-1.5">
    <p className="truncate text-xs font-medium text-token-primary" title={file.name}>{file.name}</p>
    <ZipEntrySelector file={file} choice={choice} onChange={setChoice} />
    <div className="flex justify-end gap-1.5">
      <Button size="xs" variant="ghost" onClick={onCancel}>取消</Button>
      <Button size="xs" disabled={choice.mode === 'manual' && !choice.entryFile}
        onClick={() => onUpload(getZipEntryFile(choice))}>开始上传</Button>
    </div>
  </div>;
}
