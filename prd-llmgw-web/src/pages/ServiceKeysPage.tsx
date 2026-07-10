import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, RefreshCw, X } from 'lucide-react';
import { createServiceKey, getServiceKeys, revokeServiceKey } from '@/lib/api';
import type { CreatedServiceKey, ServiceKeyItem } from '@/lib/types';
import { Button, Chip, SectionLoader } from '@/components/ui';

const DEFAULT_PROTOCOLS = 'openai-compatible';
const DEFAULT_SCOPES = 'invoke';

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
  const [appCallerCodes, setAppCallerCodes] = useState('');
  const [ingressProtocols, setIngressProtocols] = useState(DEFAULT_PROTOCOLS);
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [expiresAt, setExpiresAt] = useState('');

  const load = useCallback(async () => {
    setError(null);
    const res = await getServiceKeys();
    if (res.success) setItems(res.data);
    else setError(res.error?.message || '加载接入密钥失败');
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    setCreating(true);
    setError(null);
    const res = await createServiceKey({
      name: name.trim(),
      sourceSystem: sourceSystem.trim(),
      appCallerCodes: splitValues(appCallerCodes),
      ingressProtocols: splitValues(ingressProtocols),
      scopes: splitValues(scopes),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    });
    setCreating(false);
    if (!res.success) {
      setError(res.error?.message || '创建接入密钥失败');
      return;
    }
    setCreated(res.data);
    setShowCreate(false);
    setName('');
    setAppCallerCodes('');
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

  const canSubmit = name.trim() && sourceSystem.trim() && splitValues(appCallerCodes).length
    && splitValues(ingressProtocols).length && splitValues(scopes).length;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KeyRound size={17} />
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>接入密钥</h1>
        </div>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{items ? `${items.length} 个` : ''}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
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
          </div>
        </div>
      ) : null}

      {showCreate ? (
        <div className="lg-service-key-form" style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) minmax(150px, 1fr) minmax(220px, 2fr)', gap: 8, padding: 12, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <Field label="名称" value={name} onChange={setName} placeholder="例如 content-service" />
          <Field label="Source system" value={sourceSystem} onChange={setSourceSystem} placeholder="external" />
          <Field label="AppCallerCodes" value={appCallerCodes} onChange={setAppCallerCodes} placeholder="逗号分隔" />
          <Field label="入口协议" value={ingressProtocols} onChange={setIngressProtocols} placeholder="openai-compatible" />
          <Field label="Scopes" value={scopes} onChange={setScopes} placeholder="invoke, stream:invoke, raw:invoke, profile:test" />
          <label style={labelStyle}>过期时间<input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={inputStyle} /></label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" disabled={!canSubmit || creating} onClick={() => void submit()}>{creating ? '创建中' : '创建密钥'}</Button>
          </div>
        </div>
      ) : null}

      {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div> : null}
      {!items ? <SectionLoader text="正在加载接入密钥" /> : items.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>暂无接入密钥</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)' }}>
          <table className="lg-service-key-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}><tr>
              {['名称', '来源', 'AppCaller', '协议', 'Scope', '最后使用', '过期', '状态', ''].map((label) => <th key={label} style={th}>{label}</th>)}
            </tr></thead>
            <tbody>{items.map((item) => <tr key={item.id}>
              <td style={td}><strong>{item.name}</strong><div style={mutedMono}>{item.id}</div></td>
              <td style={td}>{item.sourceSystem}</td>
              <td style={td}>{item.appCallerCodes.join(', ')}</td>
              <td style={td}>{item.ingressProtocols.join(', ')}</td>
              <td style={td}>{item.scopes.join(', ')}</td>
              <td style={td}>{formatTime(item.lastUsedAt)}</td>
              <td style={td}>{formatTime(item.expiresAt)}</td>
              <td style={td}><Chip label={item.enabled ? '有效' : '已撤销'} color={item.enabled ? '#3fb950' : '#8b949e'} bg={item.enabled ? 'rgba(63,185,80,0.14)' : 'rgba(139,148,158,0.12)'} /></td>
              <td style={{ ...td, textAlign: 'right' }}>{item.enabled ? <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void revoke(item)}>撤销</Button> : null}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label style={labelStyle}>{label}<input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} /></label>;
}

function splitValues(value: string) {
  return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function formatTime(value?: string | null) {
  if (!value) return '未设置';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--text-muted)', fontSize: 11 };
const inputStyle: React.CSSProperties = { width: '100%', height: 34, boxSizing: 'border-box', padding: '0 9px', color: 'var(--text-primary)', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 12 };
const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { maxWidth: 260, padding: '9px 10px', borderTop: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: 12, verticalAlign: 'top', wordBreak: 'break-word' };
const mutedMono: React.CSSProperties = { marginTop: 3, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', fontSize: 10 };
