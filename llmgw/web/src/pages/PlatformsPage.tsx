// Provider（模型供应方）：先完成单个 Provider 的可理解自助配置，再把批量维护收进高级区。
// 密钥明文只随创建/轮换请求发送，列表永远只展示 hasKey。
import { useEffect, useState } from 'react';
import { bulkRotateApiKeys, claimPlatformToGateway, createPlatform, deletePlatformApiKey, getPlatforms, rotatePlatformApiKey, setPlatformEnabled } from '@/lib/api';
import type { CreatePlatformRequest, PlatformItem } from '@/lib/types';
import { Chip, SectionLoader, Button, ReadOnlyNotice } from '@/components/ui';
import { EntityPreviewDrawer } from '@/components/EntityPreviewDrawer';
import { boolChip } from '@/components/poolsHelpers';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

export function PlatformsPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [items, setItems] = useState<PlatformItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [keyEditId, setKeyEditId] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [bulkKeyValue, setBulkKeyValue] = useState('');
  const [bulkOnlyMissing, setBulkOnlyMissing] = useState(true);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [draft, setDraft] = useState<CreatePlatformRequest>({
    name: '',
    platformType: 'openai',
    apiUrl: '',
    apiKey: '',
    maxConcurrency: 20,
  });

  useEffect(() => {
    let alive = true;
    getPlatforms().then((res) => {
      if (!alive) return;
      if (res.success) {
        setItems(res.data.items);
        setShowCreate(res.data.items.length === 0);
      }
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, []);

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreateBusy(true);
    setToast(null);
    const res = await createPlatform(draft);
    setCreateBusy(false);
    if (!res.success) {
      setDraft((value) => ({ ...value, apiKey: '' }));
      setToast(res.error?.message || '创建失败');
      return;
    }
    setItems((prev) => [...(prev || []), res.data]);
    setDraft({ name: '', platformType: 'openai', apiUrl: '', apiKey: '', maxConcurrency: 20 });
    setShowCreate(false);
    setToast(`Provider「${res.data.name}」已保存，通讯密钥已加密，可继续添加模型`);
  }

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

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle' };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <section style={createCardStyle}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 720 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Provider（模型供应方）</div>
            <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
              Provider 告诉网关“去哪里调用模型”。这里保存的是供应方地址和供应方通讯密钥；它不是给业务应用使用的 <code>gwk_</code> 接入密钥。
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              第一步添加 Provider，第二步到“模型管理”添加具体模型，第三步再生成应用接入 key。
            </div>
          </div>
          {canWrite ? <Button variant="primary" size="sm" onClick={() => setShowCreate((value) => !value)}>
            {showCreate ? '收起配置' : '添加 Provider'}
          </Button> : null}
        </div>
        {showCreate && canWrite ? (
          <form onSubmit={submitCreate} style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
            <label style={fieldStyle}>
              <span style={labelStyle}>名称</span>
              <input required value={draft.name} onChange={(e) => setDraft((value) => ({ ...value, name: e.target.value }))} placeholder="例如：教程假上游" style={formInputStyle} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>接口类型</span>
              <select value={draft.platformType} onChange={(e) => setDraft((value) => ({ ...value, platformType: e.target.value as CreatePlatformRequest['platformType'] }))} style={formInputStyle}>
                <option value="openai">OpenAI 兼容</option>
                <option value="claude">Claude 兼容</option>
              </select>
            </label>
            <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
              <span style={labelStyle}>API 地址</span>
              <input required type="url" value={draft.apiUrl} onChange={(e) => setDraft((value) => ({ ...value, apiUrl: e.target.value }))} placeholder="https://provider.example.com/v1" style={formInputStyle} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Provider 通讯密钥</span>
              <input required type="password" autoComplete="new-password" value={draft.apiKey} onChange={(e) => setDraft((value) => ({ ...value, apiKey: e.target.value }))} placeholder="必填，只保存加密结果" style={formInputStyle} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>最大并发</span>
              <input required type="number" min={1} max={10000} value={draft.maxConcurrency ?? 20} onChange={(e) => setDraft((value) => ({ ...value, maxConcurrency: Number(e.target.value) }))} style={formInputStyle} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>供应方标识（可选）</span>
              <input value={draft.providerId || ''} onChange={(e) => setDraft((value) => ({ ...value, providerId: e.target.value }))} placeholder="用于费用或日志归类" style={formInputStyle} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>备注（可选）</span>
              <input value={draft.remark || ''} onChange={(e) => setDraft((value) => ({ ...value, remark: e.target.value }))} placeholder="例如：仅供教程测试" style={formInputStyle} />
            </label>
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Button type="submit" variant="primary" size="sm" disabled={createBusy}>{createBusy ? '保存中…' : '保存并继续添加模型'}</Button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>保存后列表只显示“已配置”，不会回显密钥。</span>
            </div>
          </form>
        ) : null}
      </section>
      {!canWrite ? <ReadOnlyNotice /> : null}
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      {items.length > 0 && canWrite ? (
        <details style={{ flexShrink: 0 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', padding: '6px 2px' }}>高级：批量轮换已有 Provider 密钥</summary>
          <div style={toolbarStyle}>
            <span style={toolbarTitleStyle}>批量维护 Provider 密钥</span>
            <input type="password" autoComplete="new-password" value={bulkKeyValue} onChange={(e) => setBulkKeyValue(e.target.value)} placeholder="新 apiKey" style={inputStyle} />
            <label style={checkStyle}><input type="checkbox" checked={bulkOnlyMissing} onChange={(e) => setBulkOnlyMissing(e.target.checked)} />只补缺失</label>
            <label style={checkStyle}><input type="checkbox" checked={bulkConfirm} onChange={(e) => setBulkConfirm(e.target.checked)} />确认应用到当前 Provider</label>
            <Button size="sm" variant="ghost" disabled={busyId === 'bulk-platform-api-key'} onClick={() => void applyBulkApiKey()}>
              {busyId === 'bulk-platform-api-key' ? '处理中…' : '批量轮换密钥'}
            </Button>
          </div>
        </details>
      ) : null}
      {items.length === 0 ? (
        <Empty text={canWrite ? '还没有 Provider。请填写上方 4 个必填项，保存后再去添加第一个模型。' : '当前租户还没有 Provider。请联系 Owner 或 Admin 添加。'} />
      ) : (
      <div className="lg-config-table-shell" style={{ flex: 1, minHeight: 160, overflow: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
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
                  <td style={td}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      <EntityPreviewDrawer
                        buttonLabel="查看接口"
                        kicker="Provider 接口预览"
                        title={p.name}
                        summary="从当前页确认网关会把模型请求发往哪里、采用哪种兼容协议，以及这条上游连接是否具备通讯密钥。预览本身不会访问供应方。"
                        status={[
                          { label: p.enabled ? '已启用' : '已停用', tone: p.enabled ? 'good' : 'warning' },
                          { label: p.hasKey ? '通讯密钥已配置' : '通讯密钥缺失', tone: p.hasKey ? 'good' : 'warning' },
                        ]}
                        sections={[
                          {
                            title: '连接方式',
                            fields: [
                              { label: '接口类型', value: platformTypeLabel(p.platformType) },
                              { label: 'API 地址', value: <code>{p.apiUrl || '未配置'}</code>, hint: '这是供应方地址，不是业务应用调用 Gateway 的地址。' },
                              { label: '供应方标识', value: p.providerId || '未单独设置' },
                              { label: '最大并发', value: p.maxConcurrency ?? '未配置' },
                            ],
                          },
                          {
                            title: '平台归属',
                            description: '配置来源决定这条 Provider 是否可在当前控制台直接维护。',
                            fields: [
                              { label: '配置来源', value: p.authority === 'llm_gateway' ? 'Gateway 权威配置' : '旧 MAP 配置，需先导入' },
                              { label: '备注', value: p.remark || '无备注' },
                              { label: '最近更新', value: formatPlatformTime(p.updatedAt) },
                            ],
                          },
                        ]}
                      />
                    </div>
                  </td>
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
                    {canWrite ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}

function platformTypeLabel(value: string) {
  return ({ openai: 'OpenAI 兼容', claude: 'Claude 兼容' } as Record<string, string>)[value] || value || '未配置';
}

function formatPlatformTime(value?: string | null) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
