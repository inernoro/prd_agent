import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getUpstreamProxy, saveUpstreamProxy, testUpstreamNetwork } from '@/lib/api';
import type { UpstreamNetworkTestResult, UpstreamProxyDraft, UpstreamProxyView } from '@/lib/types';
import { Button, Chip, InlineAlert, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, SECTION_TITLE } from '@/lib/typography';

const GlobalProxyContext = createContext<UpstreamProxyView | null>(null);

export function proxyDraft(view?: UpstreamProxyView | null): UpstreamProxyDraft {
  return { mode: view?.mode ?? 'inherit', address: view?.address ?? '', username: view?.username ?? '' };
}

export function ProxyBadge({ proxy }: { proxy?: UpstreamProxyView | null }) {
  const global = useContext(GlobalProxyContext);
  const mode = proxy?.mode ?? 'inherit';
  const label = mode === 'custom' ? '独立代理' : mode === 'direct' ? '强制直连'
    : global === null ? '跟随全局' : global.mode === 'custom' ? '全局代理' : '直连 · 跟随全局';
  const address = mode === 'custom' ? proxy?.address : mode === 'inherit' ? global?.address : null;
  return <span title={address || label}><Chip label={label} color="var(--text-secondary)" bg="var(--bg-elevated)" /></span>;
}

export function ProxyFields({ value, onChange, stored, global = false }: {
  value: UpstreamProxyDraft; onChange: (value: UpstreamProxyDraft) => void; stored?: UpstreamProxyView | null; global?: boolean;
}) {
  return <fieldset style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 12, minWidth: 0, width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10 }}>
    <legend style={FIELD_LABEL}>{global ? '全局上游代理' : '上游代理'}</legend>
    <label style={FIELD_LABEL}>
      <span>连接方式</span>
      <select aria-label={global ? '全局连接方式' : '上游连接方式'} value={value.mode} onChange={e => onChange({ ...value, mode: e.target.value as UpstreamProxyDraft['mode'] })} style={FIELD_INPUT}>
        {!global ? <option value="inherit">跟随全局设置</option> : null}
        <option value="direct">{global ? '直连' : '强制直连'}</option>
        <option value="custom">{global ? '使用代理' : '使用独立代理'}</option>
      </select>
    </label>
    {value.mode === 'custom' ? <>
      <label style={FIELD_LABEL}><span>代理地址</span><input aria-label={global ? '全局代理地址' : '代理地址'} value={value.address ?? ''} onChange={e => onChange({ ...value, address: e.target.value })} placeholder="http://proxy.example.com:8080 或 socks5://proxy.example.com:1080" autoComplete="off" style={FIELD_INPUT} /></label>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...FIELD_LABEL, flex: '1 1 160px' }}><span>代理账号（可选）</span><input aria-label="代理账号" value={value.username ?? ''} onChange={e => onChange({ ...value, username: e.target.value })} autoComplete="off" style={FIELD_INPUT} /></label>
        <label style={{ ...FIELD_LABEL, flex: '1 1 160px' }}><span>代理密码（可选）</span><input aria-label="代理密码" type="password" value={value.password ?? ''} onChange={e => onChange({ ...value, password: e.target.value, clearPassword: false })} autoComplete="new-password" placeholder={stored?.hasPassword ? '已保存，留空保留原密码' : '无认证可留空'} style={FIELD_INPUT} /></label>
      </div>
      {stored?.hasPassword ? <label style={HINT_TEXT}><input type="checkbox" checked={value.clearPassword ?? false} onChange={e => onChange({ ...value, clearPassword: e.target.checked, password: '' })} />清除已保存的代理密码</label> : null}
      <span style={HINT_TEXT}>支持 HTTP、HTTPS 和 SOCKS5。代理地址须能从网关服务器访问；目标域名由代理解析。密码加密保存。</span>
    </> : null}
  </fieldset>;
}

