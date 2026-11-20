import { useEffect, useId, useState } from 'react';
import { FileArchive, FileText } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { readZipEntryOptions } from './zipEntryOptions';
import { fmtSize } from './siteFormat';

export type ZipEntryChoice = { mode: 'auto' | 'directory' } | { mode: 'manual'; entryFile: string };

export function getZipEntryFile(choice: ZipEntryChoice): string | undefined {
  if (choice.mode === 'manual') return choice.entryFile;
  if (choice.mode === 'directory') return '';
  return undefined;
}

export function ZipEntrySelector({ file, choice, onChange, autoFocus }: {
  file: File;
  choice: ZipEntryChoice;
  onChange: (choice: ZipEntryChoice) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
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

  const pages = entries?.filter(entry => entry.selectable);
  const resources = entries?.filter(entry => !entry.selectable);
  return <div className="flex min-w-0 flex-col gap-3 text-left">
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-token-primary">打开站点时</span>
      <select autoFocus={autoFocus} className="h-10 w-full rounded-lg border border-token-subtle bg-token-nested px-3 text-sm text-token-primary"
        value={choice.mode} onChange={event => {
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
      : <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-1.5">
        <h3 id={id} className="text-[13px] font-semibold text-token-primary">首页文件</h3>
        <p className="text-xs text-token-muted">{pages?.length
          ? '选择一份 HTML 或 Markdown 作为首页。' : '包内没有可作首页的文件，请选择文件目录。'}</p>
        <div className="max-h-[224px] overflow-y-auto overscroll-contain rounded-lg border border-token-subtle">
          {!!pages?.length && <ul className="divide-y divide-token-subtle">
            {pages.map(({ name, path }) => {
              const selected = choice.entryFile === name;
              return <li key={name}>
                <label className={`flex min-h-10 cursor-pointer items-center gap-2.5 px-3 py-2 ${selected ? 'bg-token-nested' : 'hover-bg-soft'}`}>
                  <input type="radio" name={id} checked={selected} className="h-4 w-4 shrink-0"
                    style={{ accentColor: 'var(--accent-primary)' }} onChange={() => onChange({ mode: 'manual', entryFile: name })} />
                  <FileText size={15} className="shrink-0 text-token-muted" aria-hidden />
                  <span className="min-w-0 text-[13px] font-medium leading-5 text-token-primary [overflow-wrap:anywhere]">{path}</span>
                </label>
              </li>;
            })}
          </ul>}
          {!!resources?.length && <div className="border-t border-token-subtle px-3 py-2">
            <h4 className="mb-1 text-xs font-medium text-token-secondary">其他文件（{resources.length}）</h4>
            <ul className="space-y-1" aria-label="其他文件">
              {resources.map(({ name, path }) => <li key={name} className="text-xs leading-[18px] text-token-muted [overflow-wrap:anywhere]">{path}</li>)}
            </ul>
          </div>}
        </div>
      </div>)}
  </div>;
}

export function QuickZipUploadOptions({ file, onUpload, onCancel }: {
  file: File;
  onUpload: (entryFile?: string) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<ZipEntryChoice>({ mode: 'auto' });
  return <div className="min-w-0">
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex min-w-0 items-center gap-3 rounded-lg border border-token-subtle bg-token-nested px-3 py-2.5">
        <FileArchive size={21} className="shrink-0 text-token-secondary" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-token-primary [overflow-wrap:anywhere]">{file.name}</p>
          <p className="text-xs text-token-muted">{fmtSize(file.size)}</p>
        </div>
      </div>
      <ZipEntrySelector file={file} choice={choice} onChange={setChoice} autoFocus />
    </div>
    <div className="flex justify-end gap-2 border-t border-token-subtle px-4 py-3">
      <Button size="sm" variant="ghost" className="!h-9" onClick={onCancel}>取消</Button>
      <Button size="sm" variant="primary" className="!h-9" disabled={choice.mode === 'manual' && !choice.entryFile}
        onClick={() => onUpload(getZipEntryFile(choice))}>开始上传</Button>
    </div>
  </div>;
}
