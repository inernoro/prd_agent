import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import type { ApiResponse } from '@/types/api';
import type { LogicalModelOption } from '@/services/contracts/modelReferences';

const EMPTY_SELECTION: string[] = [];

/** 只选择授权目录中的逻辑身份；目录失败或引用失效时不替用户选型号。 */
export function LogicalModelPickerDialog({
  open, onOpenChange, loadOptions, selectedModelIds = EMPTY_SELECTION,
  onConfirm, single = false, zIndex, title = '选择模型', description, confirmText = '确认选择',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadOptions: () => Promise<ApiResponse<{ items: LogicalModelOption[] }>>;
  selectedModelIds?: string[];
  onConfirm: (models: LogicalModelOption[]) => void | Promise<void>;
  single?: boolean;
  zIndex?: number;
  title?: string;
  description?: string;
  confirmText?: string;
}) {
  const [options, setOptions] = useState<LogicalModelOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [reload, setReload] = useState(0);
  const selectionKey = JSON.stringify(selectedModelIds);

  useEffect(() => {
    if (!open) return;
    setSelected(JSON.parse(selectionKey) as string[]);
    setSearch('');
  }, [open, selectionKey]);

  useEffect(() => {
    let active = true;
    if (!open) return;
    setLoading(true); setError(null);
    void loadOptions().then(result => {
      if (!active) return;
      if (!result.success) throw new Error('目录未读取');
      setOptions(result.data.items);
    }).catch(() => {
      if (active) setError('模型目录暂未读取成功，请重试。现有选择已保留。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, loadOptions, reload]);

  const chosen = selected.map(id => options.find(option => option.logicalModelId === id));
  const canConfirm = !loading && !saving && !error && selected.length > 0 && chosen.every(option => option?.available === true);
  const visible = options.filter(option => `${option.name} ${option.publicId}`.toLowerCase().includes(search.trim().toLowerCase()));

  async function save() {
    if (!canConfirm) return;
    setSaving(true); setError(null);
    try {
      await onConfirm(chosen.filter((option): option is LogicalModelOption => !!option));
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '选择未保存，请重试。');
    } finally { setSaving(false); }
  }

  return <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }} title={title}
    description={description ?? '选择应用已获授权的模型。更换上游线路不会改变这里保存的模型身份。'}
    maxWidth={640} zIndex={zIndex} contentStyle={{ maxHeight: '80vh' }}
    content={<div className="flex flex-col gap-3" style={{ minHeight: 0 }}>
      <input aria-label="搜索模型" className="prd-field rounded-md px-3 py-2 text-sm" placeholder="搜索名称或公开标识" value={search} onChange={event => setSearch(event.target.value)} />
      {loading ? <MapSectionLoader text="正在读取模型目录" /> : null}
      {error ? <div role="alert" className="text-sm" style={{ color: 'var(--semantic-danger-text)' }}>{error}<Button size="sm" variant="ghost" disabled={saving} onClick={() => setReload(value => value + 1)}>重新读取</Button></div> : null}
      {!loading && !error && !options.length ? <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>当前没有已授权模型，请在模型网关为此应用配置可用模型后重新读取。</p> : null}
      <div className="flex flex-col gap-2" style={{ minHeight: 0, maxHeight: '45vh', overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {visible.map(option => <label key={option.logicalModelId} className="flex items-start gap-3 rounded-md p-3 bg-token-nested" style={{ border: '1px solid var(--border-subtle)' }}>
          <input type={single ? 'radio' : 'checkbox'} name="logical-model-choice" aria-label={`选择模型 ${option.name} ${option.publicId}`} checked={selected.includes(option.logicalModelId)} disabled={loading || saving || (!option.available && !selected.includes(option.logicalModelId))}
            onChange={event => setSelected(previous => single ? [option.logicalModelId] : event.target.checked ? [...previous, option.logicalModelId] : previous.filter(id => id !== option.logicalModelId))} />
          <span className="min-w-0 flex-1"><strong className="block text-sm" style={{ color: 'var(--text-primary)' }}>{option.name}</strong><span className="block text-xs font-mono" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{option.publicId}</span>
            {!option.available ? <span className="block text-xs mt-1" style={{ color: 'var(--semantic-danger-text)' }}>{option.reason || '当前不可用，请先修复模型配置。'}</span> : null}</span>
        </label>)}
        {!loading && !error ? selected.filter(id => !options.some(option => option.logicalModelId === id)).map(id => <div key={id} role="status" className="text-sm" style={{ color: 'var(--semantic-danger-text)' }}>原选择已不在当前授权目录中，请明确选择替代模型。{!single ? <Button size="sm" variant="ghost" onClick={() => setSelected(previous => previous.filter(value => value !== id))}>移除此选择</Button> : null}</div>) : null}
      </div>
      {!loading && !error && options.length > 0 && visible.length === 0 ? <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>没有匹配模型，请调整搜索。</span> : null}
    </div>}
    actions={<><Button variant="secondary" size="sm" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button><Button variant="primary" size="sm" disabled={!canConfirm} onClick={() => void save()}>{saving ? <MapSpinner size={14} /> : null}{confirmText}</Button></>} />;
}
