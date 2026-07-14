import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { confirmServiceKeyClientCutover, createServiceKey, getGatewayAppCallers, getServiceKeys, revokeServiceKey } from '@/lib/api';
import type { CreatedServiceKey, ServiceKeyItem } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

const DEFAULT_PROTOCOLS = 'gw-native, openai-compatible, claude-compatible, gemini-compatible';
const DEFAULT_SCOPES = 'invoke, route:read';

export function ServiceKeysPage() {
  const [items, setItems] = useState<ServiceKeyItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreatedServiceKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [sourceSystem, setSourceSystem] = useState('external');
  const [clientCode, setClientCode] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [appCallerCodes, setAppCallerCodes] = useState('');
  const [ingressProtocols, setIngressProtocols] = useState(DEFAULT_PROTOCOLS);
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [expiresAt, setExpiresAt] = useState('');
  const [teamId, setTeamId] = useState('');
  const [allowedCidrs, setAllowedCidrs] = useState('');
  const [rateLimitPerMinute, setRateLimitPerMinute] = useState('');
  const [rotatesKeyId, setRotatesKeyId] = useState<string | undefined>();
  const [confirmWildcardRisk, setConfirmWildcardRisk] = useState(false);
  const [knownAppCallers, setKnownAppCallers] = useState<string[]>([]);

  const load = useCallback(async () => {
    setError(null);
    const res = await getServiceKeys();
    if (res.success) setItems(res.data);
    else setError(res.error?.message || '加载接入密钥失败');
  }, []);

  useEffect(() => {
    void load();
    void getGatewayAppCallers({ page: 1, pageSize: 200 }).then((res) => {
      if (res.success) setKnownAppCallers(Array.from(new Set(res.data.items.map((item) => item.appCallerCode))).sort());
    });
  }, [load]);

  const submit = async () => {
    setCreating(true);
    setError(null);
    const res = await createServiceKey({
      name: name.trim(),
      sourceSystem: sourceSystem.trim(),
      clientCode: clientCode.trim().toLowerCase(),
      environment,
      appCallerCodes: splitValues(appCallerCodes),
      ingressProtocols: splitValues(ingressProtocols),
      scopes: splitValues(scopes),
      teamId: teamId.trim() || undefined,
      allowedCidrs: splitValues(allowedCidrs),
      rateLimitPerMinute: rateLimitPerMinute ? Number(rateLimitPerMinute) : undefined,
      rotatesKeyId,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      confirmWildcardRisk,
    });
    setCreating(false);
    if (!res.success) {
      setError(res.error?.message || '创建接入密钥失败');
      return;
    }
    setCreated(res.data);
    setShowCreate(false);
    setName('');
    setClientCode('');
    setAppCallerCodes('');
    setTeamId('');
    setAllowedCidrs('');
    setRateLimitPerMinute('');
    setRotatesKeyId(undefined);
    setConfirmWildcardRisk(false);
    setExpiresAt('');
    await load();
  };

  const revoke = async (item: ServiceKeyItem) => {
    if (!window.confirm(`撤销接入密钥「${item.name}」？`)) return;
    setBusyId(item.id);
    const res = await revokeServiceKey(item.id);
    setBusyId(null);
    if (!res.success) {
      setError(res.error?.message || '撤销接入密钥失败');
      return;
    }
    await load();
  };

  const copyCreatedKey = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.key);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const confirmClientCutover = async (item: ServiceKeyItem) => {
    if (!window.confirm(`确认「${item.name}」的客户端已经全部切换到新密钥？`)) return;
    setBusyId(item.id);
    const res = await confirmServiceKeyClientCutover(item.id);
    setBusyId(null);
    if (!res.success) {
      setError(res.error?.message || '确认客户端切换失败');
      return;
    }
    await load();
  };

  const startRotation = (item: ServiceKeyItem) => {
    setName(`${item.name} rotation`);
    setSourceSystem(item.sourceSystem);
    setClientCode(item.clientCode);
    setEnvironment(item.environment === 'unknown' ? 'production' : item.environment);
    setAppCallerCodes(item.appCallerCodes.join(', '));
    setIngressProtocols(item.ingressProtocols.join(', '));
    setScopes(item.scopes.join(', '));
    setTeamId(item.teamId || '');
    setAllowedCidrs(item.allowedCidrs.join(', '));
    setRateLimitPerMinute(item.rateLimitPerMinute ? String(item.rateLimitPerMinute) : '');
    setRotatesKeyId(item.id);
    setConfirmWildcardRisk(false);
    setShowCreate(true);
  };

  const usesWildcard = sourceSystem.trim() === '*'
    || splitValues(appCallerCodes).includes('*')
    || splitValues(ingressProtocols).includes('*')
    || splitValues(scopes).includes('*');
  const canSubmit = name.trim() && sourceSystem.trim() && /^[a-z][a-z0-9._-]{1,79}$/.test(clientCode.trim().toLowerCase()) && environment && splitValues(appCallerCodes).length
    && splitValues(ingressProtocols).length && splitValues(scopes).length
    && (!usesWildcard || confirmWildcardRisk);

  const renderActions = (item: ServiceKeyItem) => item.enabled ? <div className="lg-service-key-actions">
    {item.rotationState === 'active' || item.rotationState === 'completed' ? <Button size="sm" variant="ghost" onClick={() => startRotation(item)}>轮换</Button> : null}
    {item.rotationState === 'awaiting-client-cutover' ? <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void confirmClientCutover(item)}>确认已切换</Button> : null}
    <Button size="sm" variant="ghost" disabled={busyId === item.id || item.rotationState === 'awaiting-client-cutover' || item.rotationState === 'client-switched' && Boolean(item.rotatesKeyId)} onClick={() => void revoke(item)}>{item.rotationState === 'client-switched' && item.rotatedByKeyId ? '撤销旧钥并完成' : item.rotationState === 'client-switched' ? '等待旧钥撤销' : '撤销'}</Button>
  </div> : null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="lg-service-key-heading" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KeyRound size={17} />
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>接入密钥</h1>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{items ? `${items.length} 个` : ''}</span>
        <div className="lg-service-key-heading-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Link to="/organization" style={{ alignSelf: 'center', color: 'var(--accent)', fontSize: 12 }}>组织与团队</Link>
          <Link to="/quickstart" style={{ alignSelf: 'center', color: 'var(--accent)', fontSize: 12 }}>Quickstart</Link>
          <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={14} />刷新</Button>
          <Button size="sm" variant="primary" onClick={() => setShowCreate((value) => !value)}>
            {showCreate ? <X size={14} /> : <Plus size={14} />}{showCreate ? '取消' : '新建密钥'}
          </Button>
        </div>
      </div>

      {created ? (
        <div style={{ flexShrink: 0, padding: 12, background: 'rgba(63,185,80,0.08)', border: '1px solid rgba(63,185,80,0.35)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 12 }}>密钥已创建，仅本次显示</strong>
            <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => setCreated(null)}><X size={14} /></Button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '9px 10px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>{created.key}</code>
            <Button size="sm" onClick={() => void copyCreatedKey()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</Button>
            <Link to="/quickstart" style={{ color: 'var(--accent)', fontSize: 12 }}>打开 Quickstart</Link>
          </div>
        </div>
      ) : null}

      {showCreate ? (
        <div className="lg-service-key-form" style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) minmax(150px, 1fr) minmax(220px, 2fr)', gap: 8, padding: 12, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <Field label="名称" value={name} onChange={setName} placeholder="例如 content-service" />
          <Field label="Source system" value={sourceSystem} onChange={setSourceSystem} placeholder="external" />
          <Field label="Client code" value={clientCode} onChange={setClientCode} placeholder="例如 content-agent" />
          <label style={labelStyle}>环境<select value={environment} onChange={(event) => setEnvironment(event.target.value)} style={inputStyle}>
            <option value="development">开发</option><option value="test">测试</option><option value="staging">预发布</option><option value="production">生产</option>
          </select></label>
          <Field label="AppCallerCodes" value={appCallerCodes} onChange={setAppCallerCodes} placeholder="选择已有值或逗号分隔输入" list="llmgw-app-callers" />
          <datalist id="llmgw-app-callers">{knownAppCallers.map((code) => <option key={code} value={code} />)}</datalist>
          <Field label="入口协议" value={ingressProtocols} onChange={setIngressProtocols} placeholder="openai-compatible" />
          <Field label="Scopes" value={scopes} onChange={setScopes} placeholder="invoke, stream:invoke, raw:invoke, profile:test" />
          <Field label="Team ID（可选）" value={teamId} onChange={setTeamId} placeholder="仅限当前租户团队" />
          <Field label="来源 CIDR（可选）" value={allowedCidrs} onChange={setAllowedCidrs} placeholder="10.20.0.0/16, 2001:db8::/32" />
          <Field label="每分钟上限（可选）" value={rateLimitPerMinute} onChange={setRateLimitPerMinute} placeholder="例如 60" type="number" />
          <label style={labelStyle}>过期时间<input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={inputStyle} /></label>
          {usesWildcard ? (
            <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'flex-start', gap: 8, padding: 10, color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>
              <input type="checkbox" checked={confirmWildcardRisk} onChange={(event) => setConfirmWildcardRisk(event.target.checked)} />
              <span><strong>确认创建通配密钥</strong><br />该密钥的来源、appCaller、协议或 scope 含通配符，权限范围明显扩大。Developer 即使确认也不能创建。</span>
            </label>
          ) : null}
          {rotatesKeyId ? <div style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)', fontSize: 12 }}>正在轮换 {rotatesKeyId}。新旧密钥会并行有效，完成客户端切换后再撤销旧密钥。</div> : null}
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" disabled={!canSubmit || creating} onClick={() => void submit()}>{creating ? '创建中' : '创建密钥'}</Button>
          </div>
        </div>
      ) : null}

      {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div> : null}
      {!items ? <SectionLoader text="正在加载接入密钥" /> : items.length === 0 ? (
        <div className="lg-service-key-empty">
          <KeyRound size={24} />
          <strong>当前租户还没有外部接入密钥</strong>
          <p>外部系统不能在没有租户密钥的情况下调用 Gateway。创建后，明文只显示一次。</p>
          <Button variant="primary" onClick={() => setShowCreate(true)}><Plus size={14} />创建第一把密钥</Button>
          <div><ShieldCheck size={16} /><span><strong>为什么 MAP 仍然可以调用</strong><small>MAP 等平台内部服务使用部署级内部身份。它不属于当前租户的外部密钥，不会显示在本列表，也不能提供给外部系统。</small></span></div>
        </div>
      ) : (
        <>
        <div className="lg-service-key-desktop" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <table className="lg-service-key-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}><tr>
              {['名称', '工作负载身份', '前缀', '团队/创建者', 'AppCaller', '协议', 'Scope', '网络/限流', '最后使用', '过期', '状态', '轮换阶段', ''].map((label) => <th key={label} style={th}>{label}</th>)}
            </tr></thead>
            <tbody>{items.map((item) => <tr key={item.id}>
              <td style={td}><strong>{item.name}</strong><div style={mutedMono}>{item.id}</div></td>
              <td style={td}><strong>{item.clientCode}</strong><div style={mutedMono}>{item.environment} · {item.sourceSystem}</div></td>
              <td style={{ ...td, ...mutedMono }}>{item.keyPrefix}</td>
              <td style={td}>{item.teamId || '租户级'}<div style={mutedMono}>{item.createdByUsername || '历史密钥'}</div></td>
              <td style={td}>{item.appCallerCodes.join(', ')}</td>
              <td style={td}>{item.ingressProtocols.join(', ')}</td>
              <td style={td}>{item.scopes.join(', ')}</td>
              <td style={td}>{item.allowedCidrs.length ? item.allowedCidrs.join(', ') : '不限 CIDR'}<div style={mutedMono}>{item.rateLimitPerMinute ? `${item.rateLimitPerMinute}/分钟` : '不限速'}</div></td>
              <td style={td}>{formatTime(item.lastUsedAt)}</td>
              <td style={td}>{formatTime(item.expiresAt)}</td>
              <td style={td}><Chip label={item.enabled ? '有效' : '已撤销'} color={item.enabled ? '#3fb950' : '#8b949e'} bg={item.enabled ? 'rgba(63,185,80,0.14)' : 'rgba(139,148,158,0.12)'} /></td>
              <td style={td}>{rotationLabel(item.rotationState)}{item.rotatedByKeyId ? <div style={mutedMono}>新钥 {item.rotatedByKeyId}</div> : null}</td>
              <td style={{ ...td, textAlign: 'right' }}>{renderActions(item)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="lg-service-key-mobile">
          {items.map((item) => <article key={item.id} className="lg-service-key-card">
            <div className="lg-service-key-card-heading">
              <div><strong>{item.name}</strong><code>{item.keyPrefix}</code></div>
              <Chip label={item.enabled ? '有效' : '已撤销'} color={item.enabled ? '#3fb950' : '#8b949e'} bg={item.enabled ? 'rgba(63,185,80,0.14)' : 'rgba(139,148,158,0.12)'} />
            </div>
            <div className="lg-service-key-card-identity">
              <span>工作负载身份</span>
              <strong>{item.clientCode}</strong>
              <small>{item.environment} · {item.sourceSystem}</small>
            </div>
            <dl>
              <div><dt>轮换阶段</dt><dd>{rotationLabel(item.rotationState)}{item.rotatedByKeyId ? <small>新钥 {item.rotatedByKeyId}</small> : null}</dd></div>
              <div><dt>AppCaller</dt><dd>{item.appCallerCodes.join(', ')}</dd></div>
              <div><dt>入口协议</dt><dd>{item.ingressProtocols.join(', ')}</dd></div>
              <div><dt>Scope</dt><dd>{item.scopes.join(', ')}</dd></div>
              <div><dt>团队 / 创建者</dt><dd>{item.teamId || '租户级'}<small>{item.createdByUsername || '历史密钥'}</small></dd></div>
              <div><dt>网络 / 限流</dt><dd>{item.allowedCidrs.length ? item.allowedCidrs.join(', ') : '不限 CIDR'}<small>{item.rateLimitPerMinute ? `${item.rateLimitPerMinute}/分钟` : '不限速'}</small></dd></div>
            </dl>
            {renderActions(item)}
          </article>)}
        </div>
        </>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', list }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; type?: string; list?: string }) {
  return <label style={labelStyle}>{label}<input type={type} list={list} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} /></label>;
}

function splitValues(value: string) {
  return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function formatTime(value?: string | null) {
  if (!value) return '未设置';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function rotationLabel(state: string) {
  return ({
    active: '未轮换',
    'new-key-created': '新钥已创建',
    'awaiting-client-cutover': '等待客户端切换',
    'client-switched': '客户端已切换',
    'old-key-revoked': '旧钥已撤销',
    completed: '轮换完成',
    revoked: '已撤销',
  } as Record<string, string>)[state] || state;
}

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--text-muted)', fontSize: 11 };
const inputStyle: React.CSSProperties = { width: '100%', height: 34, boxSizing: 'border-box', padding: '0 9px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 12 };
const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { maxWidth: 260, padding: '9px 10px', borderTop: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: 12, verticalAlign: 'top', wordBreak: 'break-word' };
const mutedMono: React.CSSProperties = { marginTop: 3, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', fontSize: 10 };
