// 模型：展示模型名、协议、所属平台、能力标记、启用态、密钥状态与 GW 权威来源。
// 启用态可就地切换；GW 权威模型写 llm_gateway，MAP 来源模型写旧集合。密钥配置不在此页暴露。
import { useEffect, useMemo, useState } from 'react';
import { bulkRotateApiKeys, bulkUpdateModelCapabilities, claimModelToGateway, deleteModelApiKey, getModels, getParameterCapabilitiesMeta, getPlatforms, rotateModelApiKey, setModelEnabled } from '@/lib/api';
import type { ModelCapability, ModelItem, ParameterCapabilityTemplateItem, PlatformItem } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';
import { boolChip } from '@/components/poolsHelpers';

export function ModelsPage() {
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

  useEffect(() => {
    let alive = true;
    Promise.all([getPlatforms(), getParameterCapabilitiesMeta()]).then(([platformRes, metaRes]) => {
      if (!alive) return;
      if (platformRes.success) setPlatforms(platformRes.data.items);
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
      if (res.success) setItems(res.data.items);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, [platformId, enabledOnly]);

  const platformName = useMemo(() => {
    const map = new Map<string, string>();
    platforms.forEach((p) => map.set(p.id, p.name));
    return map;
  }, [platforms]);

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
      <div style={toolbarStyle}>
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
      {!items ? <SectionLoader text="正在加载模型…" /> : items.length === 0 ? <Empty text="暂无模型" /> : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
              <tr>
                <th style={th}>模型</th>
                <th style={th}>平台</th>
                <th style={th}>协议</th>
                <th style={th}>能力</th>
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
                return (
                  <tr key={m.id}>
                    <td style={td}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 180 }}>
                        <span style={{ fontWeight: 600 }}>{m.name || m.modelName}</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text-muted)', fontSize: 11 }}>{m.modelName || m.id}</span>
                      </div>
                    </td>
                    <td style={td}>{m.platformId ? (platformName.get(m.platformId) || m.platformId) : '—'}</td>
                    <td style={td}>{m.protocol || '继承平台'}</td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
                        {caps.length ? caps.map((c) => <Chip key={`${m.id}:${c.type}`} label={c.type} color="var(--text-secondary)" bg="var(--bg-elevated)" />) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </span>
                    </td>
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
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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
                      </span>
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
