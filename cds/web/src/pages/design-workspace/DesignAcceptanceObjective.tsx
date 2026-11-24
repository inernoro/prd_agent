import { useState, type FormEvent, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { designKnownIssues, type DesignDimension, type DesignEvidenceStatus,
  type DesignKnownIssue, type DesignMethodId } from '../../../../src/shared/design-methods';
import type { DesignCell, DesignEntry, DesignRequirement, DesignRule, DesignRun, DesignVersion } from '../../../../src/shared/design-workspace';
import { methodGuides, MethodDemo } from './AcceptanceGuide';
import { needTrace } from './DesignNeed';
import { designDate, designPublisherLabel, type DesignCommand } from './design-ui';
import type { AcceptanceCheck, Method, MethodData } from './DesignAcceptanceMethods';

export type RuleStatus = 'failed' | 'missing' | 'unverified' | 'passed' | 'debt';
export type OpenAcceptance = (view: 'need' | 'screen', screenId?: string) => void;

const details: Record<RuleStatus, string> = { failed: '不通过', missing: '待证据', unverified: '未验证', passed: '通过', debt: '已记债' };
const order: Record<DesignMethodId, number> = { mece: 0, smoke: 1, compare: 2, visual: 3, regress: 4, flow: 5, human: 6, debt: 7 };
const isActive = (method: Method) => method.status !== 'disabled' && method.status !== 'not_applicable';
const methodStatus = (method: Method) => {
  if (method.status === 'disabled') return '未启用';
  if (method.status === 'not_applicable') return '不适用';
  const progress = method.progress;
  if (!progress?.total) return '没有条目';
  if (!progress.done) return '未开始';
  if (progress.done < progress.total) return '进行中';
  return progress.failed ? '完成 · 有问题' : '已完成';
};
const executors: Partial<Record<DesignMethodId, string>> = { human: '人', smoke: '自动化' };

function Segments({ parts, total }: { parts: Array<[string, number]>; total: number }) {
  return <span className="dw-ac-sbar" aria-hidden="true">{total > 0 && parts.filter(([, count]) => count > 0).map(([key, count]) =>
    <i key={key} data-part={key} style={{ width: `${count / total * 100}%` }} />)}</span>;
}

export function ObjectiveMethodIntro({ method, canEnable, busy, enable, demo, setDemo }: {
  method: Method; canEnable: boolean; busy: boolean; enable: () => void; demo: boolean; setDemo: (show: boolean) => void;
}) {
  const guide = methodGuides[method.id];
  const progress = method.progress!;
  const active = isActive(method);
  return <>
    <li data-item={method.id}><h4><b>1</b>{method.name}<small>{method.purpose}</small></h4>
      {active ? <div className="dw-ac-progress">
        <Segments parts={[["passed", progress.passed], ["failed", progress.failed]]} total={progress.total} />
        <span>完成 {progress.done}/{progress.total}{progress.failed > 0 && ` · 有问题 ${progress.failed}`}</span>
        <strong>{methodStatus(method)}</strong>
      </div> : <div className="dw-ac-locked"><Lock aria-hidden="true" /><div>
        <strong>{methodStatus(method)}</strong>
        <small>{method.reason || '当前稿件没有启用此手段。可以先查看做法和示例。'}</small>
      </div>{canEnable && method.status === 'disabled' && <button className="ep-button ep-button--primary" type="button" data-action="enable-method" disabled={busy}
        onClick={enable}>启用</button>}</div>}
      <p className="dw-dl-factline"><span>执行技能 <code>{method.skills}</code></span><span>{guide.who}</span><span>{guide.when}</span></p>
    </li>
    <li data-item="howto"><h4><b>2</b>怎么做<button type="button" className="ep-button dw-ac-demo-btn" data-action="show-demo"
      aria-haspopup="dialog" aria-expanded={demo} onClick={() => setDemo(true)}>看示例</button></h4>
      <ol className="dw-ac-howto">{guide.steps.map(step => <li key={step}>{step}</li>)}</ol>
      <p className="dw-ac-pass"><strong>通过标准</strong>{guide.standard}</p>
    </li>
    {demo && <MethodDemo id={method.id} name={method.name} close={() => setDemo(false)} />}
  </>;
}

export function ObjectiveMethodTable({ methods, go }: { methods: Method[]; go: (check: AcceptanceCheck) => void }) {
  const ordered = methods.slice().sort((left, right) => Number(isActive(right)) - Number(isActive(left)) || order[left.id] - order[right.id]);
  return <div className="dw-ac-mtable dw-ac-mtable--v16" role="table" aria-label="验收手段进度">
    <div className="dw-ac-mrow dw-ac-mhead" role="row">{['手段', '进度', '谁执行'].map(title => <span key={title} role="columnheader">{title}</span>)}</div>
    {ordered.map(method => {
      const { id, name, purpose, skills, status, reason } = method;
      const { total, done, passed, failed } = method.progress!;
      return <div className="dw-ac-mrow" role="row" data-status={status} key={id} data-key={id} data-done={done} data-total={total} data-failed={failed}
        title={`执行技能 ${skills}`} onClick={() => go(id)}>
        <span role="cell"><button type="button" className="dw-ac-method-link">
          {status === 'disabled' && <Lock className="dw-ac-lock" aria-hidden="true" />}{name}</button>
          <small>{isActive(method) ? purpose : [methodStatus(method), reason].filter(Boolean).join(' · ')}</small></span>
        <span role="cell" className="dw-ac-mprog">{isActive(method) && <Segments parts={[["passed", passed], ["failed", failed]]} total={total} />}
          <small>{isActive(method) && total > 0 ? `${done}/${total}${failed ? ` · ${failed} 有问题` : ''}` : isActive(method) ? '没有条目' : '可看示例'}</small></span>
        <span role="cell" className="dw-ac-who">{executors[id] ?? '智能体'}</span>
      </div>;
    })}
  </div>;
}

export function AcceptanceTrace({ entry, version, run, requirement, statusOf, onOpen, openRules }: {
  entry: DesignEntry; version: DesignVersion; run?: DesignRun; requirement?: DesignRequirement;
  statusOf: (id: string) => RuleStatus; onOpen?: OpenAcceptance; openRules: () => void;
}) {
  const { rows, gaps } = needTrace(entry, version, requirement, run);
  const counts = Object.entries(details).map(([key, label]) => ({ key, label, count: version.acceptance.filter(rule => statusOf(rule.id) === key).length }));
  const pass = rows.filter(row => row.verdict.state === 'passed').length;
  const fail = rows.filter(row => row.verdict.state === 'failed' && row.covers.length).length;
  const traced = rows.length - gaps;
  const canOpen = Boolean(requirement && onOpen);
  return <li data-item="trace"><h4><b>2</b>需求 → 验收项 → 结论<small>由对应验收项推导条款结论</small></h4>
    <div className="dw-ac-trace">
      <button type="button" className="dw-ac-stage" data-stage="need" disabled={!canOpen} onClick={() => onOpen?.('need')}>
        <small>需求条款</small>{rows.length ? <><strong>{rows.length}</strong><Segments parts={[["passed", traced], ["failed", gaps]]} total={rows.length} />
          <span>{gaps ? `${gaps} 条没有验收项` : '每条都有验收项'}</span></>
          : <span>{requirement ? '需求暂无编号条款' : '尚未关联需求'}</span>}</button>
      <span className="dw-ac-arrow" aria-hidden="true">→</span>
      <button type="button" className="dw-ac-stage" data-stage="items" onClick={openRules}><small>验收项</small><strong>{version.acceptance.length}</strong>
        <Segments parts={counts.map(({ key, count }) => [key, count])} total={version.acceptance.length} />
        <span>{counts.filter(({ count }) => count > 0).map(({ label, count }) => `${count} ${label}`).join(' · ')}</span></button>
      <span className="dw-ac-arrow" aria-hidden="true">→</span>
      <button type="button" className="dw-ac-stage" data-stage="clauses" disabled={!canOpen} onClick={() => onOpen?.('need')}>
        <small>条款结论</small>{rows.length ? <><strong>{pass}/{rows.length}</strong><Segments total={rows.length}
          parts={[["passed", pass], ["failed", fail], ["missing", traced - pass - fail], ["gap", gaps]]} />
          <span>{pass} 通过 · {fail} 不通过{gaps > 0 && ` · ${gaps} 漏项`}</span></> : <span>暂无条款结论</span>}</button>
    </div></li>;
}

export function AcceptanceScreens({ version, statusOf, onOpen }: {
  version: DesignVersion; statusOf: (id: string) => RuleStatus; onOpen?: OpenAcceptance;
}) {
  const [expanded, setExpanded] = useState(false);
  const rank: Record<RuleStatus, number> = { failed: 0, missing: 1, debt: 2, unverified: 3, passed: 4 };
  const screens = version.screens.map(screen => {
    const list = version.acceptance.filter(rule => rule.screenId === screen.id).map(rule => ({ rule, status: statusOf(rule.id) }));
    return { screen, list, worst: list.length ? Math.min(...list.map(item => rank[item.status])) : 5,
      problems: list.filter(item => item.status === 'failed' || item.status === 'missing').length };
  }).sort((left, right) => right.problems - left.problems || left.worst - right.worst);
  const visible = expanded ? screens : screens.slice(0, 8);
  return <li data-item="by-screen"><h4><b>3</b>画面 × 结果<small>问题多的画面在前，点开回到交付的那一屏</small></h4>
    <ul className="dw-ac-byscreen">{visible.map(({ screen, list, worst }) => <li key={screen.id} data-worst={worst}>
      <button type="button" className="dw-ac-byscreen-row" disabled={!onOpen} onClick={() => onOpen?.('screen', screen.id)}>
        <span className="dw-ac-byscreen-name">{screen.name}<small>{screen.viewport === 'phone' ? '手机' : '桌面'}</small></span>
        <span className="dw-ac-dots">{list.map(({ rule, status }) => <i key={rule.id} data-status={status} title={`${rule.id} ${rule.rule} · ${details[status]}`} />)}</span>
        <span className="dw-ac-byscreen-sum">{list.length ? Object.entries(details).flatMap(([key, label]) => {
          const count = list.filter(item => item.status === key).length;
          return count > 0 ? [`${count} ${label}`] : [];
        }).join(' · ') : '这一屏没有验收项'}</span>
      </button></li>)}</ul>
    {!screens.length && <p className="dw-dl-missing">稿件没有声明画面。</p>}
    {screens.length > 8 && <button type="button" className="ep-link dw-ac-next-link" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? '收起画面' : `看全部 ${screens.length} 个画面`}</button>}
  </li>;
}

