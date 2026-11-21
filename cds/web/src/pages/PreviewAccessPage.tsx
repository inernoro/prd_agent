import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Bell, CircleCheck, Clock, FlaskConical, LockKeyhole, Moon, Sun } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { CdsGem } from '@/components/brand/CdsGem';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { apiRequest } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { usePlanningRead } from './engineering-planning/planning-ui';
import './preview-access.css';

export type PreviewLoginContext = { project?: string; branch?: string; pullRequest?: number; policyUrl?: string };

export function PreviewAccessFrame({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useTheme();
  return <main className="pv-access">
    <header><Link to="/"><CdsGem detail="simple" className="h-6 w-6" /> CDS</Link>
      <button aria-label={theme === 'dark' ? '切换浅色' : '切换深色'} type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? <Sun /> : <Moon />}
      </button>
    </header>
    <section className="pv-stage">{children}</section>
  </main>;
}

export function PreviewLabel({ project, branch, pullRequest }: PreviewLoginContext) {
  return <div className="pv-label">
    <strong><FlaskConical />分支预览</strong>
    {(project || branch || pullRequest) && <p>{[project, branch && `分支 ${branch}`, pullRequest && `PR #${pullRequest}`].filter(Boolean).join(' · ')}</p>}
    <small>此预览运行分支代码，使用独立会话。</small>
  </div>;
}

export function WhyPreviewLogin({ policyUrl, decisionUrl }: { policyUrl?: string; decisionUrl?: string }) {
  if (decisionUrl) return <Link className="pv-link" to={decisionUrl}>为什么要单独登录？</Link>;
  return <details className="pv-why"><summary>为什么要单独登录？</summary>
    <p>分支预览和正式 CDS 使用不同的会话。CDS 核对项目权限后签发一次性票据，预览只用它建立自己的会话。</p>
    {policyUrl && <a className="pv-link" href={policyUrl} referrerPolicy="no-referrer">前往 CDS 查看规则依据</a>}
  </details>;
}

