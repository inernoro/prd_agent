// Exchange：展示非标准上游适配器配置。密钥本身绝不展示，只展示 hasKey。
// 本页先做观测、认领与密钥轮换，不提供 transformer 编辑，避免误改协议适配。
import { useEffect, useState } from 'react';
import { bulkRotateApiKeys, claimExchangeToGateway, deleteExchangeApiKey, getExchanges, rotateExchangeApiKey } from '@/lib/api';
import type { ExchangeItem } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';
import { boolChip } from '@/components/poolsHelpers';

export function ExchangesPage() {
  const [items, setItems] = useState<ExchangeItem[] | null>(null);
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [keyEditId, setKeyEditId] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [bulkKeyValue, setBulkKeyValue] = useState('');
  const [bulkOnlyMissing, setBulkOnlyMissing] = useState(true);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    getExchanges({ enabled: enabledOnly ? true : undefined }).then((res) => {
      if (!alive) return;
      if (res.success) setItems(res.data.items);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, [enabledOnly]);

  async function claimExchange(item: ExchangeItem) {
    setBusyId(item.id);
    setToast(null);
    const res = await claimExchangeToGateway(item.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已将「${res.data.name}」导入平台 Exchange`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function saveApiKey(item: ExchangeItem) {
    const apiKey = keyValue.trim();
    if (!apiKey) {
      setToast('apiKey 不能为空');
      return;
    }
    setBusyId(item.id);
    setToast(null);
    const res = await rotateExchangeApiKey(item.id, apiKey);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setKeyEditId(null);
      setKeyValue('');
      setToast(`已更新「${res.data.name}」的 GW Exchange 密钥`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function clearApiKey(item: ExchangeItem) {
    if (!window.confirm(`清除「${item.name}」的 GW Exchange 密钥？`)) return;
    setBusyId(item.id);
    setToast(null);
    const res = await deleteExchangeApiKey(item.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已清除「${res.data.name}」的 GW Exchange 密钥`);
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
    const enabledText = enabledOnly ? '启用的 ' : '';
    const scope = bulkOnlyMissing ? `缺失密钥的${enabledText}GW Exchange` : `全部${enabledText}GW Exchange`;
    if (!window.confirm(`批量更新${scope}密钥？`)) return;
    setBusyId('bulk-exchange-api-key');
    setToast(null);
    const res = await bulkRotateApiKeys({
      objectType: 'exchange',
      apiKey,
      enabledOnly,
      onlyMissing: bulkOnlyMissing,
      allGwOwned: true,
    });
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (
        x.authority === 'llm_gateway' && (!bulkOnlyMissing || !x.hasKey) ? { ...x, hasKey: true } : x
      )) : prev));
      setBulkKeyValue('');
      setBulkConfirm(false);
      setToast(`批量轮换完成：匹配 ${res.data.matchedCount}，更新 ${res.data.modifiedCount}，跳过 ${res.data.skippedCount}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  if (error) return <Empty text={error} />;

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={enabledOnly} onChange={(e) => setEnabledOnly(e.target.checked)} />
          仅启用
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{items ? `${items.length} 个 Exchange` : '加载中'}</span>
      </div>
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      <div style={toolbarStyle}>
        <span style={toolbarTitleStyle}>批量维护 Exchange 密钥</span>
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
          确认应用到当前筛选 Exchange
        </label>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-exchange-api-key'} onClick={() => void applyBulkApiKey()}>
          {busyId === 'bulk-exchange-api-key' ? '处理中…' : '批量轮换密钥'}
        </Button>
      </div>
      {!items ? <SectionLoader text="正在加载 Exchange…" /> : items.length === 0 ? <Empty text="暂无 Exchange" /> : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
              <tr>
                <th style={th}>Exchange</th>
                <th style={th}>Transformer</th>
                <th style={th}>模型</th>
                <th style={th}>目标 URL</th>
                <th style={th}>配置来源</th>
                <th style={th}>状态</th>
                <th style={th}>密钥</th>
                <th style={th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => {
                const en = boolChip(x.enabled, '启用', '停用');
                const key = boolChip(x.hasKey, '已配置', '未配置');
                const modelLabels = x.models.length
                  ? x.models.filter((m) => m.enabled).slice(0, 4).map((m) => m.modelId)
                  : [x.modelAlias, ...x.modelAliases].filter(Boolean).slice(0, 4);
                return (
                  <tr key={x.id}>
                    <td style={td}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 170 }}>
                        <span style={{ fontWeight: 600 }}>{x.name || x.id}</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text-muted)', fontSize: 11 }}>{x.id}</span>
                      </div>
                    </td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
                        <Chip label={x.transformerType || 'passthrough'} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                        <Chip label={x.targetAuthScheme || 'Bearer'} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                      </span>
                    </td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
                        {modelLabels.length ? modelLabels.map((m) => <Chip key={`${x.id}:${m}`} label={m} color="var(--text-secondary)" bg="var(--bg-elevated)" />) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </span>
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: 'var(--text-secondary)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.targetUrl}>{x.targetUrl || '—'}</td>
                    <td style={td}>
                      {x.authority === 'llm_gateway' ? (
                        <Chip label="平台配置" color="#7aa2ff" bg="rgba(122,162,255,0.14)" title={x.claimedAt ? `导入于 ${x.claimedAt}` : undefined} />
                      ) : (
                        <Chip label="待导入" color="var(--text-muted)" bg="var(--bg-elevated)" />
                      )}
                    </td>
                    <td style={td}><Chip label={en.label} color={en.color} bg={en.bg} /></td>
                    <td style={td}><Chip label={key.label} color={key.color} bg={key.bg} /></td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {keyEditId === x.id ? (
                          <>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={keyValue}
                              onChange={(e) => setKeyValue(e.target.value)}
                              placeholder="apiKey"
                              style={inputStyle}
                            />
                            <Button size="sm" variant="primary" disabled={busyId === x.id} onClick={() => void saveApiKey(x)}>
                              保存
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busyId === x.id} onClick={() => { setKeyEditId(null); setKeyValue(''); }}>
                              取消
                            </Button>
                          </>
                        ) : x.authority === 'llm_gateway' ? (
                          <>
                            <Button size="sm" variant="ghost" disabled={busyId === x.id} onClick={() => { setKeyEditId(x.id); setKeyValue(''); }}>
                              更新密钥
                            </Button>
                            {x.hasKey ? (
                              <Button size="sm" variant="ghost" disabled={busyId === x.id} onClick={() => void clearApiKey(x)}>
                                清除密钥
                              </Button>
                            ) : null}
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" disabled={busyId === x.id} onClick={() => void claimExchange(x)}>
                            {busyId === x.id ? '处理中…' : '导入到平台'}
                          </Button>
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

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}