type Cause = { key: string; tone: 'block' | 'fail' | 'missing' | 'open' | 'gap'; title: string; detail: string; action?: ReactNode };

export function acceptanceImpact(items: DesignRule[], version: DesignVersion) {
  const clauses = [...new Set(items.flatMap(rule => rule.requirementRef ? [rule.requirementRef] : []))];
  const screens = version.screens.filter(screen => items.some(rule => rule.screenId === screen.id));
  return [clauses.length ? `需求条款 ${clauses.join('、')}` : '',
    screens.length ? `画面 ${screens.slice(0, 4).map(screen => screen.name).join('、')}${screens.length > 4 ? ` 等 ${screens.length} 个` : ''}` : ''].filter(Boolean).join(' · ');
}

export function EvidenceCauses({ causes }: { causes: Cause[] }) {
  const blocking = causes.filter(cause => cause.tone !== 'gap').length;
  return <>
    {causes.length > 0 && <ol className="dw-ac-causes">{causes.map(({ key, tone, title, detail, action }, index) => <li key={key} data-tone={tone}>
      <strong><b aria-hidden="true">{index + 1}</b>{title}</strong><span className="dw-ac-arrow" aria-hidden="true">→</span>
      <span className="dw-ac-effect">{detail}</span>{action && <span className="dw-ac-cause-act">{action}</span>}</li>)}</ol>}
    {blocking > 0 && <p className="dw-ac-after">以上 {blocking} 条处理完成后才能签收。</p>}
  </>;
}

