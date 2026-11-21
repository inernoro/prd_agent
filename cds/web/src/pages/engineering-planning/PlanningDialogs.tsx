import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CalendarDays, Check, CheckCircle2, Flame, Folder, GitPullRequest, Link2, MessageSquare, MoreHorizontal, Pencil, UserRound } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownItem, DropdownMenu } from '@/components/ui/dropdown-menu';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import type {
  Criterion, CriterionResult, DebtDraft, DebtPatch, DecisionStructure, PlanningBoard, PlanningBriefCitation, PlanningBriefTarget, PlanningDebt, PlanningDebtDetail, PlanningDecision, PlanningDecisionLink, PlanningEvidence, PlanningPlan,
  PlanningDebtList, PlanningDuplicateCandidate, PlanningProposal, PlanningRecordKind, PlanningRepaymentProof, PlanningSource, PlanningStep, PlanningStepDraft, RootCause,
} from '../../../../src/shared/engineering-planning';
import { closedDebt, dateLabel, events, kindLabels, planningPath, priorityLabels, shortId, sourceLabels, stepKindLabels, usePlanningRead, type PlanningInput } from './planning-ui';
import { DebtCoin, DebtDeadline, DebtPriorityBadge, debtState, PlanningBadge, PlanningEmpty, type PlanningSelection } from './PlanningViews';
import { DebtHandoffCard } from './DebtHandoffCard';
import { DebtHealthBadge, DebtHealthForm, DebtHealthSection, debtHealthTitle, type DebtHealthMode } from './DebtHealth';
import { DebtScreenshotFields, DebtScreenshotGallery } from './DebtScreenshotEvidence';
import { DecisionDetails, DecisionHeading, PlanDetails, PlanHeading } from './PlanningDecisionViews';
import { PlanningImportForm } from './PlanningImport';
import { PlanningPullRequestList } from './PlanningPullRequests';

export type PlanningAction =
  | { kind: 'create'; record: PlanningRecordKind; decisionId?: string }
  | { kind: 'import' }
  | { kind: 'reject'; proposal: PlanningProposal }
  | { kind: 'debt'; action: 'edit' | 'branch' | 'defer' | 'review' | 'progress' | 'repay' | 'reopen' | 'drop' | 'hit' | 'merge' | 'not-duplicate';
      debt: PlanningDebt; collateralCandidates?: PlanningDebtDetail['collateralCandidates']; duplicateCandidates?: PlanningDebtDetail['duplicateCandidates'] }
  | { kind: 'health'; mode: DebtHealthMode; debt: PlanningDebt }
  | { kind: 'decision'; action: 'accepted' | 'amended' | 'reviewed' | 'superseded' | 'deprecated'; decision: PlanningDecision }
  | { kind: 'step'; plan: PlanningPlan; step?: PlanningStep; initialStatus?: 'todo' | 'doing' | 'done';
      initialKind?: PlanningStep['kind']; initialRelatedId?: string; initialTitle?: string }
  | { kind: 'schedule'; debt: PlanningDebt };

const debtActions = { edit: '补齐内容', branch: '调整决策归属', defer: '暂缓', review: '到期回看', progress: '记录进展', repay: '核对偿还标准', reopen: '重开债务', drop: '标记失效', hit: '我也踩到了',
  merge: '对比并合并', 'not-duplicate': '标记为不同问题' };
const decisionActions = { accepted: '采纳决策', amended: '补充决策说明', reviewed: '完成复核', superseded: '取代决策', deprecated: '废弃决策' };
const evidenceLabels: Record<PlanningEvidence['type'], string> = {
  test: '测试结果', change: '变更记录', acceptance: '验收记录', metric: '监控指标', log: '运行记录', doc: '文档', screenshot: '截图引用',
};

function field(form: FormData, name: string) { return String(form.get(name) ?? '').trim(); }
function optional(form: FormData, name: string) { return field(form, name) || undefined; }
function lines(value?: string) { return value?.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }

