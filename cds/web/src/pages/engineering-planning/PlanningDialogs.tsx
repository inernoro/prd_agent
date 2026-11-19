import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import type {
  DebtDraft, PlanningBoard, PlanningDebt, PlanningDebtDetail, PlanningDecision, PlanningEvidence, PlanningPlan,
  PlanningProposal, PlanningRecordKind, PlanningSource, PlanningStep, RootCause,
} from '../../../../src/shared/engineering-planning';
import { closedDebt, dateLabel, decisionLabels, events, kindLabels, priorityLabels, sourceLabels, stepKindLabels, stepLabels, type PlanningInput } from './planning-ui';
import { debtState, PlanningBadge, PlanningEmpty, type PlanningSelection } from './PlanningViews';

export type PlanningAction =
  | { kind: 'create'; record: PlanningRecordKind }
  | { kind: 'import' }
  | { kind: 'reject'; proposal: PlanningProposal }
  | { kind: 'debt'; action: 'edit' | 'branch' | 'defer' | 'progress' | 'repay' | 'reopen' | 'drop' | 'hit'; debt: PlanningDebt }
  | { kind: 'decision'; action: 'accepted' | 'amended' | 'reviewed' | 'superseded' | 'deprecated'; decision: PlanningDecision }
  | { kind: 'step'; plan: PlanningPlan; step?: PlanningStep }
  | { kind: 'schedule'; debt: PlanningDebt };

const debtActions = { edit: '补充债务', branch: '调整决策归属', defer: '暂缓', progress: '记录进展', repay: '标记已偿还', reopen: '重开债务', drop: '标记失效', hit: '我也踩到了' };
const decisionActions = { accepted: '采纳决策', amended: '补充决策说明', reviewed: '完成复核', superseded: '取代决策', deprecated: '废弃决策' };
const evidenceLabels: Record<PlanningEvidence['type'], string> = {
  test: '测试结果', change: '变更记录', acceptance: '验收记录', metric: '监控指标', log: '运行记录', doc: '文档', screenshot: '截图引用',
};

function field(form: FormData, name: string) { return String(form.get(name) ?? '').trim(); }
function optional(form: FormData, name: string) { return field(form, name) || undefined; }
function lines(value?: string) { return value?.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }

