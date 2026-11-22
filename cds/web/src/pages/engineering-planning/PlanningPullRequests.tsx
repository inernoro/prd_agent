import { useState } from 'react';
import { Copy, ExternalLink, FileText, GitPullRequest, KeyRound, Link2, Monitor } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { PlanningDecisionLink, PlanningPullRequest, PlanningPullRequestReference } from '../../../../src/shared/engineering-planning';
import { planningPreviewTargetUrl } from '../../../../src/shared/engineering-planning-links';
import { dateLabel, planningPath, usePlanningRead } from './planning-ui';
import { ConfigurationTrail, PreviewDecision } from './PlanningCompanion';
import './planning-pull-requests.css';

const pullStates: Record<PlanningPullRequest['state'], string> = { draft: '草稿', open: '评审中', merged: '已合并', closed: '已关闭' };
const checkStates = { pass: '检查通过', fail: '检查失败', running: '检查中' };
const previewStates = { ready: '预览就绪', building: '预览构建中', failed: '预览构建失败', expired: '预览已过期' };
const linkTypes: Record<PlanningDecisionLink['type'], string> = { doc: '文档', adr: 'ADR', issue: '议题' };

function readyPreview(pullRequest: PlanningPullRequest) {
  const { preview, target } = pullRequest;
  if (preview?.status !== 'ready' || !preview.url) return undefined;
  const root = new URL(preview.url);
  const withinPreview = (value: string) => root.pathname === '/' || new URL(value).pathname === root.pathname.replace(/\/$/, '')
    || new URL(value).pathname.startsWith(root.pathname.replace(/\/$/, '') + '/');
  const proposed = target && planningPreviewTargetUrl(preview.url, target.path);
  const destination = proposed && withinPreview(proposed) ? proposed : undefined;
  const landing = preview.path && planningPreviewTargetUrl(preview.url, preview.path);
  return { ...preview, url: preview.url, destination, frameUrl: destination || landing || preview.url };
}