export function groupEvidence(cells: DesignCell[]) {
  const groups = new Map<string, DesignCell[]>();
  for (const cell of cells) {
    const reason = cell.actual.trim() || '缺少实测证据';
    const list = groups.get(reason) ?? [];
    list.push(cell);
    groups.set(reason, list);
  }
  return [...groups.entries()];
}

type AuditCommand = (type: string, fields: Record<string, unknown>) => Promise<boolean>;

export function ObjectiveCoverage({ data, version, executable, send, busy }: {
  data: MethodData; version: DesignVersion; executable: boolean; send: AuditCommand; busy: boolean;
}) {
  const [open, setOpen] = useState<DesignDimension>();
  const chosen = data.coverage.find(row => row.id === open);
  const rows = data.coverage.flatMap(dimension => dimension.risks.map((risk, index) => ({ dimension, risk, index })));
  return <li data-item="mece-details"><h4><b>3</b>六个维度的覆盖</h4>
    <table className="dw-ac-objective-table" aria-label="MECE 风险覆盖">
      <thead><tr>{['维度', '风险', '覆盖它的验收', '结论'].map(text => <th key={text} scope="col">{text}</th>)}</tr></thead>
      <tbody>{rows.map(({ dimension, risk, index }) => <tr key={`${dimension.id}/${index}`} className="dw-ac-risk-row" data-status={risk.status}>
        <th scope="row">{dimension.name}</th><td>{risk.risk || '待核对风险'}</td>
        <td>{risk.ruleIds.length ? risk.ruleIds.map(id => <code key={id} title={version.acceptance.find(rule => rule.id === id)?.rule}>{id} </code>)
          : risk.reason || '待关联验收项'}</td>
        <td><span className="dw-ac-state" data-status={risk.status}>{risk.status === 'passed' ? '覆盖' : risk.status === 'not_applicable' ? '不需要' : '漏项'}</span>
          {executable && index === 0 && dimension.risks.some(row => row.status === 'missing') && <button className="ep-link" type="button" onClick={() => setOpen(dimension.id)}>补充核对</button>}</td>
      </tr>)}</tbody>
    </table>
    {chosen && <CoverageDialog key={chosen.id} dimension={chosen} version={version} busy={busy} close={() => setOpen(undefined)} send={send} />}
  </li>;
}

