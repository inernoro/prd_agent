import { ExternalLink, FileText, GitPullRequest, Link2, Monitor, Route } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { PlanningDecisionLink, PlanningPullRequest, PlanningPullRequestReference } from '../../../../src/shared/engineering-planning';
import { planningPreviewTargetUrl } from '../../../../src/shared/engineering-planning-links';
import { dateLabel } from './planning-ui';
import './planning-pull-requests.css';

const pullStates: Record<PlanningPullRequest['state'], string> = { draft: '草稿', open: '评审中', merged: '已合并', closed: '已关闭' };
const checkStates = { pass: '检查通过', fail: '检查失败', running: '检查中' };
const previewStates = { ready: '预览就绪', building: '预览构建中', failed: '预览构建失败', expired: '预览已过期' };
const linkTypes: Record<PlanningDecisionLink['type'], string> = { doc: '文档', adr: 'ADR', issue: '议题' };

function readyPreview(pullRequest: PlanningPullRequest) {
  const { preview, target } = pullRequest;
  if (preview?.status !== 'ready' || !preview.url) return undefined;
  const destination = target && planningPreviewTargetUrl(preview.url, target.path);
  const landing = preview.path && planningPreviewTargetUrl(preview.url, preview.path);
  return { ...preview, url: preview.url, destination, frameUrl: destination || landing || preview.url };
}

function PreviewDialog({ pullRequest, preview }: { pullRequest: PlanningPullRequest; preview: NonNullable<ReturnType<typeof readyPreview>> }) {
  return <DialogContent frame className="ep-dialog ep-pr-dialog" style={{ width: '52rem', maxWidth: '52rem' }}>
    <DialogHeader className="ep-pr-dialog-header"><DialogTitle>PR #{pullRequest.number} 预览</DialogTitle>
      <DialogDescription>{pullRequest.title}</DialogDescription></DialogHeader>
    <DialogBody className="ep-pr-dialog-body">
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
    </DialogBody>
    <footer className="ep-pr-actions">
      <a className="ep-button" href={pullRequest.url} target="_blank" rel="noopener noreferrer"><GitPullRequest aria-hidden />打开 PR</a>
      <a className="ep-button" href={preview.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />打开预览</a>
      {preview.destination && <a className="ep-button ep-button--primary" href={preview.destination} target="_blank" rel="noopener noreferrer">
        <Route aria-hidden />一键跳到目的地</a>}
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
    const preview = readyPreview(pullRequest);
    return <li key={pullRequest.url}>
      <div className="ep-pr-list-row"><PlanningPullRequestBadge pullRequest={pullRequest} />
        <strong>{pullRequest.title}</strong></div>
      <div className="ep-pr-list-row ep-pr-list-meta"><span>{pullRequest.author}</span>
        <time dateTime={pullRequest.updatedAt}>{dateLabel(pullRequest.updatedAt)} 更新</time>
        {!pullRequest.checks && <span>检查未同步</span>}
        {pullRequest.preview && <span>{previewStates[pullRequest.preview.status]}</span>}
        {preview?.destination && <a href={preview.destination} className="ep-pr-text-link" target="_blank" rel="noopener noreferrer"><Route aria-hidden />跳到目的地</a>}
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