function PreviewDialog({ pullRequest, preview }: { pullRequest: PlanningPullRequest; preview: NonNullable<ReturnType<typeof readyPreview>> }) {
  const [copy, setCopy] = useState(false);
  const path = pullRequest.target && preview.destination ? '?path=' + encodeURIComponent(pullRequest.target.path) : '';
  const current = usePlanningRead<{ state: string; url?: string; branchId?: string }>(
    `${planningPath(pullRequest.projectId)}/preview/${pullRequest.number}${path}`, 0);
  const access = current.data;
  return <DialogContent frame className="ep-dialog ep-pr-dialog" style={{ width: '52rem', maxWidth: '52rem' }}>
    <DialogHeader className="ep-pr-dialog-header"><DialogTitle>预览 · PR #{pullRequest.number}</DialogTitle>
      <DialogDescription>{pullRequest.title} · {pullRequest.author} · {pullStates[pullRequest.state]}</DialogDescription></DialogHeader>
    <DialogBody className="ep-pr-dialog-body">
      <div className="ep-pr-twocol">
        <div>
          <div className="ep-pr-browser">
            <div className="ep-pr-address"><Monitor aria-hidden /><span>{preview.frameUrl}</span></div>
            <div className="ep-pr-frame">
              <iframe title={`PR #${pullRequest.number} 页面预览`} src={preview.frameUrl}
                sandbox="allow-scripts" referrerPolicy="no-referrer" tabIndex={-1} />
              {preview.destination && <span className="ep-pr-frame-mark">本 PR 改动的页面</span>}
            </div>
          </div>
          <dl className="ep-pr-preview-data">
            {preview.commit && <div><dt>提交</dt><dd><code title={preview.commit}>{preview.commit.slice(0, 12)}</code></dd></div>}
            {preview.builtAt && <div><dt>构建于</dt><dd><time dateTime={preview.builtAt}>{dateLabel(preview.builtAt)}</time></dd></div>}
            {pullRequest.target && preview.destination && <div><dt>目的地</dt><dd>{pullRequest.target.label}
              {pullRequest.target.label !== pullRequest.target.path && <code>{pullRequest.target.path}</code>}</dd></div>}
          </dl>
        </div>
        <aside>
          <section className="ep-surface ep-pr-access">
            <h2><KeyRound />访问</h2>
            <span className="ep-badge" data-tone={access?.state === 'ready' ? 'success' : undefined}>
              {access?.state === 'ready' ? '可以直接进入' : access?.state === 'native-login' ? '使用预览自身登录' : '检查预览状态'}
            </span>
            {current.error && <p role="alert">{current.error}</p>}
            {access?.state === 'ready' && <p>从工程规划打开时，CDS 核对权限并签发一次性票据。</p>}
            {access?.url && <button type="button" className="ep-button" onClick={async () => {
              await navigator.clipboard.writeText(access.url!); setCopy(true);
            }}><Copy />{copy ? '已复制' : '复制进入链接'}</button>}
            <PreviewDecision projectId={pullRequest.projectId} open reload={0} />
          </section>
          {access?.branchId && <ConfigurationTrail projectId={pullRequest.projectId} branchId={access.branchId} compact />}
        </aside>
      </div>
    </DialogBody>
    <footer className="ep-pr-actions">
      <a className="ep-button" href={pullRequest.url} target="_blank" rel="noopener noreferrer"><GitPullRequest aria-hidden />打开 PR</a>
      {access?.url && <a className="ep-button ep-button--primary" href={access.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />
        {preview.destination ? '一键跳到目的地' : '进入预览'}</a>}
    </footer>
  </DialogContent>;
}

export function PlanningPullRequestLink({ reference }: { reference: PlanningPullRequestReference }) {
  return <a className="ep-pr-text-link" href={reference.url} target="_blank" rel="noopener noreferrer">
    <GitPullRequest aria-hidden />关联 PR <small>等待同步</small>
  </a>;
}

export function PlanningPullRequestBadge({ pullRequest }: { pullRequest: PlanningPullRequest }) {
  const preview = readyPreview(pullRequest);
  const contents = <><GitPullRequest aria-hidden /><b>#{pullRequest.number}</b><span>{pullStates[pullRequest.state]}</span>
    {pullRequest.checks && <span data-check={pullRequest.checks}>{checkStates[pullRequest.checks]}</span>}
    {preview && <span className="ep-pr-badge-preview">预览</span>}</>;
  if (!preview) return <a className="ep-pr-badge" href={pullRequest.url} target="_blank" rel="noopener noreferrer" title={pullRequest.title}>{contents}</a>;
  return <Dialog><DialogTrigger asChild><button type="button" className="ep-pr-badge" title={pullRequest.title}>{contents}</button></DialogTrigger>
    <PreviewDialog pullRequest={pullRequest} preview={preview} /></Dialog>;
}

export function PlanningPullRequestList({ pullRequests }: { pullRequests: readonly PlanningPullRequest[] }) {
  return <ul className="ep-pr-list" aria-label="相关 PR">{pullRequests.map(pullRequest => {
    return <li key={pullRequest.url}>
      <div className="ep-pr-list-row"><PlanningPullRequestBadge pullRequest={pullRequest} />
        <strong>{pullRequest.title}</strong></div>
      <div className="ep-pr-list-row ep-pr-list-meta"><span>{pullRequest.author}</span>
        <time dateTime={pullRequest.updatedAt}>{dateLabel(pullRequest.updatedAt)} 更新</time>
        {!pullRequest.checks && <span>检查未同步</span>}
        {pullRequest.preview && <span>{previewStates[pullRequest.preview.status]}</span>}

      </div>
    </li>;
  })}</ul>;
}

export function PlanningDecisionLinks({ links, limit }: { links: readonly PlanningDecisionLink[]; limit?: number }) {
  const docs = links.filter(row => row.type !== 'issue');
  const visible = typeof limit === 'number' ? [...docs, ...links.filter(row => row.type === 'issue')].slice(0, limit) : links;
  return <ul className="ep-decision-link-list">{visible.map(link => {
    const Icon = link.type === 'issue' ? Link2 : FileText;
    return <li key={`${link.type}:${link.url}`}><a className="ep-pr-text-link" href={link.url} target="_blank" rel="noopener noreferrer" title={link.title}>
      <Icon aria-hidden /><span>{link.title}</span><small>{linkTypes[link.type]}</small></a></li>;
  })}</ul>;
}

export function DecisionDocumentBadge({ count }: { count: number }) {
  return <span className="ep-document-badge"><FileText aria-hidden />{count} 份文档</span>;
}
