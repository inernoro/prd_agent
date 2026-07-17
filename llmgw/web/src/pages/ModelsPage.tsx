// 模型：先完成单个模型的 Provider 绑定、用途和费用口径，再把批量维护收进高级区。
import { useEffect, useMemo, useState } from 'react';
import { bulkRotateApiKeys, bulkUpdateModelCapabilities, claimModelToGateway, createModel, deleteModelApiKey, getModels, getParameterCapabilitiesMeta, getPlatforms, rotateModelApiKey, setModelEnabled } from '@/lib/api';
import type { CreateModelRequest, ModelCapability, ModelItem, ParameterCapabilityTemplateItem, PlatformItem } from '@/lib/types';
import { Button, Chip, SectionLoader, ReadOnlyNotice } from '@/components/ui';
import { EntityPreviewDrawer } from '@/components/EntityPreviewDrawer';
import { boolChip } from '@/components/poolsHelpers';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

export function ModelsPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [items, setItems] = useState<ModelItem[] | null>(null);
  const [platforms, setPlatforms] = useState<PlatformItem[]>([]);
  const [capabilityTemplates, setCapabilityTemplates] = useState<ParameterCapabilityTemplateItem[]>([]);
  const [platformId, setPlatformId] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [keyEditId, setKeyEditId] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [bulkKeyValue, setBulkKeyValue] = useState('');
  const [bulkOnlyMissing, setBulkOnlyMissing] = useState(true);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [capabilityText, setCapabilityText] = useState('');
  const [capabilityOnlyMissing, setCapabilityOnlyMissing] = useState(true);
  const [capabilityConfirm, setCapabilityConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createDraft, setCreateDraft] = useState<ModelDraftState>(emptyModelDraft());

  useEffect(() => {
    let alive = true;
    Promise.all([getPlatforms(), getParameterCapabilitiesMeta()]).then(([platformRes, metaRes]) => {
      if (!alive) return;
      if (platformRes.success) {
        setPlatforms(platformRes.data.items);
        const firstOwned = platformRes.data.items.find((item) => item.authority === 'llm_gateway' && item.enabled);
        if (firstOwned) setCreateDraft((value) => ({ ...value, platformId: value.platformId || firstOwned.id }));
      }
      if (metaRes.success) setCapabilityTemplates(metaRes.data.templates || []);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    getModels({ platformId: platformId || undefined, enabled: enabledOnly ? true : undefined }).then((res) => {
      if (!alive) return;
      if (res.success) {
        setItems(res.data.items);
        if (!platformId) setShowCreate(res.data.items.length === 0);
      }
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, [platformId, enabledOnly]);

  const platformById = useMemo(() => {
    const map = new Map<string, PlatformItem>();
    platforms.forEach((p) => map.set(p.id, p));
    return map;
  }, [platforms]);

  const ownedPlatforms = useMemo(
    () => platforms.filter((item) => item.authority === 'llm_gateway' && item.enabled),
    [platforms],
  );

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    const request: CreateModelRequest = {
      platformId: createDraft.platformId,
      name: createDraft.name.trim() || undefined,
      modelName: createDraft.modelName,
      protocol: createDraft.protocol,
      capabilities: createDraft.capabilities,
      apiKey: createDraft.apiKey.trim() || undefined,
      inputPricePerMillion: optionalNumber(createDraft.inputPricePerMillion),
      outputPricePerMillion: optionalNumber(createDraft.outputPricePerMillion),
      pricePerCall: optionalNumber(createDraft.pricePerCall),
      priceCurrency: createDraft.hasPricing ? createDraft.priceCurrency : undefined,
      remark: createDraft.remark.trim() || undefined,
    };
    setCreateBusy(true);
    setToast(null);
    const res = await createModel(request);
    setCreateBusy(false);
    if (!res.success) {
      setCreateDraft((value) => ({ ...value, apiKey: '' }));
      setToast(res.error?.message || '创建失败');
      return;
    }
    setItems((prev) => {
      if (!prev) return [res.data.item];
      if (platformId && platformId !== res.data.item.platformId) return prev;
      if (enabledOnly && !res.data.item.enabled) return prev;
      return [...prev, res.data.item];
    });
    setCreateDraft((value) => emptyModelDraft(value.platformId));
    setShowCreate(false);
    const poolMessage = res.data.modelsAppended > 0
      ? `已加入 ${res.data.modelsAppended} 个匹配的默认池`
      : '没有匹配用途的默认池被改动';
    setToast(`模型「${res.data.item.name || res.data.item.modelName}」已保存；${poolMessage}`);
  }

  function toggleCreateCapability(code: string) {
    setCreateDraft((value) => ({
      ...value,
      capabilities: value.capabilities.includes(code)
        ? value.capabilities.filter((item) => item !== code)
        : [...value.capabilities, code],
    }));
  }

  async function toggle(m: ModelItem) {
    setBusyId(m.id);
    setToast(null);
    const res = await setModelEnabled(m.id, !m.enabled);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === m.id ? res.data : x)) : prev));
      setToast(`已${res.data.enabled ? '启用' : '停用'}模型「${res.data.modelName || res.data.name}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function claimModel(m: ModelItem) {
    setBusyId(m.id);
    setToast(null);
    const res = await claimModelToGateway(m.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已将「${res.data.modelName || res.data.name}」导入平台模型`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function saveApiKey(m: ModelItem) {
    const apiKey = keyValue.trim();
    if (!apiKey) {
      setToast('apiKey 不能为空');
      return;
    }
    setBusyId(m.id);
    setToast(null);
    const res = await rotateModelApiKey(m.id, apiKey);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setKeyEditId(null);
      setKeyValue('');
      setToast(`已更新「${res.data.modelName || res.data.name}」的 GW 模型密钥`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function clearApiKey(m: ModelItem) {
    if (!window.confirm(`清除「${m.modelName || m.name}」的 GW 模型密钥？`)) return;
    setBusyId(m.id);
    setToast(null);
    const res = await deleteModelApiKey(m.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已清除「${res.data.modelName || res.data.name}」的 GW 模型密钥`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function applyBulkApiKey() {
    const apiKey = bulkKeyValue.trim();
    if (!apiKey) {
      setToast('apiKey 不能为空');
      return;
    }
    if (!bulkConfirm) {
      setToast('请先勾选确认范围');
      return;
    }
    const filterText = platformId ? `当前平台${enabledOnly ? '且启用' : ''}的 GW 模型` : `${enabledOnly ? '启用的 ' : ''}GW 模型`;
    const scope = bulkOnlyMissing ? `缺失密钥的${filterText}` : `全部${filterText}`;
    if (!window.confirm(`批量更新${scope}密钥？`)) return;
    setBusyId('bulk-model-api-key');
    setToast(null);
    const res = await bulkRotateApiKeys({
      objectType: 'model',
      apiKey,
      platformId: platformId || undefined,
      enabledOnly,
      onlyMissing: bulkOnlyMissing,
      allGwOwned: true,
    });
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((m) => (
        m.authority === 'llm_gateway' && (!bulkOnlyMissing || !m.hasKey) ? { ...m, hasKey: true } : m
      )) : prev));
      setBulkKeyValue('');
      setBulkConfirm(false);
      setToast(`批量轮换完成：匹配 ${res.data.matchedCount}，更新 ${res.data.modifiedCount}，跳过 ${res.data.skippedCount}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function applyBulkCapabilities() {
    const capabilities = parseCapabilities(capabilityText);
    if (capabilities.length === 0) {
      setToast('能力不能为空');
      return;
    }
    if (!platformId && !capabilityConfirm) {
      setToast('未选择平台时必须确认应用到全部平台模型');
      return;
    }
    if (!capabilityConfirm) {
      setToast('请先勾选确认范围');
      return;
    }
    const scope = platformId ? `当前平台${enabledOnly ? '且启用' : ''}的模型` : `${enabledOnly ? '启用的 ' : ''}全部平台模型`;
    if (!window.confirm(`批量维护${scope}能力？`)) return;
    setBusyId('bulk-model-capabilities');
    setToast(null);
    const res = await bulkUpdateModelCapabilities({
      platformId: platformId || undefined,
      enabledOnly,
      onlyMissing: capabilityOnlyMissing,
      allGwOwned: !platformId,
      capabilities,
    });
    setBusyId(null);
    if (res.success) {
      const fresh = await getModels({ platformId: platformId || undefined, enabled: enabledOnly ? true : undefined });
      if (fresh.success) setItems(fresh.data.items);
      setCapabilityText('');
      setCapabilityConfirm(false);
      setToast(`能力批量维护完成：匹配 ${res.data.matchedCount}，更新 ${res.data.modifiedCount}，跳过 ${res.data.skippedCount}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  function applyCapabilityTemplate(templateKey: string) {
    const template = capabilityTemplates.find((item) => item.key === templateKey);
    if (!template) return;
    const templateText = template.capabilities
      .map((capability) => capability)
      .join(', ');
    setCapabilityText((prev) => mergeCapabilityText(prev, templateText));
  }

  if (error) return <Empty text={error} />;

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <section style={createCardStyle}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 760 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>模型管理</div>
            <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
              模型是 Provider 里可以实际调用的能力。选择用途后，系统只会把它追加到匹配的默认模型池；没有匹配用途的池保持原样。
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              不填写价格时费用状态保持“未知”，不会显示成 0；CNY 与 USD 分别保存，不做无汇率相加。
            </div>
          </div>
          {canWrite && ownedPlatforms.length > 0 ? (
            <Button variant="primary" size="sm" onClick={() => setShowCreate((value) => !value)}>{showCreate ? '收起配置' : '添加模型'}</Button>
          ) : canWrite ? (
            <a href="/platforms" style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>先去添加 Provider</a>
          ) : null}
        </div>
        {showCreate && canWrite && ownedPlatforms.length > 0 ? (
          <form onSubmit={submitCreate} style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
            <label style={fieldStyle}>
              <span style={labelStyle}>Provider</span>
              <select required value={createDraft.platformId} onChange={(e) => setCreateDraft((value) => ({ ...value, platformId: e.target.value }))} style={formInputStyle}>
                {ownedPlatforms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>显示名称（可选）</span>
              <input value={createDraft.name} onChange={(e) => setCreateDraft((value) => ({ ...value, name: e.target.value }))} placeholder="例如：教程聊天模型" style={formInputStyle} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>上游模型标识</span>
              <input required value={createDraft.modelName} onChange={(e) => setCreateDraft((value) => ({ ...value, modelName: e.target.value }))} placeholder="例如：tutorial-chat" style={formInputStyle} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>调用协议</span>
              <select value={createDraft.protocol} onChange={(e) => setCreateDraft((value) => ({ ...value, protocol: e.target.value as ModelDraftState['protocol'] }))} style={formInputStyle}>
                <option value="inherit">继承 Provider</option>
                <option value="openai">OpenAI</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <fieldset style={{ gridColumn: '1 / -1', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 10, minWidth: 0 }}>
              <legend style={{ padding: '0 6px', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>模型用途（至少选一项）</legend>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 7 }}>
                {MODEL_PURPOSES.map((purpose) => (
                  <label key={purpose.code} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-secondary)' }} title={purpose.description}>
                    <input type="checkbox" checked={createDraft.capabilities.includes(purpose.code)} onChange={() => toggleCreateCapability(purpose.code)} />
                    <span><strong style={{ color: 'var(--text-primary)' }}>{purpose.label}</strong><br /><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{purpose.description}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <details style={{ gridColumn: '1 / -1' }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }}>可选：价格、模型专属密钥与备注</summary>
              <div style={{ marginTop: 9, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                <label style={checkStyle}><input type="checkbox" checked={createDraft.hasPricing} onChange={(e) => setCreateDraft((value) => ({ ...value, hasPricing: e.target.checked }))} />我知道供应方价格</label>
                {createDraft.hasPricing ? (
                  <>
                    <label style={fieldStyle}><span style={labelStyle}>币种</span><select value={createDraft.priceCurrency} onChange={(e) => setCreateDraft((value) => ({ ...value, priceCurrency: e.target.value as 'CNY' | 'USD' }))} style={formInputStyle}><option value="CNY">CNY</option><option value="USD">USD</option></select></label>
                    <label style={fieldStyle}><span style={labelStyle}>输入每百万 Token</span><input type="number" min={0} step="any" value={createDraft.inputPricePerMillion} onChange={(e) => setCreateDraft((value) => ({ ...value, inputPricePerMillion: e.target.value }))} style={formInputStyle} /></label>
                    <label style={fieldStyle}><span style={labelStyle}>输出每百万 Token</span><input type="number" min={0} step="any" value={createDraft.outputPricePerMillion} onChange={(e) => setCreateDraft((value) => ({ ...value, outputPricePerMillion: e.target.value }))} style={formInputStyle} /></label>
                    <label style={fieldStyle}><span style={labelStyle}>每次调用</span><input type="number" min={0} step="any" value={createDraft.pricePerCall} onChange={(e) => setCreateDraft((value) => ({ ...value, pricePerCall: e.target.value }))} style={formInputStyle} /></label>
                  </>
                ) : null}
                <label style={fieldStyle}><span style={labelStyle}>模型专属通讯密钥（可选）</span><input type="password" autoComplete="new-password" value={createDraft.apiKey} onChange={(e) => setCreateDraft((value) => ({ ...value, apiKey: e.target.value }))} placeholder="留空则继承 Provider" style={formInputStyle} /></label>
                <label style={fieldStyle}><span style={labelStyle}>备注（可选）</span><input value={createDraft.remark} onChange={(e) => setCreateDraft((value) => ({ ...value, remark: e.target.value }))} style={formInputStyle} /></label>
              </div>
            </details>
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Button type="submit" variant="primary" size="sm" disabled={createBusy || createDraft.capabilities.length === 0}>{createBusy ? '保存中…' : '保存并同步默认池'}</Button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>模型 key 留空时会安全继承 Provider key。</span>
            </div>
          </form>
        ) : null}
      </section>
      {!canWrite ? <ReadOnlyNotice /> : null}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select value={platformId} onChange={(e) => setPlatformId(e.target.value)} style={selectStyle}>
          <option value="">全部平台</option>
          {platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={enabledOnly} onChange={(e) => setEnabledOnly(e.target.checked)} />
          仅启用
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{items ? `${items.length} 个模型` : '加载中'}</span>
      </div>
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      {items && items.length > 0 && canWrite ? (
      <details style={{ flexShrink: 0 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', padding: '6px 2px' }}>高级：批量维护已有模型</summary>
      <div style={{ ...toolbarStyle, marginTop: 6 }}>
        <span style={toolbarTitleStyle}>批量维护模型密钥</span>
        <input
          type="password"
          autoComplete="new-password"
          value={bulkKeyValue}
          onChange={(e) => setBulkKeyValue(e.target.value)}
          placeholder="新 apiKey"
          style={inputStyle}
        />
        <label style={checkStyle}>
          <input type="checkbox" checked={bulkOnlyMissing} onChange={(e) => setBulkOnlyMissing(e.target.checked)} />
          只补缺失
        </label>
        <label style={checkStyle}>
          <input type="checkbox" checked={bulkConfirm} onChange={(e) => setBulkConfirm(e.target.checked)} />
          确认应用到当前筛选模型
        </label>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-model-api-key'} onClick={() => void applyBulkApiKey()}>
          {busyId === 'bulk-model-api-key' ? '处理中…' : '批量轮换密钥'}
        </Button>
      </div>
      <div style={toolbarStyle}>
        <span style={toolbarTitleStyle}>批量维护模型能力</span>
        <select
          value=""
          onChange={(e) => applyCapabilityTemplate(e.target.value)}
          style={{ ...selectStyle, width: 180 }}
          aria-label="参数能力模板"
          title="按 provider 模板填充字段级参数能力"
        >
          <option value="">选择模板</option>
          {capabilityTemplates.map((template) => (
            <option key={template.key} value={template.key}>{template.label}</option>
          ))}
        </select>
        <input
          value={capabilityText}
          onChange={(e) => setCapabilityText(e.target.value)}
          placeholder="vision, function_calling=false"
          style={{ ...inputStyle, flex: '1 1 260px' }}
        />
        <label style={checkStyle}>
          <input type="checkbox" checked={capabilityOnlyMissing} onChange={(e) => setCapabilityOnlyMissing(e.target.checked)} />
          只补缺失
        </label>
        <label style={checkStyle}>
          <input type="checkbox" checked={capabilityConfirm} onChange={(e) => setCapabilityConfirm(e.target.checked)} />
          确认应用到当前筛选模型
        </label>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-model-capabilities'} onClick={() => void applyBulkCapabilities()}>
          {busyId === 'bulk-model-capabilities' ? '处理中…' : '批量维护能力'}
        </Button>
      </div>
      </details>
      ) : null}
      {!items ? <SectionLoader text="正在加载模型…" /> : items.length === 0 ? <Empty text={!canWrite ? '当前租户还没有模型。请联系 Owner 或 Admin 添加。' : ownedPlatforms.length === 0 ? '还没有可用 Provider。请先添加 Provider，再回到这里添加模型。' : '还没有模型。选择上方 Provider、上游模型标识和至少一种用途即可保存。'} /> : (
        <div className="lg-config-table-shell" style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
              <tr>
                <th style={th}>模型</th>
                <th style={th}>平台</th>
                <th style={th}>协议</th>
                <th style={th}>能力</th>
                <th style={th}>价格</th>
                <th style={th}>配置来源</th>
                <th style={th}>状态</th>
                <th style={th}>密钥</th>
                <th style={th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => {
                const en = boolChip(m.enabled, '启用', '停用');
                const key = boolChip(m.hasKey, '已配置', '继承平台');
                const caps = m.capabilities.filter((c) => c.value).slice(0, 4);
                const provider = m.platformId ? platformById.get(m.platformId) : undefined;
                return (
                  <tr key={m.id}>
                    <td style={td}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 180 }}>
                        <span style={{ fontWeight: 600 }}>{m.name || m.modelName}</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text-muted)', fontSize: 11 }}>{m.modelName || m.id}</span>
                      </div>
                    </td>
                    <td style={td}>
                      {provider ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                          <span>{provider.name}</span>
                          <EntityPreviewDrawer
                            buttonLabel="查看 Provider"
                            kicker="模型关联的 Provider"
                            title={provider.name}
                            summary={`模型“${m.name || m.modelName}”会通过这条 Provider 连接访问上游。先在当前页核对协议、地址和密钥状态，不需要跳到 Provider 页面。`}
                            status={[
                              { label: provider.enabled ? 'Provider 已启用' : 'Provider 已停用', tone: provider.enabled ? 'good' : 'warning' },
                              { label: provider.hasKey ? 'Provider 密钥已配置' : 'Provider 密钥缺失', tone: provider.hasKey ? 'good' : 'warning' },
                              { label: m.hasKey ? '模型使用专属密钥' : '模型继承 Provider 密钥' },
                            ]}
                            sections={[
                              {
                                title: '上游连接',
                                fields: [
                                  { label: 'Provider 类型', value: provider.platformType || '未配置' },
                                  { label: 'API 地址', value: <code>{provider.apiUrl || '未配置'}</code> },
                                  { label: '模型上游标识', value: <code>{m.modelName || m.id}</code> },
                                  { label: '最终协议', value: m.protocol && m.protocol !== 'inherit' ? m.protocol : `继承 ${provider.platformType || 'Provider'}` },
                                ],
                              },
                              {
                                title: '运行边界',
                                description: '当前状态只说明配置是否具备调用条件；真实可用性仍由模型池健康和请求记录确认。',
                                fields: [
                                  { label: 'Provider 最大并发', value: provider.maxConcurrency ?? '未配置' },
                                  { label: '模型状态', value: m.enabled ? '已启用' : '已停用' },
                                  { label: '价格', value: formatModelPrice(m) },
                                ],
                              },
                            ]}
                          />
                        </div>
                      ) : m.platformId ? <code>{m.platformId}</code> : '—'}
                    </td>
                    <td style={td}>{m.protocol || '继承平台'}</td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
                        {caps.length ? caps.map((c) => <Chip key={`${m.id}:${c.type}`} label={c.type} color="var(--text-secondary)" bg="var(--bg-elevated)" />) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </span>
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatModelPrice(m)}</td>
                    <td style={td}>
                      {m.authority === 'llm_gateway' ? (
                        <Chip label="平台配置" color="#7aa2ff" bg="rgba(122,162,255,0.14)" title={m.claimedAt ? `导入于 ${m.claimedAt}` : undefined} />
                      ) : (
                        <Chip label="待导入" color="var(--text-muted)" bg="var(--bg-elevated)" />
                      )}
                    </td>
                    <td style={td}><Chip label={en.label} color={en.color} bg={en.bg} /></td>
                    <td style={td}><Chip label={key.label} color={key.color} bg={key.bg} /></td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {canWrite ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {keyEditId === m.id ? (
                          <>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={keyValue}
                              onChange={(e) => setKeyValue(e.target.value)}
                              placeholder="apiKey"
                              style={inputStyle}
                            />
                            <Button size="sm" variant="primary" disabled={busyId === m.id} onClick={() => void saveApiKey(m)}>
                              保存
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busyId === m.id} onClick={() => { setKeyEditId(null); setKeyValue(''); }}>
                              取消
                            </Button>
                          </>
                        ) : (
                          <>
                            {m.authority === 'llm_gateway' ? (
                              <>
                                <Button size="sm" variant="ghost" disabled={busyId === m.id} onClick={() => { setKeyEditId(m.id); setKeyValue(''); }}>
                                  更新密钥
                                </Button>
                                {m.hasKey ? (
                                  <Button size="sm" variant="ghost" disabled={busyId === m.id} onClick={() => void clearApiKey(m)}>
                                    清除密钥
                                  </Button>
                                ) : null}
                              </>
                            ) : (
                              <Button size="sm" variant="ghost" disabled={busyId === m.id} onClick={() => void claimModel(m)}>
                                {busyId === m.id ? '处理中…' : '导入到平台'}
                              </Button>
                            )}
                            <Button size="sm" variant={m.enabled ? 'ghost' : 'primary'} disabled={busyId === m.id} onClick={() => void toggle(m)}>
                              {busyId === m.id ? '处理中…' : m.enabled ? '停用' : '启用'}
                            </Button>
                          </>
                        )}
                      </span> : <span style={{ color: 'var(--text-muted)' }}>只读</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  height: 32,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 9px',
  fontSize: 12,
};

const inputStyle: React.CSSProperties = {
  width: 180,
  height: 30,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 9px',
  fontSize: 12,
};

const toolbarStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  padding: '8px 10px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius)',
};

const toolbarTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-secondary)',
};

const checkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--text-secondary)',
};

const createCardStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: 14,
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius)',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-secondary)',
};

const formInputStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  height: 34,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 9px',
  fontSize: 12,
  boxSizing: 'border-box',
};

type ModelDraftState = {
  platformId: string;
  name: string;
  modelName: string;
  protocol: 'inherit' | 'openai' | 'claude';
  capabilities: string[];
  apiKey: string;
  hasPricing: boolean;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  pricePerCall: string;
  priceCurrency: 'CNY' | 'USD';
  remark: string;
};

const MODEL_PURPOSES = [
  { code: 'chat', label: '对话', description: '聊天、推理与工具调用' },
  { code: 'intent', label: '意图识别', description: '分类、提取与判断' },
  { code: 'vision', label: '图片理解', description: '看图和视觉问答' },
  { code: 'generation', label: '图片生成', description: '文生图与图片编辑' },
  { code: 'code', label: '代码', description: '生成、补全与审查' },
  { code: 'long-context', label: '长文本', description: '长文阅读与总结' },
  { code: 'embedding', label: '向量嵌入', description: '知识库向量化' },
  { code: 'rerank', label: '重排序', description: '搜索结果重排' },
  { code: 'asr', label: '语音识别', description: '语音转文字' },
  { code: 'tts', label: '语音合成', description: '文字转语音' },
  { code: 'video-gen', label: '视频生成', description: '文字或图片生成视频' },
  { code: 'audio-gen', label: '音频生成', description: '音乐与通用音频' },
  { code: 'moderation', label: '内容审核', description: '安全与内容过滤' },
] as const;

function emptyModelDraft(platformId = ''): ModelDraftState {
  return {
    platformId,
    name: '',
    modelName: '',
    protocol: 'inherit',
    capabilities: ['chat'],
    apiKey: '',
    hasPricing: false,
    inputPricePerMillion: '',
    outputPricePerMillion: '',
    pricePerCall: '',
    priceCurrency: 'CNY',
    remark: '',
  };
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatModelPrice(model: ModelItem): string {
  const parts: string[] = [];
  if (model.inputPricePerMillion != null) parts.push(`输入 ${model.inputPricePerMillion}/百万`);
  if (model.outputPricePerMillion != null) parts.push(`输出 ${model.outputPricePerMillion}/百万`);
  if (model.pricePerCall != null) parts.push(`每次 ${model.pricePerCall}`);
  if (parts.length === 0) return '价格未知';
  return `${model.priceCurrency || '币种未知'} · ${parts.join(' · ')}`;
}

function parseCapabilities(text: string): ModelCapability[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawType, rawValue] = part.split('=');
      const type = rawType.trim();
      if (!/^[a-zA-Z0-9_.:-]+$/.test(type)) return null;
      return {
        type,
        source: 'user',
        value: rawValue === undefined ? true : parseCapabilityBool(rawValue),
      };
    })
    .filter((x): x is ModelCapability => x !== null);
}

function parseCapabilityBool(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off';
}

function mergeCapabilityText(current: string, incoming: string) {
  const parts = [...current.split(','), ...incoming.split(',')]
    .map((part) => part.trim())
    .filter(Boolean);
  const byName = new Map<string, string>();
  for (const part of parts) {
    const [rawName] = part.split('=');
    const name = rawName.trim().replace(/^parameter:/, '').toLowerCase();
    if (name) byName.set(name, part);
  }
  return Array.from(byName.values()).sort((a, b) => a.localeCompare(b)).join(', ');
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}
