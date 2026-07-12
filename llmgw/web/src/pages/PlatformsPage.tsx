// 平台：表格展示平台名/类型/API URL/并发/启用/密钥是否已配置。密钥本身绝不展示（只回 hasKey）。
// 启用态可就地切换：GW 权威平台写 llm_gateway，MAP 来源平台写旧集合。密钥配置不在此页暴露。
import { useEffect, useState } from 'react';
import { bulkRotateApiKeys, claimPlatformToGateway, deletePlatformApiKey, getPlatforms, rotatePlatformApiKey, setPlatformEnabled } from '@/lib/api';
import type { PlatformItem } from '@/lib/types';
import { Chip, SectionLoader, Button } from '@/components/ui';
import { boolChip } from '@/components/poolsHelpers';

export function PlatformsPage() {
  const [items, setItems] = useState<PlatformItem[] | null>(null);
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
    getPlatforms().then((res) => {
      if (!alive) return;
      if (res.success) setItems(res.data.items);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(p: PlatformItem) {
    setBusyId(p.id);
    setToast(null);
    const res = await setPlatformEnabled(p.id, !p.enabled);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === p.id ? res.data : x)) : prev));
      setToast(`已${res.data.enabled ? '启用' : '停用'}平台「${res.data.name}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function claimPlatform(p: PlatformItem) {
    setBusyId(p.id);
    setToast(null);
    const res = await claimPlatformToGateway(p.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已将「${res.data.name}」导入平台配置`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function saveApiKey(p: PlatformItem) {
    const apiKey = keyValue.trim();
    if (!apiKey) {
      setToast('apiKey 不能为空');
      return;
    }
    setBusyId(p.id);
    setToast(null);
    const res = await rotatePlatformApiKey(p.id, apiKey);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setKeyEditId(null);
      setKeyValue('');
      setToast(`已更新「${res.data.name}」的 GW 平台密钥`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function clearApiKey(p: PlatformItem) {
    if (!window.confirm(`清除「${p.name}」的 GW 平台密钥？`)) return;
    setBusyId(p.id);
    setToast(null);
    const res = await deletePlatformApiKey(p.id);
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已清除「${res.data.name}」的 GW 平台密钥`);
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
    const scope = bulkOnlyMissing ? '缺失密钥的 GW 平台' : '全部 GW 平台';
    if (!window.confirm(`批量更新${scope}密钥？`)) return;
    setBusyId('bulk-platform-api-key');
    setToast(null);
    const res = await bulkRotateApiKeys({
      objectType: 'platform',
      apiKey,
      onlyMissing: bulkOnlyMissing,
      allGwOwned: true,
    });
    setBusyId(null);
    if (res.success) {
      setItems((prev) => (prev ? prev.map((p) => (
        p.authority === 'llm_gateway' && (!bulkOnlyMissing || !p.hasKey) ? { ...p, hasKey: true } : p
      )) : prev));
      setBulkKeyValue('');
      setBulkConfirm(false);
      setToast(`批量轮换完成：匹配 ${res.data.matchedCount}，更新 ${res.data.modifiedCount}，跳过 ${res.data.skippedCount}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  if (error) return <Empty text={error} />;
  if (!items) return <SectionLoader text="正在加载平台…" />;
  if (items.length === 0) return <Empty text="暂无平台" />;

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      <div style={toolbarStyle}>
        <span style={toolbarTitleStyle}>批量维护平台密钥</span>
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
          确认应用到当前平台配置
        </label>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-platform-api-key'} onClick={() => void applyBulkApiKey()}>
          {busyId === 'bulk-platform-api-key' ? '处理中…' : '批量轮换密钥'}
        </Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
            <tr>
              <th style={th}>平台</th>
              <th style={th}>类型</th>
              <th style={th}>API URL</th>
              <th style={th}>并发</th>
              <th style={th}>配置来源</th>
              <th style={th}>状态</th>
              <th style={th}>密钥</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const en = boolChip(p.enabled, '启用', '停用');
              const key = boolChip(p.hasKey, '已配置', '未配置');
              return (
                <tr key={p.id}>
                  <td style={td}><span style={{ fontWeight: 600 }}>{p.name}</span></td>
                  <td style={td}>{p.platformType || '—'}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: 'var(--text-secondary)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.apiUrl || ''}>{p.apiUrl || '—'}</td>
                  <td style={td}>{p.maxConcurrency || '—'}</td>
                  <td style={td}>
                    {p.authority === 'llm_gateway' ? (
                      <Chip label="平台配置" color="#7aa2ff" bg="rgba(122,162,255,0.14)" title={p.claimedAt ? `导入于 ${p.claimedAt}` : undefined} />
                    ) : (
                      <Chip label="待导入" color="var(--text-muted)" bg="var(--bg-elevated)" />
                    )}
                  </td>
                  <td style={td}><Chip label={en.label} color={en.color} bg={en.bg} /></td>
                  <td style={td}><Chip label={key.label} color={key.color} bg={key.bg} /></td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {keyEditId === p.id ? (
                        <>
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={keyValue}
                            onChange={(e) => setKeyValue(e.target.value)}
                            placeholder="apiKey"
                            style={inputStyle}
                          />
                          <Button size="sm" variant="primary" disabled={busyId === p.id} onClick={() => void saveApiKey(p)}>
                            保存
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => { setKeyEditId(null); setKeyValue(''); }}>
                            取消
                          </Button>
                        </>
                      ) : (
                        <>
                          {p.authority === 'llm_gateway' ? (
                            <>
                              <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => { setKeyEditId(p.id); setKeyValue(''); }}>
                                更新密钥
                              </Button>
                              {p.hasKey ? (
                                <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void clearApiKey(p)}>
                                  清除密钥
                                </Button>
                              ) : null}
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void claimPlatform(p)}>
                              {busyId === p.id ? '处理中…' : '导入到平台'}
                            </Button>
                          )}
                          <Button size="sm" variant={p.enabled ? 'ghost' : 'primary'} disabled={busyId === p.id} onClick={() => void toggle(p)}>
                            {busyId === p.id ? '处理中…' : p.enabled ? '停用' : '启用'}
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
