import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, Save, Sparkles } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { EmailAiDrawer } from './EmailAiDrawer';
import {
  createEmailTemplate,
  updateEmailTemplate,
} from '@/services';
import type {
  EmailTemplate,
  EmailCategoryOption,
  EmailRecipient,
  EmailTemplateVariable,
  UpsertEmailTemplateInput,
} from '@/services';

interface Props {
  open: boolean;
  onClose: () => void;
  categories: EmailCategoryOption[];
  /** null = 新建；否则编辑该模板（必须是用户自建，非系统） */
  editing: EmailTemplate | null;
  /** 保存成功回调，返回最新模板 */
  onSaved: (tpl: EmailTemplate) => void;
}

const emptyRecipient = (): EmailRecipient => ({ name: '', email: '', note: '' });
const emptyVariable = (): EmailTemplateVariable => ({ key: '', label: '', placeholder: '', defaultValue: '', multiline: false });

export function EmailTemplateEditorModal({ open, onClose, categories, editing, onSaved }: Props) {
  const [aiOpen, setAiOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('other');
  const [scenario, setScenario] = useState('');
  const [subject, setSubject] = useState('');
  const [approvalTarget, setApprovalTarget] = useState('');
  const [body, setBody] = useState('');
  const [toRecipients, setToRecipients] = useState<EmailRecipient[]>([]);
  const [ccRecipients, setCcRecipients] = useState<EmailRecipient[]>([]);
  const [variables, setVariables] = useState<EmailTemplateVariable[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setTitle(editing.title);
      setCategory(editing.category);
      setScenario(editing.scenario ?? '');
      setSubject(editing.subject);
      setApprovalTarget(editing.approvalTarget ?? '');
      setBody(editing.body);
      setToRecipients(editing.toRecipients.length ? editing.toRecipients.map((r) => ({ ...r })) : []);
      setCcRecipients(editing.ccRecipients.length ? editing.ccRecipients.map((r) => ({ ...r })) : []);
      setVariables(editing.variables.length ? editing.variables.map((v) => ({ ...v })) : []);
    } else {
      setTitle('');
      setCategory(categories[0]?.key ?? 'other');
      setScenario('');
      setSubject('');
      setApprovalTarget('');
      setBody('');
      setToRecipients([emptyRecipient()]);
      setCcRecipients([]);
      setVariables([]);
    }
  }, [open, editing, categories]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const save = async () => {
    if (!title.trim()) {
      toast.warning('请填写模板名称');
      return;
    }
    setSaving(true);
    const payload: UpsertEmailTemplateInput = {
      title: title.trim(),
      category,
      scenario: scenario.trim() || undefined,
      subject: subject.trim(),
      approvalTarget: approvalTarget.trim() || undefined,
      body,
      toRecipients: toRecipients.filter((r) => r.name.trim()),
      ccRecipients: ccRecipients.filter((r) => r.name.trim()),
      variables: variables.filter((v) => v.key.trim()),
    };
    const res = editing
      ? await updateEmailTemplate(editing.id, payload)
      : await createEmailTemplate(payload);
    setSaving(false);
    if (res.success && res.data) {
      toast.success(editing ? '模板已更新' : '模板已创建');
      onSaved(res.data.template);
      onClose();
    } else {
      toast.error('保存失败', res.error?.message);
    }
  };

  if (!open) return null;

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-2xl border border-white/10 bg-[#0f1014] shadow-2xl flex flex-col"
        style={{ maxWidth: '760px', height: '88vh', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-white">{editing ? '编辑模板' : '新建模板'}</h2>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAiOpen(true)}>
              <Sparkles className="w-3.5 h-3.5" /> AI 起草正文
            </Button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-white/55">
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 px-5 py-4 space-y-4" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="模板名称 *">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：请假审批申请" className={inputCls} />
            </Field>
            <Field label="流程分类">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
                {categories.map((c) => (
                  <option key={c.key} value={c.key} className="bg-[#0f1014]">
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="适用场景">
            <input value={scenario} onChange={(e) => setScenario(e.target.value)} placeholder="什么时候用这个模板" className={inputCls} />
          </Field>

          <Field label="邮件主题">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="支持占位符，如 【请假申请】{{name}}" className={inputCls} />
          </Field>

          <Field label="审批对象 / 内容描述">
            <textarea value={approvalTarget} onChange={(e) => setApprovalTarget(e.target.value)} rows={2} placeholder="谁来审批、内容要点是什么" className={`${inputCls} resize-y`} />
          </Field>

          <Field label="正文">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="邮件正文，占位符用 {{变量名}}，如 {{name}}、{{startDate}}" className={`${inputCls} resize-y font-mono text-[13px] leading-relaxed`} />
          </Field>

          <RecipientEditor title="发送对象（收件人）" list={toRecipients} onChange={setToRecipients} />
          <RecipientEditor title="抄送对象" list={ccRecipients} onChange={setCcRecipients} />
          <VariableEditor list={variables} onChange={setVariables} />
        </div>

        <footer className="shrink-0 px-5 py-3 border-t border-white/10 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={saving}>
            <Save className="w-3.5 h-3.5" /> {saving ? '保存中…' : '保存'}
          </Button>
        </footer>
      </div>

      <EmailAiDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        initialMode="draft"
        onApply={(t) => {
          setBody(t);
          setAiOpen(false);
        }}
      />
    </div>
  );

  return createPortal(modal, document.body);
}

const inputCls =
  'w-full h-9 rounded-lg border border-white/12 bg-white/[0.04] px-3 text-sm text-white/90 placeholder:text-white/30 outline-none focus:border-indigo-400/40';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-white/60 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function RecipientEditor({
  title,
  list,
  onChange,
}: {
  title: string;
  list: EmailRecipient[];
  onChange: (v: EmailRecipient[]) => void;
}) {
  const update = (i: number, patch: Partial<EmailRecipient>) => {
    onChange(list.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/70">{title}</span>
        <button
          type="button"
          onClick={() => onChange([...list, emptyRecipient()])}
          className="h-7 px-2 rounded-md text-[11px] text-white/70 hover:bg-white/10 inline-flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> 添加
        </button>
      </div>
      {list.length === 0 ? (
        <p className="text-[11px] text-white/30">暂无</p>
      ) : (
        <div className="space-y-2">
          {list.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="角色/姓名" className={`${inputCls} h-8 flex-1`} />
              <input value={r.email ?? ''} onChange={(e) => update(i, { email: e.target.value })} placeholder="邮箱（可空）" className={`${inputCls} h-8 flex-1`} />
              <input value={r.note ?? ''} onChange={(e) => update(i, { note: e.target.value })} placeholder="备注" className={`${inputCls} h-8 w-24`} />
              <button type="button" onClick={() => onChange(list.filter((_, idx) => idx !== i))} className="p-1.5 rounded-md text-white/40 hover:text-red-300 hover:bg-white/10">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VariableEditor({
  list,
  onChange,
}: {
  list: EmailTemplateVariable[];
  onChange: (v: EmailTemplateVariable[]) => void;
}) {
  const update = (i: number, patch: Partial<EmailTemplateVariable>) => {
    onChange(list.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  };
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-white/70">占位符变量</span>
        <button
          type="button"
          onClick={() => onChange([...list, emptyVariable()])}
          className="h-7 px-2 rounded-md text-[11px] text-white/70 hover:bg-white/10 inline-flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> 添加
        </button>
      </div>
      <p className="text-[11px] text-white/30 mb-2">正文里用 {'{{key}}'} 引用，填写后一键复制会自动替换。</p>
      {list.length === 0 ? (
        <p className="text-[11px] text-white/30">暂无</p>
      ) : (
        <div className="space-y-2">
          {list.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={v.key} onChange={(e) => update(i, { key: e.target.value })} placeholder="key" className={`${inputCls} h-8 w-28 font-mono`} />
              <input value={v.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="显示标签" className={`${inputCls} h-8 flex-1`} />
              <input value={v.defaultValue ?? ''} onChange={(e) => update(i, { defaultValue: e.target.value })} placeholder="默认值" className={`${inputCls} h-8 w-28`} />
              <label className="text-[11px] text-white/50 inline-flex items-center gap-1 shrink-0">
                <input type="checkbox" checked={!!v.multiline} onChange={(e) => update(i, { multiline: e.target.checked })} /> 多行
              </label>
              <button type="button" onClick={() => onChange(list.filter((_, idx) => idx !== i))} className="p-1.5 rounded-md text-white/40 hover:text-red-300 hover:bg-white/10">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
