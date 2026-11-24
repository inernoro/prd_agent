import { PanelRightClose } from 'lucide-react';
import type { DesignEntry, DesignRequirement, DesignScreen, DesignVersion, DesignWorkspace } from '../../../../src/shared/design-workspace';
import { rationaleGoal } from './DesignRationale';
import { needTrace } from './DesignNeed';
import { designFeedbackAwaitsViewer } from './design-ui';

import type { DesignFullView } from './DesignDeliverySide';
type Open = (view: DesignFullView, fields?: Record<string, string>) => void;

export function DesignLegacyDeliverySide({ entry, version, screen, requirement, permissions, onOpen, onCollapse }: {
  entry: DesignEntry; version: DesignVersion; screen?: DesignScreen; requirement?: DesignRequirement;
  permissions: DesignWorkspace['permissions']; onOpen: Open; onCollapse: () => void;
}) {
  const { rows, gaps } = needTrace(entry, version, requirement);
  const clauses = screen ? rows.filter(clause => clause.covers.some(({ rule }) => rule.screenId === screen.id)) : [];
  const rules = screen ? version.acceptance.filter(rule => rule.screenId === screen.id) : [];
  const goal = rationaleGoal(entry, version);
  const pending = (entry.feedback ?? []).filter(row => row.status !== 'closed');
  const feedback = pending.filter(row => screen && row.screenId === screen.id)
    .map(row => ({ row, mine: permissions.feedback && designFeedbackAwaitsViewer(entry, row, permissions.actorId) }))
    .sort((first, second) => Number(second.mine) - Number(first.mine) || second.row.createdAt.localeCompare(first.row.createdAt));
  const files = version.delivery?.files ?? [];
  const primaryFiles = files.filter(file => file.kind === 'guide' || file.kind === 'rationale' || file.kind === 'document')
    .sort((left, right) => Number(right.kind === 'guide') - Number(left.kind === 'guide')).slice(0, 3);
  return <aside className="dw-ds" aria-label="这一屏的需求、说明、反馈和资料">
    <header className="dw-ds-head">
      <span><small>这一屏</small><strong title={screen?.name}>{screen?.name ?? '全部画面'}</strong></span>
      <button type="button" className="ep-button ep-icon-button" aria-label="收起右栏" data-action="side-collapse"
        onClick={onCollapse}><PanelRightClose /></button>
    </header>
    <section className="dw-ds-sec" data-sec="need">
      <h3>需求{requirement && <small>{clauses.length} 条</small>}</h3>
      {!requirement ? <p className="dw-ds-empty">这份稿件没有关联需求。</p>
        : clauses.length ? <ul>{clauses.slice(0, 3).map(row => <li key={row.n}>
          <button type="button" className="dw-ds-row" onClick={() => onOpen('need')}>
            <b className="dw-need-n">{row.n}</b><span>{row.text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')}</span>
            <span className="dw-status" data-state={row.verdict.state}>{row.verdict.label}</span>
          </button>
        </li>)}</ul> : <p className="dw-ds-empty">这一屏没有对应的需求条款。</p>}
      {gaps > 0 && <button type="button" className="ep-link dw-ds-warn" onClick={() => onOpen('need')}>
        {gaps} 条需求还没有验收项</button>}
      <button type="button" className="ep-link dw-ds-more" aria-label="看全部需求" data-action="side-need"
        onClick={() => onOpen('need')}>看全部</button>
    </section>
    <section className="dw-ds-sec" data-sec="notes">
      <h3>说明</h3>
      {goal && <p className="dw-ds-goal">{goal}</p>}
      {!!rules.length && <><small>这一屏要遵守</small><ul>
        {rules.slice(0, 3).map(rule => <li key={rule.id} className="dw-ds-rule">
          <code>{rule.id}</code><span>{rule.rule}{rule.expected && <small>{rule.expected}</small>}</span>
        </li>)}
      </ul></>}
      {!goal && !rules.length && <p className="dw-ds-empty">这一版暂无说明。</p>}
      <button type="button" className="ep-link dw-ds-more" aria-label="看全部说明" data-action="side-notes"
        onClick={() => onOpen('notes')}>看全部</button>
    </section>
    <section className="dw-ds-sec" data-sec="feedback">
      <h3>反馈{!!feedback.length && <small>{feedback.length} 条未关闭</small>}</h3>
      {feedback.length ? <ul>{feedback.slice(0, 3).map(({ row, mine }) => <li key={row.id}>
        <button type="button" className="dw-ds-row" onClick={() => onOpen('delivery', { part: 'feedback', fb: row.id })}>
          <span className="dw-ds-dot" data-mine={mine || undefined} aria-hidden="true" /><span>{row.title}</span>
          <small>{mine ? '等你' : row.status === 'responded' ? '已回复' : '等对方'}</small>
        </button>
      </li>)}</ul> : <p className="dw-ds-empty">这一屏没有未关闭的反馈。</p>}
      <span className="dw-ds-actions">
        <button type="button" className="ep-link" aria-label="看全部反馈" data-action="side-feedback"
          onClick={() => onOpen('delivery', { part: 'feedback' })}>看全部{pending.length ? ` ${pending.length}` : ''}</button>
        {permissions.feedback && <button type="button" className="ep-link"
          onClick={() => onOpen('delivery', { part: 'feedback', fb: 'new' })}>提反馈</button>}
      </span>
    </section>
    <section className="dw-ds-sec" data-sec="files">
      <h3>资料{!!files.length && <small>{files.length} 个文件</small>}</h3>
      {primaryFiles.length ? <ul>{primaryFiles.map(file => <li key={file.id}>
        <button type="button" className="dw-ds-row dw-ds-file"
          onClick={() => onOpen('delivery', { part: 'files', file: file.id })}><span>{file.path.split('/').at(-1)}</span></button>
      </li>)}</ul> : <p className="dw-ds-empty">{files.length ? '在资料全文查看归档文件。' : '这一版没有附交付文件。'}</p>}
      <button type="button" className="ep-link dw-ds-more" aria-label="看全部资料" data-action="side-files"
        onClick={() => onOpen('delivery', { part: 'files' })}>看全部</button>
    </section>
  </aside>;
}
