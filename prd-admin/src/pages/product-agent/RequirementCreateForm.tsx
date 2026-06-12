import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Save, Sparkles } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { ItemSearchSelect } from '@/components/ItemSearchSelect';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { CustomerSearchSelect } from './CustomerSearchSelect';
import { useSseStream } from '@/lib/useSseStream';
import { FormFieldsRenderer, RichTextField, useEffectiveTemplate, useEffectiveWorkflow } from './DynamicForm';
import { TapdPropertyPanel, TapdPropertyRow } from './TapdPropertyPanel';
import { toRequirementOptions } from './comboboxOptions';
import { REQUIREMENT_ORIGIN_FORM_KEY, REQUIREMENT_ORIGIN_OPTIONS, type RequirementOriginValue } from './requirementOriginCatalog';
import { validateRequirementCreateInput } from './requirementCreateValidation';
import { createRequirement, listDescTemplates } from '@/services/real/productAgent';
import type { Customer, DescTemplate, ItemGrade, Requirement } from './types';
import { ITEM_GRADE_LABEL } from './types';

const ITEM_GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];
const RESERVED_TEMPLATE_LABELS = new Set(['需求来源', '客户名称', '客户', '归属版本', '标题', '名称', '描述', '需求名称', '需求描述']);
const RESERVED_TEMPLATE_KEYS = new Set(['title', 'name', 'description', 'desc', 'requirementSource', 'customerName']);

interface AiFillResult { title?: string; description?: string; grade?: string; formData?: Record<string, string> }

function mergeDesc(prev: string, tpl: string): string {
  const stripped = (prev || '').replace(/<br\s*\/?>/gi, '').replace(/<div>\s*<\/div>/gi, '').replace(/&nbsp;/gi, '').trim();
  return stripped ? `${prev}${tpl}` : tpl;
}