function Field({ name, label, initial, required, multiline, choices, date, max }: {
  name: string; label: string; initial?: string; required?: boolean; multiline?: boolean; choices?: readonly (readonly [string, string])[]; date?: boolean; max?: number;
}) {
  return <label className="ep-field"><span>{label}</span>
    {choices ? <select name={name} defaultValue={initial} required={required}>{choices.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select>
      : multiline ? <textarea name={name} defaultValue={initial} required={required} rows={3} maxLength={max ?? 4000} />
        : <input name={name} type={date ? 'date' : 'text'} defaultValue={initial} required={required} maxLength={max ?? 2000} />}
  </label>;
}

function SourceFields() {
  return <div className="ep-form-pair">
    <Field name="sourceType" label="来源类型" initial="manual" choices={Object.entries(sourceLabels).filter(([key]) => key !== 'import')} />
    <Field name="sourceRef" label="来源编号（选填）" max={300} />
    <Field name="sourceUrl" label="来源链接（选填）" />
  </div>;
}

function DebtFields({ debt }: { debt?: PlanningDebt }) {
  return <>
    <Field name="summary" label="问题概况" initial={debt?.summary} multiline />
    <Field name="whyDebt" label="为什么现在先欠下" initial={debt?.whyDebt} multiline />
    <div className="ep-form-pair">
      <Field name="priority" label="优先级" initial={debt?.priority ?? 'mid'} choices={Object.entries(priorityLabels)} />
      <Field name="owner" label="负责人" initial={debt?.owner} max={120} />
      <Field name="dueAt" label="预计偿还日期" initial={debt?.dueAt} date />
      <Field name="trigger" label="偿还触发条件" initial={debt?.trigger} />
    </div>
    <Field name="impact" label="已知影响" initial={debt?.impact} multiline />
    <div className="ep-form-pair">
      <Field name="rootState" label="根因状态" initial={debt?.rootCause?.state ?? 'pending'} choices={[['pending', '待查'], ['suspected', '推测'], ['confirmed', '已确认']]} />
      <Field name="tags" label="标签（用逗号分隔）" initial={debt?.tags?.join('，')} />
    </div>
    <Field name="rootText" label="根因说明" initial={debt?.rootCause?.text} multiline />
    <Field name="rootBasis" label="确认根因的依据" initial={debt?.rootCause?.basis} multiline />
    <Field name="criteria" label="偿还标准（每行一项）" initial={debt?.criteria.map(row => row.text).join('\n')} multiline />
  </>;
}

function debtInput(form: FormData): Partial<DebtDraft> {
  const rootState = field(form, 'rootState') as RootCause['state'];
  const tags = field(form, 'tags').split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
  return {
    summary: optional(form, 'summary'), whyDebt: optional(form, 'whyDebt'), priority: field(form, 'priority') as DebtDraft['priority'],
    owner: optional(form, 'owner'), dueAt: optional(form, 'dueAt'), trigger: optional(form, 'trigger'), impact: optional(form, 'impact'),
    criteria: lines(optional(form, 'criteria')) ?? [], tags,
    rootCause: { state: rootState, text: optional(form, 'rootText'), basis: optional(form, 'rootBasis') },
  };
}

function actionTitle(action: PlanningAction) {
  switch (action.kind) {
    case 'create': return action.record === 'debt' ? '记一笔债' : action.record === 'plan' ? '新建落地计划' : '记一个决策';
    case 'import': return '批量导入债务';
    case 'reject': return '驳回提案';
    case 'debt': return debtActions[action.action];
    case 'decision': return decisionActions[action.action];
    case 'step': return action.step ? '更新步骤' : '添加步骤';
    case 'schedule': return '排进落地计划';
  }
}

function decisionOptions(board: PlanningBoard) {
  return board.decisions.filter(row => row.status !== 'superseded' && row.status !== 'deprecated').map(row => [row.id, row.title] as const);
}

function actionFields(action: PlanningAction, board: PlanningBoard): ReactNode {
  switch (action.kind) {
    case 'create': return <>
      <Field name="title" label="标题" required max={120} />
      <SourceFields />
      {action.record === 'debt' ? <><Field name="decisionId" label="所属决策" choices={[[ '', '未归属决策' ], ...decisionOptions(board)]} /><DebtFields /></>
        : <><Field name="summary" label="概况" multiline /><Field name="owner" label="负责人" max={120} />
          {action.record === 'decision' ? <><Field name="rationale" label="决策与取舍" multiline /><Field name="reviewAt" label="复核日期" date /></>
            : <><Field name="decisionId" label="关联决策" choices={[[ '', '未关联' ], ...decisionOptions(board)]} /><Field name="dueAt" label="计划期限" date /></>}</>}
    </>;
    case 'reject': return <Field name="reason" label="驳回原因" required multiline />;
    case 'debt': {
      const row = action.debt;
      switch (action.action) {
        case 'edit': return <><Field name="title" label="标题" initial={row.title} required max={120} /><DebtFields debt={row} /></>;
        case 'branch': return <><Field name="decisionId" label="重新归属" initial={row.decisionId} choices={[[ '', '未归属决策' ], ...decisionOptions(board)]} />
          <Field name="reason" label="改挂原因" required multiline /></>;
        case 'defer': return <><Field name="reviewAt" label="下次回看日期" required date initial={row.reviewAt && row.reviewAt > board.today ? row.reviewAt : undefined} />
          <Field name="reason" label="暂缓原因" required multiline /></>;
        case 'progress': return <Field name="note" label="进展说明" required multiline />;
        case 'hit': return <Field name="note" label="在哪里又遇到了问题" required multiline />;
        case 'repay': return <>
          <Field name="summary" label="处理结果" required multiline max={6000} />
          <fieldset className="ep-criteria"><legend>逐项核对偿还标准</legend>{row.criteria.map(criterion => <div key={criterion.id}>
            <Field name={`result-${criterion.id}`} label={criterion.text} required choices={[[ '', '请选择结果' ], ['met', '达标'], ['na', '不适用']]} />
            <Field name={`note-${criterion.id}`} label="核对说明（不适用时必填）" />
          </div>)}</fieldset>
          <Field name="evidenceType" label="证据类型" initial="test" choices={Object.entries(evidenceLabels)} />
          <Field name="evidenceLabel" label="证据说明" required max={500} />
          <Field name="evidenceUrl" label="证据链接（选填）" />
        </>;
        case 'reopen': return <Field name="reason" label="复发情况与重开原因" required multiline />;
        case 'drop': return <>
          <Field name="outcome" label="失效原因类别" choices={[[ 'cancelled', '取消' ], ['superseded', '替代'], ['extinct', '随功能消失']]} />
          <Field name="reason" label="失效依据" required multiline />
          <Field name="targetId" label="承接债务编号（替代时必填）" />
          <Field name="evidenceLabel" label="验证说明（功能消失时必填）" max={500} />
        </>;
      }
      break;
    }
    case 'decision': return <>
      {action.action === 'superseded' && <>
        <Field name="successorId" label="已采纳的接替决策" required choices={[[ '', '选择接替决策' ], ...board.decisions
          .filter(row => row.status === 'accepted' && row.id !== action.decision.id).map(row => [row.id, row.title] as const)]} />
        <label className="ep-check"><input type="checkbox" name="transfer" defaultChecked /> 转移未还债务</label>
      </>}
      <Field name="reason" label="说明" required multiline />
    </>;
    case 'step': return action.step ? <>
      <Field name="status" label="步骤状态" initial={action.step.status} choices={[[ 'todo', '待处理' ], ['doing', '进行中'], ['done', '完成']]} />
      <Field name="note" label="状态变化依据" required multiline />
    </> : <>
      <Field name="title" label="步骤标题" required max={120} />
      <Field name="stepKind" label="步骤类型" choices={Object.entries(stepKindLabels)} />
      <Field name="relatedId" label="相关决策或债务编号" />
      <Field name="dueAt" label="步骤期限" date />
    </>;
    case 'schedule': return <>
      <Field name="planId" label="落地计划" required choices={[[ '', '选择落地计划' ], ...board.plans.map(plan => [plan.id, plan.title] as const)]} />
      <Field name="dueAt" label="步骤期限" date />
    </>;
    case 'import': return null;
  }
}

function actionCommand(action: PlanningAction, form: FormData, board: PlanningBoard, sourceRef: string): PlanningInput {
  const reason = field(form, 'reason');
  switch (action.kind) {
    case 'create': {
      const title = field(form, 'title');
      const type = field(form, 'sourceType') as PlanningSource['type'];
      const reference = optional(form, 'sourceRef');
      if (type !== 'manual' && !reference) throw new Error('这个来源类型需要填写可核对的来源编号');
      const source: PlanningSource = { type, ref: reference || sourceRef, url: optional(form, 'sourceUrl') };
      if (action.record === 'debt') return { type: 'debt.create', ...debtInput(form), title, source, decisionId: optional(form, 'decisionId') };
      const common = { title, source, summary: optional(form, 'summary'), owner: optional(form, 'owner') };
      return action.record === 'decision'
        ? { type: 'decision.create', ...common, rationale: optional(form, 'rationale'), reviewAt: optional(form, 'reviewAt') }
        : { type: 'plan.create', ...common, decisionId: optional(form, 'decisionId'), dueAt: optional(form, 'dueAt') };
    }
    case 'reject': return { type: 'proposal.reject', proposalId: action.proposal.id, reason };
    case 'decision': return { type: 'decision.change', change: action.action, decisionId: action.decision.id, expectedVersion: action.decision.version,
      reason, ...(action.action === 'superseded' ? { successorId: field(form, 'successorId'), transfer: form.has('transfer') } : {}) };
    case 'schedule': {
      const target = board.plans.find(plan => plan.id === field(form, 'planId'));
      if (!target) throw new Error('请选择当前项目的落地计划');
      return { type: 'plan.add-step', planId: target.id, expectedVersion: target.version, kind: 'debt', title: action.debt.title, relatedId: action.debt.id, dueAt: optional(form, 'dueAt') };
    }
    case 'step': {
      const common = { planId: action.plan.id, expectedVersion: action.plan.version };
      return action.step
        ? { type: 'plan.step', ...common, stepId: action.step.id, status: field(form, 'status') as 'todo' | 'doing' | 'done', note: field(form, 'note') }
        : { type: 'plan.add-step', ...common, title: field(form, 'title'), kind: field(form, 'stepKind') as PlanningStep['kind'], relatedId: optional(form, 'relatedId'), dueAt: optional(form, 'dueAt') };
    }
    case 'debt': {
      const common = { debtId: action.debt.id, expectedVersion: action.debt.version };
      switch (action.action) {
        case 'edit': return { type: 'debt.update', ...common, patch: { ...debtInput(form), title: field(form, 'title') } };
        case 'branch': return { type: 'debt.branch', ...common, decisionId: optional(form, 'decisionId') ?? null, reason };
        case 'defer': return { type: 'debt.defer', ...common, reason, reviewAt: field(form, 'reviewAt') };
        case 'progress': return { type: 'debt.progress', ...common, note: field(form, 'note') };
        case 'hit': return { type: 'debt.hit', ...common, note: field(form, 'note') };
        case 'reopen': return { type: 'debt.reopen', ...common, reason };
        case 'repay': return {
          type: 'debt.repay', ...common, summary: field(form, 'summary'),
          results: action.debt.criteria.map(row => ({ criterionId: row.id, verdict: field(form, `result-${row.id}`) as 'met' | 'na', note: optional(form, `note-${row.id}`) })),
          evidence: [{ type: field(form, 'evidenceType') as PlanningEvidence['type'], label: field(form, 'evidenceLabel'), url: optional(form, 'evidenceUrl') }],
        };
        case 'drop': {
          const label = optional(form, 'evidenceLabel');
          return { type: 'debt.drop', ...common, kind: field(form, 'outcome') as 'cancelled' | 'superseded' | 'extinct', reason,
            targetId: optional(form, 'targetId'), evidence: label ? [{ type: 'doc', label }] : undefined };
        }
      }
    }
    case 'import': throw new Error('请先预览导入内容');
  }
}

type ImportRows = Extract<PlanningInput, { type: 'debt.import' }>['items'];
function readImport(input: string): ImportRows {
  const text = input.trim();
  if (!text) throw new Error('请输入 JSON 数组或逐行 JSON');
  let rows: unknown;
  try { rows = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(row => JSON.parse(row)); }
  catch { throw new Error('无法解析导入数据，请检查 JSON 格式'); }
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('每批可导入 1 至 100 笔债务');
  if (rows.some(row => !row || typeof row.title !== 'string' || !row.title.trim() || row.source?.type !== 'import' || typeof row.source?.ref !== 'string' || !row.source.ref.trim())) {
    throw new Error('每条需有标题和稳定来源编号，来源类型填写 import');
  }
  return rows as ImportRows;
}

export function PlanningActionDialog({ action, board, busy, error, onClose, onSubmit }: {
  action: PlanningAction; board: PlanningBoard; busy: boolean; error: string;
  onClose: () => void; onSubmit: (input: PlanningInput) => void;
}) {
  const [preview, setPreview] = useState<ImportRows>();
  const [validation, setValidation] = useState('');
  const sourceRef = useRef('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceRef.current) sourceRef.current = `web:${crypto.randomUUID()}`;
    const form = new FormData(event.currentTarget);
    try {
      setValidation('');
      if (action.kind !== 'import') { onSubmit(actionCommand(action, form, board, sourceRef.current)); return; }
      if (!preview) { setPreview(readImport(field(form, 'data'))); return; }
      onSubmit({ type: 'debt.import', items: preview });
    } catch (error) { setValidation(error instanceof Error ? error.message : '请核对表单内容'); }
  }
  const title = actionTitle(action);
  const description = action.kind === 'debt' ? action.debt.title : action.kind === 'reject' ? action.proposal.draft.title
    : action.kind === 'decision' ? action.decision.title : action.kind === 'step' ? action.plan.title : '变更保存到当前项目';
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="ep-dialog ep-dialog--form" frame>
      <DialogHeader className="ep-dialog-head"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <form className="ep-dialog-form" onSubmit={submit}>
        <div className="ep-dialog-content">
          {action.kind === 'import' ? <>
            {preview ? <><p>已识别 {preview.length} 笔。CDS 提交时按稳定来源去重。</p>
              <ul className="ep-import-preview">{preview.map((row, index) => <li key={index}>{row.title} · {row.source.ref}</li>)}</ul>
              <button type="button" className="ep-text-button" onClick={() => setPreview(undefined)}>重新编辑</button></> : <>
              <p>粘贴 JSON 数组或每行一条 JSON。每条包含标题和来源编号。</p>
              <Field name="data" label="导入内容" required multiline max={1_500_000} /></>}
          </> : actionFields(action, board)}
          {(validation || error) && <p className="ep-error" role="alert">{validation || error}</p>}
        </div>
        <div className="ep-dialog-footer">
          <button type="button" className="ep-button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="ep-button ep-button--primary" disabled={busy}>
            {busy ? '正在保存…' : action.kind === 'import' ? preview ? '确认导入' : '预览导入'
              : action.kind === 'debt' && action.action === 'repay' ? '确认偿还'
                : action.kind === 'reject' ? '确认驳回' : '保存'}
          </button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function PlanningDetailDialog({ item, board, detail, loading, error, onClose, onRetry, onSelect, onAction }: {
  item: PlanningSelection; board: PlanningBoard; detail?: PlanningDebtDetail; loading: boolean; error?: string;
  onClose: () => void; onRetry: () => void; onSelect: (item: PlanningSelection) => void; onAction: (action: PlanningAction) => void;
}) {
  const record = item.kind === 'debt' ? detail?.debt : item.kind === 'plan' ? board.plans.find(row => row.id === item.id)
    : board.decisions.find(row => row.id === item.id);
  const write = board.permissions.includes('write');
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent frame className="ep-dialog ep-dialog--detail">
      <DialogHeader className="ep-dialog-head"><DialogTitle>{record?.title ?? `${kindLabels[item.kind]}详情`}</DialogTitle>
        <DialogDescription>{record?.id ?? kindLabels[item.kind]}</DialogDescription></DialogHeader>
      <div className="ep-dialog-content ep-detail">
        {loading ? <ContentLoading variant="rows" label="正在读取记录" /> : error ? <div role="alert" className="ep-error">{error}<button type="button" className="ep-button" onClick={onRetry}>重试</button></div>
          : !record ? <PlanningEmpty>没有可访问的记录</PlanningEmpty> : null}
        {item.kind === 'debt' && detail && <DebtDetails data={detail} board={board} write={write} onSelect={onSelect} onAction={onAction} />}
        {item.kind === 'decision' && board.decisions.filter(row => row.id === item.id).map(row =>
          <DecisionDetails key={row.id} row={row} board={board} write={write} onSelect={onSelect} onAction={onAction} />)}
        {item.kind === 'plan' && board.plans.filter(row => row.id === item.id).map(plan =>
          <PlanDetails key={plan.id} plan={plan} write={write} onSelect={onSelect} onAction={onAction} />)}
      </div>
    </DialogContent>
  </Dialog>;
}

function DebtDetails({ data, board, write, onSelect, onAction }: {
  data: PlanningDebtDetail; board: PlanningBoard; write: boolean; onSelect: (item: PlanningSelection) => void; onAction: (action: PlanningAction) => void;
}) {
  const debt = data.debt;
  const active = !closedDebt(debt.status);
  const assigned = board.decisions.find(row => row.id === debt.decisionId);
  const origin = board.decisions.find(row => row.id === debt.originDecisionId);
  const repayment = debt.repayment;
  return <>
    <div className="ep-row">
      <PlanningBadge tone={debt.status === 'repaid' ? 'success' : 'accent'}>{debtState(debt)}</PlanningBadge>
      <PlanningBadge>{priorityLabels[debt.priority]}优先级</PlanningBadge>
      {debt.reopenCount > 0 && <PlanningBadge tone="warning">重开 {debt.reopenCount} 次</PlanningBadge>}
      {debt.hitCount > 0 && <PlanningBadge tone="warning">踩到 {debt.hitCount} 次</PlanningBadge>}
    </div>
    {write && <div className="ep-row">
      {active ? (['progress', 'defer', 'repay', 'edit', 'branch', 'hit', 'drop'] as const).map(action =>
        <button type="button" key={action} className={`ep-button${action === 'repay' ? ' ep-button--primary' : ''}`}
          disabled={action === 'repay' && !debt.criteria.length} onClick={() => onAction({ kind: 'debt', action, debt })}>{debtActions[action]}</button>)
        : debt.outcome?.kind !== 'merged' && <button type="button" className="ep-button" onClick={() => onAction({ kind: 'debt', action: 'reopen', debt })}>重开债务</button>}
      {active && board.plans.length > 0 && <button type="button" className="ep-button" onClick={() => onAction({ kind: 'schedule', debt })}>排进落地计划</button>}
    </div>}
    <section className="ep-surface">
      <h3>债务上下文</h3>
      <dl className="ep-facts">
        <dt>问题概况</dt><dd>{debt.summary || '待补充'}</dd><dt>已知影响</dt><dd>{debt.impact || '待补充'}</dd>
        <dt>来源</dt><dd>{sourceLabels[debt.source.type]} · {debt.source.url ? <a href={debt.source.url} target="_blank" rel="noreferrer">{debt.source.ref}</a> : debt.source.ref}</dd>
        <dt>根因</dt><dd>{debt.rootCause?.state === 'confirmed' ? '已确认' : debt.rootCause?.state === 'suspected' ? '推测' : '待查'}{debt.rootCause?.text && ` · ${debt.rootCause.text}`}{debt.rootCause?.basis && <p>{debt.rootCause.basis}</p>}</dd>
        <dt>欠债理由</dt><dd>{debt.whyDebt || '待补充'}</dd><dt>负责人</dt><dd>{debt.owner || '待认领'}</dd>
        <dt>回看日期</dt><dd>{debt.reviewAt || '未设置'}{debt.deferReason && ` · ${debt.deferReason}`}</dd>
        <dt>偿还计划</dt><dd>{[debt.dueAt, debt.trigger].filter(Boolean).join(' · ') || '未安排'}</dd>
        <dt>当前决策</dt><dd>{assigned ? <button type="button" className="ep-text-button" onClick={() => onSelect({ kind: 'decision', id: assigned.id })}>{assigned.title}</button> : '未归属决策'}</dd>
        {origin && origin.id !== assigned?.id && <><dt>来源决策</dt><dd><button type="button" className="ep-text-button" onClick={() => onSelect({ kind: 'decision', id: origin.id })}>{origin.title}</button></dd></>}
        {debt.tags?.length ? <><dt>标签</dt><dd>{debt.tags.join(' · ')}</dd></> : null}
      </dl>
    </section>
    <section className="ep-surface">
      <h3>偿还标准与证据</h3>
      {debt.criteria.length ? <ol className="ep-evidence">{debt.criteria.map(row => <li key={row.id}>{row.text}</li>)}</ol> : <p>待补充偿还标准</p>}
      {repayment && <><p>{repayment.summary} · {repayment.by.label} · {dateLabel(repayment.at)}</p>
        <ul className="ep-evidence">{repayment.evidence.map((evidence, index) => <li key={index}>
          <PlanningBadge tone="success">{evidenceLabels[evidence.type]}</PlanningBadge> {evidence.url
            ? <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.label}</a> : evidence.label}</li>)}</ul></>}
      {debt.outcome && <p>{debt.outcome.reason}</p>}
    </section>
    <section className="ep-surface"><h3>变更历史</h3><ol className="ep-events">{data.events.map(event => <li key={event.id}>
      <time dateTime={event.at}>{dateLabel(event.at)}</time><div><PlanningBadge>{events[event.type]}</PlanningBadge> {event.actor.label}
        {event.proposedBy && <p>提案来源 · {event.proposedBy.label}</p>}{event.note && <p>{event.note}</p>}
        {event.evidence?.length ? <ul className="ep-evidence">{event.evidence.map((evidence, index) => <li key={index}>{evidence.url
          ? <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.label}</a> : evidence.label}</li>)}</ul> : null}</div>
    </li>)}</ol></section>
  </>;
}

