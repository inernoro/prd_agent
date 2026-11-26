import { marked, type Tokens } from 'marked';
import { Link } from 'react-router-dom';
import type { DesignEntry, DesignRequirement, DesignRule, DesignRun, DesignVersion } from '../../../../src/shared/design-workspace';
import { InlineDesignNotes, ReadableNotes } from './DesignMarkdown';
import { designDate } from './design-ui';

type Clause = { n: string; text: string };
type Result = { state: 'failed' | 'passed' | 'needs_evidence'; label: string };

export function requirementClauses(source: string): Clause[] {
  let ruleHeading: number | undefined;
  let fallback: Tokens.List | undefined;
  let chosen: Tokens.List | undefined;
  for (const token of marked.lexer(source)) {
    if (token.type === 'heading') {
      const { text, depth } = token as Tokens.Heading;
      if (/业务规则与验收|需求条款|^业务规则$/.test(text)) ruleHeading = depth;
      else if (ruleHeading !== undefined && depth <= ruleHeading) ruleHeading = undefined;
    }
    if (token.type !== 'list' || !(token as Tokens.List).ordered) continue;
    const list = token as Tokens.List;
    if (ruleHeading !== undefined) { chosen = list; break; }
    fallback ??= list;
  }
  const list = chosen ?? fallback;
  return list?.items.map((item, index) => ({ n: String((Number(list.start) || 1) + index), text: item.text.trim() })) ?? [];
}

function resultFor(rule: DesignRule, run?: DesignRun): Result {
  const cells = run?.cells.filter(cell => cell.itemId === rule.id) ?? [];
  if (!cells.length) return { state: 'needs_evidence', label: '未运行' };
  if (cells.some(cell => cell.status === 'failed')) return { state: 'failed', label: '不通过' };
  if (rule.slots.every(slot => cells.some(cell => cell.slot === slot && cell.status === 'passed'))) return { state: 'passed', label: '通过' };
  return { state: 'needs_evidence', label: '待验证' };
}

export function needTrace(entry: DesignEntry, version: DesignVersion, requirement?: DesignRequirement, run?: DesignRun) {
  const current = run?.version === version.version ? run : entry.runs.filter(row => row.version === version.version).at(-1);
  const rows = requirementClauses(requirement?.requirements ?? '').map(clause => {
    const covers = version.acceptance.filter(rule => rule.requirementRef === clause.n)
      .map(rule => ({ rule, result: resultFor(rule, current) }));
    const verdict: Result = !covers.length ? { state: 'failed', label: '漏项' }
      : covers.some(row => row.result.state === 'failed') ? { state: 'failed', label: '不通过' }
      : covers.every(row => row.result.state === 'passed') ? { state: 'passed', label: '通过' }
      : { state: 'needs_evidence', label: '待验证' };
    return { ...clause, covers, verdict };
  });
  return { rows, gaps: rows.filter(row => !row.covers.length).length };
}

export function DesignNeed({ entry, version, requirement }: { entry: DesignEntry; version: DesignVersion; requirement?: DesignRequirement }) {
  if (!requirement) return <div className="dw-need dw-need--empty dw-surface">
    <p><strong>这份稿件没有关联需求。</strong></p>
    <p className="dw-muted">从计划提案交接的需求会在这里显示原文与条款对照。</p>
  </div>;
  const { rows, gaps } = needTrace(entry, version, requirement);
  const passed = rows.filter(row => row.verdict.state === 'passed').length;
  const planHref = '/engineering-planning?' + new URLSearchParams({ project: entry.projectId, kind: 'plan', item: requirement.planId });
  return <div className="dw-need">
    <p className="dw-dl-factline dw-need-facts">
      <span>来源 <Link className="ep-link" to={planHref}>{`${requirement.planId} V${requirement.planVersion}`}</Link> · 提案 {requirement.proposalId}</span>
      <span>{designDate(requirement.sharedAt)}交接</span>
      {rows.length > 0 && <span data-gaps={gaps || undefined}>{gaps ? `${rows.length} 条里 ${gaps} 条没有验收` : `${rows.length} 条都有验收`}</span>}
    </p>
    <ol className="dw-dl-items dw-surface dw-need-items">
      <li data-item="trace"><h4><b>1</b>条款与验收<small>有验收 {rows.length - gaps}/{rows.length} · 通过 {passed}/{rows.length}</small></h4>
        {rows.length ? <table className="dw-need-table" aria-label="需求条款与验收">
          <thead><tr><th scope="col">条款</th><th scope="col">需求</th><th scope="col">验收项与结果</th><th scope="col">条款结论</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.n} data-clause={row.n} data-status={row.covers.length ? undefined : 'missing'}>
            <th scope="row"><b className="dw-need-n">{row.n}</b></th>
            <td><InlineDesignNotes source={row.text} /></td>
            <td className="dw-need-covers">{row.covers.length ? row.covers.map(({ rule, result }) =>
              <span key={rule.id}><code>{rule.id}</code> {rule.rule} <span className="dw-status" data-state={result.state}>{result.label}</span></span>)
              : <span className="dw-muted">没有对应验收项</span>}</td>
            <td><strong className="dw-status" data-state={row.verdict.state}>{row.verdict.label}</strong></td>
          </tr>)}</tbody>
        </table> : <p className="dw-dl-missing">请在需求的「业务规则与验收」下写编号列表，以便逐条对照。</p>}
      </li>
      <li data-item="source"><h4><b>2</b>原始需求<small>{requirement.title}</small></h4><ReadableNotes source={requirement.requirements} /></li>
      {!!requirement.replies?.length && <li data-item="replies"><h4><b>3</b>需求方回复<small>{requirement.replies.length} 条</small></h4>
        <ul className="dw-need-replies">{requirement.replies.map(reply => <li key={reply.id}>
          <strong>{reply.author.label}</strong><small>{designDate(reply.at)} · 计划 V{reply.planVersion}</small>
          <ReadableNotes source={reply.body} />
        </li>)}</ul>
      </li>}
    </ol>
  </div>;
}