function DescTemplatePicker({ onApply }: { onApply: (content: string) => void }) {
  const [templates, setTemplates] = useState<DescTemplate[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void listDescTemplates('requirement').then((res) => {
      if (alive && res.success) setTemplates(res.data.items);
    });
    return () => { alive = false; };
  }, []);
  if (templates.length === 0) return null;
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
        <FileText size={12} /> 套用模板
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-20 w-56 max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-[#1b1d22] shadow-xl p-1" style={{ overscrollBehavior: 'contain' }}>
            {templates.map((t) => (
              <button key={t.id} type="button" onClick={() => { onApply(t.content); setOpen(false); }} className="w-full text-left px-2.5 py-1.5 rounded text-sm text-white/80 hover:bg-white/5 truncate" title={t.name}>{t.name}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AiFillBar({ productId, templateId, onFill }: { productId: string; templateId?: string; onFill: (r: AiFillResult) => void }) {
  const [text, setText] = useState('');
  const { phase, phaseMessage, typing, isStreaming, start, abort } = useSseStream<AiFillResult>({
    url: `/api/product/products/${productId}/requirements/ai-fill/stream`,
    method: 'POST',
    itemEvent: 'result',
    onItem: (r) => onFill(r),
  });
  return (
    <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="粘贴原始需求描述，AI 自动拆解回填标题与字段…"
          className="flex-1 min-w-0 bg-black/20 border border-white/10 rounded-md px-2.5 py-2 text-[13px] text-white outline-none focus:border-cyan-500/40 resize-none placeholder:text-white/25"
        />
        <div className="flex items-center gap-2 shrink-0">
          {isStreaming ? (
            <button type="button" onClick={abort} className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-white/15 text-white/70 text-xs"><MapSpinner size={13} /> 停止</button>
          ) : (
            <button type="button" onClick={() => { if (text.trim()) void start({ body: { text: text.trim(), templateId } }); }} disabled={!text.trim()} className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-xs disabled:opacity-40">
              <Sparkles size={13} /> 智能填充
            </button>
          )}
        </div>
      </div>
      {phase !== 'idle' && <div className={`mt-1.5 text-[11px] ${phase === 'error' ? 'text-red-300/80' : 'text-white/45'}`}>{phaseMessage}</div>}
      {isStreaming && typing && <div className="mt-1.5 text-[11px] text-white/40 font-mono max-h-16 overflow-y-auto whitespace-pre-wrap">{typing}</div>}
    </div>
  );
}

function RequirementOriginSelect({ value, onChange }: { value: RequirementOriginValue; onChange: (v: RequirementOriginValue) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as RequirementOriginValue)}
      className="w-full h-9 rounded-[8px] border border-white/12 bg-[var(--bg-input)] px-2.5 text-[13px] text-white outline-none focus:border-cyan-500/40 no-focus-ring"
    >
      {REQUIREMENT_ORIGIN_OPTIONS.map((o) => (
        <option key={o.value || '__empty'} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function GradePicker({ grade, setGrade }: { grade: ItemGrade; setGrade: (g: ItemGrade) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ITEM_GRADES.map((g) => (
        <button
          key={g}
          type="button"
          onClick={() => setGrade(g)}
          className={`px-2 py-0.5 rounded text-[12px] border ${grade === g ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/45 border-white/10 hover:bg-white/5'}`}
        >
          {ITEM_GRADE_LABEL[g]}
        </button>
      ))}
    </div>
  );
}

export function RequirementCreateForm({
  productId,
  requirements,
  customers,
  onCreated,
}: {
  productId: string;
  requirements: Requirement[];
  customers: Customer[];
  onCreated: (newId: string) => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [assigneeId, setAssigneeId] = useState('');
  const [parentId, setParentId] = useState('');
  const [requirementOrigin, setRequirementOrigin] = useState<RequirementOriginValue>('');
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [customerList, setCustomerList] = useState(customers);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const { template } = useEffectiveTemplate('requirement', productId);
  const { workflow } = useEffectiveWorkflow('requirement', productId);
  useEffect(() => { setCustomerList(customers); }, [customers]);

  const split = useMemo(() => {
    const templateName = (template?.name ?? '').trim();
    const usable = (template?.fields ?? []).filter((f) => {
      const key = (f.key || '').toLowerCase();
      const label = (f.label || '').trim();
      if (RESERVED_TEMPLATE_KEYS.has(key) || RESERVED_TEMPLATE_LABELS.has(label)) return false;
      // 模板管理用内部名（如「需求默认表单」），不在用户表单展示
      if (label.endsWith('默认表单') || (templateName && label === templateName)) return false;
      return true;
    });
    return { files: usable.filter((f) => f.type === 'file'), others: usable.filter((f) => f.type !== 'file') };
  }, [template]);

  const mergedFormData = useMemo(() => ({
    ...formData,
    [REQUIREMENT_ORIGIN_FORM_KEY]: requirementOrigin,
  }), [formData, requirementOrigin]);

  const descAutoFilledRef = useRef(false);
  useEffect(() => {
    let alive = true;
    void listDescTemplates('requirement').then((res) => {
      if (!alive || !res.success || descAutoFilledRef.current) return;
      const content = res.data.items[0]?.content;
      if (content && !description.trim()) {
        descAutoFilledRef.current = true;
        setDescription(content);
      }
    });
    return () => { alive = false; };
  }, [description]);

  const validationError = useMemo(() => validateRequirementCreateInput({
    title,
    description,
    assigneeId,
    templateFields: [...split.others, ...split.files],
    formData: mergedFormData,
  }), [title, description, assigneeId, split.others, split.files, mergedFormData]);

  const onAiFill = (r: AiFillResult) => {
    if (r.title) setTitle(r.title);
    if (r.description) { descAutoFilledRef.current = true; setDescription(r.description); }
    if (r.grade && ITEM_GRADES.includes(r.grade as ItemGrade)) setGrade(r.grade as ItemGrade);
    if (r.formData) setFormData((prev) => ({ ...prev, ...r.formData }));
  };

  const create = async () => {
    const err = validationError;
    if (err) return setMessage(err);
    setSaving(true);
    setMessage('');
    const res = await createRequirement(productId, {
      title: title.trim(),
      description,
      grade,
      assigneeId: assigneeId || null,
      parentId: parentId || null,
      customerIds,
      formData: mergedFormData,
      templateId: template?.id,
      workflowDefId: workflow?.id,
    });
    setSaving(false);
    if (res.success && res.data) onCreated(res.data.id);
    else setMessage(res.error?.message ?? '创建需求失败');
  };

  const cancel = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/product-agent');
  };

  return (
    <div className="flex flex-col gap-0 w-full rounded-lg border border-white/10 bg-[#0f1014] overflow-hidden">
      {/* TAPD 顶栏：类型 + 操作 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/8 bg-[#13151a]">
        <span className="text-[12px] px-2 py-0.5 rounded text-amber-200 bg-amber-500/15 border border-amber-500/25">需求</span>
        <span className="text-[12px] text-white/35">新建</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={cancel} className="px-3 py-1.5 rounded-md text-[13px] text-white/60 border border-white/10 hover:bg-white/5">取消</button>
          <button type="button" onClick={() => void create()} disabled={saving || !!validationError || !title.trim()}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[13px] bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed">
            {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
          </button>
        </div>
      </div>

      {/* 标题行（TAPD：全宽单行输入） */}
      <div className="px-4 py-3 border-b border-white/8 bg-[#111318]">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="请输入标题"
          className="w-full bg-transparent text-lg font-medium text-white outline-none placeholder:text-white/25"
        />
      </div>

      {/* 双栏：左描述 / 右属性（全宽 TAPD 约 7:3） */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] gap-0 items-stretch">
        <div className="flex flex-col gap-4 p-5 xl:p-6 border-b xl:border-b-0 xl:border-r border-white/8 min-h-[560px]">
          <AiFillBar productId={productId} templateId={template?.id} onFill={onAiFill} />
          <div className="flex-1 flex flex-col rounded-lg border border-white/10 bg-[#13151a] overflow-hidden min-h-[460px]">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/8 shrink-0">
              <span className="text-[12px] text-white/55">详情描述</span>
              <DescTemplatePicker onApply={(c) => setDescription((p) => mergeDesc(p, c))} />
            </div>
            <div className="flex-1 min-h-0 p-2">
              <RichTextField value={description} onChange={setDescription} minHeight={440} placeholder="补充背景、目标、验收标准…" />
            </div>
          </div>
          {message && <div className="rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">{message}</div>}
        </div>

        <div className="p-5 xl:p-6 bg-[#0f1014] flex flex-col gap-4">
          <TapdPropertyPanel title="基本信息">
            <TapdPropertyRow label="需求来源">
              <RequirementOriginSelect value={requirementOrigin} onChange={setRequirementOrigin} />
            </TapdPropertyRow>
            <TapdPropertyRow label="分级" required>
              <GradePicker grade={grade} setGrade={setGrade} />
            </TapdPropertyRow>
            <TapdPropertyRow label="处理人" required>
              <UserSearchSelect value={assigneeId} onChange={setAssigneeId} placeholder="搜索用户名或昵称..." uiSize="md" />
            </TapdPropertyRow>
            <TapdPropertyRow label="父需求">
              <ItemSearchSelect
                value={parentId}
                onChange={setParentId}
                options={toRequirementOptions(requirements)}
                placeholder="搜索需求..."
                clearOptionLabel="无（顶层）"
                countUnit="条"
                uiSize="md"
              />
            </TapdPropertyRow>
            <TapdPropertyRow label="客户名称">
              <CustomerSearchSelect
                value={customerIds}
                onChange={setCustomerIds}
                customers={customerList}
                onCustomerCreated={(c) => setCustomerList((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c]))}
                uiSize="md"
              />
            </TapdPropertyRow>
            {split.others.map((field) => (
              <TapdPropertyRow key={field.key} label={field.label || field.key} required={field.required}>
                <FormFieldsRenderer fields={[field]} values={formData} onChange={(k, v) => setFormData((d) => ({ ...d, [k]: v }))} productId={productId} hideLabels />
              </TapdPropertyRow>
            ))}
          </TapdPropertyPanel>
          {split.files.length > 0 && (
            <TapdPropertyPanel title="附件">
              <div className="px-3 py-2">
                <FormFieldsRenderer
                  fields={split.files}
                  values={formData}
                  onChange={(k, v) => setFormData((d) => ({ ...d, [k]: v }))}
                  productId={productId}
                  hideLabels
                  fileUploadHint=""
                />
              </div>
            </TapdPropertyPanel>
          )}
        </div>
      </div>
    </div>
  );
}
