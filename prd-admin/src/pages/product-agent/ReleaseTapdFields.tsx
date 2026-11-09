import { useState, type Dispatch, type SetStateAction } from 'react';
import { Button } from '@/components/design/Button';
import { appendReleaseTapdLinks, invalidReleaseTapdLinks, parseReleaseTapdLinks, type ReleaseTapdLink } from './releaseTapdLinks';

type Props = {
  noLinks: boolean;
  links: ReleaseTapdLink[];
  onNoLinksChange: (value: boolean) => void;
  onLinksChange: Dispatch<SetStateAction<ReleaseTapdLink[]>>;
  disabled?: boolean;
  required?: boolean;
};

export function ReleaseTapdFields({ noLinks, links, onNoLinksChange, onLinksChange, disabled, required }: Props) {
  const [pasted, setPasted] = useState('');
  const [hint, setHint] = useState('');
  function recognize(value: string) {
    const recognized = parseReleaseTapdLinks(value);
    setHint(recognized.length ? `已识别 ${recognized.length} 条 TAPD 链接，请核对。` : '未识别到 TAPD 链接，可在下方手动填写。');
    if (!recognized.length) return;
    onLinksChange((current) => appendReleaseTapdLinks(current, recognized));
  }

  return <section aria-label="TAPD 需求" className="space-y-3 border-t border-token-subtle pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-token-primary">TAPD 链接{required && !noLinks ? ' *' : ''}</h2>
      <label className="flex items-center gap-2 text-sm text-token-secondary">
        <input type="checkbox" checked={noLinks} disabled={disabled} onChange={(event) => onNoLinksChange(event.target.checked)} />
        无 TAPD 链接
      </label>
    </div>
    {!noLinks && <fieldset disabled={disabled} className="space-y-3">
      <label className="block space-y-1 text-xs text-token-secondary">
        粘贴 TAPD 链接（支持多条）
        <textarea rows={2} value={pasted} className={inputClass}
          onChange={(event) => setPasted(event.target.value)}
          onPaste={(event) => {
            const value = event.clipboardData.getData('text');
            if (!value) return;
            event.preventDefault();
            setPasted(value);
            recognize(value);
          }} />
      </label>
      <Button type="button" size="sm" disabled={!pasted.trim()} onClick={() => recognize(pasted)}>识别链接</Button>
      {hint && <p role="status" className="text-xs text-token-secondary">{hint}</p>}
      {links.map((link, index) => <div key={index} className="flex items-end gap-2">
        <label className="block min-w-0 flex-1 space-y-1 text-xs text-token-secondary">
          <span>TAPD 链接{required ? ' *' : ''}</span>
          <input type="url" value={link.url} placeholder="https://www.tapd.cn/…" className={inputClass}
            onChange={(event) => {
              const url = event.target.value;
              onLinksChange((rows) => rows.map((row, i) => i === index ? { title: '', url } : row));
            }} />
        </label>
        {links.length > 1 && <Button type="button" size="sm" onClick={() => onLinksChange((rows) => rows.filter((_, i) => i !== index))}>移除</Button>}
      </div>)}
      <Button type="button" size="sm" onClick={() => onLinksChange((rows) => [...rows, { title: '', url: '' }])}>添加链接</Button>
      {(required || links.some((link) => link.url.trim())) && invalidReleaseTapdLinks(false, links)
        && <p className="text-xs text-token-muted">请填写有效的 TAPD 链接。</p>}
    </fieldset>}
  </section>;
}

const inputClass = 'block w-full rounded-lg border border-token-subtle bg-token-nested p-2 text-sm text-token-primary';
