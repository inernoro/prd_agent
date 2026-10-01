import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ACCEPTANCE_STATUS_LABELS, onlineEvidenceUrl } from '@/lib/acceptance-api';
import type { AcceptanceCase, AcceptanceResult, AcceptanceSubmission } from '@/lib/acceptance-api';
import { AcceptanceField, acceptanceInputClass } from './AcceptanceTemplateEditor';

export function initialAcceptanceSubmission(testCase: AcceptanceCase, result?: AcceptanceResult): AcceptanceSubmission {
  return {
    status: result?.status ?? 'not-run', actual: result?.actual ?? '',
    assertions: testCase.assertions.map((assertion) => {
      const saved = result?.assertions.find((value) => value.id === assertion.id);
      return { id: assertion.id, passed: saved?.passed ?? false, actual: saved?.actual ?? '' };
    }),
    evidence: result ? structuredClone(result.evidence) : [],
    cleanup: result ? { ...result.cleanup } : { status: testCase.cleanup === 'none' ? 'not-required' : 'fail', details: '' },
  };
}

export function acceptanceSubmissionProblem(testCase: AcceptanceCase, draft: AcceptanceSubmission): string | undefined {
  if (!draft.actual.trim()) return '请填写实际结果或未执行原因。';
  if (draft.evidence.some((item) => !onlineEvidenceUrl(item.url) || !item.caption.trim())) return '证据必须填写可打开的线上 HTTP(S) 链接及其证明内容；本机文件不能作为验收证据。';
  if (testCase.cleanup === 'required' && draft.status !== 'pass' && !draft.cleanup.details.trim()) return '请填写清理回读结果；未执行或未清理时须说明原因，不能留空。';
  if (draft.status === 'pass') {
    if (draft.assertions.some((item) => !item.passed || !item.actual.trim())) return '通过需逐条填写并确认通过断言，不能只勾选总体通过。';
    if (testCase.evidenceRequired && draft.evidence.length === 0) return '本项要求线上证据；缺少证据不能判通过。';
    if (draft.cleanup.status === 'fail') return '清理未通过，不能将本项验收标为通过。';
    if (testCase.cleanup === 'required' && (draft.cleanup.status !== 'pass' || !draft.cleanup.details.trim())) return '请完成资源清理并填写无残留回读结果后再判通过。';
  }
  if (draft.cleanup.status !== 'not-required' && !draft.cleanup.details.trim()) return '请填写清理实际结果或未清理原因。';
  return undefined;
}

export function preparedAcceptanceSubmission(draft: AcceptanceSubmission): AcceptanceSubmission {
  // Non-pass can be recorded before every assertion is attempted, but never sends an assertion with an empty actual.
  return { ...draft, assertions: draft.status === 'pass' ? draft.assertions : draft.assertions.filter((item) => item.actual.trim()) };
}

