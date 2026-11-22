import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { DesignRequirement, DesignWorkspace } from '../../../../src/shared/design-workspace';
import { ReadableNotes } from './DesignMarkdown';
import { designDate, type DesignCommand } from './design-ui';

export function DesignRequirementList({ workspace }: { workspace: DesignWorkspace }) {
  if (!workspace.requirements?.length) return null;
  return <section className="dw-surface dw-brief-list">
    <h2>设计需求</h2>
    <ul>{workspace.requirements.map(row => {
      const draft = workspace.designs.find(item => item.designKey === row.designKey);
      return <li key={row.designKey}>
        <Link className="ep-link" to={`/design?${new URLSearchParams({ project: workspace.projectId, brief: row.designKey })}`}>{row.title}</Link>
        <code>{row.designKey}</code>
        <small>{draft ? `已出稿 V${draft.versions.at(-1)?.version}` : '待出稿'}</small>
      </li>;
    })}</ul>
  </section>;
}

export function DesignRequirementView({ project, requirement, workspace, command, busy }: {
  project: string; requirement?: DesignRequirement; workspace: DesignWorkspace; command: DesignCommand; busy: boolean;
}) {
  const [body, setBody] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const back = `/design?${new URLSearchParams({ project })}`;
  if (!requirement) return <div className="dw-placeholder">当前项目没有这条已交接的需求。 <Link className="ep-link" to={back}>返回设计库</Link></div>;
  const { title, designKey, planVersion, planId, proposalId, sharedAt, replies } = requirement;
  const draft = workspace.designs.find(row => row.designKey === designKey);
  const ref = { designKey, expectedVersion: planVersion };
  const reply = async (event: FormEvent) => {
    event.preventDefault();
    if (body.trim() && await command('brief.reply', { ...ref, body: body.trim() })) setBody('');
  };
  return <div className="dw-brief">
    <header className="dw-row">
      <Link className="ep-link" to={back}>设计库</Link>
      <h1>{title}</h1>
      <span className="ep-badge">{draft ? '已出稿' : '待出稿'}</span>
      {draft && <Link className="ep-button dw-right" to={`/design?${new URLSearchParams({ project, design: draft.id })}`}>查看稿件</Link>}
    </header>
    <section className="dw-surface dw-markdown">
      <header className="dw-row"><h2>已确认需求</h2><code>{designKey}</code><small>{designDate(sharedAt)}交接</small></header>
      <ReadableNotes source={requirement.requirements} />
      <div className="dw-row">
        <Link className="ep-link" to={`/engineering-planning?${new URLSearchParams({ project, kind: 'plan', item: planId })}`}>原计划</Link>
        <small>计划版本 {planVersion} · 提案 {proposalId}</small>
      </div>
    </section>
    <section className="dw-surface dw-markdown">
      <h2>需求沟通</h2>
      {replies?.length ? <ol className="dw-brief-replies">{replies.map(row => <li key={row.id}>
        <div className="dw-row"><strong>{row.author.label}</strong><small>{designDate(row.at)}</small></div>
        <ReadableNotes source={row.body} />
      </li>)}</ol> : <p className="dw-muted">有疑问可以在这里和设计智能体确认。</p>}
      {workspace.permissions.feedback && <form className="dw-brief-reply" onSubmit={reply}>
        <textarea aria-label="回复设计需求" rows={3} placeholder="补充信息或提出问题" maxLength={4000} value={body} onChange={event => setBody(event.target.value)} />
        <button className="ep-button ep-button--primary" disabled={busy || !body.trim()}>回复</button>
      </form>}
    </section>
    {workspace.permissions.steward && (confirmRevoke ? <div className="dw-row">
      <span>撤回后，此需求将从设计接入清单移除。</span>
      <button className="ep-button" type="button" onClick={() => setConfirmRevoke(false)}>取消</button>
      <button className="ep-button" type="button" disabled={busy} onClick={() => void command('brief.revoke', { ...ref, planId })}>确认撤回</button>
    </div> : <button className="ep-button" type="button" onClick={() => setConfirmRevoke(true)}>撤回需求交接</button>)}
  </div>;
}
