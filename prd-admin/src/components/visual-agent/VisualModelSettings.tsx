import { useState } from 'react';
import { Settings2, ArrowUp, ArrowDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import {
  getVisualModelPolicy, getVisualModelCatalog, saveVisualModelPolicy,
  type VisualModelPolicy, type VisualModelCatalogEntry,
} from '@/services/real/visualModelPolicy';

export function VisualModelSettings() {
  const canManage = useAuthStore(s => s.isRoot || s.permissions.includes('settings.write'));
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [policy, setPolicy] = useState<VisualModelPolicy | null>(null);
  const [catalog, setCatalog] = useState<VisualModelCatalogEntry[]>([]);

  const load = async () => {
    setOpen(true); setLoading(true); setError(''); setPolicy(null);
    try {
      const [saved, discovered] = await Promise.all([getVisualModelPolicy(), getVisualModelCatalog()]);
      if (!saved.success || !discovered.success) {
        setError(saved.error?.message || discovered.error?.message || '模型配置加载失败，请重试。');
        return;
      }
      setPolicy(saved.data); setCatalog(discovered.data);
    } catch { setError('模型配置加载失败，请重试。'); }
    finally { setLoading(false); }
  };
  const save = async () => {
    if (!policy) return;
    setSaving(true); setError('');
    try {
      const result = await saveVisualModelPolicy(policy);
      if (!result.success) { setError(result.error?.message || '保存失败，请重试。'); return; }
      setPolicy(result.data); setOpen(false);
    } catch { setError('保存失败，请稍后重试。'); }
    finally { setSaving(false); }
  };
  const move = (index: number, offset: number) => {
    if (!policy) return;
    const models = [...policy.models];
    [models[index], models[index + offset]] = [models[index + offset], models[index]];
    setPolicy({ ...policy, models });
  };
  if (!canManage) return null;
  return <>
    <Button variant="secondary" size="sm" onClick={() => void load()}><Settings2 size={16} />模型设置</Button>
    <Dialog open={open} onOpenChange={value => { if (!saving) setOpen(value); }} title="视觉创作模型设置"
      description="选择开放模型及默认项"
      maxWidth={680} contentStyle={{ maxHeight: '85dvh' }} content={<div className="space-y-5" style={{ color: 'var(--text-primary)' }}>
        <p className="text-sm whitespace-normal break-words" style={{ color: 'var(--text-secondary)' }}>决定客户可选的模型和默认项。网关新增模型不会自动开放，调整顺序不会改变默认项。</p>
        {error && <div role="alert" className="rounded-lg p-3 text-sm" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>{error}</div>}
        {loading ? <MapSectionLoader text="正在读取模型目录…" /> : policy ? <>
          <section className="space-y-2" aria-label="开放模型">
            <h3 className="text-sm font-semibold">开放模型</h3>
            {catalog.length === 0 && <p className="text-sm">网关尚未提供可用生图模型，请先完成网关接入后刷新。</p>}
            {catalog.map(({ model, imageCapabilities }) => <label key={model.code}
              className="flex items-start gap-3 rounded-lg p-3" style={{ border: '1px solid var(--border-default)' }}>
              <input type="checkbox" className="mt-1" aria-label={`开放 ${model.name}`}
                checked={policy.models.some(x => x.modelId === model.code)}
                onChange={e => setPolicy({ ...policy, models: e.target.checked
                  ? [...policy.models, { modelId: model.code, displayName: model.name, description: model.description }]
                  : policy.models.filter(x => x.modelId !== model.code),
                  defaultModelId: !e.target.checked && policy.defaultModelId === model.code ? '' : policy.defaultModelId,
                })} />
              <span className="min-w-0"><span className="font-medium">{model.name}</span>
                <span className="block text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {imageCapabilities?.supportsImageToImage ? '支持参考图' : '文生图'} · {model.code}
                </span></span>
            </label>)}
          </section>
          <section className="space-y-3" aria-label="默认模型与展示顺序">
            <h3 className="text-sm font-semibold">默认模型与展示顺序</h3>
            {policy.models.length === 0 && <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>先开放模型，再明确选择一个默认模型。</p>}
            {policy.models.map((model, index) => <div key={model.modelId} className="rounded-lg p-3 space-y-2" style={{ background: 'var(--bg-secondary)' }}>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <input type="radio" name="visual-default-model" aria-label={`默认使用 ${model.displayName}`}
                    checked={policy.defaultModelId === model.modelId} onChange={() => setPolicy({ ...policy, defaultModelId: model.modelId })} />
                  <span className="truncate">{model.displayName}</span>
                  {policy.defaultModelId === model.modelId && <span className="shrink-0 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>默认</span>}
                </label>
                <div className="flex shrink-0 justify-end gap-2">
                <Button size="xs" variant="secondary" aria-label={`上移 ${model.displayName}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></Button>
                <Button size="xs" variant="secondary" aria-label={`下移 ${model.displayName}`} disabled={index === policy.models.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></Button>
                <Button size="xs" variant="secondary" onClick={() => setPolicy({ ...policy, models: policy.models.filter(x => x.modelId !== model.modelId), defaultModelId: policy.defaultModelId === model.modelId ? '' : policy.defaultModelId })}>移除</Button>
                </div>
              </div>
              <input aria-label={`${model.displayName} 业务说明`} placeholder="业务说明（可选）" maxLength={500} value={model.description || ''}
                className="w-full rounded-md px-3 py-2 text-sm" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)' }}
                onChange={e => setPolicy({ ...policy, models: policy.models.map(x => x.modelId === model.modelId ? { ...x, description: e.target.value } : x) })} />
              {!catalog.some(x => x.model.code === model.modelId) && <p className="text-xs">该模型当前不可用；保留原配置，不会自动换成其他型号。</p>}
            </div>)}
          </section>
        </> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={loading || saving} onClick={() => void load()}>刷新目录</Button>
          <Button disabled={loading || saving || !policy?.defaultModelId} onClick={() => void save()}>{saving && <Loader2 size={16} className="animate-spin" />}{saving ? '正在保存…' : '保存模型配置'}</Button>
        </div>
      </div>} />
  </>;
}