export function AcceptanceResultEditor({ testCase, result, writable, busy, onSave }: {
  testCase: AcceptanceCase; result?: AcceptanceResult; writable: boolean; busy: boolean;
  onSave: (draft: AcceptanceSubmission) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(() => initialAcceptanceSubmission(testCase, result));
  const [validation, setValidation] = useState('');
  const update = (patch: Partial<AcceptanceSubmission>): void => setDraft((current) => ({ ...current, ...patch }));
  const submit = async (): Promise<void> => {
    const problem = acceptanceSubmissionProblem(testCase, draft);
    if (problem) { setValidation(problem); return; }
    setValidation('');
    await onSave(preparedAcceptanceSubmission(draft));
  };
  return (
    <section className="min-w-0 space-y-4 rounded-lg border border-border bg-card p-4" aria-label={`回填 ${testCase.caseId}`}>
      <header><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">{testCase.title}</h3><span className="rounded border border-border px-2 py-0.5 font-mono text-xs">{testCase.caseId}</span><span className="text-xs text-muted-foreground">{testCase.criticality === 'core' ? '核心必测' : '一般功能'}</span></div><p className="mt-2 break-words text-sm text-muted-foreground">{testCase.breadcrumb.join(' → ')} · {testCase.entryPath}</p><p className="mt-1 text-xs text-muted-foreground">负责人：{testCase.owner} · {testCase.module}</p></header>
      {testCase.preconditions.length ? <div className="text-sm"><h4 className="mb-1 font-medium">前置条件</h4><ul className="list-inside list-disc space-y-1">{testCase.preconditions.map((value, i) => <li key={i}>{value}</li>)}</ul></div> : null}
      {testCase.inputs.length ? <div className="text-sm"><h4 className="mb-1 font-medium">固定输入</h4>{testCase.inputs.map((value, i) => <p key={i} className="break-words">{value.name}：{value.value}</p>)}</div> : null}
      <div><h4 className="mb-2 text-sm font-medium">验收步骤</h4><ol className="list-inside list-decimal space-y-2 text-sm">{testCase.steps.map((step) => <li key={step.id}><span>{step.action}</span><p className="mt-1 pl-4 text-muted-foreground">预期：{step.expected}</p></li>)}</ol></div>
      {!writable ? <p className="rounded-md border border-border bg-muted/50 p-3 text-sm">只读查看。领取此任务后可回填；已完成任务保留不可覆盖的执行记录。</p> : null}
      {validation ? <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{validation}</div> : null}
      <fieldset disabled={!writable || busy} className="min-w-0 space-y-4 disabled:opacity-70">
        <div className="grid gap-3 md:grid-cols-2"><AcceptanceField label="本项验收状态"><select className={acceptanceInputClass} value={draft.status} onChange={(event) => update({ status: event.target.value as AcceptanceSubmission['status'] })}>{Object.entries(ACCEPTANCE_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></AcceptanceField><AcceptanceField label="实际结果／失败或未执行原因"><textarea className={acceptanceInputClass} rows={3} value={draft.actual} onChange={(event) => update({ actual: event.target.value })} /></AcceptanceField></div>
        <div className="space-y-3"><h4 className="text-sm font-semibold">逐条断言</h4>{testCase.assertions.map((assertion, index) => <div className="rounded-md border border-border p-3" key={assertion.id}><label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={draft.assertions[index].passed} onChange={(event) => update({ assertions: draft.assertions.map((value, i) => i === index ? { ...value, passed: event.target.checked } : value) })} /><span>{assertion.description}</span></label><div className="mt-2"><AcceptanceField label={`断言 ${index + 1} 实际回读`}><input className={acceptanceInputClass} value={draft.assertions[index].actual} onChange={(event) => update({ assertions: draft.assertions.map((value, i) => i === index ? { ...value, actual: event.target.value } : value) })} /></AcceptanceField></div></div>)}</div>
        <div className="space-y-3"><h4 className="text-sm font-semibold">线上证据 {testCase.evidenceRequired ? '（必需）' : '（可选）'}</h4><p className="text-xs text-muted-foreground">填写图片、产物或取证的线上链接，并说明它能证明什么。入口截图不能替代实际业务结果。</p>{draft.evidence.map((evidence, index) => <div className="grid items-end gap-2 rounded-md border border-border p-3 md:grid-cols-[8rem_minmax(0,1fr)_auto]" key={index}><AcceptanceField label={`证据 ${index + 1} 类型`}><select className={acceptanceInputClass} value={evidence.kind} onChange={(event) => update({ evidence: draft.evidence.map((value, i) => i === index ? { ...value, kind: event.target.value as typeof evidence.kind } : value) })}><option value="image">图片</option><option value="artifact">业务产物</option><option value="trace">调用取证</option></select></AcceptanceField><AcceptanceField label={`证据 ${index + 1} 线上链接`}><input type="url" className={acceptanceInputClass} value={evidence.url} onChange={(event) => update({ evidence: draft.evidence.map((value, i) => i === index ? { ...value, url: event.target.value } : value) })} /></AcceptanceField><Button variant="ghost" size="sm" aria-label={`移除证据 ${index + 1}`} onClick={() => update({ evidence: draft.evidence.filter((_, i) => i !== index) })}><Trash2 /></Button><div className="md:col-span-3"><AcceptanceField label={`证据 ${index + 1} 能证明什么`}><input className={acceptanceInputClass} value={evidence.caption} onChange={(event) => update({ evidence: draft.evidence.map((value, i) => i === index ? { ...value, caption: event.target.value } : value) })} /></AcceptanceField></div></div>)}<Button variant="outline" size="sm" onClick={() => update({ evidence: [...draft.evidence, { kind: 'image', url: '', caption: '' }] })}><Plus />添加线上证据</Button></div>
        <div className="grid gap-3 md:grid-cols-2"><AcceptanceField label="清理与回读状态" help={testCase.cleanupInstructions}><select className={acceptanceInputClass} value={draft.cleanup.status} onChange={(event) => update({ cleanup: { ...draft.cleanup, status: event.target.value as AcceptanceSubmission['cleanup']['status'] } })}><option value="pass">已清理且回读无残留</option><option value="fail">清理未完成／失败</option><option value="not-required">不产生资源</option></select></AcceptanceField><AcceptanceField label="清理回读结果"><textarea rows={3} className={acceptanceInputClass} value={draft.cleanup.details} onChange={(event) => update({ cleanup: { ...draft.cleanup, details: event.target.value } })} /></AcceptanceField></div>
        <Button disabled={!writable || busy} onClick={() => void submit()}>{busy ? '正在保存结果' : '保存本项执行结果'}</Button>
      </fieldset>
      {result ? <div className="space-y-2 border-t border-border pt-3 text-xs text-muted-foreground"><p>已保存 {result.attempts.length} 次尝试 · {new Date(result.submittedAt).toLocaleString()}{result.flaky ? ' · 不稳定：重试通过不抹去首轮失败' : ''}</p>{result.attempts.map((attempt, i) => <p key={i}>尝试 {i + 1}：{ACCEPTANCE_STATUS_LABELS[attempt.status]} · {attempt.actual}</p>)}{result.evidence.map((evidence, i) => onlineEvidenceUrl(evidence.url) ? <a key={i} className="block break-words text-primary underline" href={onlineEvidenceUrl(evidence.url)} target="_blank" rel="noopener noreferrer">{evidence.caption}</a> : <p key={i}>证据链接无效，不能作为通过依据</p>)}</div> : null}
    </section>
  );
}
