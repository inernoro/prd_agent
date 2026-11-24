import type { ReactNode } from 'react';
import { CheckSquare, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  designDimensions, designMeasurementGap, designVisualBreakdown, type DesignMethodId, type DesignMethodStatus, type designMethodsState,
} from '../../../../src/shared/design-methods';
import type { DesignCell, DesignEntry, DesignRun, DesignVersion } from '../../../../src/shared/design-workspace';
import { cellNames, designArtifact, designPublisherLabel, ruleModes, slotNames } from './design-ui';

export type AcceptanceCheck = 'overview' | DesignMethodId;
export type MethodData = ReturnType<typeof designMethodsState>;
export type Method = MethodData['methods'][number];
const names: Record<DesignMethodStatus, string> = { passed: '通过', failed: '有问题', missing: '缺证据',
  notrun: '未运行', not_applicable: '不适用', disabled: '未启用' };

function MethodStatus({ status }: { status: DesignMethodStatus }) {
  return <span className="dw-ac-state" data-status={status}>{names[status]}</span>;
}

export function AcceptanceMethodTabs({ active, methods, overall, objective, go }: {
  active: AcceptanceCheck; methods: MethodData['methods']; overall: DesignMethodStatus; objective?: boolean; go: (check: AcceptanceCheck) => void;
}) {
  const tabs = [{ id: 'overview' as const, name: '总览', status: overall, progress: undefined, setting: undefined }, ...methods];
  return <div className="dw-ac-methods" role="tablist" aria-label="验收手段">
    {tabs.map(({ id, name, status, progress, setting }, index) => <button key={id} type="button" role="tab" data-check={id} id={`dw-ac-tab-${id}`}
      data-status={objective ? status : undefined}
      title={setting?.enabled === false ? ['已停用', setting.reason, setting.by.label, setting.at].filter(Boolean).join(' · ') : undefined}
      aria-controls="dw-ac-method-panel" aria-selected={active === id} tabIndex={active === id ? 0 : -1} onClick={() => go(id)}
      onKeyDown={event => {
        const destinations: Record<string, number> = { ArrowLeft: (index + tabs.length - 1) % tabs.length,
          ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
        if (!Object.hasOwn(destinations, event.key)) return;
        const target = destinations[event.key];
        event.preventDefault();
        const next = tabs[target].id;
        go(next);
        document.getElementById(`dw-ac-tab-${next}`)?.focus();
      }}>
      {objective && status === 'disabled' ? <Lock className="dw-ac-lock" role="img" aria-label={setting?.enabled === false ? '已停用' : '未启用'} />
        : objective && status === 'passed' ? <CheckSquare className="dw-ac-done" role="img" aria-label="已完成" /> : null}
      {name}{(!objective || (status !== 'disabled' && status !== 'passed')) && <span className="dw-ac-dot" data-status={status} role="img" aria-label={names[status]} />}
      {objective && progress && progress.done > 0 && progress.done < progress.total && status !== 'disabled' && status !== 'not_applicable'
        && <small className="dw-ac-count">{progress.done}/{progress.total}</small>}
    </button>)}
  </div>;
}

export function AcceptanceMethodOverview({ methods, go }: { methods: MethodData['methods']; go: (check: AcceptanceCheck) => void }) {
  return <div className="dw-ac-mtable">
    {methods.map(method => <button type="button" className="dw-ac-mrow" data-status={method.status} key={method.id} onClick={() => go(method.id)}>
      <strong>{method.name}</strong><span>{method.purpose}</span><code>{method.skills}</code>
      <span><MethodStatus status={method.status} />{method.reason && <small>{method.reason}</small>}</span>
    </button>)}
  </div>;
}

export function AcceptanceMethodIntro({ method }: { method: Method }) {
  return <li data-item={method.id}><h4><b>1</b>{method.name}<small>{method.purpose}</small></h4>
    <p className="dw-dl-factline"><MethodStatus status={method.status} /><span>执行技能 <code>{method.skills}</code></span></p>
    {method.status === 'not_applicable' && <p className="dw-vs-muted">{method.reason}</p>}
  </li>;
}

function Coverage({ data, version }: { data: MethodData; version: DesignVersion }) {
  const unassigned = version.acceptance.filter(rule => !rule.dimension);
  return <>
    <div className="dw-ac-coverage">{data.coverage.map(row => {
      const empty = !row.rules.length && !row.flows.length && !row.smoke.length && !row.visual.length;
      return <div key={row.id} className="dw-ac-crow" data-missing={empty || undefined}>
        <strong>{row.name}</strong>
        <span>{empty ? <em>暂无验收覆盖，可用 risk-matrix 补充。</em> : <>
          {row.rules.map(rule => <code key={rule.id} title={rule.rule}>{rule.id}</code>)}
          {row.flows.map(flow => <span className="dw-ac-chip" key={flow.id} title={flow.title}>流程 · {flow.title}</span>)}
          {row.smoke.map(item => <span className="dw-ac-chip" key={item.id} title={item.title}>冒烟 · {item.title}</span>)}
          {row.visual.map(([id, name]) => <span className="dw-ac-chip" key={id} title={name}>视觉 {id}</span>)}
        </>}</span>
      </div>;
    })}</div>
    {unassigned.length > 0 && <details className="dw-dl-rulegroup"><summary>未标维度的稿件验收项 <small>{unassigned.length} 条</small></summary>
      <ul className="dw-dl-rules">{unassigned.map(rule => <li key={rule.id}><code>{rule.id}</code><span>{rule.rule}</span></li>)}</ul>
    </details>}
  </>;
}

export function AcceptanceMethodDetails({ method, data, version, run, entry, writable, busy, onRule, onDebt, savedCompare }: {
  method: Method; data: MethodData; version: DesignVersion; run?: DesignRun; entry: DesignEntry; writable: boolean; busy: boolean;
  onRule: (cell: DesignCell) => void; onDebt: (id: string) => void; savedCompare?: () => void;
}) {
  let title: string;
  let body: ReactNode;
  switch (method.id) {
    case 'mece':
      title = '六个维度的覆盖';
      body = <Coverage data={data} version={version} />;
      break;
    case 'visual':
      title = '通用视觉检查 · 10 项';
      body = <ul className="dw-ac-evidence-list">{designVisualBreakdown(version, run).map(check => <li key={check.id}
        data-status={check.counts.failed ? 'failed' : undefined}>
        <div className="dw-ac-evidence-head"><strong>{check.id} · {check.name}</strong><small>{check.how}</small>
          <span>{check.counts.passed} 通过 · {check.counts.failed} 有问题 · {check.counts.missing} 缺证据</span></div>
        <p>{check.criterion}</p>
        {data.objective && check.results.length > 0 ? <details className="dw-ac-visual-results"><summary>逐画面结果 · {check.results.length} 处</summary>
          <table className="dw-ac-objective-table" aria-label={`${check.name}逐画面结果`}>
            <thead><tr>{['画面', '视口', '证据', '结论'].map(title => <th scope="col" key={title}>{title}</th>)}</tr></thead>
            <tbody>{check.results.map(result => <tr key={`${result.screenId}/${result.slot}`} data-status={result.status}>
              <th scope="row">{result.screenName}</th><td>{slotNames[result.slot]}</td><td>{result.evidence || '尚无证明'}
                {result.imageId && <small><a className="ep-link" target="_blank" rel="noreferrer" href={designArtifact(entry.projectId, result.imageId)}>打开实拍</a></small>}</td>
              <td><MethodStatus status={result.status} /></td>
            </tr>)}</tbody>
          </table>
        </details> : !!check.issues.length && <ul>{check.issues.map(issue => <li key={`${issue.screenId}/${issue.slot}`}>
          <strong>{issue.screenName}</strong> · {slotNames[issue.slot]} · {issue.evidence}
        </li>)}</ul>}
      </li>)}</ul>;
      break;
    case 'flow':
      title = '按角色验证关键流程';
      body = run?.flows?.length ? <ul className="dw-ac-evidence-list">{run.flows.map(flow => <li key={flow.id} data-status={flow.status}>
        <div className="dw-ac-evidence-head"><code>{flow.id}</code><strong>{flow.role} · {flow.title}</strong>
          <small>{designDimensions[flow.dimension]}</small><MethodStatus status={flow.status} /></div>
        <p>记录人 {designPublisherLabel(flow.by)}</p>
        <ol>{flow.steps.map((step, index) => <li key={index}>
          <div className="dw-ac-evidence-head"><strong>{step.action}</strong><MethodStatus status={step.status} /></div>
          <dl className="dw-details"><dt>预期</dt><dd>{step.expected}</dd><dt>实际</dt><dd>{step.actual}</dd></dl>
        </li>)}</ol>
      </li>)}</ul> : <p className="dw-vs-muted">{run ? '这次运行还没有流程证据。' : '开始验收后，技能可以回填流程证据。'}</p>;
      break;
    case 'human': {
      title = '需要人工核对的验收项';
      const rules = version.acceptance.filter(rule => rule.how === 'human');
      body = <>
        <p className="dw-vs-muted">用 <code>acceptance-checklist</code> 生成操作、预期结果和失败处理步骤，按适用视口核对。</p>
        {rules.length ? <ul className="dw-dl-rules">{rules.map(rule => <li key={rule.id}><code>{rule.id}</code><span><strong>{rule.rule}</strong>
          {rule.expected && <small>{rule.expected}</small>}
          <span className="dw-ac-slots">{rule.slots.map(slot => {
            const cell = run?.cells.find(value => value.itemId === rule.id && value.slot === slot);
            return cell ? <button className="dw-status" data-state={cell.status} type="button" key={slot} onClick={() => onRule(cell)}>
              {slotNames[slot]} · {cellNames[cell.status]}</button> : <span className="dw-ac-slot" key={slot}>{slotNames[slot]}</span>;
          })}</span></span></li>)}</ul> : <p className="dw-vs-muted">稿件没有声明人工验收项。</p>}
      </>;
      break;
    }
    case 'smoke':
      title = '关键页面和接口';
      body = run?.smoke?.length ? <ul className="dw-ac-evidence-list">{run.smoke.map(item => <li key={item.id} data-status={item.status}>
        <div className="dw-ac-evidence-head"><strong>{item.title}</strong><small>{item.target === 'page' ? '页面' : '接口'} · {designDimensions[item.dimension]}</small>
          <MethodStatus status={item.status} /></div>
        <p><code>{item.path}</code> · {designPublisherLabel(item.by)}</p>
        <dl className="dw-details"><dt>预期</dt><dd>{item.expected}</dd><dt>实际</dt><dd>{item.actual}</dd></dl>
      </li>)}</ul> : <p className="dw-vs-muted">{run ? '这次运行还没有冒烟结果。' : '开始验收后，可以回填关键页面和接口的结果。'}</p>;
      break;
    case 'debt': {
      title = '测量缺口和关联债务';
      const debt = version.acceptance.filter(rule => designMeasurementGap(version, rule) || run?.issues[rule.id]);
      body = debt.length ? <ul className="dw-ac-evidence-list">{debt.map(rule => {
        const issue = run?.issues[rule.id];
        const canRegister = !issue && writable && run?.cells.some(cell => cell.itemId === rule.id && cell.status !== 'passed');
        return <li key={rule.id}><div className="dw-ac-evidence-head"><strong>{rule.id} · {rule.rule}</strong><small>{ruleModes[rule.how]}</small></div>
          {designMeasurementGap(version, rule) && <p>{data.objective ? '尚未声明可重复的检查办法。' : '尚未声明可自动执行的测量方法。'}</p>}
          {issue?.pending && <p>待确认提案 {issue.id}</p>}
          {issue && !issue.pending && <Link className="ep-link" to={`/engineering-planning?${new URLSearchParams({ project: entry.projectId,
            view: 'debts', kind: 'debt', item: issue.id })}`}>查看债务 {issue.id}</Link>}
          {canRegister && <button type="button" className="ep-button" disabled={busy} onClick={() => onDebt(rule.id)}>记成债务</button>}
        </li>;
      })}</ul> : <p className="dw-vs-muted">{data.objective ? '目前没有已登记的验收债务或检查方法缺口。' : '目前没有已登记的验收债务或自动测量缺口。'}</p>;
      break;
    }
    case 'compare':
    case 'regress':
      return null;
  }
  return <li data-item={`${method.id}-details`}>
    <h4><b>{data.objective ? 3 : 2}</b>{title}</h4>
    {body}
    {method.id === 'visual' && savedCompare && <button type="button" className="ep-link dw-ac-next-link" onClick={savedCompare}>打开逐画面对照</button>}
  </li>;
}