function Field({ name, label, initial, required, multiline, choices, date, max, onValue, placeholder }: {
  name: string; label: string; initial?: string; required?: boolean; multiline?: boolean; choices?: readonly (readonly [string, string])[]; date?: boolean; max?: number;
  placeholder?: string; onValue?: (value: string) => void;
}) {
  return <label className="ep-field"><span>{label}{required && <small className="ep-required" aria-hidden="true">必填</small>}</span>
    {choices ? <select name={name} defaultValue={initial} required={required}>{choices.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select>
      : multiline ? <textarea name={name} defaultValue={initial} required={required} rows={3} maxLength={max ?? 4000} />
        : <input name={name} type={date ? 'date' : 'text'} defaultValue={initial} required={required} maxLength={max ?? 2000} placeholder={placeholder}
          onChange={onValue && (event => onValue(event.target.value))} />}
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
  const [assignToSelf, setAssignToSelf] = useState(!debt);
  return <>
    <Field name="summary" label="问题概况" initial={debt?.summary} multiline />
    <Field name="whyDebt" label="为什么现在先欠下" initial={debt?.whyDebt} multiline />
    <div className="ep-form-pair">
      <Field name="priority" label="优先级" initial={debt?.priority ?? 'mid'} choices={Object.entries(priorityLabels)} />
      {!debt && <label className="ep-check"><input type="checkbox" name="assignToSelf" checked={assignToSelf}
        onChange={event => setAssignToSelf(event.target.checked)} />由我负责</label>}
      {!assignToSelf && <Field name="owner" label="负责人" initial={debt?.owner} max={120} />}
      <Field name="dueAt" label="预计偿还日期" initial={debt?.dueAt} date />
      <Field name="trigger" label="偿还触发条件" initial={debt?.trigger} />
      <Field name="module" label="所属模块" initial={debt?.module} max={80} />
    </div>
    <Field name="impact" label="已知影响" initial={debt?.impact} multiline />
    <div className="ep-form-pair">
      <Field name="rootState" label="根因状态" initial={debt?.rootCause?.state ?? 'pending'} choices={[['pending', '待查'], ['suspected', '推测'], ['confirmed', '已确认']]} />
      <Field name="tags" label="标签（用逗号分隔）" initial={debt?.tags?.join('，')} />
    </div>
    <Field name="rootText" label="根因说明" initial={debt?.rootCause?.text} multiline />
    <Field name="rootBasis" label="确认根因的依据" initial={debt?.rootCause?.basis} multiline />
    <Field name="direction" label="期望方向" initial={debt?.direction?.target} multiline max={2000} />
    <Field name="criteria" label="偿还标准（每行一项）" initial={debt?.criteria.map(row => row.text).join('\n')} multiline />
  </>;
}

function debtInput(form: FormData): Partial<DebtDraft> {
  const rootState = field(form, 'rootState') as RootCause['state'];
  const tags = field(form, 'tags').split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
  const direction = optional(form, 'direction');
  return {
    summary: optional(form, 'summary'), whyDebt: optional(form, 'whyDebt'), priority: field(form, 'priority') as DebtDraft['priority'],
    owner: optional(form, 'owner'), dueAt: optional(form, 'dueAt'), trigger: optional(form, 'trigger'), impact: optional(form, 'impact'),
    criteria: lines(optional(form, 'criteria')) ?? [], tags, module: optional(form, 'module'),
    rootCause: { state: rootState, text: optional(form, 'rootText'), basis: optional(form, 'rootBasis') },
    direction: direction ? { target: direction } : undefined,
  };
}

function debtPatch(form: FormData, debt: PlanningDebt): DebtPatch {
  const fields = debtInput(form);
  const target = fields.direction?.target;
  const approaches = debt.direction?.approaches;
  return {
    ...fields, title: field(form, 'title'),
    summary: fields.summary ?? null, whyDebt: fields.whyDebt ?? null, impact: fields.impact ?? null,
    trigger: fields.trigger ?? null, owner: fields.owner ?? null, module: fields.module ?? null, dueAt: fields.dueAt ?? null,
    direction: target || approaches?.length ? { target, approaches } : null,
  };
}

function actionTitle(action: PlanningAction) {
  switch (action.kind) {
    case 'create': return action.record === 'debt' ? '记一笔债' : action.record === 'plan' ? '新建落地计划' : '记一个决策';
    case 'import': return '批量导入债务';
    case 'reject': return '驳回提案';
    case 'health': return debtHealthTitle(action.debt, action.mode);
    case 'debt': return debtActions[action.action];
    case 'decision': return decisionActions[action.action];
    case 'step': return action.step ? '更新步骤' : '添加步骤';
    case 'schedule': return '排进落地计划';
  }
}

function decisionOptions(board: PlanningBoard) {
  return board.decisions.filter(row => row.status !== 'superseded' && row.status !== 'deprecated').map(row => [row.id, row.title] as const);
}

function DecisionFields({ decision }: { decision?: PlanningDecision }) {
  const [options, setOptions] = useState((decision?.options ?? []).map((option, idx) => ({ ...option, id: idx + 1 })));
  const [chosen, setChosen] = useState(decision?.chosenOption ?? '');
  const nextOption = useRef(options.length + 1);
  return <>
    <Field name="decisionKind" label="决策类型" initial={decision?.decisionKind ?? 'forward'} choices={[[ 'forward', '正向决策' ], ['debt', '债务决策' ]]} />
    <fieldset className="ep-decision-options-form">
      <legend>候选方案</legend>
      {options.map((option, index) => <div className="ep-decision-option-fields" key={option.id}>
        <label className="ep-field"><span>方案 {index + 1}</span><input name="optionTitle" value={option.title} maxLength={120}
          onChange={event => {
            const title = event.target.value;
            setOptions(current => current.map(row => row.id === option.id ? { ...row, title } : row));
            if (option.title && chosen === option.title) setChosen(title);
          }} required /></label>
        <div className="ep-form-pair">
          <Field name="optionBenefits" label="好处" initial={option.benefits} max={2000} multiline />
          <Field name="optionDrawbacks" label="代价" initial={option.drawbacks} max={2000} multiline />
        </div>
        <button className="ep-text-button" type="button" onClick={() => {
          setOptions(current => current.filter(row => row.id !== option.id));
          if (option.title === chosen) setChosen('');
        }}>移除此方案</button>
      </div>)}
      {options.length < 12 && <button className="ep-button" type="button" onClick={() => {
        const id = nextOption.current++;
        setOptions(current => [...current, { id, title: '', benefits: undefined, drawbacks: undefined }]);
      }}>添加方案</button>}
      <label className="ep-field"><span>决定采用</span><select name="chosenOption" value={chosen} onChange={event => setChosen(event.target.value)}>
        <option value="">仍在比较</option>{options.filter(row => row.title).map(row => <option key={row.id} value={row.title}>{row.title}</option>)}
      </select></label>
    </fieldset>
    <Field name="consequences" label="预期后果" initial={decision?.consequences} multiline />
    <Field name="aliases" label="日常说法（每行一个）" initial={decision?.aliases?.join('\n')} multiline />
    <Field name="appliesTo" label="适用对象（每行填类型和名称）" initial={decision?.appliesTo?.map(item => item.kind + ' ' + item.ref).join('\n')}
      placeholder="例如 config PREVIEW_PASSWORD" multiline />
    <div className="ep-form-pair">
      <Field name="provenanceLevel" label="证据等级" initial={decision?.provenance?.level ?? ''}
        choices={[[ '', '未填写' ], ['original','原始记录'], ['backfilled','补录'], ['inferred','推断']]} />
      <Field name="provenanceUrl" label="原始依据链接" initial={decision?.provenance?.url} />
      <Field name="occurredOn" label="原始日期" initial={decision?.provenance?.occurredOn} date />
      <Field name="decidedBy" label="原决定者" initial={decision?.provenance?.decidedBy} />
    </div>
    <Field name="evidenceBasis" label="推断或补录依据" initial={decision?.provenance?.basis} multiline />
    <Field name="decisionLinks" label="决策文档（每行一个链接）" initial={decision?.links?.map(item => item.url).join('\n')} multiline />
    <Field name="pullRequestUrl" label="GitHub PR 链接" initial={decision?.pullRequest?.url} />
    <div className="ep-form-pair">
      <Field name="destinationLabel" label="预览目的地" initial={decision?.pullRequest?.target?.label} max={160} />
      <Field name="destinationPath" label="预览页面路径" initial={decision?.pullRequest?.target?.path} />
    </div>
  </>;
}

function decisionInput(form: FormData, previous?: PlanningDecision) {
  const benefits = form.getAll('optionBenefits').map(value => String(value).trim());
  const drawbacks = form.getAll('optionDrawbacks').map(value => String(value).trim());
  const options = form.getAll('optionTitle').map((value, index) => ({
    title: String(value).trim(), benefits: benefits[index] || undefined, drawbacks: drawbacks[index] || undefined,
  }));
  const aliases = lines(optional(form, 'aliases')) ?? [];
  const subjects = (lines(optional(form, 'appliesTo')) ?? []).map(value => {
    const [kind, ...name] = value.split(/\s+/);
    if (!['feature','config','preview','module'].includes(kind) || !name.length) throw new Error('适用对象每行填写类型和名称');
    return { kind: kind as 'feature' | 'config' | 'preview' | 'module', ref: name.join(' ') };
  });
  const level = optional(form, 'provenanceLevel') as NonNullable<DecisionStructure['provenance']>['level'] | undefined;
  const provenanceUrl = optional(form, 'provenanceUrl');
  const basis = optional(form, 'evidenceBasis');
  if ((level || provenanceUrl) && (!level || !provenanceUrl)) throw new Error('请同时填写原始依据和证据等级');
  if (level === 'inferred' && !basis) throw new Error('推断需要说明依据');
  const structure: DecisionStructure = { decisionKind: field(form, 'decisionKind') as DecisionStructure['decisionKind'],
    options, chosenOption: optional(form, 'chosenOption'), consequences: optional(form, 'consequences'),
    aliases, appliesTo: subjects,
    provenance: level && provenanceUrl ? { level, url: provenanceUrl, occurredOn: optional(form, 'occurredOn'),
      decidedBy: optional(form, 'decidedBy'), basis } : undefined };
  const links: PlanningDecisionLink[] = (lines(optional(form, 'decisionLinks')) ?? []).map(url =>
    previous?.links?.find(link => link.url === url) ?? { type: /\/adr(?:\/|[-_])/i.test(url) ? 'adr' : 'doc', title: url.slice(0, 200), url });
  const url = optional(form, 'pullRequestUrl');
  const label = optional(form, 'destinationLabel');
  const path = optional(form, 'destinationPath');
  if ((label || path) && (!url || !label || !path)) throw new Error('请填写预览目的地、页面路径和对应的 GitHub PR 链接');
  return { structure, links, pullRequest: url ? { url, ...(label && path ? { target: { label, path } } : {}) } : undefined };
}

function RepaymentCheck({ criterion, number, verdict, onChange }: {
  criterion: Criterion; number: number; verdict?: string; onChange: (verdict: string) => void;
}) {
  const id = criterion.id;
  const isNotApplicable = verdict === 'na';
  return <fieldset className="ep-repay-check" aria-labelledby={`criterion-title-${id}`}>
    <div className="ep-repay-check-head">
      <strong id={`criterion-title-${id}`}>{number}. {criterion.text}</strong>
      <div className="ep-verdicts" role="radiogroup" aria-label={criterion.text}>
        {([['met', '达标'], ['unmet', '未达标'], ['na', '不适用']] as const).map(([value, label]) =>
          <label key={value} data-verdict={value}>
            <input className="sr-only" type="radio" name={`result-${id}`} value={value} checked={verdict === value}
              onChange={() => onChange(value)} required />{label}
          </label>)}
      </div>
    </div>
    <Field name={`note-${id}`} label={isNotApplicable ? '不适用说明' : '实际结果'} required={isNotApplicable}
      placeholder={isNotApplicable ? '说明为什么不适用（必填）' : '实际结果，例如查询 p95 = 220ms'} />
    <div className="ep-repay-proof-line">
      <Field name={`proof-type-${id}`} label="证据类型" initial="test" choices={Object.entries(evidenceLabels)} />
      <Field name={`proof-label-${id}`} label="证据说明（可选）" placeholder="证据说明（可选）" max={500} />
      <Field name={`proof-url-${id}`} label="证据链接（可选）" placeholder="链接（可选）" />
    </div>
  </fieldset>;
}

function RepaymentFields({ action, verdicts, onVerdict, onScreenshotReady }: {
  action: Extract<PlanningAction, { kind: 'debt' }>; verdicts: Record<string, string>;
  onVerdict: (id: string, verdict: string) => void; onScreenshotReady: (ready: boolean) => void;
}) {
  return <>
    <section className="ep-repay-section" aria-label="逐项核对偿还标准">
      {action.debt.criteria.map((criterion, index) => <RepaymentCheck key={criterion.id} criterion={criterion} number={index + 1}
        verdict={verdicts[criterion.id]} onChange={value => onVerdict(criterion.id, value)} />)}
      {Object.values(verdicts).includes('unmet') && <p className="ep-error" role="status">还有未达标的核对项。补完修复后再确认偿还。</p>}
    </section>
    <fieldset className="ep-repay-section ep-collateral">
      <legend>这次改动顺带还掉了</legend>
      <p className="ep-caption">{action.collateralCandidates?.length ? '核对标准相同的债务可以共享这次偿还证据。' : '当前没有偿还标准相同的待还债务。'}</p>
      {action.collateralCandidates?.map(item => <label className="ep-check" key={item.id}>
        <input type="checkbox" name="collateral" value={item.id} /><code>{shortId(item.id)}</code> {item.title}
      </label>)}
    </fieldset>
    <DebtScreenshotFields onReadyChange={onScreenshotReady} />
    <Field name="repaymentPrs" label="关联 PR（可选，每行一个链接）" multiline />
    <Field name="summary" label="实际做了什么" required multiline max={6000} />
  </>;
}

const mergeFields = { title: '标题', summary: '问题概况', owner: '负责人' } as const;
type MergeField = keyof typeof mergeFields;
function DuplicateResolutionFields({ action }: { action: Extract<PlanningAction, { kind: 'debt' }> }) {
  const candidates = action.duplicateCandidates ?? [];
  const [choice, setChoice] = useState(candidates.length === 1 ? candidates[0].id : '');
  const other = candidates.find(row => row.id === choice);
  return <>
    <label className="ep-field"><span>候选债务</span><select name="fromId" required value={choice} onChange={event => setChoice(event.target.value)}>
      <option value="">选择债务</option>{candidates.map(row => <option key={row.id} value={row.id}>{shortId(row.id)} · {row.title}</option>)}
    </select></label>
    {other && action.action === 'merge' && <div className="ep-merge-compare" key={other.id}>
      <b>字段</b><b>保留当前 {shortId(action.debt.id)}</b><b>采用 {shortId(other.id)}</b>
      {(Object.keys(mergeFields) as MergeField[]).map(key => <div className="ep-merge-row" key={key}>
        <strong>{mergeFields[key]}</strong>
        <label><input type="radio" name={`choose-${key}`} value="keep" defaultChecked />{action.debt[key] || '未填写'}</label>
        <label><input type="radio" name={`choose-${key}`} value="from" />{other[key] || '未填写'}</label>
      </div>)}
    </div>}
    <Field name="reason" label={action.action === 'merge' ? '确认重复的依据' : '两笔债务的区别'} required multiline />
  </>;
}

function LinkedDebtsField({ projectId, legend }: { projectId: string; legend: string }) {
  const [search, setSearch] = useState('');
  const [q, setQuery] = useState('');
  const [picked, setPicked] = useState<Pick<PlanningDebt, 'id' | 'title'>[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [search]);
  const query = new URLSearchParams({ view: 'unpaid', limit: '12', sort: 'deadline', ...(q ? { q } : {}) });
  const { data, error, loading } = usePlanningRead<PlanningDebtList>(`${planningPath(projectId)}/debts?${query}`, 0);
  const choices = [...picked, ...(data?.items ?? []).filter(row => !picked.some(item => item.id === row.id))];
  return <fieldset className="ep-repay-section ep-collateral ep-linked-debts">
    <legend>{legend}</legend>
    <label className="ep-field"><span>查找项目债务</span><input type="search" value={search} maxLength={200}
      onChange={event => setSearch(event.target.value)} /></label>
    {error && <p className="ep-error" role="status">{error}</p>}
    {!error && !choices.length && <p className="ep-caption">{loading ? '读取待还债务…' : '没有符合条件的待还债务'}</p>}
    <div className="ep-linked-items">{choices.map(({ id, title }) => <label className="ep-check" key={id}>
      <input type="checkbox" checked={picked.some(row => row.id === id)} onChange={event => {
        const checked = event.target.checked;
        setPicked(current => checked ? [...current, { id, title }] : current.filter(row => row.id !== id));
      }} /><code>{shortId(id)}</code> {title}
    </label>)}</div>
    <input type="hidden" name="linkedDebts" value={JSON.stringify(picked)} />
    {data?.nextCursor && <p className="ep-caption">输入编号或关键词可查找更多待还债务。</p>}
  </fieldset>;
}

function DebtReviewFields() {
  const [next, setNext] = useState('start');
  return <>
    <label className="ep-field"><span>回看结论</span><select name="next" value={next} onChange={event => setNext(event.target.value)}>
      <option value="start">开始处理</option><option value="defer">继续暂缓</option><option value="drop">不再需要</option>
    </select></label>
    {next === 'defer' && <Field name="reviewAt" label="下次回看日期" date required />}
    <Field name="reason" label="回看依据" required multiline max={2000} />
  </>;
}

function actionFields(action: PlanningAction, board: PlanningBoard, duplicateCheck?: ReactNode, onTitle?: (title: string) => void): ReactNode {
  switch (action.kind) {
    case 'create': return <>
      <Field name="title" label="标题" required max={120} onValue={onTitle} />
      {duplicateCheck}
      <SourceFields />
      {action.record === 'debt' ? <><Field name="decisionId" label="所属决策" initial={action.decisionId} choices={[[ '', '未归属决策' ], ...decisionOptions(board)]} /><DebtFields /></>
        : <><Field name="summary" label="概况" multiline /><Field name="owner" label="负责人" max={120} />
          {action.record === 'decision' ? <><Field name="rationale" label="决策与取舍" multiline /><Field name="reviewAt" label="复核日期" date />
            <DecisionFields /><LinkedDebtsField projectId={board.projectId} legend="计划解决的债务" /></>
            : <><Field name="decisionId" label="关联决策" choices={[[ '', '未关联' ], ...decisionOptions(board)]} />
              <div className="ep-form-pair"><Field name="startAt" label="开始日期" date /><Field name="dueAt" label="计划期限" date /></div>
              <Field name="initialTasks" label="初始步骤（每行一个任务）" multiline />
              <LinkedDebtsField projectId={board.projectId} legend="要还的债" /></>}</>}
    </>;
    case 'reject': return <Field name="reason" label="驳回原因" required multiline />;
    case 'health': return null;
    case 'debt': {
      const row = action.debt;
      switch (action.action) {
        case 'edit': return <><Field name="title" label="标题" initial={row.title} required max={120} /><DebtFields debt={row} /></>;
        case 'branch': return <><Field name="decisionId" label="重新归属" initial={row.decisionId} choices={[[ '', '未归属决策' ], ...decisionOptions(board)]} />
          <Field name="reason" label="改挂原因" required multiline /></>;
        case 'defer': return <><Field name="reviewAt" label="下次回看日期" required date initial={row.reviewAt && row.reviewAt > board.today ? row.reviewAt : undefined} />
          <Field name="reason" label="暂缓原因" required multiline /></>;
        case 'review': return <DebtReviewFields />;
        case 'progress': return <><Field name="note" label="进展说明" required multiline />
          <div className="ep-form-pair">
            <Field name="progressEvidence" label="验证依据（选填）" max={500} />
            <Field name="progressEvidenceUrl" label="验证链接（选填）" />
          </div></>;
        case 'hit': return <Field name="note" label="在哪里又遇到了问题" required multiline />;
        case 'repay': return null;
        case 'reopen': return <><Field name="reason" label="复发情况与重开原因" required multiline />
          <Field name="reopenProof" label="复发证据说明（可选）" max={500} /><Field name="reopenUrl" label="复发证据链接（可选）" /></>;
        case 'merge':
        case 'not-duplicate': return <DuplicateResolutionFields action={action} />;
        case 'drop': return <>
          <Field name="outcome" label="失效原因类别" choices={[[ 'cancelled', '取消' ], ['superseded', '替代']]} />
          <Field name="reason" label="失效依据" required multiline />
          <Field name="targetId" label="承接债务编号（替代时必填）" />
          <Field name="evidenceLabel" label="验证说明（可选）" max={500} />
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
      {action.action === 'amended' && <DecisionFields decision={action.decision} />}
    </>;
    case 'step': return action.step ? <>
      <Field name="status" label="步骤状态" initial={action.initialStatus ?? action.step.status} choices={[[ 'todo', '待处理' ], ['doing', '进行中'], ['done', '完成']]} />
      <Field name="note" label="状态变化依据" required multiline />
    </> : <>
      <Field name="title" label="步骤标题" initial={action.initialTitle} required max={120} />
      <Field name="stepKind" label="步骤类型" initial={action.initialKind} choices={Object.entries(stepKindLabels)} />
      <Field name="relatedId" label="相关决策、债务或稿件编号" initial={action.initialRelatedId} />
      <Field name="dueAt" label="步骤期限" date />
      <Field name="stepOwner" label="步骤负责人" max={120} />
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
      if (action.record === 'debt') return { type: 'debt.create', ...debtInput(form), title, source,
        decisionId: optional(form, 'decisionId'), ...(form.has('assignToSelf') ? { assignToSelf: true } : {}) };
      const common = { title, source, summary: optional(form, 'summary'), owner: optional(form, 'owner') };
      const linked = JSON.parse(field(form, 'linkedDebts') || '[]') as Pick<PlanningDebt, 'id' | 'title'>[];
      if (action.record === 'decision') {
        const { structure, ...links } = decisionInput(form);
        return { type: 'decision.create', ...common, ...structure, ...links, rationale: optional(form, 'rationale'),
          reviewAt: optional(form, 'reviewAt'), ...(linked.length ? { resolves: linked.map(row => row.id) } : {}) };
      }
      const dueAt = optional(form, 'dueAt');
      const initialSteps: PlanningStepDraft[] = [...(lines(optional(form, 'initialTasks')) ?? []).map(task => ({ kind: 'task' as const, title: task })),
        ...linked.map(row => ({ kind: 'debt' as const, title: row.title, relatedId: row.id, dueAt }))];
      return { type: 'plan.create', ...common, decisionId: optional(form, 'decisionId'), startAt: optional(form, 'startAt'), dueAt,
        ...(initialSteps.length ? { initialSteps } : {}) };
    }
    case 'reject': return { type: 'proposal.reject', proposalId: action.proposal.id, reason };
    case 'decision': {
      const draft = action.action === 'amended' ? decisionInput(form, action.decision) : undefined;
      return { type: 'decision.change', change: action.action, decisionId: action.decision.id, expectedVersion: action.decision.version, reason,
        ...(action.action === 'superseded' ? { successorId: field(form, 'successorId'), transfer: form.has('transfer') } : {}),
        ...(draft ? { ...draft, pullRequest: draft.pullRequest ?? null } : {}),
      };
    }
    case 'schedule': {
      const target = board.plans.find(plan => plan.id === field(form, 'planId'));
      if (!target) throw new Error('请选择当前项目的落地计划');
      return { type: 'plan.add-step', planId: target.id, expectedVersion: target.version, kind: 'debt', title: action.debt.title, relatedId: action.debt.id, dueAt: optional(form, 'dueAt') };
    }
    case 'step': {
      const common = { planId: action.plan.id, expectedVersion: action.plan.version };
      return action.step
        ? { type: 'plan.step', ...common, stepId: action.step.id, status: field(form, 'status') as 'todo' | 'doing' | 'done', note: field(form, 'note') }
        : { type: 'plan.add-step', ...common, title: field(form, 'title'), kind: field(form, 'stepKind') as PlanningStep['kind'],
          relatedId: optional(form, 'relatedId'), dueAt: optional(form, 'dueAt'), owner: optional(form, 'stepOwner') };
    }
    case 'debt': {
      const common = { debtId: action.debt.id, expectedVersion: action.debt.version };
      switch (action.action) {
        case 'edit': return { type: 'debt.update', ...common, patch: debtPatch(form, action.debt) };
        case 'branch': return { type: 'debt.branch', ...common, decisionId: optional(form, 'decisionId') ?? null, reason };
        case 'defer': return { type: 'debt.defer', ...common, reason, reviewAt: field(form, 'reviewAt') };
        case 'review': return { type: 'debt.review', ...common, next: field(form, 'next') as 'start' | 'defer' | 'drop', reason, reviewAt: optional(form, 'reviewAt') };
        case 'progress': {
          const label = optional(form, 'progressEvidence'), url = optional(form, 'progressEvidenceUrl');
          return { type: 'debt.progress', ...common, note: field(form, 'note'),
            ...(label || url ? { evidence: [{ type: 'test', label: label || '进展验证', url }] } : {}) };
        }
        case 'hit': return { type: 'debt.hit', ...common, note: field(form, 'note') };
        case 'reopen': {
          const label = optional(form, 'reopenProof'), url = optional(form, 'reopenUrl');
          return { type: 'debt.reopen', ...common, reason, ...(label || url ? { evidence: [{ type: 'test', label: label || '复发证据', url }] } : {}) };
        }
        case 'merge': {
          const other = action.duplicateCandidates?.find(item => item.id === field(form, 'fromId'));
          if (!other) throw new Error('请先选择一笔重复债务');
          const takeFrom = (Object.keys(mergeFields) as MergeField[]).filter(key => field(form, `choose-${key}`) === 'from');
          return { type: 'debt.merge', ...common, fromId: other.id, fromVersion: other.version, reason, takeFrom };
        }
        case 'not-duplicate': {
          const other = action.duplicateCandidates?.find(item => item.id === field(form, 'fromId'));
          if (!other) throw new Error('请先选择一笔候选债务');
          return { type: 'debt.not-duplicate', ...common, fromId: other.id, fromVersion: other.version, reason };
        }
        case 'repay': {
          const evidence: PlanningEvidence[] = (lines(optional(form, 'repaymentPrs')) ?? []).map(url => {
            let path: string;
            try { path = new URL(url).pathname; } catch { throw new Error('请为关联 PR 填写完整链接'); }
            const number = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:\/|$)/.exec(path)?.[1];
            return { type: 'change', label: number ? `PR #${number}` : '关联 PR', url };
          });
          const results = action.debt.criteria.map<CriterionResult>(row => {
            const verdict = field(form, `result-${row.id}`);
            if (verdict !== 'met' && verdict !== 'na') throw new Error('请逐项确认已经达标或说明为何不适用');
            const label = optional(form, `proof-label-${row.id}`);
            const url = optional(form, `proof-url-${row.id}`);
            const proof: PlanningEvidence | undefined = label || url ? {
              type: field(form, `proof-type-${row.id}`) as PlanningEvidence['type'], label: label || '证据链接', url,
            } : undefined;
            return { criterionId: row.id, verdict, note: optional(form, `note-${row.id}`), ...(proof ? { evidence: [proof] } : {}) };
          });
          const selected = new Set(form.getAll('collateral').map(String));
          const collateral = (action.collateralCandidates ?? []).filter(row => selected.has(row.id))
            .map(row => ({ debtId: row.id, expectedVersion: row.version }));
          return { type: 'debt.repay', ...common, summary: field(form, 'summary'), results, evidence, collateral,
            repaymentProofs: JSON.parse(field(form, 'repaymentProofs')) as PlanningRepaymentProof[] };
        }
        case 'drop': {
          const label = optional(form, 'evidenceLabel');
          return { type: 'debt.drop', ...common, kind: field(form, 'outcome') as 'cancelled' | 'superseded', reason,
            targetId: optional(form, 'targetId'), evidence: label ? [{ type: 'doc', label }] : undefined };
        }
      }
    }
    case 'import': throw new Error('请先预览导入内容');
    case 'health': throw new Error('请通过债务认证与功能绑定表单保存');
  }
}
export function PlanningActionDialog({ action, board, busy, error, returnFocusTo, onClose, onSubmit, onOpenRecord }: {
  action: PlanningAction; board: PlanningBoard; busy: boolean; error: string;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void; onSubmit: (input: PlanningInput) => void; onOpenRecord: (item: PlanningSelection) => void;
}) {
  const [validation, setValidation] = useState('');
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  const [screenshotReady, setScreenshotReady] = useState(false);
  const [repaymentNotes, setRepaymentNotes] = useState<Record<string, string>>({});
  const [enteredTitle, setEnteredTitle] = useState('');
  const [checkedTitle, setCheckedTitle] = useState('');
  const creatingDebt = action.kind === 'create' && action.record === 'debt';
  useEffect(() => {
    if (!creatingDebt || !enteredTitle.trim()) { setCheckedTitle(''); return; }
    const timer = window.setTimeout(() => setCheckedTitle(enteredTitle.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [creatingDebt, enteredTitle]);
  const candidates = usePlanningRead<{ projectId: string; items: PlanningDuplicateCandidate[] }>(
    creatingDebt && checkedTitle && checkedTitle === enteredTitle.trim() ? `${planningPath(board.projectId)}/duplicates?${new URLSearchParams({ title: checkedTitle })}` : null, error ? 1 : 0,
  ).data?.items;
  const sourceRef = useRef('');
  const repayment = action.kind === 'debt' && action.action === 'repay' ? action : undefined;
  const ready = !repayment || (screenshotReady && !!repaymentNotes.summary && repayment.debt.criteria.length > 0
    && repayment.debt.criteria.every(row => verdicts[row.id] === 'met' || (verdicts[row.id] === 'na' && !!repaymentNotes[`note-${row.id}`])));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    if (!sourceRef.current) sourceRef.current = `web:${crypto.randomUUID()}`;
    const form = new FormData(event.currentTarget);
    try {
      setValidation('');
      const input = actionCommand(action, form, board, sourceRef.current);
      if (input.type === 'debt.create' && field(form, 'distinctReason') && candidates?.length) {
        input.distinction = { debtIds: candidates.map(row => row.id), reason: field(form, 'distinctReason') };
      }
      onSubmit(input);
    } catch (error) { setValidation(error instanceof Error ? error.message : '请核对表单内容'); }
  }
  const title = actionTitle(action);
  const description = repayment ? '逐条核对标准并写明实际结果。达标或说明不适用后，用带标记的偿还后截图证明问题已解决。'
    : action.kind === 'debt' || action.kind === 'health' ? action.debt.title : action.kind === 'reject' ? action.proposal.draft.title
    : action.kind === 'decision' ? action.decision.title : action.kind === 'step' ? action.plan.title : '变更保存到当前项目';
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className={`ep-dialog ep-dialog--form${repayment ? ' ep-dialog--repay' : ''}`} overlayClassName="ep-dialog-overlay" frame
      style={repayment ? { maxHeight: 'var(--ep-repay-max-height, 90dvh)' } : undefined}
      onInteractOutside={event => event.preventDefault()} onCloseAutoFocus={event => {
        if (!returnFocusTo?.isConnected || returnFocusTo.matches(':disabled') || !returnFocusTo.getClientRects().length) return;
        event.preventDefault();
        returnFocusTo.focus({ preventScroll: true });
      }}>
      <DialogHeader className="ep-dialog-head"><DialogTitle>{title}{repayment && <span className="ep-repay-record" aria-hidden="true"> · {shortId(repayment.debt.id)}</span>}</DialogTitle>
        <DialogDescription>{description}</DialogDescription></DialogHeader>
      {action.kind === 'import' ? <PlanningImportForm projectId={board.projectId} busy={busy} error={error} onCancel={onClose} onSubmit={onSubmit} />
        : action.kind === 'health' ? <div className="ep-dialog-content"><DebtHealthForm debt={action.debt} mode={action.mode}
        busy={busy} error={error} onCancel={onClose} onSubmit={onSubmit} /></div> : <form className="ep-dialog-form" onSubmit={submit}
        onChange={event => {
          if (!repayment) return;
          const input = event.target;
          if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
          if (input.name === 'summary' || input.name.startsWith('note-')) {
            const { name, value } = input;
            setRepaymentNotes(current => ({ ...current, [name]: value.trim() }));
          }
        }}>
        <div className="ep-dialog-content">
          {repayment ? <RepaymentFields action={repayment} verdicts={verdicts}
            onVerdict={(id, verdict) => setVerdicts(current => ({ ...current, [id]: verdict }))} onScreenshotReady={setScreenshotReady} />
            : actionFields(action, board, !!candidates?.length && <section className="ep-debt-similar" aria-label="可能已经记过">
              <strong>可能已经记过</strong>
              {candidates.map(row => <button className="ep-text-button" type="button" key={row.id} onClick={() => {
                onClose(); onOpenRecord({ kind: 'debt', id: row.id });
              }}>{shortId(row.id)} · {row.title}{row.status === 'repaid' && ' · 已偿还，可查看和重开'}</button>)}
              <Field name="distinctReason" label="仍需单独记录时，说明区别" max={2000} />
            </section>, creatingDebt ? setEnteredTitle : undefined)}
          {(validation || error) && <p className="ep-error" role="alert">{validation || error}</p>}
        </div>
        <div className="ep-dialog-footer">
          <button type="button" className="ep-button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="ep-button ep-button--primary" disabled={busy || !ready}>
            {busy ? '正在保存…' : action.kind === 'debt' && action.action === 'repay' ? '确认偿还'
                : action.kind === 'reject' ? '确认驳回' : '保存'}
          </button>
        </div>
      </form>}
    </DialogContent>
  </Dialog>;
}

const debtTarget = (id: string, target: PlanningBriefTarget) => `planning-debt-${id}-${target}`;
const eventTarget = (id: string) => `planning-event-${id}`;
const debtHeadingTones = { open: 'quiet', deferred: 'warning', in_progress: 'info', repaid: 'success', dropped: 'quiet' } as const;
type OpenPlanningAction = (action: PlanningAction, returnFocusTo?: HTMLElement | null) => void;

function DebtHeading({ debt, projectLabel, today }: { debt: PlanningDebt; projectLabel: string; today: string }) {
  const recorded = debt.discoveredAt || debt.createdAt.slice(0, 10);
  const age = Math.max(0, Math.floor((Date.parse(today) - Date.parse(recorded)) / 86_400_000));
  return <DialogHeader className="ep-dialog-head ep-debt-head ep-citation-target" id={debtTarget(debt.id, 'header')} tabIndex={-1}>
    <div className="ep-debt-headline">
      <DebtCoin debt={debt} />
      <div className="ep-debt-heading">
        <div className="ep-debt-kicker">
          <code className="ep-id" title={debt.id}>{shortId(debt.id)}</code>
          <PlanningBadge tone={debtHeadingTones[debt.status]}>{debtState(debt)}</PlanningBadge>
          <DebtPriorityBadge priority={debt.priority} />
        </div>
        <DialogTitle>{debt.title}<DebtHealthBadge debt={debt} /></DialogTitle>
      </div>
      <div className="ep-debt-deadline"><DebtDeadline debt={debt} today={today} large /></div>
    </div>
    <DialogDescription className="sr-only">{debt.id}</DialogDescription>
    <div className="ep-debt-meta">
      <span title={projectLabel}><Folder />{projectLabel}</span>
      <span title={debt.owner}><UserRound />{debt.owner ? `负责人 ${debt.owner}` : '待认领'}</span>
      <span><CalendarDays />记于 {Number(recorded.slice(5, 7))}月{Number(recorded.slice(8))}日 · 负债 {age} 天</span>
      <span title={debt.source.ref}><Link2 />{sourceLabels[debt.source.type]} · {debt.source.url
        ? <a href={debt.source.url} target="_blank" rel="noreferrer">{debt.source.ref}</a> : debt.source.ref}</span>
    </div>
  </DialogHeader>;
}

export function PlanningDetailDialog({
  item, board, detail, projectLabel, loading, error, actionsDisabled, onClose, onRetry, onSelect, onAction, onBranch, onOpenList, onBack,
}: {
  item: PlanningSelection; board: PlanningBoard; detail?: PlanningDebtDetail; projectLabel: string; loading: boolean; error?: string;
  actionsDisabled: boolean;
  onClose: () => void; onRetry: () => void; onSelect: (item: PlanningSelection) => void; onAction: OpenPlanningAction;
  onBranch: (id: string) => void; onOpenList: (id: string) => void; onBack?: () => void;
}) {
  const debt = item.kind === 'debt' ? detail?.debt : undefined;
  const decision = item.kind === 'decision' ? board.decisions.find(row => row.id === item.id) : undefined;
  const plan = item.kind === 'plan' ? board.plans.find(row => row.id === item.id) : undefined;
  const record = debt ?? decision ?? plan;
  const write = board.permissions.includes('write');
  const scroll = useRef<HTMLDivElement>(null);
  const lastRecord = useRef<string>();
  const returnPoints = useRef(new Map<string, { scrollTop: number; signature?: string; occurrence: number }>());
  const controls = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('button, a[href], summary'));
  const signature = (element: HTMLElement) => element.dataset.planningFocus
    || JSON.stringify([element.tagName, element.getAttribute('aria-label'), element.textContent?.trim()]);
  useLayoutEffect(() => {
    const view = scroll.current;
    if (!view || loading || lastRecord.current === item.id) return;
    const first = lastRecord.current === undefined;
    lastRecord.current = item.id;
    const point = returnPoints.current.get(item.id);
    returnPoints.current.delete(item.id);
    view.scrollTop = point?.scrollTop ?? 0;
    if (first) return;
    const matches = point?.signature ? controls(view).filter(node => signature(node) === point.signature) : [];
    const control = point && matches[point.occurrence];
    (control || view).focus({ preventScroll: true });
  }, [item.id, loading]);
  function follow(next: PlanningSelection) {
    const active = document.activeElement;
    if (scroll.current) {
      const trigger = active instanceof HTMLElement && scroll.current.contains(active) ? active : null;
      const key = trigger ? signature(trigger) : undefined;
      const occurrence = trigger ? controls(scroll.current).filter(node => signature(node) === key).indexOf(trigger) : -1;
      returnPoints.current.set(item.id, { scrollTop: scroll.current.scrollTop, signature: key, occurrence });
    }
    onSelect(next);
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent frame className={`ep-dialog ep-dialog--detail${item.kind === 'debt' ? ' ep-dialog--debt-detail' : ''}`} overlayClassName="ep-dialog-overlay">
      <div className="ep-detail-strip">
        <PlanningBadge tone={item.kind === 'debt' ? 'accent' : 'info'}>{kindLabels[item.kind]}</PlanningBadge>
        <code title={item.id}>{shortId(item.id)}</code>
        {onBack && <button type="button" onClick={onBack}>返回上一项</button>}
        {item.kind === 'debt' && <button type="button" className="ep-open-in-list" onClick={() => onOpenList(item.id)}>在「清单」上打开</button>}
        <span className="ep-escape-help">Esc 关闭</span>
      </div>
      <div className="ep-dialog-content ep-detail-scroll" ref={scroll} tabIndex={-1}>
        {debt ? <DebtHeading debt={debt} projectLabel={projectLabel} today={board.today} />
          : decision ? <DecisionHeading row={decision} projectLabel={projectLabel} />
          : plan ? <PlanHeading plan={plan} projectLabel={projectLabel} options={{ board, write, actionsDisabled, onAction }} />
          : <DialogHeader className="ep-dialog-head"><DialogTitle>{record?.title ?? `${kindLabels[item.kind]}详情`}</DialogTitle>
            <DialogDescription>{record?.id ?? kindLabels[item.kind]}</DialogDescription></DialogHeader>}
        <div className="ep-detail">
          {loading ? <ContentLoading variant="rows" label="正在读取记录" /> : error ? <div role="alert" className="ep-error">{error}<button type="button" className="ep-button" onClick={onRetry}>重试</button></div>
            : !record ? <PlanningEmpty>没有可访问的记录</PlanningEmpty> : null}
          {record && write && actionsDisabled && <p className="ep-caption" role="status">正在同步记录</p>}
          {item.kind === 'debt' && detail && <DebtDetails data={detail} board={board} write={write} actionsDisabled={actionsDisabled} onSelect={follow} onAction={onAction} />}
          {decision && <DecisionDetails key={decision.id} row={decision} board={board} write={write}
            actionsDisabled={actionsDisabled} onSelect={follow} onAction={onAction} onBranch={onBranch} />}
          {plan && <PlanDetails key={plan.id} plan={plan} board={board} write={write} actionsDisabled={actionsDisabled} onSelect={follow} onAction={onAction} />}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

function DebtDetails({ data, board, write, actionsDisabled, onSelect, onAction }: {
  data: PlanningDebtDetail; board: PlanningBoard; write: boolean; actionsDisabled: boolean;
  onSelect: (item: PlanningSelection) => void; onAction: OpenPlanningAction;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [history, setHistory] = useState('all');
  const [pendingCitation, setPendingCitation] = useState<string>();
  const debt = data.debt;
  const active = !closedDebt(debt.status);
  const assigned = board.decisions.find(row => row.id === debt.decisionId);
  const origin = board.decisions.find(row => row.id === debt.originDecisionId);
  const repayment = debt.repayment;
  const results = new Map(repayment?.results.map(result => [result.criterionId, result]));
  const earlierRepayments = data.events.filter(event => event.type === 'repaid' && event.entityId === debt.id && event.at !== repayment?.at);
  const edit = (action: Extract<PlanningAction, { kind: 'debt' }>['action'], returnFocusTo?: HTMLElement | null) =>
    onAction({ kind: 'debt', action, debt, collateralCandidates: data.collateralCandidates,
      duplicateCandidates: data.duplicateCandidates }, returnFocusTo);
  function focusCitation(id: string) {
    const target = document.getElementById(id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }
  useLayoutEffect(() => {
    if (!pendingCitation) return;
    focusCitation(pendingCitation);
    setPendingCitation(undefined);
  }, [pendingCitation]);
  function jumpToCitation(cite: PlanningBriefCitation) {
    if (cite.kind === 'decision' || cite.kind === 'plan') { onSelect({ kind: cite.kind, id: cite.id }); return; }
    const id = cite.kind === 'record' ? debtTarget(cite.id, cite.target) : eventTarget(cite.id);
    if (cite.kind === 'event' && history !== 'all') {
      setHistory('all'); setPendingCitation(id); return;
    }
    focusCitation(id);
  }
  return <>
    {write && <div className="ep-row ep-debt-actions">
      {active ? <>
        {debt.status === 'deferred' && debt.reviewAt && debt.reviewAt <= board.today && <button type="button" className="ep-button"
          disabled={actionsDisabled} onClick={() => edit('review')}><CalendarDays aria-hidden="true" />{debtActions.review}</button>}
        <button type="button" className="ep-button ep-button--primary" disabled={actionsDisabled || !debt.criteria.length}
          onClick={() => edit('repay')}><Check aria-hidden="true" />{debtActions.repay}</button>
        <button type="button" className="ep-button" disabled={actionsDisabled} onClick={() => edit('progress')}><MessageSquare aria-hidden="true" />{debtActions.progress}</button>
        <button type="button" className="ep-button" disabled={actionsDisabled} onClick={() => edit('edit')}><Pencil aria-hidden="true" />{debtActions.edit}</button>
        <button type="button" className="ep-button ep-debt-hit" disabled={actionsDisabled} onClick={() => edit('hit')}><Flame aria-hidden="true" />{debtActions.hit}</button>
        <DropdownMenu trigger={<button type="button" className="ep-button ep-debt-more" ref={more} disabled={actionsDisabled}
          aria-label="更多操作" title="更多操作"><MoreHorizontal aria-hidden="true" /></button>}>
          <DropdownItem onSelect={() => edit('defer', more.current)}>{debtActions.defer}</DropdownItem>
          <DropdownItem onSelect={() => edit('branch', more.current)}>{debtActions.branch}</DropdownItem>
          {!!data.duplicateCandidates?.length && <DropdownItem onSelect={() => edit('merge', more.current)}>{debtActions.merge}</DropdownItem>}
          {!!data.duplicateCandidates?.length && <DropdownItem onSelect={() => edit('not-duplicate', more.current)}>{debtActions['not-duplicate']}</DropdownItem>}
          {board.plans.length > 0 && <DropdownItem onSelect={() => onAction({ kind: 'schedule', debt }, more.current)}>排进落地计划</DropdownItem>}
          <DropdownItem destructive onSelect={() => edit('drop', more.current)}>{debtActions.drop}</DropdownItem>
        </DropdownMenu>
      </> : debt.outcome?.kind !== 'merged' && <button type="button" className="ep-button" disabled={actionsDisabled}
        onClick={() => edit('reopen')}>{debtActions.reopen}</button>}
    </div>}
    {!!data.duplicateCandidates?.length && <section className="ep-debt-similar" aria-label="疑似重复债务">
      <strong>疑似重复债务</strong>
      {data.duplicateCandidates.map(row => <button className="ep-text-button" type="button" key={row.id}
        onClick={() => onSelect({ kind: 'debt', id: row.id })}>{shortId(row.id)} · {row.title}</button>)}
    </section>}
    {data.brief && <DebtHandoffCard key={debt.id} brief={data.brief} debtId={debt.id} onCitation={jumpToCitation} />}
    {repayment && <section className="ep-surface ep-paid-banner" aria-label="已偿结论">
      <CheckCircle2 aria-hidden="true" /><div><h3>{repayment.mode === 'collateral' ? '连带偿还' : '已偿还'}</h3>
        <p>{repayment.summary}</p><span className="ep-caption">{repayment.by.label} · {dateLabel(repayment.at)}</span>
        {repayment.collateralOf && <button type="button" className="ep-text-button" onClick={() => onSelect({ kind: 'debt', id: repayment.collateralOf! })}>
          查看共同偿还的 {shortId(repayment.collateralOf)}
        </button>}
      </div>
    </section>}
    <section className="ep-surface ep-citation-target" id={debtTarget(debt.id, 'context')} tabIndex={-1} aria-label="债务上下文">
      <h3>债务上下文</h3>
      <dl className="ep-facts">
        <dt>问题概况</dt><dd>{debt.summary || '待补充'}</dd><dt>已知影响</dt><dd>{debt.impact || '待补充'}</dd>
        <dt>来源</dt><dd>{sourceLabels[debt.source.type]} · {debt.source.url ? <a href={debt.source.url} target="_blank" rel="noreferrer">{debt.source.ref}</a> : debt.source.ref}</dd>
        {debt.legacy && <><dt>原台账状态</dt><dd>{debt.legacy.originalStatus}
          {debt.legacy.status === 'repaid' && !repayment && ' · 待补 CDS 核验材料'}
          <p>{debt.legacy.path} · 第 {debt.legacy.line} 行 · <span title={debt.legacy.commit}>{debt.legacy.commit.slice(0, 12)}</span></p>
        </dd></>}
        <dt>根因</dt><dd>{debt.rootCause?.state === 'confirmed' ? '已确认' : debt.rootCause?.state === 'suspected' ? '推测' : '待查'}{debt.rootCause?.text && ` · ${debt.rootCause.text}`}{debt.rootCause?.basis && <p>{debt.rootCause.basis}</p>}</dd>
        <dt>欠债理由</dt><dd>{debt.whyDebt || '待补充'}</dd><dt>负责人</dt><dd>{debt.owner || '待认领'}</dd>
        {debt.module && <><dt>所属模块</dt><dd>{debt.module}</dd></>}
        <dt>回看日期</dt><dd>{debt.reviewAt || '未设置'}{debt.deferReason && ` · ${debt.deferReason}`}</dd>
        <dt>偿还计划</dt><dd>{[debt.dueAt, debt.trigger].filter(Boolean).join(' · ') || '未安排'}</dd>
        {debt.direction?.target && <><dt>期望方向</dt><dd>{debt.direction.target}</dd></>}
        {debt.direction?.approaches?.length ? <><dt>方案记录</dt><dd><ul className="ep-evidence">
          {debt.direction.approaches.map((row, index) => <li key={index}>
            {({ candidate: '候选', tried: '试过', rejected: '否决' })[row.status]} · {row.title}{row.note && ` · ${row.note}`}
          </li>)}
        </ul></dd></> : null}
        <dt>当前决策</dt><dd>{assigned ? <button type="button" className="ep-text-button" onClick={() => onSelect({ kind: 'decision', id: assigned.id })}>{assigned.title}</button> : '未归属决策'}</dd>
        {origin && origin.id !== assigned?.id && <><dt>来源决策</dt><dd><button type="button" className="ep-text-button" onClick={() => onSelect({ kind: 'decision', id: origin.id })}>{origin.title}</button></dd></>}
        {debt.tags?.length ? <><dt>标签</dt><dd>{debt.tags.join(' · ')}</dd></> : null}
      </dl>
      {!!data.pullRequests?.length && <PlanningPullRequestList pullRequests={data.pullRequests} />}
    </section>
    <section className="ep-surface ep-citation-target" id={debtTarget(debt.id, 'criteria')} tabIndex={-1} aria-label="偿还标准与证据">
      <h3>偿还标准与证据</h3>
      {debt.criteria.length ? <ol className="ep-criterion-results">{debt.criteria.map(row => {
        const result = results.get(row.id);
        return <li key={row.id}><div><strong>{row.text}</strong>{result && <PlanningBadge tone={result.verdict === 'met' ? 'success' : 'quiet'}>
          {result.verdict === 'met' ? '达标' : '不适用'}</PlanningBadge>}</div>{result?.note && <p>{result.note}</p>}
          <EvidenceList items={result?.evidence} /></li>;
      })}</ol> : <p>待补充偿还标准</p>}
      {repayment && <div className="ep-repayment-evidence"><h4>偿还记录</h4>
        <p>{repayment.summary} · {repayment.by.label} · {dateLabel(repayment.at)}</p>
        <DebtScreenshotGallery items={repayment.evidence} projectId={data.projectId} />
        <EvidenceList items={repayment.evidence.filter(item => !item.image)} />
      </div>}
      {earlierRepayments.map((event, index) => <div className="ep-repayment-evidence" key={event.id}>
        <h4>{!repayment && index === 0 ? '上一次偿还' : '历史偿还'} · {dateLabel(event.at)}</h4>
        <p>{event.repayment?.summary ?? event.note}{' · '}{event.actor.label}</p>
        {event.repayment?.results.length ? <ol className="ep-criterion-results">{event.repayment.results.map(result => <li key={result.criterionId}>
          <div><strong>{(event.repayment?.criteria ?? debt.criteria).find(row => row.id === result.criterionId)?.text ?? `历史标准 ${result.criterionId}`}</strong>
            <PlanningBadge tone={result.verdict === 'met' ? 'success' : 'quiet'}>{result.verdict === 'met' ? '达标' : '不适用'}</PlanningBadge></div>
          {result.note && <p>{result.note}</p>}<EvidenceList items={result.evidence} />
        </li>)}</ol> : null}
        <DebtScreenshotGallery items={event.repayment?.evidence ?? event.evidence} projectId={data.projectId} />
        <EvidenceList items={(event.repayment?.evidence ?? event.evidence)?.filter(item => !item.image)} />
      </div>)}
      {debt.outcome && <div className="ep-citation-target ep-repayment-evidence" id={debtTarget(debt.id, 'outcome')} tabIndex={-1}>
        <h4>关闭依据</h4><p>{debt.outcome.reason}</p>
        {debt.outcome.targetId && <button type="button" className="ep-text-button" onClick={() => onSelect({ kind: 'debt', id: debt.outcome!.targetId! })}>查看承接债务</button>}
        <EvidenceList items={debt.outcome.evidence} />
      </div>}
    </section>
    <DebtHealthSection debt={debt} health={data.health} canWrite={write} disabled={actionsDisabled}
      onAction={mode => onAction({ kind: 'health', mode, debt })} />
    <section className="ep-surface ep-debt-history"><div className="ep-section-header"><h3>历史</h3>
      <div role="group" aria-label="历史记录类型" className="ep-history-tabs">{([
        ['all', '全部'], ['plan', '暂缓与计划'], ['work', '处理进展'], ['repay', '偿还与重开'],
      ] as const).map(([value, text]) => <button key={value} type="button" aria-pressed={history === value} onClick={() => setHistory(value)}>{text}</button>)}</div>
    </div><ol className="ep-events">{data.events.filter(event => history === 'all'
      || (history === 'work' && !event.dates?.dueAt && ['started', 'progress', 'updated', 'verified', 'hit', 'anchor_bound', 'anchor_kept', 'extinct_pending'].includes(event.type))
      || (history === 'repay' && ['repaid', 'reopened', 'dropped', 'extinct', 'merged_into'].includes(event.type))
      || (history === 'plan' && (event.type === 'planned' || event.type === 'deferred' || event.dates?.dueAt || event.dates?.reviewAt))).map(event => <li key={event.id}
      id={eventTarget(event.id)} className="ep-citation-target" tabIndex={-1}>
      <time dateTime={event.at}>{dateLabel(event.at)}</time><div><PlanningBadge>{events[event.type]}</PlanningBadge> {event.actor.label}
        {event.entityId !== debt.id && <p>来自 <button type="button" className="ep-text-button"
          onClick={() => onSelect({ kind: 'debt', id: event.entityId })}>{shortId(event.entityId)}</button></p>}
        {event.proposedBy && <p>提案来源 · {event.proposedBy.label}{event.proposal?.skill && ` · ${event.proposal.skill}`}{event.proposal?.source.url
          ? <> · <a href={event.proposal.source.url} target="_blank" rel="noreferrer">{event.proposal.source.ref}</a></> : null}</p>}
        {event.note && <p>{event.note}</p>}
        {event.relatedDebtId && <button type="button" className="ep-text-button"
          onClick={() => onSelect({ kind: 'debt', id: event.relatedDebtId! })}>查看相关债务 {shortId(event.relatedDebtId)}</button>}
        {event.relatedPlanId && <button type="button" className="ep-text-button"
          onClick={() => onSelect({ kind: 'plan', id: event.relatedPlanId! })}>查看落地计划 {shortId(event.relatedPlanId)}</button>}
        {event.dates?.dueAt && <p>预计偿还 · {event.dates.dueAt.map(day => day ?? '未设置').join(' → ')}</p>}
        {event.dates?.reviewAt && <p>下次回看 · {event.dates.reviewAt.map(day => day ?? '未设置').join(' → ')}</p>}
        <EvidenceList items={event.evidence?.filter(item => !item.image)} />
        {event.type === 'repaid' && event.entityId !== debt.id && <DebtScreenshotGallery
          items={event.repayment?.evidence ?? event.evidence} projectId={data.projectId} />}
      </div>
    </li>)}</ol></section>
  </>;
}

function EvidenceList({ items }: { items?: PlanningEvidence[] }) {
  if (!items?.length) return null;
  return <ul className="ep-evidence">{items.map((item, index) => <li key={index}>
    {item.type === 'change' && item.label.startsWith('PR #') ? <GitPullRequest aria-hidden="true" /> : <PlanningBadge>{evidenceLabels[item.type]}</PlanningBadge>} {item.url
      ? <a href={item.url} target="_blank" rel="noreferrer">{item.label}</a> : item.label}
  </li>)}</ul>;
}
