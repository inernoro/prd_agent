import { Check, CircleAlert, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ACCEPTANCE_STATUS_LABELS, acceptanceTaskLink, onlineEvidenceUrl } from '@/lib/acceptance-api';
import type { AcceptanceCase, AcceptanceCaseStatus, AcceptanceTask } from '@/lib/acceptance-api';

const STATUS_CLASS: Record<AcceptanceCaseStatus, string> = {
  pass: 'text-primary bg-primary/5 border-primary/30',
  fail: 'text-destructive bg-destructive/5 border-destructive/30',
  blocked: 'text-foreground bg-muted border-border',
  'not-run': 'text-muted-foreground bg-background border-border',
};

export function AcceptanceStatus({ status, flaky }: { status: AcceptanceCaseStatus; flaky?: boolean }): JSX.Element {
  return <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${STATUS_CLASS[status]}`}>
    {status === 'pass' ? <Check className="size-3.5" /> : status === 'fail' ? <X className="size-3.5" /> : <CircleAlert className="size-3.5" />}
    {ACCEPTANCE_STATUS_LABELS[status]}{flaky ? ' · 不稳定' : ''}
  </span>;
}

/** The reader and executor expand the same immutable case, not a second checklist. */
export function AcceptanceCaseDetails({ testCase }: { testCase: AcceptanceCase }): JSX.Element {
  return <div className="space-y-3 text-sm" data-case-id={testCase.caseId}>
    <p className="break-words text-muted-foreground">{testCase.breadcrumb.join(' → ')} · {testCase.entryPath}</p>
    <p className="text-xs text-muted-foreground">负责人：{testCase.owner} · {testCase.module}</p>
    {testCase.preconditions.length ? <div><h4 className="font-medium">前置条件</h4><ul className="list-inside list-disc space-y-1">{testCase.preconditions.map((value, i) => <li key={i}>{value}</li>)}</ul></div> : null}
    {testCase.inputs.length ? <div><h4 className="font-medium">固定输入</h4>{testCase.inputs.map((value, i) => <p key={i} className="break-words">{value.name}：{value.value}</p>)}</div> : null}
    <div><h4 className="font-medium">验收步骤</h4><ol className="list-inside list-decimal space-y-2">{testCase.steps.map((step) => <li key={step.id}>{step.action}<p className="mt-1 pl-4 text-muted-foreground">预期：{step.expected}</p></li>)}</ol></div>
    <div><h4 className="font-medium">全部通过标准</h4><ul className="list-inside list-disc space-y-1">{testCase.assertions.map((assertion) => <li key={assertion.id}>{assertion.description}</li>)}</ul></div>
    <p>清理要求：{testCase.cleanup === 'required' ? testCase.cleanupInstructions : '不产生资源，无需清理'}</p>
  </div>;
}

export function AcceptanceChecklist({ cases, results, projectId, taskId }: {
  cases: AcceptanceCase[];
  results?: AcceptanceTask['results'];
  projectId?: string;
  taskId?: string;
}): JSX.Element {
  return <div className="max-w-full overflow-x-auto rounded-lg border border-border">
    <table className="w-full min-w-[42rem] border-collapse text-left text-sm" aria-label="重要功能验收评分表">
      <caption className="bg-card p-3 text-left text-xs text-muted-foreground">您和 Agent 使用同一编号、同一功能、同一通过标准。展开只显示详细步骤，不增加另一份清单。</caption>
      <thead className="bg-muted/50"><tr>{['编号', '重要功能', '怎么验／通过标准', '本轮结果', '证据'].map((label) => <th className="border-b border-border p-3" key={label}>{label}</th>)}</tr></thead>
      <tbody>{cases.map((testCase) => {
        const result = results?.[testCase.caseId];
        const taskLink = projectId && taskId ? acceptanceTaskLink(projectId, taskId, testCase.caseId) : undefined;
        return <tr key={testCase.caseId} data-case-id={testCase.caseId}>
          <td className="border-b border-border p-3 align-top font-mono text-xs">{testCase.caseId}</td>
          <th scope="row" className="min-w-[10rem] border-b border-border p-3 align-top font-normal">
            {taskLink ? <Link className="font-medium text-primary underline" to={taskLink}>{testCase.title}</Link> : <span className="font-medium">{testCase.title}</span>}
            <p className="mt-1 text-xs text-muted-foreground">{testCase.module} · {testCase.environments.map((environment) => environment === 'production' ? '正式' : 'CDS').join('／')}</p>
          </th>
          <td className="min-w-[16rem] border-b border-border p-3 align-top">
            <p className="break-words">{testCase.steps[0]?.action}{testCase.steps.length > 1 ? <span className="text-xs text-muted-foreground"> · 另 {testCase.steps.length - 1} 步，展开查看</span> : null}</p>
            <p className="mt-2 break-words text-muted-foreground">通过：{testCase.assertions[0]?.description}{testCase.assertions.length > 1 ? <span className="text-xs"> · 另 {testCase.assertions.length - 1} 项标准，展开查看</span> : null}</p>
            <details className="mt-2"><summary className="cursor-pointer text-xs text-primary">展开执行细节 · {testCase.steps.length} 步</summary><div className="mt-3"><AcceptanceCaseDetails testCase={testCase} /></div></details>
          </td>
          <td className="border-b border-border p-3 align-top">
            {results ? <AcceptanceStatus status={result?.status ?? 'not-run'} flaky={result?.flaky} /> : <span className="text-xs text-muted-foreground">模板，尚未执行</span>}
            {result ? <p className="mt-2 max-w-xs break-words text-xs text-muted-foreground">{result.actual}</p> : null}
            {taskLink ? <Link className="mt-2 block text-xs text-primary underline" to={taskLink}>查看／填写这一项</Link> : null}
          </td>
          <td className="border-b border-border p-3 align-top">
            {result?.evidence.length ? result.evidence.map((evidence, i) => {
              const url = onlineEvidenceUrl(evidence.url);
              return url ? <a className="mb-2 block max-w-xs break-words text-xs text-primary underline" key={i} href={url} target="_blank" rel="noopener noreferrer">{evidence.caption}</a> : <p className="text-xs text-destructive" key={i}>证据链接无效</p>;
            }) : <span className="text-xs text-muted-foreground">{results ? '未提供证据' : '执行后填写'}</span>}
          </td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
