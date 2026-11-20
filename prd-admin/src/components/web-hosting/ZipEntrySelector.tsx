import { useEffect, useId, useState } from 'react';
import { FileArchive, FileText, Search } from 'lucide-react';
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
  const [query, setQuery] = useState('');
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

  const filter = query.trim().toLowerCase();
  const visibleEntries = filter ? entries?.filter(entry => entry.path.toLowerCase().includes(filter)) : entries;
  const selectedEntry = manual ? entries?.find(entry => entry.name === choice.entryFile) : undefined;
  return <div className="flex min-w-0 flex-col gap-3 text-left">
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-token-primary">打开站点时</span>
      <select autoFocus={autoFocus} className="h-10 w-full rounded-lg border border-token-subtle bg-token-nested px-3 text-sm text-token-primary"
        value={choice.mode} onChange={event => {
        const mode = event.currentTarget.value;
        setQuery('');
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
      : entries.length === 0 ? <p role="status" className="text-xs text-token-muted">包内没有可发布的文件，请换一个 ZIP。</p>
      : <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 id={id} className="text-[13px] font-semibold text-token-primary">选择首页文件</h3>
          <span className="text-xs tabular-nums text-token-muted">{filter ? `${visibleEntries?.length} / ` : ''}{entries.length} 个文件</span>
        </div>
        <label className="flex h-9 items-center gap-2 rounded-lg border border-token-subtle bg-token-nested px-3 focus-within:border-token-default">
          <Search size={15} className="shrink-0 text-token-muted" aria-hidden />
          <input type="search" aria-label="搜索文件名或路径" placeholder="搜索文件名或路径" value={query}
            onChange={event => setQuery(event.currentTarget.value)}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-token-primary outline-none placeholder:text-token-muted" />
        </label>
        <div className="max-h-[224px] overflow-y-auto overscroll-contain rounded-lg border border-token-subtle">
          {visibleEntries?.length ? <ul aria-label="ZIP 文件列表" className="divide-y divide-token-subtle">
            {visibleEntries.map(({ name, path }) => {
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
          </ul> : <p role="status" className="px-3 py-3 text-xs text-token-muted">没找到匹配的文件，请换个关键词。</p>}
        </div>
        {selectedEntry && <p className="text-xs text-token-muted [overflow-wrap:anywhere]">已选 {selectedEntry.path}</p>}
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
