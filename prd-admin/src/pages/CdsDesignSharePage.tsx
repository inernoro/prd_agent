import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest } from '@/services/real/apiClient';
import { revokeShare } from '@/services/real/webPages';

type Handoff = { grant: string; cdsOrigin: string };
type Approval = { title: string; preparationId: string; version: number; sourceCommit: string;
  access: 'public' | 'password'; expiresInHours: number; privateSources: Array<{ title: string; scope: string }>; fingerprint?: string;
  state: 'awaiting_human_confirmation' | 'approved' | 'revoked' | 'expired'; shareId?: string; shareUrl?: string; expiresAt?: string };
type Approved = { id: string; preparationId: string; shareUrl: string; expiresAt: string };
const path = '/api/web-pages/shares/cds';
const primary = 'rounded-lg bg-primary px-4 py-2.5 text-primary-foreground disabled:opacity-50';
const fixedSharePath = /^\/s\/wp\/[A-Za-z0-9_-]+\?revision=[A-Za-z0-9_.%:-]+$/;

export default function CdsDesignSharePage() {
  const handoff = useRef<Handoff>();
  const [approval, setApproval] = useState<Approval>();
  const [approved, setApproved] = useState<Approved>();
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revoked, setRevoked] = useState(false);

  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!opener) return;
    let active = true;
    const receive = async (event: MessageEvent) => {
      if (event.source !== opener || event.data?.type !== 'cds-design-share' || typeof event.data.grant !== 'string'
        || event.data.grant.length > 4096 || handoff.current) return;
      const input = { grant: event.data.grant as string, cdsOrigin: event.origin };
      handoff.current = input;
      try {
        const response = await apiRequest<Approval>(`${path}/inspect`, { method: 'POST', body: input });
        if (!active) return;
        if (!response.success) { setError(response.error?.message || '无法读取固定版本，请回到 CDS 重新打开。'); return; }
        const data = response.data;
        setApproval(data);
        if (data.state === 'approved' && data.shareId && data.shareUrl && data.expiresAt && fixedSharePath.test(data.shareUrl))
          setApproved({ id: data.shareId, preparationId: data.preparationId, shareUrl: data.shareUrl, expiresAt: data.expiresAt });
        if (data.state === 'revoked') setRevoked(true);
      } catch {
        if (active) setError('无法读取固定版本，请回到 CDS 重新打开。');
      }
    };
    window.addEventListener('message', receive);
    opener.postMessage({ type: 'cds-design-share-ready' }, '*');
    return () => { active = false; window.removeEventListener('message', receive); };
  }, []);

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!approval || !handoff.current || busy || !confirmed) return;
    setBusy(true); setError('');
    try {
      const response = await apiRequest<Approved>(`${path}/approve`, { method: 'POST', body: { ...handoff.current, confirmed,
        password: approval.access === 'password' ? password : undefined, confirmedPrivateSourceFingerprint: approval.fingerprint } });
      if (!response.success || response.data.preparationId !== approval.preparationId
        || !fixedSharePath.test(response.data.shareUrl)) {
        setError(response.error?.message || '分享回执无法读取，请重试。');
        return;
      }
      setApproved(response.data); setPassword('');
    } catch { setError('暂时无法确认分享。可重试同一确认。'); }
    finally { setBusy(false); }
  }

  async function revoke() {
    if (!approved || busy) return;
    setBusy(true); setError('');
    try {
      const response = await revokeShare(approved.id, '从固定稿件分享确认页撤销');
      if (response.success && response.data.revoked) setRevoked(true);
      else setError(response.error?.message || '撤销未完成，请重试。');
    } catch { setError('撤销未完成，请重试。'); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-5 px-5 py-10 text-sm">
    <h1 className="text-2xl font-semibold">确认固定版本分享</h1>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!approval && !error && <p role="status">请从 CDS 稿件的「固定版本分享」打开确认。</p>}
    {approval && <>
      <section className="rounded-xl border border-border p-4" aria-label="要分享的版本">
        <h2 className="text-base font-semibold">{approval.title} · V{approval.version}</h2>
        <p className="my-2 text-muted-foreground">提交 {approval.sourceCommit.slice(0, 12)}</p>
        <p>{approval.access === 'password' ? '凭密码访问' : '获得链接的人可访问'} · {approval.expiresInHours} 小时</p>
      </section>
      {!!approval.privateSources.length && <section>
        <h2 className="font-semibold">这版引用的私有资料</h2>
        <ul className="list-disc pl-5">{approval.privateSources.map((source, index) => <li key={index}>{source.title}</li>)}</ul>
      </section>}
      {approval.state === 'expired' && <p role="status">链接已到期。</p>}
      {!approved && !revoked && approval.state === 'awaiting_human_confirmation' && <form className="flex flex-col gap-4" onSubmit={approve}>
        {approval.access === 'password' && <label className="grid gap-1.5">访问密码
          <input type="password" className="rounded-lg border border-border bg-background px-3 py-2" value={password}
            autoComplete="new-password" onChange={event => setPassword(event.target.value)} maxLength={128} required />
        </label>}
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={confirmed}
          onChange={event => setConfirmed(event.target.checked)} />我确认按上述受众和期限分享这版内容。</label>
        <button className={`self-start ${primary}`} disabled={busy || !confirmed}>确认并生成分享</button>
      </form>}
    </>}
    {revoked && <p role="status">链接已撤销。</p>}
    {approved && !revoked && <section className="grid gap-4" aria-label="已生成的链接">
      <p role="status">分享已生成 · {new Date(approved.expiresAt).toLocaleString()} 到期</p>
      <div className="flex flex-wrap items-center gap-4">
        <Link className="text-primary underline" to={approved.shareUrl} target="_blank" rel="noreferrer">打开分享</Link>
        {!revoking && <button type="button" className="text-muted-foreground underline" onClick={() => setRevoking(true)}>撤销分享</button>}
      </div>
      {revoking && <div className="flex flex-wrap items-center gap-3">
        <span>撤销后，已保存的页面和资源链接将失效。</span>
        <button type="button" className="text-destructive underline" onClick={() => void revoke()} disabled={busy}>确认撤销</button>
        <button type="button" className="underline" onClick={() => setRevoking(false)} disabled={busy}>取消</button>
      </div>}
    </section>}
    <Link to="/web-pages" className="text-muted-foreground underline">返回网页托管</Link>
  </main>;
}