function CoverageDialog({ dimension, version, busy, close, send }: {
  dimension: MethodData['coverage'][number]; version: DesignVersion; busy: boolean; close: () => void; send: AuditCommand;
}) {
  const [needed, setNeeded] = useState(true);
  const declared = version.risks?.some(risk => risk.dimension === dimension.id && !risk.reason);
  const [risk, setRisk] = useState(dimension.risks.find(row => row.status === 'missing')?.risk ?? '');
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await send('acceptance.coverage', { dimension: dimension.id, risk: risk.trim(), ruleIds: needed ? ruleIds : [],
      ...(needed ? {} : { reason: reason.trim() }) })) close();
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="dw-modal dw-surface">
    <DialogTitle>核对{dimension.name}风险</DialogTitle><DialogDescription>关联本版能验证风险的规则，或说明本维度无适用风险。</DialogDescription>
    <form onSubmit={event => void submit(event)}>
      {!declared && <label>适用性<select value={needed ? 'needed' : 'none'} onChange={event => setNeeded(event.target.value === 'needed')}>
        <option value="needed">有适用风险</option><option value="none">无适用风险</option></select></label>}
      {needed ? <><label>风险或核对范围<input required maxLength={1200} value={risk} readOnly={declared} onChange={event => setRisk(event.target.value)} /></label>
        <label>对应验收项<select multiple required size={5} value={ruleIds}
        onChange={event => setRuleIds(Array.from(event.target.selectedOptions, option => option.value))}>
        {version.acceptance.map(rule => <option key={rule.id} value={rule.id}>{rule.id} {rule.rule}</option>)}</select></label></>
        : <label>理由<textarea required maxLength={1200} value={reason} onChange={event => setReason(event.target.value)} /></label>}
      <footer><button type="button" className="ep-button" onClick={close}>取消</button>
        <button className="ep-button ep-button--primary" disabled={busy || (needed ? !risk.trim() || !ruleIds.length : !reason.trim())}>保存核对</button></footer>
    </form>
  </DialogContent></Dialog>;
}

const sources = { defect: '缺陷', ticket: '工单', feedback: '反馈' } as const;
const outcomes: Record<DesignEvidenceStatus, string> = { passed: '通过', failed: '有问题', missing: '待复查' };

export function HistoricalAcceptance({ entry, version, run, busy, canRegister, executable, command, send }: {
  entry: DesignEntry; version: DesignVersion; run?: DesignRun; busy: boolean; canRegister: boolean; executable: boolean;
  command: DesignCommand; send: AuditCommand;
}) {
  const [register, setRegister] = useState(false);
  const [checking, setChecking] = useState<DesignKnownIssue>();
  const issues = designKnownIssues(entry, version, run);
  return <li data-item="regress-details"><h4><b>3</b>历史易错<small>同类问题持续复查，每次运行单独留证</small>
    {canRegister && <button type="button" className="ep-button dw-ac-demo-btn" onClick={() => setRegister(true)}>登记易错项</button>}</h4>
    {issues.length > 0 ? <table className="dw-ac-objective-table" aria-label="本次历史易错复查">
      <thead><tr>{['编号', '问题', '来源（次数）', '怎么查', '这次的证据', '结论'].map(text => <th key={text} scope="col">{text}</th>)}</tr></thead>
      <tbody>{issues.map(issue => {
        const result = run?.regress?.[issue.id];
        const status = result?.status ?? 'missing';
        return <tr key={issue.id} data-issue={issue.id} data-status={status}>
          <td><code>{issue.id}</code></td><th scope="row">{issue.problem}<small>{issue.screenIds.length ? issue.screenIds.map(id => version.screens.find(screen => screen.id === id)?.name ?? id).join('、') : '全稿适用'}</small></th>
          <td className="dw-ac-sources">{issue.sources.map(({ kind, ref, count }) => <span key={`${kind}/${ref}`}>{sources[kind]} {ref} · {count} 次</span>)}</td>
          <td>{issue.how} · {issue.check}</td><td>{result?.evidence || '本次尚无证据'}{result && <small>{designPublisherLabel(result.by)} · {designDate(result.at)}</small>}</td>
          <td><span className="dw-ac-state" data-status={status}>{outcomes[status]}</span>
            {executable && <button type="button" className="ep-link" onClick={() => setChecking(issue)}>记录复查</button>}</td>
        </tr>;
      })}</tbody>
    </table> : <p className="dw-dl-missing">当前画面范围还没有已登记的易错项。</p>}
    {register && <IssueRegistration entry={entry} version={version} busy={busy} command={command} close={() => setRegister(false)} />}
    {checking && <IssueCheck issue={checking} run={run} busy={busy} send={send} close={() => setChecking(undefined)} />}
  </li>;
}

