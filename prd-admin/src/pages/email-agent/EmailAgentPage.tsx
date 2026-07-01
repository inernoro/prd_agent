import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Mail, User, Search, Plus, Copy, Check, Sparkles, Pencil, Trash2, Files,
  AlertCircle, Star, HelpCircle, X,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  getEmailAgentMeta,
  listEmailTemplates,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  markEmailTemplateUsed,
} from '@/services';
import type { EmailAgentMeta, EmailTemplate } from '@/services';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { EmailTemplateEditorModal } from './EmailTemplateEditorModal';
import { EmailAiDrawer } from './EmailAiDrawer';
import { composeEmail, formatRecipients, renderText, copyToClipboard } from './emailTemplateUtils';

export function EmailAgentPage() {
  const [meta, setMeta] = useState<EmailAgentMeta | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [aiOpen, setAiOpen] = useState(false);

  const selected = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId]);

  const loadMeta = useCallback(async () => {
    const res = await getEmailAgentMeta();
    if (res.success && res.data) setMeta(res.data);
  }, []);

  const loadTemplates = useCallback(async (opts?: { keepSelection?: boolean }) => {
    setLoading(true);
    const res = await listEmailTemplates({ category: category || undefined, keyword: keyword || undefined });
    if (res.success && res.data) {
      setTemplates(res.data.items);
      setError(null);
      if (!opts?.keepSelection) {
        setSelectedId((prev) => (prev && res.data!.items.some((t) => t.id === prev) ? prev : res.data!.items[0]?.id ?? null));
      }
    } else {
      setError(res.error?.message || '加载失败');
    }
    setLoading(false);
  }, [category, keyword]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  // 切换模板时：用默认值预填主题/正文，直接进可编辑 textarea（不再逐字段填表单）
  useEffect(() => {
    if (!selected) {
      setEditSubject('');
      setEditBody('');
      return;
    }
    const defaults: Record<string, string> = {};
    for (const v of selected.variables) if (v.defaultValue) defaults[v.key] = v.defaultValue;
    setEditSubject(renderText(selected.subject, defaults));
    setEditBody(renderText(selected.body, defaults));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const categories = meta?.categories ?? [];
  const catLabel = (key: string) => categories.find((c) => c.key === key)?.label ?? key;

  const doCopy = async (text: string, key: string, tpl: EmailTemplate) => {
    const ok = await copyToClipboard(text);
    if (!ok) {
      toast.error('复制失败，请手动选择复制');
      return;
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    toast.success('已复制到剪贴板');
    // 复用打点（仅用户模板生效）
    const res = await markEmailTemplateUsed(tpl.id);
    if (res.success && res.data && !res.data.system) {
      setTemplates((arr) => arr.map((t) => (t.id === tpl.id ? { ...t, usageCount: res.data!.usageCount } : t)));
    }
  };

  const handleDelete = async (tpl: EmailTemplate) => {
    if (!window.confirm(`确定删除模板「${tpl.title}」？`)) return;
    const res = await deleteEmailTemplate(tpl.id);
    if (res.success) {
      toast.success('已删除');
      setSelectedId(null);
      void loadTemplates();
    } else {
      toast.error('删除失败', res.error?.message);
    }
  };

  const handleDuplicate = async (tpl: EmailTemplate) => {
    const res = await duplicateEmailTemplate(tpl.id);
    if (res.success && res.data) {
      toast.success('已另存为副本，可编辑');
      await loadTemplates({ keepSelection: true });
      setSelectedId(res.data.template.id);
    } else {
      toast.error('操作失败', res.error?.message);
    }
  };

  const onSaved = async (tpl: EmailTemplate) => {
    await loadTemplates({ keepSelection: true });
    setSelectedId(tpl.id);
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 px-6 py-5 overflow-hidden">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-sky-500/10 border border-sky-400/20 flex items-center justify-center">
          <Mail className="w-5 h-5 text-sky-300" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-white truncate">邮件模板智能体</h1>
          <p className="text-xs text-white/50 truncate">常用流程邮件模板库：内容 / 发送 / 抄送对象一键复制，填几个变量即可用，还能让 AI 起草润色</p>
          {meta?.authorName && (
            <p className="text-[11px] text-white/35 mt-0.5 inline-flex items-center gap-1">
              <User className="w-3 h-3" /> 作者：{meta.authorName}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="shrink-0 h-8 px-3 rounded-lg border border-white/12 bg-white/5 hover:bg-white/10 text-xs text-white/75 inline-flex items-center gap-1.5 transition"
        >
          <HelpCircle className="w-3.5 h-3.5 text-sky-300/85" /> 使用帮助
        </button>
      </header>

      {/* Body: 左列表 + 右详情 */}
      <div className="flex-1 min-h-0 flex gap-4">
        {/* 左侧：筛选 + 列表 */}
        <div className="w-[300px] shrink-0 flex flex-col gap-3 min-h-0">
          <div className="shrink-0 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-white/35 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索模板"
                className="w-full h-9 rounded-lg border border-white/12 bg-white/[0.04] pl-8 pr-3 text-sm text-white/90 placeholder:text-white/30 outline-none focus:border-sky-400/40"
              />
            </div>
            <Button variant="primary" size="sm" onClick={() => { setEditing(null); setEditorOpen(true); }}>
              <Plus className="w-3.5 h-3.5" /> 新建
            </Button>
          </div>

          <div className="shrink-0 flex flex-wrap gap-1.5">
            <CatChip active={category === ''} onClick={() => setCategory('')}>全部</CatChip>
            {categories.map((c) => (
              <CatChip key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
                {c.label}
              </CatChip>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-white/10 bg-white/[0.02]">
            {loading ? (
              <div className="h-full flex items-center justify-center"><MapSectionLoader /></div>
            ) : error ? (
              <div className="h-full flex items-center justify-center text-sm text-red-300/80 px-4 text-center">
                <AlertCircle className="w-4 h-4 mr-1.5" /> {error}
              </div>
            ) : templates.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-2">
                <Mail className="w-8 h-8 text-white/20" />
                <p className="text-sm text-white/45">没有匹配的模板</p>
                <Button variant="secondary" size="sm" onClick={() => { setEditing(null); setEditorOpen(true); }}>
                  <Plus className="w-3.5 h-3.5" /> 新建模板
                </Button>
              </div>
            ) : (
              <ul className="divide-y divide-white/5">
                {templates.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(t.id)}
                      className={`w-full text-left px-3 py-2.5 transition ${
                        selectedId === t.id ? 'bg-sky-500/15' : 'hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white/90 truncate flex-1">{t.title}</span>
                        {t.isSystem && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50">预置</span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-white/40">
                        <span className="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-200/80">{catLabel(t.category)}</span>
                        {t.usageCount > 0 && (
                          <span className="inline-flex items-center gap-0.5"><Star className="w-2.5 h-2.5" /> {t.usageCount}</span>
                        )}
                        {t.scenario && <span className="truncate">{t.scenario}</span>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* 右侧：详情 */}
        <div className="flex-1 min-h-0 rounded-xl border border-white/10 bg-white/[0.02] overflow-auto">
          {selected ? (
            <EmailTemplateDetail
              tpl={selected}
              subject={editSubject}
              body={editBody}
              onSubjectChange={setEditSubject}
              onBodyChange={setEditBody}
              catLabel={catLabel}
              copiedKey={copiedKey}
              onCopy={doCopy}
              onEdit={() => { setEditing(selected); setEditorOpen(true); }}
              onDuplicate={() => handleDuplicate(selected)}
              onDelete={() => handleDelete(selected)}
              onPolish={() => setAiOpen(true)}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center gap-3 px-6">
              <Mail className="w-10 h-10 text-white/15" />
              <p className="text-sm text-white/45">从左侧选择一个模板，或新建一个</p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setAiOpen(true)}>
                  <Sparkles className="w-3.5 h-3.5" /> 让 AI 起草
                </Button>
                <Button variant="primary" size="sm" onClick={() => { setEditing(null); setEditorOpen(true); }}>
                  <Plus className="w-3.5 h-3.5" /> 新建模板
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <EmailTemplateEditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        categories={categories}
        editing={editing}
        onSaved={onSaved}
      />

      <EmailAiDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        initialMode={selected ? 'polish' : 'draft'}
        initialContent={selected ? editBody : ''}
        baseTemplate={selected}
        onApply={selected ? (t) => setEditBody(t) : undefined}
      />

      <EmailHelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

function CatChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 px-2.5 rounded-full text-xs border transition ${
        active ? 'border-sky-400/50 bg-sky-500/20 text-white' : 'border-white/12 bg-white/5 text-white/60 hover:text-white/85'
      }`}
    >
      {children}
    </button>
  );
}

function EmailTemplateDetail({
  tpl,
  subject,
  body,
  onSubjectChange,
  onBodyChange,
  catLabel,
  copiedKey,
  onCopy,
  onEdit,
  onDuplicate,
  onDelete,
  onPolish,
}: {
  tpl: EmailTemplate;
  subject: string;
  body: string;
  onSubjectChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  catLabel: (k: string) => string;
  copiedKey: string | null;
  onCopy: (text: string, key: string, tpl: EmailTemplate) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPolish: () => void;
}) {
  const fullEmail = composeEmail(tpl, subject, body);

  return (
    <div className="p-5 space-y-4">
      {/* 标题行 + 操作 */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-white">{tpl.title}</h2>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-200/80">{catLabel(tpl.category)}</span>
            {tpl.isSystem && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50">系统预置</span>}
          </div>
          {tpl.scenario && <p className="mt-1 text-xs text-white/50">{tpl.scenario}</p>}
          {tpl.createdByName && (
            <p className="mt-1 text-[11px] text-white/35 inline-flex items-center gap-1">
              <User className="w-3 h-3" /> {tpl.createdByName}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {tpl.isSystem ? (
            <Button variant="secondary" size="sm" onClick={onDuplicate}>
              <Files className="w-3.5 h-3.5" /> 另存为
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <Pencil className="w-3.5 h-3.5" /> 编辑
              </Button>
              <Button variant="secondary" size="sm" onClick={onDuplicate}>
                <Files className="w-3.5 h-3.5" />
              </Button>
              <button type="button" onClick={onDelete} className="h-[28px] px-2 rounded-[9px] text-white/45 hover:text-red-300 hover:bg-white/10 inline-flex items-center">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* 收件人 / 抄送 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <RecipientsBlock title="发送对象" list={tpl.toRecipients} />
        <RecipientsBlock title="抄送对象" list={tpl.ccRecipients} />
      </div>

      {/* 可编辑邮件内容：直接改，改完复制。主题 + 正文两个可编辑框 */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between gap-2">
          <span className="text-[11px] text-white/45">邮件内容（可直接修改后复制）</span>
          <div className="flex items-center gap-1.5">
            <CopyBtn label="复制主题" active={copiedKey === 'subject'} onClick={() => onCopy(subject, 'subject', tpl)} />
            <CopyBtn label="复制正文" active={copiedKey === 'body'} onClick={() => onCopy(body, 'body', tpl)} />
          </div>
        </div>
        <div className="px-3 py-3 space-y-3">
          <div>
            <label className="block text-[11px] text-white/45 mb-1">主题</label>
            <input
              value={subject}
              onChange={(e) => onSubjectChange(e.target.value)}
              placeholder="邮件主题"
              className="w-full h-9 rounded-lg border border-white/12 bg-white/[0.04] px-3 text-sm text-white/90 placeholder:text-white/30 outline-none focus:border-sky-400/40"
            />
          </div>
          <div>
            <label className="block text-[11px] text-white/45 mb-1">正文</label>
            <textarea
              value={body}
              onChange={(e) => onBodyChange(e.target.value)}
              placeholder="邮件正文，可直接修改"
              rows={16}
              className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-sm text-white/90 placeholder:text-white/30 outline-none focus:border-sky-400/40 resize-y leading-relaxed"
            />
          </div>
        </div>
      </div>

      {/* 主操作 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" size="sm" onClick={() => onCopy(fullEmail, 'full', tpl)}>
          {copiedKey === 'full' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} 一键复制整封邮件
        </Button>
        <Button variant="secondary" size="sm" onClick={onPolish}>
          <Sparkles className="w-3.5 h-3.5" /> AI 润色正文
        </Button>
      </div>
    </div>
  );
}

function RecipientsBlock({ title, list }: { title: string; list: EmailTemplate['toRecipients'] }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[11px] text-white/45 mb-1">{title}</div>
      {list.length === 0 ? (
        <div className="text-xs text-white/30">无</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {list.map((r, i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-white/[0.06] text-white/75 border border-white/10" title={r.email || r.note || ''}>
              {r.name}
              {r.note ? <span className="text-white/40">（{r.note}）</span> : null}
            </span>
          ))}
        </div>
      )}
      <div className="sr-only">{formatRecipients(list)}</div>
    </div>
  );
}

function CopyBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-7 px-2 rounded-md text-[11px] text-white/70 hover:bg-white/10 inline-flex items-center gap-1">
      {active ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />} {label}
    </button>
  );
}

function EmailHelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const drawer = (
    <div className="fixed inset-0 z-[100] flex justify-end" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <aside
        className="h-full border-l border-white/10 bg-[#0f1014] shadow-2xl flex flex-col"
        style={{ width: 'min(92vw, 480px)', maxHeight: '100vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-white">邮件模板智能体使用帮助</h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-white/55">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 px-5 py-4 space-y-4 text-sm text-white/75" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">怎么用</h3>
            <ol className="list-decimal list-inside space-y-1.5 text-white/65">
              <li>左侧挑一个贴近你场景的模板（系统已内置请假 / 加班 / 汇报 / 通知 / 交接 / 报销）。</li>
              <li>右侧「填写变量」把姓名、日期、事由等填上，成品预览会实时套用。</li>
              <li>点「一键复制整封邮件」，收件人 / 抄送 / 主题 / 正文一起进剪贴板，粘贴到邮件客户端微调即可发送。</li>
              <li>没有合适模板时点「让 AI 起草」，一句话描述场景，AI 流式生成含收发建议的邮件。</li>
              <li>常用的自己写法可「新建」或把系统模板「另存为」后编辑，沉淀成你的专属模板库。</li>
            </ol>
          </section>
          <section className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-medium text-white mb-2">占位符</h3>
            <p className="text-white/65">正文里 {'{{name}}'} 这类记号就是变量，填写后自动替换；没填的会原样保留，方便你一眼看到还差什么。</p>
          </section>
        </div>
      </aside>
    </div>
  );

  return createPortal(drawer, document.body);
}