function DecisionDetails({ row, board, write, onSelect, onAction }: {
  row: PlanningDecision; board: PlanningBoard; write: boolean; onSelect: (item: PlanningSelection) => void; onAction: (action: PlanningAction) => void;
}) {
  const available = row.status === 'proposed' || row.status === 'accepted';
  return <>
    <div className="ep-row"><PlanningBadge tone={row.status === 'accepted' ? 'success' : 'quiet'}>{decisionLabels[row.status]}</PlanningBadge>
      {row.reviewAt && <PlanningBadge>复核 {row.reviewAt}</PlanningBadge>}</div>
    <section className="ep-surface"><h3>决策与取舍</h3>
      <p>{row.summary || '暂无概况'}</p>{row.rationale && <p>{row.rationale}</p>}
      <p className="ep-caption">{sourceLabels[row.source.type]} · {row.source.url ? <a href={row.source.url} target="_blank" rel="noreferrer">{row.source.ref}</a> : row.source.ref}</p>
    </section>
    {write && available && <div className="ep-row">{(Object.keys(decisionActions) as (keyof typeof decisionActions)[])
      .filter(action => action !== 'accepted' || row.status === 'proposed').map(action => <button key={action} type="button" className="ep-button"
        onClick={() => onAction({ kind: 'decision', decision: row, action })}>{decisionActions[action]}</button>)}</div>}
    <section className="ep-surface"><h3>落地计划</h3>{board.plans.filter(plan => plan.decisionId === row.id).map(plan =>
      <button type="button" className="ep-text-button" key={plan.id} onClick={() => onSelect({ kind: 'plan', id: plan.id })}>{plan.title}</button>)}</section>
    <section className="ep-surface"><h3>决策历史</h3>
      <ol className="ep-events">{board.events.filter(event => event.entityId === row.id).map(event => <li key={event.id}>
        <time dateTime={event.at}>{dateLabel(event.at)}</time><div><PlanningBadge>{events[event.type]}</PlanningBadge> {event.actor.label}
          {event.note && <p>{event.note}</p>}</div></li>)}</ol></section>
  </>;
}

