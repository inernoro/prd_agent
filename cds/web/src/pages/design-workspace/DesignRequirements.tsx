import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { DesignRequirement, DesignViewerState, DesignWorkspace } from '../../../../src/shared/design-workspace';
import { ReadableNotes } from './DesignMarkdown';
import { designDate, isNewDesignRequirement, latestDesign, legacyRequirementGroup, scopePath, type DesignCommand } from './design-ui';

export function DesignRequirementList({ workspace, requirements, viewer }: {
  workspace: DesignWorkspace; requirements: DesignRequirement[]; viewer: DesignViewerState;
}) {
  const drafts = new Map(workspace.designs.filter(row => row.designKey).map(row => [row.designKey, row]));
  const pending = requirements.filter(row => !drafts.has(row.designKey));
  const ready = requirements.filter(row => drafts.has(row.designKey));
  const sections = [[pending, '待出稿'], [ready, '已出稿需求']] as const;
  return <>{sections.map(([selected, section]) => {
    if (!selected.length) return null;
    return <section className="dw-surface dw-brief-list" key={section}>
      <h2>{section as string} <small>{selected.length}</small></h2>
      <ul>{selected.map(row => {
        const draft = drafts.get(row.designKey);
        return <li key={row.designKey}>
          <Link className="ep-link" to={'/design?' + new URLSearchParams({ project: workspace.projectId, brief: row.designKey })}>{row.title}</Link>
          {isNewDesignRequirement(row, viewer) && <small className="dw-new-text">新需求</small>}
          <small>{draft ? 'V' + latestDesign(draft).version : row.assignee?.label ?? '等设计方认领'}</small>
          <small>{draft ? '核对稿件与原需求' : '确认细节并发布首稿'}</small>
        </li>;
      })}</ul>
    </section>;
  })}</>;
}

function StartDesign({ project, requirement, workspace, command, busy, open }: {
  project: string; requirement: DesignRequirement; workspace: DesignWorkspace; command: DesignCommand; busy: boolean; open: boolean;
}) {
  const system = workspace.systems?.find(row => row.id === requirement.scope?.systemId);
  const module = system?.modules.find(row => row.id === requirement.scope?.moduleId);
  const frameId = module?.framework ?? system?.framework;
  const frame = workspace.frameworks.find(row => row.id === frameId);
  const revision = frame?.versions.filter(row => !row.charter || row.charter.status === 'adopted').at(-1);
  const folder = 'design/' + requirement.designKey.split('/').at(-1);
  const title = "'" + requirement.title.replaceAll("'", "'\"'\"'") + "'";
  const draftCommand = frame && revision
    ? `cdscli design scaffold --framework ${frame.id} --framework-version ${revision.version} --dir ${folder} --title ${title}`
    : undefined;
  const scope = { designKey: requirement.designKey, expectedVersion: requirement.planVersion };
  const assigned = requirement.assignee?.id;
  return <details className="ep-new dw-brief-start dw-right" data-design-panel="brief-start" open={open || undefined}>
    <summary className="ep-button ep-button--primary" data-action="brief-start">开始出稿</summary>
    <div aria-label="出稿命令">
      <p>先确认所属模块、框架和未解决的问题，再沿这个接入标识发布首稿。</p>
      <code>cdscli design intake --project {project}</code>
      {!assigned && <code>cdscli design brief-claim {requirement.designKey} --expected-version {requirement.planVersion}</code>}
      {draftCommand ? <code>{draftCommand}</code>
        : <p>先从接入清单选择已采用框架，再用 cdscli design scaffold 建立稿件目录。</p>}
      <code>cdscli design publish --private --intent create --design-key {requirement.designKey} --dir {folder}</code>
      {!assigned
        ? <button className="ep-button" type="button" disabled={busy} onClick={() => void command('brief.claim', scope)}>认领需求</button>
        : (assigned === workspace.permissions.actorId || workspace.permissions.steward)
            && <button className="ep-button" type="button" disabled={busy} onClick={() => void command('brief.release', scope)}>交回待认领</button>}
      {assigned && assigned !== workspace.permissions.actorId && <p>当前由 {requirement.assignee?.label} 出稿。可以在需求沟通中确认交接。</p>}
    </div>
  </details>;
}