export function UpstreamProxyProvider({ children }: { children: ReactNode }) {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [saved, setSaved] = useState<UpstreamProxyView | null>(null);
  const [draft, setDraft] = useState<UpstreamProxyDraft>({ mode: 'direct' });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSaved(null); setLoaded(false); setError(null); setNotice(null);
    void getUpstreamProxy().then(res => {
      if (!alive) return;
      if (res.success) { setSaved(res.data); setDraft(proxyDraft(res.data)); setLoaded(true); }
      else setError(res.error.message || '代理配置加载失败，请刷新页面后重试');
    });
    return () => { alive = false; };
  }, [tenant?.id]);
  async function save() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await saveUpstreamProxy(draft);
      if (res.success) { setSaved(res.data); setDraft(proxyDraft(res.data)); setNotice('全局代理已保存，跟随全局的上游会在新请求中使用此设置。'); }
      else setError(res.error.message || '保存失败，请重试');
    } finally { setBusy(false); }
  }
  return <GlobalProxyContext.Provider value={saved}>
    <details style={{ flexShrink: 0, border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px', maxHeight: '55vh', overflow: 'auto' }}>
      <summary style={{ ...SECTION_TITLE, cursor: 'pointer' }}>全局上游代理 · {saved === null ? '尚未加载' : saved.mode === 'custom' ? saved.address : '直连'}</summary>
      <p style={HINT_TEXT}>应用于当前组织内所有跟随全局设置的上游，也包括之后新增的上游。单个上游可以独立配置代理或强制直连。</p>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {notice ? <InlineAlert tone="ok">{notice}</InlineAlert> : null}
      {canWrite && loaded ? <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ProxyFields value={draft} onChange={setDraft} stored={saved} global />
        <div><Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner size={14} /> : null}应用全局设置</Button></div>
      </div> : null}
    </details>
    {children}
  </GlobalProxyContext.Provider>;
}

export function UpstreamNetworkTest({ kind, id, revision, disabled = false }: { kind: 'platform' | 'exchange'; id: string; revision?: string | null; disabled?: boolean }) {
  const [result, setResult] = useState<UpstreamNetworkTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const generation = useRef(0);
  const global = useContext(GlobalProxyContext);
  useEffect(() => { generation.current++; setResult(null); setError(null); setBusy(false); return () => { generation.current++; }; }, [id, revision, global]);
  useEffect(() => {
    if (!busy) return;
    const interval = window.setInterval(() => setSeconds(value => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [busy]);
  async function run() {
    const current = ++generation.current;
    setBusy(true); setSeconds(0); setResult(null); setError(null);
    try {
      const res = await testUpstreamNetwork(kind, id);
      if (current !== generation.current) return;
      if (res.success) setResult(res.data); else setError(res.error.message || '测试未完成，请重试');
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
    <div><Button size="sm" disabled={disabled || busy} onClick={() => void run()}>{busy ? <Spinner size={14} /> : null}{busy ? `连续测试中 · ${seconds} 秒` : '连续测试网络'}</Button></div>
    <span style={HINT_TEXT}>按已保存的配置建立 3 次连接，每次最多 5 秒；不发起模型推理。</span>
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    {result ? <InlineAlert tone={result.successCount === result.sampleCount ? 'ok' : 'error'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <strong>{result.route} · 连通率 {result.successRate.toFixed(0)}%（{result.successCount}/{result.sampleCount}）</strong>
        <span>平均 {result.averageMs ?? '—'} ms · 最快 {result.minMs ?? '—'} ms · 最慢 {result.maxMs ?? '—'} ms</span>
        {result.samples.map(sample => <span key={sample.attempt}>第 {sample.attempt} 次 · {sample.elapsedMs} ms{sample.httpStatus ? ` · HTTP ${sample.httpStatus}` : ''} · {sample.message}</span>)}
        <span style={HINT_TEXT}>测试时间：{new Date(result.testedAt).toLocaleString()}。结果仅代表本次短时采样；收到响应不代表模型或密钥可用，也不保证长期稳定。</span>
      </div>
    </InlineAlert> : null}
  </div>;
}
