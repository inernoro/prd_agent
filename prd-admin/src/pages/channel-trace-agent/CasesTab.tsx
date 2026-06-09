import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Send, Plus, Pencil, Trash2, Loader2, X, Stethoscope, Search, Upload } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { uploadAttachment } from '@/services/real/aiToolbox';
import {
  listCases,
  createCase,
  updateCase,
  deleteCase,
  caseDiagnoseUrl,
  caseImportUrl,
  type ChannelTraceCase,
  type ChannelTraceCaseSeverity,
  type ChannelTraceRelatedCase,
  type UpsertCasePayload,
} from '@/services/real/channelTraceAgent';

const SEVERITY_META: Record<ChannelTraceCaseSeverity, { label: string; cls: string }> = {
  low: { label: '低', cls: 'bg-sky-500/10 text-sky-300' },
  medium: { label: '中', cls: 'bg-amber-500/10 text-amber-300' },
  high: { label: '高', cls: 'bg-rose-500/10 text-rose-300' },
};

export function CasesTab() {
  const [items, setItems] = useState<ChannelTraceCase[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const [related, setRelated] = useState<ChannelTraceRelatedCase[]>([]);
  const [model, setModel] = useState<{ model?: string; platform?: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelTraceCase | null>(null);
  const [importMsg, setImportMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { phase, phaseMessage, typing, isStreaming, start } = useSseStream({
    url: caseDiagnoseUrl,
    method: 'POST',
    onEvent: {
      model: (d) => setModel(d as { model?: string; platform?: string }),
      relatedCases: (d) => setRelated((d as { items: ChannelTraceRelatedCase[] }).items ?? []),
    },
  });

  const importStream = useSseStream({
    url: caseImportUrl,
    method: 'POST',
    onEvent: {
      case: (d) => {
        const c = d as { title: string; index: number };
        setImportMsg(`已解析第 ${c.index} 条：${c.title}`);
      },
    },
    onPhase: (m) => setImportMsg(m),
    onDone: (d) => {
      const count = (d as { count?: number }).count ?? 0;
      setImportMsg(`导入完成，共 ${count} 条案例`);
      void load(keyword);
      window.setTimeout(() => setImportMsg(''), 4000);
    },
    onError: (m) => setImportMsg(`导入失败：${m}`),
  });

  const load = useCallback(async (kw?: string) => {
    setLoading(true);
    try {
      const res = await listCases(kw);
      if (res.success && res.data) setItems(res.data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const diagnose = () => {
    if (!problem.trim() || isStreaming) return;
    setModel(null);
    setRelated([]);
    void start({ body: { problem: problem.trim() } });
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('确定删除该案例？')) return;
    const res = await deleteCase(id);
    if (res.success) void load(keyword);
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportMsg('上传文件中…');
    const up = await uploadAttachment(file);
    if (!up.success || !up.data) {
      setImportMsg(`上传失败：${up.error?.message || ''}`);
      return;
    }
    void importStream.start({ body: { attachmentId: up.data.attachmentId } });
  };

  return (
    <div className="h-full min-h-0 flex">
      {/* 左：智能排查 */}
      <div className="flex-1 min-w-0 flex flex-col border-r border-white/10">
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="text-sm font-medium text-white/85 mb-2 inline-flex items-center gap-1.5">
            <Stethoscope className="w-4 h-4 text-emerald-400" />
            线上问题智能排查
          </div>
          <div className="flex items-end gap-2">
            <textarea
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) diagnose();
              }}
              rows={2}
              placeholder="描述线上问题现象，例如：扫码提示「该码未上码」，但生产系统显示已上码（Ctrl/⌘+Enter 发送）"
              className="flex-1 resize-none rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
            />
            <button
              onClick={diagnose}
              disabled={isStreaming || !problem.trim()}
              className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-sm hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              排查
            </button>
          </div>
          {model?.model && (
            <div className="text-[11px] text-white/40 font-mono mt-2">
              ● {model.model}
              {model.platform ? ` · ${model.platform}` : ''}
            </div>
          )}
        </div>

        <div
          className="flex-1 px-6 pb-5"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {related.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-white/50 mb-1.5">召回的相似历史案例：</div>
              <div className="flex flex-wrap gap-1.5">
                {related.map((c) => (
                  <span
                    key={c.id}
                    className="text-[11px] px-2 py-1 rounded-md bg-white/5 border border-white/10 text-white/75"
                  >
                    {c.title}
                    <span className={`ml-1.5 px-1 rounded ${SEVERITY_META[c.severity].cls}`}>
                      {SEVERITY_META[c.severity].label}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {isStreaming && !typing && (
            <div className="flex items-center gap-2 text-sm text-white/50 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              {phaseMessage || 'AI 正在排查…'}
            </div>
          )}
          {typing ? (
            <div className="rounded-xl bg-white/3 border border-white/10 px-4 py-3">
              <MarkdownContent content={typing} variant="reading" />
            </div>
          ) : (
            !isStreaming &&
            related.length === 0 && (
              <div className="text-sm text-white/35 py-10 text-center">
                描述线上问题，AI 会召回相似历史案例并给出快速排查路径。
              </div>
            )
          )}
          {phase === 'error' && (
            <div className="text-sm text-rose-400 py-3">{phaseMessage || '请求失败'}</div>
          )}
        </div>
      </div>

      {/* 右：案例库管理 */}
      <div className="w-[380px] shrink-0 flex flex-col">
        <div className="shrink-0 px-4 pt-5 pb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-white/30 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load(keyword);
              }}
              placeholder="搜索案例"
              className="w-full rounded-lg bg-white/5 border border-white/10 pl-8 pr-3 py-1.5 text-sm text-white/85 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importStream.isStreaming}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white/80 hover:bg-white/10 disabled:opacity-40"
            title="导入历史 bug 文件，AI 自动解析为案例"
          >
            {importStream.isStreaming ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5" />
            )}
            导入
          </button>
          <button
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white/80 hover:bg-white/10"
          >
            <Plus className="w-3.5 h-3.5" />
            记录
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".md,.txt,.pdf,.doc,.docx,.xls,.xlsx,.csv"
            onChange={onImportFile}
          />
        </div>
        {importMsg && (
          <div className="shrink-0 px-4 pb-2 text-[11px] text-emerald-300/80 inline-flex items-center gap-1.5">
            {importStream.isStreaming && <Loader2 className="w-3 h-3 animate-spin" />}
            {importMsg}
          </div>
        )}
        <div
          className="flex-1 px-4 pb-4 space-y-2"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <div className="text-sm text-white/40 py-6 text-center">加载中…</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-white/35 py-10 text-center">
              暂无案例，点击「记录」沉淀第一条线上问题排查经验。
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                className="rounded-lg bg-white/3 border border-white/10 px-3 py-2.5 group"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${SEVERITY_META[it.severity].cls}`}
                      >
                        {SEVERITY_META[it.severity].label}
                      </span>
                      <span className="text-sm text-white/90 font-medium truncate">{it.title}</span>
                    </div>
                    <div className="text-xs text-white/45 mt-1 line-clamp-2 whitespace-pre-wrap">
                      {it.symptom}
                    </div>
                    {it.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {it.tags.map((t) => (
                          <span
                            key={t}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300/80"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => {
                        setEditing(it);
                        setEditorOpen(true);
                      }}
                      className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10"
                      title="编辑"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDelete(it.id)}
                      className="p-1 rounded text-white/40 hover:text-rose-400 hover:bg-white/10"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {editorOpen && (
        <CaseEditorModal
          initial={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false);
            void load(keyword);
          }}
        />
      )}
    </div>
  );
}

function CaseEditorModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ChannelTraceCase | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [symptom, setSymptom] = useState(initial?.symptom ?? '');
  const [rootCause, setRootCause] = useState(initial?.rootCause ?? '');
  const [resolution, setResolution] = useState(initial?.resolution ?? '');
  const [tagsInput, setTagsInput] = useState((initial?.tags ?? []).join(', '));
  const [severity, setSeverity] = useState<ChannelTraceCaseSeverity>(initial?.severity ?? 'medium');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!title.trim() || !symptom.trim()) {
      setError('标题与现象均不能为空');
      return;
    }
    setSaving(true);
    setError('');
    const tags = tagsInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const payload: UpsertCasePayload = {
      title: title.trim(),
      symptom: symptom.trim(),
      rootCause: rootCause.trim() || undefined,
      resolution: resolution.trim() || undefined,
      tags,
      severity,
    };
    try {
      const res = initial ? await updateCase(initial.id, payload) : await createCase(payload);
      if (res.success) onSaved();
      else setError(res.error?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#0f1014] flex flex-col"
        style={{ maxHeight: '85vh' }}
      >
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-white/10">
          <div className="text-sm font-medium text-white/90">
            {initial ? '编辑问题案例' : '记录问题案例'}
          </div>
          <button onClick={onClose} className="p-1 rounded text-white/40 hover:text-white/80">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 px-5 py-4 space-y-3" style={{ minHeight: 0, overflowY: 'auto' }}>
          <div>
            <label className="text-xs text-white/55">标题</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-white/55">严重程度</label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as ChannelTraceCaseSeverity)}
                className="mt-1 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 focus:outline-none focus:border-emerald-500/40"
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs text-white/55">标签（逗号分隔）</label>
              <input
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="上码失败, 关联错乱"
                className="mt-1 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-white/55">问题现象</label>
            <textarea
              value={symptom}
              onChange={(e) => setSymptom(e.target.value)}
              rows={3}
              className="mt-1 w-full resize-y rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          <div>
            <label className="text-xs text-white/55">根因（可选）</label>
            <textarea
              value={rootCause}
              onChange={(e) => setRootCause(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-y rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          <div>
            <label className="text-xs text-white/55">排查步骤 / 解决方案（可选，支持 Markdown）</label>
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={5}
              className="mt-1 w-full resize-y rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 font-mono leading-relaxed focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          {error && <div className="text-xs text-rose-400">{error}</div>}
        </div>
        <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-sm text-white/70 hover:bg-white/5"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-sm hover:bg-emerald-500/25 disabled:opacity-40"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