type Info = PreviewLoginContext & {
  state: 'ready' | 'requested' | 'forbidden'; startUrl?: string; decisionUrl?: string; requestedAt?: string; approver?: string;
};
type AccessRequest = { id: string; projectId: string; branchId: string; subject: string; name: string; note: string; state: 'ready' | 'requested' };
type NamedOption = { id: string; name: string };
export function PreviewAccessPage() {
  const [params] = useSearchParams();
  const client = params.get('client');
  const requestId = params.get('request');
  const accessEntry = Boolean(client || requestId);
  const destination = params.get('path');
  const [refresh, update] = useState(0);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [sent, setSent] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const query = new URLSearchParams(requestId ? { request: requestId } : client ? { client, ...(destination ? { path: destination } : {}) } : {});
  const access = usePlanningRead<Info>(accessEntry ? `/api/auth/preview/access?${query}` : null, refresh);
  const inbox = usePlanningRead<{ requests: AccessRequest[]; projects?: NamedOption[] }>(accessEntry ? null : '/api/auth/preview/requests', refresh);
  async function request() {
    setBusy('request'); setError('');
    try {
      const response = await apiRequest<{ state: string }>('/api/auth/preview/access', {
        method: 'POST', body: { client, note: note.trim(), ...(destination ? { path: destination } : {}) },
      });
      setSent(response.state === 'requested');
      setWaiting(response.state === 'requested');
      update(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : '未能提交申请'); }
    finally { setBusy(''); }
  }
  async function approve(item: AccessRequest) {
    setBusy(item.id); setError('');
    try {
      await apiRequest(`/api/auth/users/${encodeURIComponent(item.subject)}/projects/${encodeURIComponent(item.projectId)}`,
        { method: 'POST', body: { previewRequestId: item.id } });
      update(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : '授权失败，请重试'); }
    finally { setBusy(''); }
  }
  const info = access.data;
  const approver = info?.approver ?? 'CDS 系统所有者';
  useEffect(() => {
    if (info?.state === 'requested') setWaiting(true);
    if (info?.state === 'ready' || access.error) setWaiting(false);
  }, [info?.state, access.error]);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => update(value => value + 1), 5000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  return <PreviewAccessFrame><article className="pv-card" data-inbox={!accessEntry}>
    {accessEntry ? <>
      <PreviewLabel {...info} />
      {info?.state === 'ready' && info.startUrl ? <>
        <div className="pv-approved" role="status"><CircleCheck /><div>
          <h1>已开通预览访问</h1><p>已取得「{info.project}」的访问权限。</p>
        </div></div>
        <a href={info.startUrl} className="pv-primary"><ArrowRight />返回原预览</a>
      </> : (sent || info?.state === 'requested') ? <>
        <div className="pv-denied"><LockKeyhole /><div><h1>等待项目授权</h1><p>审批人 · {approver}</p></div></div>
        <div className="pv-status-note"><Clock /><div>{info?.requestedAt && <p>已于 <time dateTime={info.requestedAt}>{new Date(info.requestedAt)
          .toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> 提交</p>}
          <p>批准后，CDS 信息中心会提供返回原预览的入口。</p></div></div>
        <button className="pv-secondary" type="button" onClick={() => update(value => value + 1)}>刷新审批状态</button>
      </> : info ? <>
        <div className="pv-denied"><LockKeyhole /><div><strong>你还没有「{info.project}」的访问权限</strong><p>预览沿用该项目的成员授权。</p></div></div>
        <p>审批人 · {approver}</p>
        <form onSubmit={event => { event.preventDefault(); void request(); }}>
          <button className="pv-primary" disabled={!!busy}><Bell />申请访问</button>
          <details className="pv-native"><summary>补充说明</summary>
            <label>申请说明<textarea value={note} maxLength={300} onChange={event => setNote(event.target.value)} /></label>
          </details>
        </form>
      </> : access.error ? <p role="alert">{access.error}</p> : <ContentLoading label="正在核对预览访问权限" />}
      <WhyPreviewLogin decisionUrl={info?.decisionUrl} />
    </> : <>
      <h1>分支预览访问申请</h1>
      {inbox.error ? <p role="alert">{inbox.error}</p> : inbox.loading ? <ContentLoading label="正在读取访问申请" />
        : inbox.data?.requests.length ? <ul className="pv-inbox">{inbox.data.requests.map(item => <li key={item.id}>
          <div><strong>{item.name}</strong><p>{item.projectId} · {item.branchId}</p><small>{item.note}</small></div>
          {item.state === 'ready' ? <small>已授权</small> : <button type="button" className="pv-secondary" disabled={!!busy} onClick={() => void approve(item)}>授权项目</button>}
        </li>)}</ul> : <p>暂无分支预览访问申请。</p>}
      {!!inbox.data?.projects?.length && <PreviewApprovalSettings projects={inbox.data.projects} />}
      <Link to="/engineering-planning" className="pv-link">返回工程规划</Link>
    </>}
    {error && <p role="alert" className="pv-error">{error}</p>}
  </article></PreviewAccessFrame>;
}

function PreviewApprovalSettings({ projects }: { projects: NamedOption[] }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState('');
  const [selection, setSelection] = useState<string>();
  const [reload, refresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const project = projects.some(option => option.id === chosen) ? chosen : projects[0].id;
  const path = `/api/auth/preview/approvers/${encodeURIComponent(project)}`;
  const current = usePlanningRead<{ userId: string | null; members: NamedOption[] }>(open ? path : null, reload);
  const saved = current.data?.userId ?? '';
  const selected = selection ?? saved;
  const save = async () => {
    if (saving || !current.data || selected === saved) return;
    setSaving(true); setStatus(''); setError('');
    try {
      await apiRequest(path, { method: 'PUT', body: { userId: selected || null } });
      setStatus('审批人已保存');
      refresh(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : '审批人保存失败'); }
    finally { setSaving(false); }
  };
  return <details className="pv-native" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>设置项目审批人</summary>
    {open && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>项目<select aria-label="项目" disabled={saving} value={project} onChange={event => {
        setChosen(event.target.value); setSelection(undefined); setStatus(''); setError('');
      }}>{projects.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
      <label>项目审批人<select aria-label="项目审批人" disabled={saving || current.loading || !current.data} value={selected}
        onChange={event => { setSelection(event.target.value); setStatus(''); setError(''); }}>
        <option value="">CDS 系统所有者</option>
        {current.data?.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select></label>
      {current.loading && <ContentLoading label="正在读取项目成员" />}
      {(error || current.error) && <p role="alert" className="pv-error">{error || current.error}</p>}
      {status && <p role="status">{status}</p>}
      <button type="submit" className="pv-secondary" disabled={saving || current.loading || !current.data || selected === saved}>保存审批人</button>
    </form>}
  </details>;
}
