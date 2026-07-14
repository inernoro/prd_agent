import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { confirmServiceKeyClientCutover, createServiceKey, getGatewayAppCallers, getLegacyKeyCutover, getServiceKeys, revokeServiceKey, updateLegacyKeyCutover } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { CreatedServiceKey, LegacyKeyCutoverData, ServiceKeyItem } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

const DEFAULT_PROTOCOLS = 'gw-native, openai-compatible, claude-compatible, gemini-compatible';
const DEFAULT_SCOPES = 'invoke, route:read';

export function ServiceKeysPage() {
  const { tenant } = useAuth();
  const isInternalTenant = tenant?.isInternal === true;
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
  const [purpose, setPurpose] = useState<'runtime' | 'release-gate' | 'canary' | 'external-platform'>('external-platform');
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
  const [legacy, setLegacy] = useState<LegacyKeyCutoverData | null>(null);
  const [legacyDeadline, setLegacyDeadline] = useState('');
  const [legacyAllowedCallers, setLegacyAllowedCallers] = useState('');
  const [legacySuccessorIds, setLegacySuccessorIds] = useState('');
  const [legacyRequired, setLegacyRequired] = useState('1');
  const [legacyStatus, setLegacyStatus] = useState<'observing' | 'ready' | 'revoked'>('observing');
  const [legacyBusy, setLegacyBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await getServiceKeys();
    if (res.success) setItems(res.data);
    else setError(res.error?.message || '加载接入密钥失败');
    const legacyRes = await getLegacyKeyCutover();
    if (legacyRes.success && legacyRes.data.applicable) {
      setLegacy(legacyRes.data);
      setLegacyStatus(legacyRes.data.status === 'not-applicable' ? 'observing' : legacyRes.data.status);
      setLegacyDeadline(legacyRes.data.deadlineAt ? toLocalInput(legacyRes.data.deadlineAt) : '');
      setLegacyAllowedCallers(legacyRes.data.allowedAppCallerCodes.join(', '));
      setLegacySuccessorIds(legacyRes.data.successorServiceKeyIds.join(', '));
      setLegacyRequired(String(legacyRes.data.requiredSuccessorObservations));
    }
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
      purpose,
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
    setPurpose(item.purpose);
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
  const sourceIsMap = sourceSystem.trim().toLowerCase() === 'map';
  const purposeMatchesSource = sourceIsMap ? purpose !== 'external-platform' : purpose === 'external-platform';
  const purposeMatchesTenant = isInternalTenant || (!sourceIsMap && purpose === 'external-platform');
  const canSubmit = name.trim() && sourceSystem.trim() && /^[a-z][a-z0-9._-]{1,79}$/.test(clientCode.trim().toLowerCase()) && environment && splitValues(appCallerCodes).length
    && splitValues(ingressProtocols).length && splitValues(scopes).length
    && purposeMatchesSource && purposeMatchesTenant && (!usesWildcard || confirmWildcardRisk);
  const updateSourceSystem = (value: string) => {
    setSourceSystem(value);
    const nextIsMap = value.trim().toLowerCase() === 'map';
    if (nextIsMap && purpose === 'external-platform') setPurpose('runtime');
    if (!nextIsMap && purpose !== 'external-platform') setPurpose('external-platform');
  };
  const activeKeys = (items ?? []).filter((item) => item.enabled);
  const mapCoverage = (['runtime', 'release-gate', 'canary'] as const).map((requiredPurpose) => ({
    purpose: requiredPurpose,
    ready: activeKeys.some((item) => item.sourceSystem.toLowerCase() === 'map' && item.environment === 'production' && item.purpose === requiredPurpose),
  }));
  const externalIdentities = Array.from(new Set(activeKeys
    .filter((item) => item.purpose === 'external-platform')
    .map((item) => `${item.clientCode} · ${item.environment}`)));

  const saveLegacyCutover = async () => {
    if (!legacyDeadline) return;
    if (legacyStatus === 'revoked' && !window.confirm('确认撤销 legacy shared key？撤销后旧 key 将立即返回 401，且必须已有 scoped key 双 key 观测。')) return;
    setLegacyBusy(true);
    const res = await updateLegacyKeyCutover({
      status: legacyStatus,
      deadlineAt: new Date(legacyDeadline).toISOString(),
      allowedAppCallerCodes: splitValues(legacyAllowedCallers),
      successorServiceKeyIds: splitValues(legacySuccessorIds),
      requiredSuccessorObservations: Math.max(1, Number(legacyRequired) || 1),
    });
    setLegacyBusy(false);
    if (!res.success) {
      setError(res.error?.message || '更新 legacy 收口策略失败');
      return;
    }
    await load();
  };

  const renderActions = (item: ServiceKeyItem) => item.enabled ? <div className="lg-service-key-actions">
    {item.rotationState === 'active' || item.rotationState === 'completed' ? <Button size="sm" variant="ghost" onClick={() => startRotation(item)}>轮换</Button> : null}
    {item.rotationState === 'awaiting-client-cutover' ? <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void confirmClientCutover(item)}>确认已切换</Button> : null}
    <Button size="sm" variant="ghost" disabled={busyId === item.id || item.rotationState === 'awaiting-client-cutover' || item.rotationState === 'client-switched' && Boolean(item.rotatesKeyId) && !item.rotatedByKeyId} onClick={() => void revoke(item)}>{item.rotationState === 'client-switched' && item.rotatedByKeyId ? '撤销旧钥并完成' : item.rotationState === 'client-switched' ? '等待旧钥撤销' : '撤销'}</Button>
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
          {isInternalTenant
            ? <Field label="Source system" value={sourceSystem} onChange={updateSourceSystem} placeholder="external；内部 MAP 填 map" />
            : <label style={labelStyle}>Source system<input aria-label="Source system" value="external" readOnly style={inputStyle} /><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>外部租户身份由服务端固定，不能伪装为 MAP。</span></label>}
          <Field label="Client code" value={clientCode} onChange={setClientCode} placeholder="例如 content-agent" />
          <label style={labelStyle}>环境<select value={environment} onChange={(event) => setEnvironment(event.target.value)} style={inputStyle}>
            <option value="development">开发</option><option value="test">测试</option><option value="staging">预发布</option><option value="production">生产</option>
          </select></label>
          {isInternalTenant
            ? <label style={labelStyle}>用途<select value={purpose} onChange={(event) => setPurpose(event.target.value as typeof purpose)} style={inputStyle}>
              <option value="runtime">MAP runtime</option><option value="release-gate">发布 Gate</option><option value="canary">Canary</option><option value="external-platform">外部平台</option>
            </select></label>
            : <label style={labelStyle}>用途<input aria-label="用途" value="external-platform" readOnly style={inputStyle} /></label>}
          {!purposeMatchesSource ? <div style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 12 }}>MAP 只能使用 runtime、release-gate 或 canary；其他来源只能使用 external-platform。</div> : null}
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
      {items ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        {isInternalTenant ? <div style={{ padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}><strong style={{ fontSize: 12 }}>MAP 生产 key 覆盖</strong><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{mapCoverage.map((item) => <Chip key={item.purpose} label={`${item.purpose} ${item.ready ? '已独立' : '缺失'}`} color={item.ready ? '#3fb950' : '#f59e0b'} bg={item.ready ? 'rgba(63,185,80,0.12)' : 'rgba(245,158,11,0.12)'} />)}</div><p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 11 }}>runtime、release-gate、canary 各用一把 production scoped key，不共享身份。</p></div> : null}
        <div style={{ padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}><strong style={{ fontSize: 12 }}>外部平台独立身份</strong><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{externalIdentities.length ? externalIdentities.map((item) => <Chip key={item} label={item} color="var(--text-secondary)" bg="var(--bg-muted)" />) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>暂无外部平台 key</span>}</div><p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 11 }}>每个 clientCode 与环境生成独立 key；一把 key 不能跨 purpose 或 environment。</p></div>
      </div> : null}
      {legacy ? <details style={{ flexShrink: 0, padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 12 }}>Legacy shared key 收口 · {legacy.status} · 后继观测 {legacy.successorObservedCount}/{legacy.requiredSuccessorObservations}</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginTop: 12 }}>
          <label style={labelStyle}>截止时间<input type="datetime-local" value={legacyDeadline} onChange={(e) => setLegacyDeadline(e.target.value)} style={inputStyle} /></label>
          <label style={labelStyle}>状态<select value={legacyStatus} onChange={(e) => setLegacyStatus(e.target.value as typeof legacyStatus)} style={inputStyle}><option value="observing">观测中</option><option value="ready">待撤销</option><option value="revoked">已撤销</option></select></label>
          <Field label="允许的 appCaller 清单" value={legacyAllowedCallers} onChange={setLegacyAllowedCallers} placeholder="逗号分隔；空表示先盘点" />
          <Field label="后继 scoped key IDs" value={legacySuccessorIds} onChange={setLegacySuccessorIds} placeholder="逗号分隔" />
          <Field label="最低观测次数" value={legacyRequired} onChange={setLegacyRequired} placeholder="1" type="number" />
          <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'flex-end' }}><Button variant="primary" disabled={legacyBusy || !legacyDeadline} onClick={() => void saveLegacyCutover()}>{legacyBusy ? '保存中' : '保存收口策略'}</Button></div>
        </div>
        <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 11 }}>外部来源使用 legacy key 永远拒绝；到达截止时间或状态为 revoked 后旧 key 返回 401。只有后继 scoped key 观测达标才能显式撤销。</div>
        {legacy.usage.length ? <div style={{ overflowX: 'auto', marginTop: 10 }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['来源', 'appCaller', '协议', '允许', '拒绝', '最后出现', '决定'].map((label) => <th key={label} style={th}>{label}</th>)}</tr></thead><tbody>{legacy.usage.map((item) => <tr key={`${item.sourceSystem}-${item.appCallerCode}-${item.ingressProtocol}`}><td style={td}>{item.sourceSystem}</td><td style={td}>{item.appCallerCode || '缺失'}</td><td style={td}>{item.ingressProtocol}</td><td style={td}>{item.allowedCount}</td><td style={td}>{item.rejectedCount}</td><td style={td}>{formatTime(item.lastSeenAt)}</td><td style={td}>{item.lastDecision}</td></tr>)}</tbody></table></div> : null}
      </details> : null}
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
              <td style={td}><strong>{item.clientCode}</strong><div style={mutedMono}>{item.environment} · {item.purpose} · {item.sourceSystem}</div></td>
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
              <small>{item.environment} · {item.purpose} · {item.sourceSystem}</small>
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

function toLocalInput(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
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