function PlanDetails({ plan, write, onSelect, onAction }: {
  plan: PlanningPlan; write: boolean; onSelect: (item: PlanningSelection) => void; onAction: (action: PlanningAction) => void;
}) {
  return <>
    {plan.summary && <p>{plan.summary}</p>}
    <div className="ep-row"><PlanningBadge>{plan.steps.filter(step => step.status === 'done').length} / {plan.steps.length} 步完成</PlanningBadge>
      {plan.dueAt && <PlanningBadge>{plan.dueAt}</PlanningBadge>}
      {plan.decisionId && <button type="button" className="ep-button" onClick={() => onSelect({ kind: 'decision', id: plan.decisionId! })}>关联决策</button>}
      {write && <button type="button" className="ep-button ep-button--primary" onClick={() => onAction({ kind: 'step', plan })}>添加步骤</button>}</div>
    <section className="ep-surface"><h3>落地步骤</h3>
      {!plan.steps.length ? <PlanningEmpty>暂无落地步骤</PlanningEmpty> : <ol className="ep-plan-steps">{plan.steps.map(step => <li key={step.id}>
        <div><PlanningBadge>{stepKindLabels[step.kind]}</PlanningBadge> <strong>{step.title}</strong>
          <p>{stepLabels[step.status]}{step.dueAt && ` · ${step.dueAt}`}</p></div>
        {step.relatedId && <button type="button" className="ep-text-button" onClick={() => onSelect({ kind: step.kind === 'debt' ? 'debt' : 'decision', id: step.relatedId! })}>打开记录</button>}
        {write && step.kind !== 'debt' && <button type="button" className="ep-button" onClick={() => onAction({ kind: 'step', plan, step })}>更新步骤</button>}
      </li>)}</ol>}
    </section>
  </>;
}
