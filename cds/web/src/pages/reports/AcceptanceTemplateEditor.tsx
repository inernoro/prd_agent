import { useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AcceptanceCase, AcceptanceTemplate } from '@/lib/acceptance-api';

export const acceptanceInputClass = 'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function AcceptanceField({ label, children, help }: { label: string; children: ReactNode; help?: string }): JSX.Element {
  return <div className="flex min-w-0 flex-col gap-1.5 text-sm"><label className="flex min-w-0 flex-col gap-1.5"><span className="font-medium">{label}</span>{children}</label>{help ? <span className="text-xs text-muted-foreground">{help}</span> : null}</div>;
}

export function newAcceptanceCase(index: number): AcceptanceCase {
  return {
    caseId: `CORE-${String(index + 1).padStart(3, '0')}`, title: '', module: '', criticality: 'core',
    environments: ['production'], breadcrumb: [], entryPath: '', preconditions: [], inputs: [],
    steps: [{ id: 'step-1', action: '', expected: '' }], assertions: [{ id: 'assert-1', description: '' }],
    evidenceRequired: true, cleanup: 'required', cleanupInstructions: '', owner: '',
  };
}

function nextId(prefix: string, values: Array<{ id: string }>): string {
  let index = values.length + 1;
  while (values.some((value) => value.id === `${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function lines(value: string): string[] { return value.split('\n').map((line) => line.trim()).filter(Boolean); }

export function AcceptanceTemplateEditor({ template, busy, onPublish, onCancel }: {
  template?: AcceptanceTemplate;
  busy: boolean;
  onPublish: (draft: { title: string; description: string; cases: AcceptanceCase[] }) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(template?.title ?? '核心功能稳定验收');
  const [description, setDescription] = useState(template?.description ?? '以正式环境为主体，逐项验证重要产品功能的真实结果。');
  const [cases, setCases] = useState<AcceptanceCase[]>(() => template ? structuredClone(template.cases) : [newAcceptanceCase(0)]);
  const [validation, setValidation] = useState('');
  const update = (index: number, patch: Partial<AcceptanceCase>): void => setCases((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  const submit = async (): Promise<void> => {
    const invalid = cases.find((item) => !item.caseId.trim() || !item.title.trim() || !item.module.trim() || !item.owner.trim()
      || !item.entryPath.trim() || item.environments.length === 0 || item.steps.length === 0 || item.assertions.length === 0
      || item.steps.some((step) => !step.action.trim() || !step.expected.trim()) || item.assertions.some((assertion) => !assertion.description.trim())
      || (item.cleanup === 'required' && !item.cleanupInstructions.trim()));
    if (!title.trim() || !cases.length || invalid || new Set(cases.map((item) => item.caseId.trim())).size !== cases.length) {
      setValidation('未能发布：请填写清单名称及每项功能、唯一编号、模块、负责人、入口、步骤、通过断言和必需的清理说明。');
      return;
    }
    setValidation('');
    await onPublish({ title: title.trim(), description, cases });
  };

  return (
    <section className="flex min-h-0 flex-col gap-4" aria-label="结构化测试清单编辑器">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{template ? `发布新版本（当前 v${template.version}）` : '新建测试清单'}</h2><p className="mt-1 text-sm text-muted-foreground">每项都是用户能完成的一件事。发布后历史任务保留原模板快照。</p></div>
        <div className="flex gap-2"><Button variant="outline" onClick={onCancel} disabled={busy}>取消</Button><Button onClick={() => void submit()} disabled={busy}>{busy ? '正在发布' : '发布清单版本'}</Button></div>
      </div>
      {validation ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{validation}</div> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <AcceptanceField label="清单名称"><input value={title} onChange={(event) => setTitle(event.target.value)} className={acceptanceInputClass} /></AcceptanceField>
        <AcceptanceField label="清单目标"><input value={description} onChange={(event) => setDescription(event.target.value)} className={acceptanceInputClass} /></AcceptanceField>
      </div>
      {cases.map((item, index) => (
        <fieldset key={index} className="min-w-0 rounded-lg border border-border bg-card p-4">
          <legend className="px-2 text-sm font-semibold">重要功能 {index + 1}</legend>
          <div className="mb-3 flex justify-end"><Button variant="ghost" size="sm" disabled={cases.length === 1 || busy} onClick={() => setCases((current) => current.filter((_, i) => i !== index))}><Trash2 />移除功能</Button></div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <AcceptanceField label="重要功能"><input placeholder="例如：默认模型文字生图" className={acceptanceInputClass} value={item.title} onChange={(event) => update(index, { title: event.target.value })} /></AcceptanceField>
            <AcceptanceField label="用例编号 caseId"><input className={acceptanceInputClass} value={item.caseId} onChange={(event) => update(index, { caseId: event.target.value })} /></AcceptanceField>
            <AcceptanceField label="所属模块"><input className={acceptanceInputClass} value={item.module} onChange={(event) => update(index, { module: event.target.value })} /></AcceptanceField>
            <AcceptanceField label="负责人"><input className={acceptanceInputClass} value={item.owner} onChange={(event) => update(index, { owner: event.target.value })} /></AcceptanceField>
            <AcceptanceField label="关键程度"><select className={acceptanceInputClass} value={item.criticality} onChange={(event) => update(index, { criticality: event.target.value as AcceptanceCase['criticality'] })}><option value="core">核心必测</option><option value="standard">一般功能</option></select></AcceptanceField>
            <div className="flex flex-col gap-2 text-sm"><span className="font-medium">执行环境</span>{(['production', 'cds'] as const).map((environment) => <label className="flex items-center gap-2" key={environment}><input type="checkbox" value={environment} checked={item.environments.includes(environment)} onChange={(event) => update(index, { environments: event.target.checked ? [...item.environments, environment] : item.environments.filter((value) => value !== environment) })} />{environment === 'production' ? '正式环境（主体）' : 'CDS（少量核心项）'}</label>)}</div>
            <AcceptanceField label="业务面包屑" help="每行一个导航层级"><textarea className={acceptanceInputClass} rows={3} value={item.breadcrumb.join('\n')} onChange={(event) => update(index, { breadcrumb: event.target.value.split('\n') })} /></AcceptanceField>
            <AcceptanceField label="业务入口路径"><input className={acceptanceInputClass} placeholder="/visual-agent" value={item.entryPath} onChange={(event) => update(index, { entryPath: event.target.value })} /></AcceptanceField>
            <AcceptanceField label="前置条件" help="每行一个条件"><textarea className={acceptanceInputClass} rows={3} value={item.preconditions.join('\n')} onChange={(event) => update(index, { preconditions: event.target.value.split('\n') })} /></AcceptanceField>
          </div>
          <div className="mt-4 space-y-3">
            <h3 className="text-sm font-semibold">固定输入</h3>
            {item.inputs.map((input, inputIndex) => <div key={inputIndex} className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1"><AcceptanceField label={`输入 ${inputIndex + 1} 名称`}><input className={acceptanceInputClass} value={input.name} onChange={(event) => update(index, { inputs: item.inputs.map((value, i) => i === inputIndex ? { ...value, name: event.target.value } : value) })} /></AcceptanceField></div><div className="min-w-0 flex-[2]"><AcceptanceField label={`输入 ${inputIndex + 1} 内容`}><input className={acceptanceInputClass} value={input.value} onChange={(event) => update(index, { inputs: item.inputs.map((value, i) => i === inputIndex ? { ...value, value: event.target.value } : value) })} /></AcceptanceField></div><Button variant="ghost" size="sm" aria-label={`移除输入 ${inputIndex + 1}`} onClick={() => update(index, { inputs: item.inputs.filter((_, i) => i !== inputIndex) })}><Trash2 /></Button></div>)}
            <Button variant="outline" size="sm" onClick={() => update(index, { inputs: [...item.inputs, { name: '', value: '' }] })}><Plus />添加输入</Button>
          </div>
          <div className="mt-4 space-y-3">
            <h3 className="text-sm font-semibold">真人验收步骤与预期</h3>
            {item.steps.map((step, stepIndex) => <div key={step.id} className="rounded-md border border-border p-3"><div className="mb-2 flex items-center justify-between text-sm"><span>步骤 {stepIndex + 1} · {step.id}</span><Button variant="ghost" size="sm" aria-label={`移除步骤 ${stepIndex + 1}`} disabled={item.steps.length === 1} onClick={() => update(index, { steps: item.steps.filter((_, i) => i !== stepIndex) })}><Trash2 /></Button></div><div className="grid gap-3 md:grid-cols-2"><AcceptanceField label={`步骤 ${stepIndex + 1} 操作`}><textarea rows={2} className={acceptanceInputClass} value={step.action} onChange={(event) => update(index, { steps: item.steps.map((value, i) => i === stepIndex ? { ...value, action: event.target.value } : value) })} /></AcceptanceField><AcceptanceField label={`步骤 ${stepIndex + 1} 预期`}><textarea rows={2} className={acceptanceInputClass} value={step.expected} onChange={(event) => update(index, { steps: item.steps.map((value, i) => i === stepIndex ? { ...value, expected: event.target.value } : value) })} /></AcceptanceField></div></div>)}
            <Button variant="outline" size="sm" onClick={() => update(index, { steps: [...item.steps, { id: nextId('step', item.steps), action: '', expected: '' }] })}><Plus />添加步骤</Button>
          </div>
          <div className="mt-4 space-y-3">
            <h3 className="text-sm font-semibold">可机械判定的通过断言</h3>
            {item.assertions.map((assertion, assertionIndex) => <div key={assertion.id} className="flex items-end gap-2"><div className="min-w-0 flex-1"><AcceptanceField label={`断言 ${assertionIndex + 1} · ${assertion.id}`}><input className={acceptanceInputClass} placeholder="例如：返回图片可下载、可解码且尺寸为1024×1024" value={assertion.description} onChange={(event) => update(index, { assertions: item.assertions.map((value, i) => i === assertionIndex ? { ...value, description: event.target.value } : value) })} /></AcceptanceField></div><Button variant="ghost" size="sm" aria-label={`移除断言 ${assertionIndex + 1}`} disabled={item.assertions.length === 1} onClick={() => update(index, { assertions: item.assertions.filter((_, i) => i !== assertionIndex) })}><Trash2 /></Button></div>)}
            <Button variant="outline" size="sm" onClick={() => update(index, { assertions: [...item.assertions, { id: nextId('assert', item.assertions), description: '' }] })}><Plus />添加断言</Button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="space-y-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.evidenceRequired} onChange={(event) => update(index, { evidenceRequired: event.target.checked })} />必须有线上证据才能通过</label><AcceptanceField label="资源清理要求"><select className={acceptanceInputClass} value={item.cleanup} onChange={(event) => update(index, { cleanup: event.target.value as AcceptanceCase['cleanup'] })}><option value="required">清理并回读无残留</option><option value="none">不产生资源，无需清理</option></select></AcceptanceField></div>
            <AcceptanceField label="清理操作与回读标准"><textarea className={acceptanceInputClass} rows={3} value={item.cleanupInstructions} onChange={(event) => update(index, { cleanupInstructions: event.target.value })} /></AcceptanceField>
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap justify-between gap-2"><Button variant="outline" disabled={busy} onClick={() => setCases((current) => { let index = current.length; while (current.some((item) => item.caseId === newAcceptanceCase(index).caseId)) index += 1; return [...current, newAcceptanceCase(index)]; })}><Plus />添加重要功能</Button><Button disabled={busy} onClick={() => void submit()}>发布清单版本</Button></div>
    </section>
  );
}

export function normalizeAcceptanceCases(cases: AcceptanceCase[]): AcceptanceCase[] {
  return cases.map((item) => ({ ...item, caseId: item.caseId.trim(), breadcrumb: lines(item.breadcrumb.join('\n')), preconditions: lines(item.preconditions.join('\n')) }));
}
