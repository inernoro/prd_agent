import { useState } from 'react';
import { ArrowLeft, ChevronDown, Settings2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import {
  getVisualModelPolicy, getVisualModelCatalog, saveVisualModelPolicy,
  type VisualModelPolicy, type VisualModelCatalogEntry,
} from '@/services/real/visualModelPolicy';
import './VisualModelSettings.css';

function ModelSizes({ entry }: { entry: VisualModelCatalogEntry }) {
  const groups = Object.entries(entry.imageCapabilities?.sizesByResolution ?? {})
    .map(([resolution, sizes]) => [resolution, sizes.filter(size => size.size?.trim())] as const)
    .filter(([, sizes]) => sizes.length > 0);
  const [resolution, setResolution] = useState(groups[0]?.[0] ?? '');
  const [expanded, setExpanded] = useState(false);
  const sizes = groups.find(([key]) => key === resolution)?.[1] ?? groups[0]?.[1] ?? [];
  return <section className="vms-detail-section" aria-label="输出尺寸">
    <h4>输出尺寸</h4>
    {groups.length ? <>
      <div className="vms-resolutions" aria-label="分辨率">
        {groups.map(([key]) => <button key={key} type="button" aria-pressed={key === resolution}
          onClick={() => setResolution(key)}>{key.toUpperCase()}</button>)}
      </div>
      <div className="vms-size-preview">{sizes.slice(0, 3).map((option, index) => <span key={`${option.size}-${index}`}>{option.size.replace(/[x×]/, ' × ')}</span>)}</div>
      <button type="button" className="vms-disclosure" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起全部尺寸与比例' : '查看全部尺寸与比例'}<ChevronDown size={14} className={expanded ? 'vms-rotated' : ''} />
      </button>
      {expanded && <div className="vms-all-sizes">{groups.map(([key, options]) => <section key={key} aria-label={`${key} 全部尺寸`}>
        <h5>{key.toUpperCase()}</h5><ul>{options.map((option, index) => <li key={`${option.size}-${index}`}><span>{option.size.replace(/[x×]/, ' × ')}</span><span>{option.aspectRatio || '—'}</span></li>)}</ul>
      </section>)}</div>}
    </> : <p className="vms-muted">目录暂未提供尺寸信息。</p>}
  </section>;
}

export function VisualModelSettings() {
  const canManage = useAuthStore(s => s.isRoot || s.permissions.includes('settings.write'));
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [policy, setPolicy] = useState<VisualModelPolicy | null>(null);
  const [catalog, setCatalog] = useState<VisualModelCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);

  const load = async () => {
    setOpen(true); setLoading(true); setError(''); setPolicy(null); setSearch(''); setMobileDetail(false);
    try {
      const [saved, discovered] = await Promise.all([getVisualModelPolicy(), getVisualModelCatalog()]);
      if (!saved.success || !discovered.success) {
        setError(saved.error?.message || discovered.error?.message || '模型配置加载失败，请重试。');
        return;
      }
      setPolicy(saved.data); setCatalog(discovered.data);
      setSelectedId(saved.data.defaultModelId || saved.data.models[0]?.modelId || discovered.data[0]?.model.code || '');
    } catch { setError('模型配置加载失败，请重试。'); }
    finally { setLoading(false); }
  };
  // 刷新只更新目录，避免管理员正在编辑的说明、顺序和默认项被覆盖。
  const refresh = async () => {
    if (!policy) { await load(); return; }
    setLoading(true); setError('');
    try {
      const result = await getVisualModelCatalog();
      if (result.success) setCatalog(result.data);
      else setError(result.error?.message || '目录刷新失败，已保留当前配置，请重试。');
    } catch { setError('目录刷新失败，已保留当前配置，请重试。'); }
    finally { setLoading(false); }
  };
  const validDefault = Boolean(policy?.defaultModelId
    && policy.models.some(model => model.modelId === policy.defaultModelId)
    && catalog.some(entry => entry.model.code === policy.defaultModelId));
  const save = async () => {
    if (!policy || !validDefault || loading || saving) return;
    setSaving(true); setError('');
    try {
      const result = await saveVisualModelPolicy(policy);
      if (!result.success) { setError(result.error?.message || '保存失败，请重试。'); return; }
      setPolicy(result.data); setOpen(false);
    } catch { setError('保存失败，请稍后重试。'); }
    finally { setSaving(false); }
  };
  const toggle = (id: string, enabled: boolean) => {
    if (!policy) return;
    const entry = catalog.find(item => item.model.code === id);
    if (enabled && !entry) return;
    setPolicy({ ...policy,
      models: enabled && entry
        ? [...policy.models, { modelId: id, displayName: entry.model.name, description: entry.model.description }]
        : policy.models.filter(model => model.modelId !== id),
      defaultModelId: !enabled && policy.defaultModelId === id ? '' : policy.defaultModelId,
    });
  };
  const move = (index: number, offset: number) => {
    if (!policy || index < 0 || index + offset < 0 || index + offset >= policy.models.length) return;
    const models = [...policy.models];
    [models[index], models[index + offset]] = [models[index + offset], models[index]];
    setPolicy({ ...policy, models });
  };
  // 已开放模型按客户侧顺序排列，失效配置也保留，便于显式移除或迁移。
  const rows = [
    ...(policy?.models ?? []).map(model => ({ id: model.modelId, name: model.displayName,
      entry: catalog.find(entry => entry.model.code === model.modelId) })),
    ...catalog.filter(entry => !policy?.models.some(model => model.modelId === entry.model.code))
      .map(entry => ({ id: entry.model.code, name: entry.model.name, entry })),
  ];
  const selected = rows.find(row => row.id === selectedId) ?? rows[0];
  const selectedModel = policy?.models.find(model => model.modelId === selected?.id);
  const selectedIndex = policy?.models.findIndex(model => model.modelId === selected?.id) ?? -1;
  const isDefault = validDefault && policy?.defaultModelId === selected?.id;
  const visibleRows = rows.filter(row => `${row.name} ${row.entry?.model.name ?? ''} ${row.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const defaultName = policy?.models.find(model => model.modelId === policy.defaultModelId)?.displayName;
  const busy = loading || saving;
  if (!canManage) return null;
  return <>
    <Button variant="secondary" size="sm" onClick={() => void load()}><Settings2 size={16} />模型设置</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }} title="视觉创作模型设置"
      description="管理客户可用模型、默认项与展示顺序" maxWidth={1120} contentClassName="visual-model-settings"
      titleAction={<Button disabled={busy} onClick={() => setOpen(false)}>关闭</Button>}
      contentStyle={{ height: 'min(816px, 92dvh)', maxHeight: '92dvh' }}
      actions={<>
        <div className="vms-summary" aria-live="polite"><span>已开放 {policy?.models.length ?? 0} 个模型</span><span title={defaultName}>默认：{validDefault ? defaultName : '待选择'}</span></div>
        <div className="vms-footer-buttons">
          <Button disabled={busy} onClick={() => void refresh()}>刷新目录</Button>
          <Button disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button variant="primary" disabled={busy || !validDefault} onClick={() => void save()}>{saving && <MapSpinner size={16} />}{saving ? '正在保存…' : '保存配置'}</Button>
        </div>
      </>}
      content={<>
        <p className="vms-notice">新增模型需手动开放；调整展示顺序不会改变默认项。</p>
        {error && <div role="alert" className="vms-alert"><span>{error}</span>{policy && <div className="vms-error-recovery">
          <span>重新加载会丢弃未保存的修改。</span><Button disabled={busy} onClick={() => void load()}>重新加载配置</Button>
        </div>}</div>}
        {policy && !validDefault && <div role="alert" className="vms-alert">
          <strong>{policy.defaultModelId ? '默认模型已不可用' : '请选择默认模型'}</strong>
          <span>{policy.defaultModelId ? '原默认模型已不可用。请选择一个已开放且可用的模型作为默认项，再保存配置。' : '先开放模型，再明确选择一个默认模型。'}</span>
        </div>}
        {loading ? <MapSectionLoader text="正在读取模型目录…" /> : policy ? <div className={`vms-split${mobileDetail ? ' vms-show-detail' : ''}`}>
          <section className="vms-list" aria-label="开放模型">
            <div className="vms-toolbar"><label className="vms-search"><input aria-label="搜索模型名称或标识" placeholder="搜索模型名称或标识" value={search} onChange={e => setSearch(e.target.value)} disabled={saving} /></label>
              <span className="vms-count">全部 {rows.length} / 开放 {policy.models.length}</span></div>
            <div className="vms-rows">
              {visibleRows.map(row => <div key={row.id} className={`vms-row${selected?.id === row.id ? ' vms-selected' : ''}`}>
                <button type="button" className="vms-row-select" aria-label={`查看 ${row.name}`} aria-pressed={selected?.id === row.id} disabled={saving}
                  onClick={() => { setSelectedId(row.id); setMobileDetail(true); }}>
                  <span className="vms-row-title">{row.name}{policy.defaultModelId === row.id && !row.entry && <span className="vms-badge">原默认</span>}{!row.entry && <span className="vms-badge vms-unavailable">不可用</span>}</span>
                  <span className="vms-code" title={row.id}>{row.id}</span>
                </button>
                <input className="vms-switch" type="checkbox" role="switch" aria-label={`开放 ${row.name}`} checked={policy.models.some(model => model.modelId === row.id)} disabled={saving}
                  onChange={e => toggle(row.id, e.target.checked)} />
              </div>)}
              {visibleRows.length === 0 && <div className="vms-empty">{rows.length ? <><p>没有匹配的模型</p><Button onClick={() => setSearch('')}>清空搜索</Button></> : <p>网关尚未提供可用生图模型，请先完成网关接入后刷新。</p>}</div>}
            </div>
            <p className="vms-list-hint">点击模型查看详情；开关仅控制客户是否可选。</p>
          </section>
          <section className="vms-detail" aria-label="模型详情">
            <button type="button" className="vms-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={16} />返回模型列表</button>
            {selected ? <>
              <div className="vms-detail-heading"><h3>模型详情</h3>{isDefault && <span className="vms-badge">当前默认</span>}</div>
              <div><h4 className="vms-model-name">{selected.name}</h4><p className="vms-code">{selected.id}</p></div>
              {!selected.entry ? <p className="vms-alert">该模型当前不可用；保留原配置用于迁移，不会自动换成其他型号。关闭左侧开关可移除失效项。</p> : <>
                <p className="vms-muted">{selected.entry.imageCapabilities?.supportsImageToImage ? '支持参考图 · 文字生成图片' : '文字生成图片'}</p>
                <ModelSizes key={selected.id} entry={selected.entry} />
              </>}
              <section className="vms-detail-section"><label className="vms-field-label" htmlFor="visual-model-name">显示名称</label>
                <input id="visual-model-name" aria-label={`${selected.id} 显示名称`} placeholder="给模型起个好记的名字" maxLength={80}
                  value={selectedModel?.displayName ?? ''} disabled={saving || !selectedModel}
                  className="w-full mt-1 rounded-md px-3 py-2 text-sm" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  onChange={e => setPolicy({ ...policy, models: policy.models.map(model => model.modelId === selected.id ? { ...model, displayName: e.target.value } : model) })} />
              </section>
              <section className="vms-detail-section"><label className="vms-field-label" htmlFor="visual-model-description">业务说明</label>
                <textarea id="visual-model-description" aria-label={`${selected.name} 业务说明`} placeholder={selectedModel ? '业务说明（可选）' : '开放模型后可编辑业务说明'} maxLength={500} rows={1}
                  value={selectedModel?.description ?? ''} disabled={saving || !selectedModel}
                  onChange={e => setPolicy({ ...policy, models: policy.models.map(model => model.modelId === selected.id ? { ...model, description: e.target.value } : model) })} />
                <p className="vms-muted">这段说明会展示在客户的模型选择器中。</p>
              </section>
              <div className="vms-order"><span>展示顺序 {selectedIndex >= 0 ? String(selectedIndex + 1).padStart(2, '0') : '未开放'}</span><div>
                <Button aria-label={`上移 ${selected.name}`} disabled={saving || selectedIndex <= 0} onClick={() => move(selectedIndex, -1)}>上移</Button>
                <Button aria-label={`下移 ${selected.name}`} disabled={saving || selectedIndex < 0 || selectedIndex === policy.models.length - 1} onClick={() => move(selectedIndex, 1)}>下移</Button>
              </div></div>
              <div className="vms-default">{isDefault ? <><span>当前默认模型</span><p>切换模型后可设为默认</p></> : <>
                <Button disabled={saving || !selectedModel || !selected.entry} onClick={() => setPolicy({ ...policy, defaultModelId: selected.id })}>设为默认模型</Button>
                {!selectedModel && <p>开放后可设为默认</p>}
              </>}</div>
            </> : <div className="vms-empty">模型详情将在这里显示。</div>}
          </section>
        </div> : <div className="vms-empty">点击“刷新目录”重新加载模型配置。</div>}
      </>} />
  </>;
}
