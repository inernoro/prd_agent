import { useEffect, useMemo, useState } from 'react';
import {
  createLogicalModel,
  createModelOffering,
  getExchanges,
  getLogicalModels,
  getModels,
  setLogicalModelEnabled,
  setModelOfferingEnabled,
  updateLogicalModel,
  updateModelOffering,
} from '@/lib/api';
import type {
  CreateLogicalModelRequest,
  CreateModelOfferingRequest,
  ExchangeItem,
  LogicalModelItem,
  ModelItem,
} from '@/lib/types';
import { Button, Card, Chip, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

const inputStyle: React.CSSProperties = {
  width: '100%', height: 34, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '0 10px', fontSize: 12,
};
const labelStyle: React.CSSProperties = { display: 'grid', gap: 5, fontSize: 11, color: 'var(--text-secondary)' };

export function LogicalModelsPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [items, setItems] = useState<LogicalModelItem[] | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [exchanges, setExchanges] = useState<ExchangeItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [offeringFor, setOfferingFor] = useState<string | null>(null);
  const [editingOfferingId, setEditingOfferingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<CreateLogicalModelRequest>({
    publicId: '', name: '', modelType: 'generation', capabilities: ['image_generation'],
    allowedAppCallerCodes: [], routingStrategy: 'priority', displayOrder: 100,
  });
  const [offeringDraft, setOfferingDraft] = useState<CreateModelOfferingRequest>({
    targetKind: 'model', targetId: '', priority: 100, weight: 100,
  });

  async function reload() {
    setError(null);
    const [logicalRes, modelsRes, exchangesRes] = await Promise.all([
      getLogicalModels(), getModels({ enabled: true }), getExchanges({ enabled: true }),
    ]);
    if (!logicalRes.success) {
      setError(logicalRes.error?.message || '加载逻辑模型失败');
      setItems([]);
      return;
    }
    setItems(logicalRes.data.items);
    if (modelsRes.success) setModels(modelsRes.data.items.filter((x) => x.authority === 'llm_gateway'));
    if (exchangesRes.success) setExchanges(exchangesRes.data.items.filter((x) => x.authority === 'llm_gateway'));
  }

  useEffect(() => { void reload(); }, []);

  const targets = useMemo(() => offeringDraft.targetKind === 'model'
    ? models.map((x) => ({ id: x.id, label: `${x.name || x.modelName} · ${x.modelName}` }))
    : exchanges.map((x) => ({ id: x.id, label: x.name })), [models, exchanges, offeringDraft.targetKind]);

  async function submitLogical(event: React.FormEvent) {
    event.preventDefault();
    setBusy('create-logical');
    setNotice(null);
    const request = {
      ...draft,
      publicId: draft.publicId.trim(), name: draft.name.trim(),
      capabilities: draft.capabilities.map((x) => x.trim()).filter(Boolean),
      allowedAppCallerCodes: draft.allowedAppCallerCodes.map((x) => x.trim()).filter(Boolean),
      description: draft.description?.trim() || undefined,
    };
    const res = await createLogicalModel(request);
    setBusy(null);
    if (!res.success) { setNotice(res.error?.message || '创建失败'); return; }
    setItems((prev) => [...(prev || []), res.data]);
    setDraft({ publicId: '', name: '', modelType: 'generation', capabilities: ['image_generation'], allowedAppCallerCodes: [], routingStrategy: 'priority', displayOrder: 100 });
    setCreateOpen(false);
    setNotice(`逻辑模型「${res.data.name}」已创建，请继续添加至少一个上游 Offering`);
  }

  async function submitOffering(event: React.FormEvent, logical: LogicalModelItem) {
    event.preventDefault();
    if (!offeringDraft.targetId) { setNotice('请选择上游目标'); return; }
    setBusy(`offering:${logical.id}`);
    const res = editingOfferingId
      ? await updateModelOffering(logical.id, editingOfferingId, {
          ...offeringDraft,
          maxConcurrency: offeringDraft.maxConcurrency ?? 0,
          rateLimitPerMinute: offeringDraft.rateLimitPerMinute ?? 0,
        })
      : await createModelOffering(logical.id, offeringDraft);
    setBusy(null);
    if (!res.success) { setNotice(res.error?.message || '添加 Offering 失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === logical.id
      ? { ...x, offerings: editingOfferingId ? x.offerings.map((o) => o.id === editingOfferingId ? res.data : o) : [...x.offerings, res.data] }
      : x) || null);
    setOfferingFor(null);
    setEditingOfferingId(null);
    setOfferingDraft({ targetKind: 'model', targetId: '', priority: 100, weight: 100 });
    setNotice(editingOfferingId ? `已更新「${logical.name}」的上游 ${res.data.targetName}` : `已为「${logical.name}」添加上游 ${res.data.targetName}`);
  }

  async function changeStrategy(item: LogicalModelItem, routingStrategy: 'priority' | 'weighted') {
    setBusy(`strategy:${item.id}`);
    const res = await updateLogicalModel(item.id, { routingStrategy });
    setBusy(null);
    if (!res.success) { setNotice(res.error?.message || '更新路由策略失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === item.id ? res.data : x) || null);
    setNotice(`「${item.name}」已切换为${routingStrategy === 'weighted' ? '权重负载均衡' : '优先级与故障切换'}`);
  }

  function openNewOffering(logicalId: string) {
    setOfferingFor((current) => current === logicalId && editingOfferingId === null ? null : logicalId);
    setEditingOfferingId(null);
    setOfferingDraft({ targetKind: 'model', targetId: '', priority: 100, weight: 100 });
  }

  function openOfferingEditor(logicalId: string, offering: LogicalModelItem['offerings'][number]) {
    setOfferingFor(logicalId);
    setEditingOfferingId(offering.id);
    setOfferingDraft({
      targetKind: offering.targetKind,
      targetId: offering.targetId,
      upstreamModelId: offering.upstreamModelId || undefined,
      protocol: offering.protocol || undefined,
      endpointPath: offering.endpointPath || undefined,
      priority: offering.priority,
      weight: offering.weight,
      maxConcurrency: offering.maxConcurrency || undefined,
      rateLimitPerMinute: offering.rateLimitPerMinute || undefined,
      notes: offering.notes || undefined,
    });
  }

  async function toggleLogical(item: LogicalModelItem) {
    setBusy(item.id);
    const res = await setLogicalModelEnabled(item.id, !item.enabled);
    setBusy(null);
    if (!res.success) { setNotice(res.error?.message || '操作失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === item.id ? { ...x, enabled: res.data.enabled } : x) || null);
  }

  async function toggleOffering(logical: LogicalModelItem, offeringId: string, enabled: boolean) {
    setBusy(offeringId);
    const res = await setModelOfferingEnabled(logical.id, offeringId, !enabled);
    setBusy(null);
    if (!res.success) { setNotice(res.error?.message || '操作失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === logical.id
      ? { ...x, offerings: x.offerings.map((o) => o.id === offeringId ? res.data : o) }
      : x) || null);
  }

  if (items === null) return <SectionLoader text="正在加载逻辑模型目录" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
      <Card style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 760 }}>
            <h1 style={{ margin: 0, fontSize: 17 }}>逻辑模型目录</h1>
            <p style={{ margin: '7px 0 0', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.7 }}>
              应用只选择稳定的模型标识。Provider、Endpoint、协议、密钥、限流和故障切换由其下的 Offering 维护；模型池只负责未指定模型时的默认与兜底。
            </p>
          </div>
          {canWrite ? <Button variant="primary" size="sm" onClick={() => setCreateOpen((x) => !x)}>{createOpen ? '收起' : '添加逻辑模型'}</Button> : null}
        </div>
        {createOpen && canWrite ? (
          <form onSubmit={submitLogical} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginTop: 14 }}>
            <label style={labelStyle}>公开模型标识<input required value={draft.publicId} onChange={(e) => setDraft((x) => ({ ...x, publicId: e.target.value }))} placeholder="例如 image2" style={inputStyle} /></label>
            <label style={labelStyle}>显示名称<input required value={draft.name} onChange={(e) => setDraft((x) => ({ ...x, name: e.target.value }))} placeholder="例如 GPT Image 2" style={inputStyle} /></label>
            <label style={labelStyle}>模型类型<select value={draft.modelType} onChange={(e) => setDraft((x) => ({ ...x, modelType: e.target.value }))} style={inputStyle}><option value="generation">generation</option><option value="vision">vision</option><option value="chat">chat</option><option value="video-gen">video-gen</option></select></label>
            <label style={labelStyle}>路由策略<select value={draft.routingStrategy} onChange={(e) => setDraft((x) => ({ ...x, routingStrategy: e.target.value as 'priority' | 'weighted' }))} style={inputStyle}><option value="priority">优先级与故障切换</option><option value="weighted">按权重负载均衡</option></select></label>
            <label style={labelStyle}>能力，逗号分隔<input value={draft.capabilities.join(', ')} onChange={(e) => setDraft((x) => ({ ...x, capabilities: e.target.value.split(',') }))} style={inputStyle} /></label>
            <label style={labelStyle}>允许的 appCaller，留空为租户内全部<input value={draft.allowedAppCallerCodes.join(', ')} onChange={(e) => setDraft((x) => ({ ...x, allowedAppCallerCodes: e.target.value.split(',').filter(Boolean) }))} style={inputStyle} /></label>
            <div style={{ gridColumn: '1 / -1' }}><Button type="submit" variant="primary" size="sm" disabled={busy === 'create-logical'}>{busy === 'create-logical' ? '保存中' : '保存逻辑模型'}</Button></div>
          </form>
        ) : null}
      </Card>

      {!canWrite ? <ReadOnlyNotice /> : null}
      {error || notice ? <div style={{ padding: '8px 11px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: error ? 'var(--danger)' : 'var(--text-secondary)', fontSize: 12 }}>{error || notice}</div> : null}
      {items.length === 0 ? <Card style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>尚无逻辑模型。先创建模型，再把一个或多个上游模型或 Exchange 绑定为 Offering。</Card> : null}

      {items.map((item) => (
        <Card key={item.id} style={{ padding: 14 }}>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14 }}>{item.name}</strong>
                <code style={{ fontSize: 11, color: 'var(--accent)' }}>{item.publicId}</code>
                <Chip label={item.modelType} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                <Chip label={item.routingStrategy === 'weighted' ? '权重路由' : '优先级路由'} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                <Chip label={item.enabled ? '已启用' : '已停用'} color={item.enabled ? 'var(--success)' : 'var(--text-muted)'} bg="var(--bg-elevated)" />
              </div>
              <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11 }}>{item.capabilities.join(' · ') || '未声明能力'} · {item.offerings.length} 个 Offering</div>
              <div style={{ marginTop: 3, color: 'var(--text-muted)', fontSize: 11 }}>可用 appCaller：{item.allowedAppCallerCodes.length > 0 ? item.allowedAppCallerCodes.join('、') : '当前租户全部 appCaller'}</div>
            </div>
            {canWrite ? <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <select aria-label={`${item.name} 路由策略`} value={item.routingStrategy} disabled={busy === `strategy:${item.id}`} onChange={(e) => void changeStrategy(item, e.target.value as 'priority' | 'weighted')} style={{ ...inputStyle, width: 150 }}><option value="priority">优先级与故障切换</option><option value="weighted">权重负载均衡</option></select>
              <Button size="sm" onClick={() => openNewOffering(item.id)}>添加上游</Button><Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => void toggleLogical(item)}>{item.enabled ? '停用' : '启用'}</Button>
            </div> : null}
          </div>

          {offeringFor === item.id && canWrite ? (
            <form onSubmit={(e) => submitOffering(e, item)} style={{ marginTop: 12, padding: 11, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 9 }}>
              <label style={labelStyle}>目标类型<select disabled={editingOfferingId !== null} value={offeringDraft.targetKind} onChange={(e) => setOfferingDraft((x) => ({ ...x, targetKind: e.target.value as 'model' | 'exchange', targetId: '' }))} style={inputStyle}><option value="model">Provider 模型</option><option value="exchange">Exchange</option></select></label>
              <label style={labelStyle}>上游目标<select disabled={editingOfferingId !== null} required value={offeringDraft.targetId} onChange={(e) => setOfferingDraft((x) => ({ ...x, targetId: e.target.value }))} style={inputStyle}><option value="">请选择</option>{targets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
              <label style={labelStyle}>上游模型标识，可覆盖<input value={offeringDraft.upstreamModelId || ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, upstreamModelId: e.target.value }))} style={inputStyle} /></label>
              <label style={labelStyle}>协议，可覆盖<input value={offeringDraft.protocol || ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, protocol: e.target.value }))} placeholder="openai / google / exchange" style={inputStyle} /></label>
              <label style={labelStyle}>Endpoint path，可覆盖<input value={offeringDraft.endpointPath || ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, endpointPath: e.target.value }))} placeholder="例如 v1beta/models/{model}:generateContent" style={inputStyle} /></label>
              <label style={labelStyle}>优先级<input type="number" min={0} value={offeringDraft.priority ?? 100} onChange={(e) => setOfferingDraft((x) => ({ ...x, priority: Number(e.target.value) }))} style={inputStyle} /></label>
              <label style={labelStyle}>权重<input type="number" min={1} value={offeringDraft.weight ?? 100} onChange={(e) => setOfferingDraft((x) => ({ ...x, weight: Number(e.target.value) }))} style={inputStyle} /></label>
              <label style={labelStyle}>最大并发，留空为继承<input type="number" min={1} max={10000} value={offeringDraft.maxConcurrency ?? ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, maxConcurrency: e.target.value ? Number(e.target.value) : undefined }))} style={inputStyle} /></label>
              <label style={labelStyle}>每分钟速率，留空为不限<input type="number" min={1} max={1000000} value={offeringDraft.rateLimitPerMinute ?? ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, rateLimitPerMinute: e.target.value ? Number(e.target.value) : undefined }))} style={inputStyle} /></label>
              <label style={labelStyle}>运维备注<input value={offeringDraft.notes || ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, notes: e.target.value }))} style={inputStyle} /></label>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6 }}><Button type="submit" variant="primary" size="sm" disabled={busy === `offering:${item.id}`}>{busy === `offering:${item.id}` ? '保存中' : editingOfferingId ? '保存修改' : '保存 Offering'}</Button>{editingOfferingId ? <Button type="button" size="sm" variant="ghost" onClick={() => openNewOffering(item.id)}>取消编辑</Button> : null}</div>
            </form>
          ) : null}

          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
              <thead><tr>{['上游', '目标类型', '协议', '优先级 / 权重', '健康', '治理', '操作'].map((x) => <th key={x} style={{ textAlign: 'left', padding: '7px 9px', color: 'var(--text-muted)', fontSize: 10, fontWeight: 600 }}>{x}</th>)}</tr></thead>
              <tbody>{item.offerings.length === 0 ? <tr><td colSpan={7} style={{ padding: 14, color: 'var(--text-muted)', fontSize: 12, borderTop: '1px solid var(--border-subtle)' }}>还没有可用上游，当前逻辑模型不会承接请求。</td></tr> : item.offerings.map((o) => (
                <tr key={o.id}>
                  <td style={td}><strong>{o.targetName}</strong><div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{o.providerName || o.upstreamModelId || o.targetId}</div></td>
                  <td style={td}>{o.targetKind}</td><td style={td}>{o.protocol || '继承目标'}</td><td style={td}>{o.priority} / {o.weight}</td>
                  <td style={td}>{o.healthStatus === 0 ? '健康' : o.healthStatus === 1 ? '降权' : '不可用'}{o.consecutiveFailures > 0 ? ` · 连续失败 ${o.consecutiveFailures}` : ''}</td>
                  <td style={td}>{o.maxConcurrency ? `并发 ${o.maxConcurrency}` : '继承上游'}{o.rateLimitPerMinute ? ` · ${o.rateLimitPerMinute}/分钟` : ''}</td>
                  <td style={td}>{canWrite ? <div style={{ display: 'flex', gap: 4 }}><Button size="sm" variant="ghost" onClick={() => openOfferingEditor(item.id, o)}>编辑</Button><Button size="sm" variant="ghost" disabled={busy === o.id} onClick={() => void toggleOffering(item, o.id, o.enabled)}>{o.enabled ? '停用' : '启用'}</Button></div> : (o.enabled ? '已启用' : '已停用')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

const td: React.CSSProperties = { padding: '8px 9px', borderTop: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', fontSize: 11, verticalAlign: 'middle' };