export function DesignRequirementView({ project, requirement, workspace, command, busy, startOpen }: {
  project: string; requirement?: DesignRequirement; workspace: DesignWorkspace; command: DesignCommand; busy: boolean; startOpen: boolean;
}) {
  const [body, setBody] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const draft = workspace.designs.find(row => requirement && row.designKey === requirement.designKey);
  const group = requirement ? legacyRequirementGroup(requirement, workspace.designs) : undefined;
  const back = scopePath(project, requirement?.scope, group);
  if (!requirement) return <div className="dw-placeholder">当前项目没有这条已交接的需求。 <Link className="ep-link" to={back}>返回设计库</Link></div>;
  const { title, designKey, planVersion, planId, proposalId, sharedAt, replies } = requirement;
  const ref = { designKey, expectedVersion: planVersion };
  const system = workspace.systems?.find(row => row.id === requirement.scope?.systemId);
  const module = system?.modules.find(row => row.id === requirement.scope?.moduleId);
  const folder = module?.name ?? group;
  const assignee = requirement.assignee?.label ?? (draft ? latestDesign(draft).publisher.label : '等设计方认领');
  const planHref = '/engineering-planning?' + new URLSearchParams({ project, kind: 'plan', item: planId });
  const reply = async (event: FormEvent) => {
    event.preventDefault();
    if (body.trim() && await command('brief.reply', { ...ref, body: body.trim() })) setBody('');
  };
  return <div className="dw-brief">
    <nav className="dw-row" aria-label="设计需求归属">
      <Link className="ep-link" to={scopePath(project)}>设计库</Link><span>/</span><Link className="ep-link" to={back}>{folder}</Link>
    </nav>
    <header className="dw-row">
      <h1>{title}</h1>
      <span className="ep-badge">{draft ? '已出稿' : '待出稿'}</span>
      {draft ? <Link className="ep-button ep-button--primary dw-right" to={'/design?' + new URLSearchParams({ project, design: draft.id })}>查看稿件</Link>
        : workspace.permissions.write ? <StartDesign project={project} requirement={requirement} workspace={workspace} command={command} busy={busy} open={startOpen} />
          : <a className="ep-button dw-right" href="#brief-conversation">查看待确认问题</a>}
    </header>
    <dl className="dw-brief-facts dw-surface">
      <div><dt>所属</dt><dd><Link className="ep-link" to={back}>{system ? system.name + ' · ' : ''}{folder}</Link></dd></div>
      <div><dt>交接时间</dt><dd><time dateTime={sharedAt}>{designDate(sharedAt)}</time></dd></div>
      <div><dt>出稿人</dt><dd>{assignee}</dd></div>
      <div><dt>来源计划</dt><dd><Link className="ep-link" to={planHref}>原计划 · V{planVersion}</Link></dd></div>
    </dl>
    <section className="dw-surface dw-markdown">
      <header className="dw-row"><h2>已确认需求</h2><code>{designKey}</code></header>
      <p className="dw-muted">{draft ? '下一步 · 对照原计划核对稿件与讨论' : '下一步 · 确认细节并发布首稿'}</p>
      <ReadableNotes source={requirement.requirements} />
      <small>提案 {proposalId}</small>
    </section>
    <section className="dw-surface dw-markdown">
      <h2 id="brief-conversation">需求沟通</h2>
      {replies?.length ? <ol className="dw-brief-replies">{replies.map(row => <li key={row.id}>
        <div className="dw-row"><strong>{row.author.label}</strong><small>{designDate(row.at)}</small></div>
        <ReadableNotes source={row.body} />
      </li>)}</ol> : <p className="dw-muted">有疑问可以在这里和设计智能体确认。</p>}
      {workspace.permissions.feedback && <form className="dw-brief-reply" onSubmit={reply}>
        <textarea aria-label="回复设计需求" rows={3} placeholder="补充信息或提出问题" maxLength={4000} value={body} onChange={event => setBody(event.target.value)} />
        <button className="ep-button ep-button--primary" disabled={busy || !body.trim()}>回复</button>
      </form>}
    </section>
    {workspace.permissions.steward && <footer className="dw-row dw-brief-revoke">{confirmRevoke ? <>
      <span>撤回后，这条需求会从设计接入清单移除。</span>
      <button className="ep-button" type="button" onClick={() => setConfirmRevoke(false)}>取消</button>
      <button className="ep-button" type="button" disabled={busy} onClick={() => void command('brief.revoke', { ...ref, planId })}>确认撤回</button>
    </> : <button className="ep-text-button" type="button" onClick={() => setConfirmRevoke(true)}>撤回需求交接</button>}</footer>}
  </div>;
}