function IssueRegistration({ entry, version, command, busy, close }: {
  entry: DesignEntry; version: DesignVersion; command: DesignCommand; busy: boolean; close: () => void;
}) {
  const [problem, setProblem] = useState('');
  const [how, setHow] = useState('');
  const [check, setCheck] = useState('');
  const [kind, setKind] = useState<keyof typeof sources>('feedback');
  const [ref, setRef] = useState('');
  const [count, setCount] = useState(1);
  const [screenIds, setScreens] = useState<string[]>([]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await command('known.create', { designId: entry.id, problem: problem.trim(), how: how.trim(), check: check.trim(), screenIds,
      sources: [{ kind, ref: ref.trim(), count }] })) close();
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="dw-modal dw-surface">
    <DialogTitle>登记历史易错</DialogTitle><DialogDescription>从已发生的缺陷或反馈提取能重复验证的检查。</DialogDescription>
    <form onSubmit={event => void submit(event)}>
      <label>发生过什么<input required maxLength={250} value={problem} onChange={event => setProblem(event.target.value)} /></label>
      <label>来源<select value={kind} onChange={event => setKind(event.target.value as keyof typeof sources)}>
        {Object.entries(sources).map(([id, title]) => <option value={id} key={id}>{title}</option>)}</select></label>
      <label>来源编号<input required maxLength={160} value={ref} onChange={event => setRef(event.target.value)} /></label>
      <label>出现次数<input required type="number" min={1} max={10000} value={count} onChange={event => setCount(Number(event.target.value))} /></label>
      <label>检查方法<input required maxLength={250} value={how} onChange={event => setHow(event.target.value)} /></label>
      <label>通过条件<textarea required maxLength={1800} value={check} onChange={event => setCheck(event.target.value)} /></label>
      <label>适用画面（可多选，留空表示全稿）<select multiple size={4} value={screenIds}
        onChange={event => setScreens(Array.from(event.target.selectedOptions, item => item.value))}>
        {version.screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}</select></label>
      <footer><button type="button" className="ep-button" onClick={close}>取消</button><button className="ep-button ep-button--primary" disabled={busy}>登记</button></footer>
    </form>
  </DialogContent></Dialog>;
}

function IssueCheck({ issue, run, busy, send, close }: {
  issue: DesignKnownIssue; run?: DesignRun; busy: boolean; send: AuditCommand; close: () => void;
}) {
  const former = run?.regress?.[issue.id];
  const [status, setStatus] = useState<DesignEvidenceStatus>(former?.status ?? 'missing');
  const [evidence, setEvidence] = useState(former?.evidence ?? '');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await send('acceptance.regress', { issueId: issue.id, status, evidence: evidence.trim() })) close();
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="dw-modal dw-surface">
    <DialogTitle>复查 {issue.id}</DialogTitle><DialogDescription>{issue.check}</DialogDescription>
    <form onSubmit={event => void submit(event)}>
      <label>实测证据<textarea required maxLength={2000} placeholder="写清测试画面、条件和实际结果" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
      <label>结论<select value={status} onChange={event => setStatus(event.target.value as DesignEvidenceStatus)}>
        {Object.entries(outcomes).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <footer><button type="button" className="ep-button" onClick={close}>取消</button>
        <button className="ep-button ep-button--primary" disabled={busy || !evidence.trim()}>记录复查</button></footer>
    </form>
  </DialogContent></Dialog>;
}
