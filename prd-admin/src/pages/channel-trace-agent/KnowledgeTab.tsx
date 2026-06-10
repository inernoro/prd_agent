import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Send, Plus, Pencil, Trash2, Loader2, X, BookOpen, Search, Upload, Paperclip, Image as ImageIcon, ClipboardPaste } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { uploadAttachment } from '@/services/real/aiToolbox';
import {
  listKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  importKnowledge,
  knowledgeAskUrl,
  type ChannelTraceKnowledge,
} from '@/services/real/channelTraceAgent';

export function KnowledgeTab() {
  const [items, setItems] = useState<ChannelTraceKnowledge[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState('');
  const [model, setModel] = useState<{ model?: string; platform?: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelTraceKnowledge | null>(null);
  const [importing, setImporting] = useState(false);
  const [askFiles, setAskFiles] = useState<{ attachmentId: string; fileName: string; isImage: boolean }[]>([]);
  const [askUploading, setAskUploading] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [contextText, setContextText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const askFileInputRef = useRef<HTMLInputElement>(null);

  const { phase, phaseMessage, typing, isStreaming, start } = useSseStream({
    url: knowledgeAskUrl,
    method: 'POST',
    onEvent: {
      model: (d) => setModel(d as { model?: string; platform?: string }),
    },
  });

  const load = useCallback(async (kw?: string) => {
    setLoading(true);
    try {
      const res = await listKnowledge(kw);
      if (res.success && res.data) setItems(res.data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ask = () => {
    if (!question.trim() || isStreaming) return;
    setModel(null);
    void start({
      body: {
        question: question.trim(),
        attachmentIds: askFiles.length > 0 ? askFiles.map((f) => f.attachmentId) : undefined,
        contextText: contextText.trim() || undefined,
      },
    });
  };

  const onAttachAskFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setAskUploading(true);
    try {
      for (const file of files) {
        if (askFiles.length >= 8) break;
        const up = await uploadAttachment(file);
        if (up.success && up.data) {
          setAskFiles((prev) => [
            ...prev,
            { attachmentId: up.data!.attachmentId, fileName: file.name, isImage: file.type.startsWith('image/') },
          ]);
        }
      }
    } finally {
      setAskUploading(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('确定删除该知识条目？')) return;
    const res = await deleteKnowledge(id);
    if (res.success) void load(keyword);
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const up = await uploadAttachment(file);
      if (!up.success || !up.data) {
        window.alert(up.error?.message || '文件上传失败');
        return;
      }
      const res = await importKnowledge({ attachmentId: up.data.attachmentId });
      if (res.success) void load(keyword);
      else window.alert(res.error?.message || '导入失败（请确认文件可解析出文本）');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex">
      {/* 左：业务知识问答 */}
      <div className="flex-1 min-w-0 flex flex-col border-r border-white/10">
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="text-sm font-medium text-white/85 mb-2 inline-flex items-center gap-1.5">
            <BookOpen className="w-4 h-4 text-emerald-400" />
            业务知识问答
          </div>
          <div className="flex items-end gap-2">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask();
              }}
              rows={2}
              placeholder="例如：防窜货的「窜货判定」是怎么定义的？上码和关联各是什么环节？（Ctrl/⌘+Enter 发送）"
              className="flex-1 resize-none rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
            />
            <button
              onClick={() => setShowPaste((v) => !v)}
              title="粘贴防窜后台页面 HTML / 文本作为上下文（比截图省 token、字段更全）"
              className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border text-sm hover:bg-white/10 ${
                showPaste || contextText.trim()
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                  : 'bg-white/5 border-white/10 text-white/75'
              }`}
            >
              <ClipboardPaste className="w-4 h-4" />
            </button>
            <button
              onClick={() => askFileInputRef.current?.click()}
              disabled={askUploading || askFiles.length >= 8}
              title="上传防窜后台页面截图 / 文档，让 AI 识别页面与操作"
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white/75 hover:bg-white/10 disabled:opacity-40"
            >
              {askUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            </button>
            <button
              onClick={ask}
              disabled={isStreaming || !question.trim()}
              className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-sm hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              提问
            </button>
            <input
              ref={askFileInputRef}
              type="file"
              multiple
              className="hidden"
              accept="image/*,.md,.txt,.pdf,.doc,.docx,.xls,.xlsx,.csv"
              onChange={onAttachAskFiles}
            />
          </div>
          {showPaste && (
            <div className="mt-2">
              <textarea
                value={contextText}
                onChange={(e) => setContextText(e.target.value)}
                rows={3}
                placeholder="粘贴防窜后台页面的 HTML 或文本（如选中页面右键「检查」复制元素，或直接复制页面文字）。提交问题时一并作为上下文。"
                className="w-full resize-y rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-xs text-white/85 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40 font-mono"
              />
              {contextText.trim() && (
                <div className="text-[11px] text-white/40 mt-1">
                  已附带粘贴内容（{contextText.trim().length} 字），提交时会去标签转纯文本。
                  <button
                    onClick={() => setContextText('')}
                    className="ml-2 text-white/40 hover:text-rose-400"
                  >
                    清空
                  </button>
                </div>
              )}
            </div>
          )}
          {askFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {askFiles.map((f, i) => (
                <span
                  key={f.attachmentId}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-white/5 border border-white/10 text-white/70"
                >
                  {f.isImage ? <ImageIcon className="w-3 h-3" /> : <Paperclip className="w-3 h-3" />}
                  <span className="max-w-[140px] truncate">{f.fileName}</span>
                  <button
                    onClick={() => setAskFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    className="text-white/40 hover:text-rose-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
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
          {isStreaming && !typing && (
            <div className="flex items-center gap-2 text-sm text-white/50 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              {phaseMessage || 'AI 正在思考…'}
            </div>
          )}
          {typing ? (
            <div className="rounded-xl bg-white/3 border border-white/10 px-4 py-3">
              <MarkdownContent content={typing} variant="reading" />
            </div>
          ) : (
            !isStreaming && (
              <div className="text-sm text-white/35 py-10 text-center">
                输入问题，AI 会基于右侧防窜物流业务知识库为你解答。
              </div>
            )
          )}
          {phase === 'error' && (
            <div className="text-sm text-rose-400 py-3">{phaseMessage || '请求失败'}</div>
          )}
        </div>
      </div>

      {/* 右：知识库管理 */}
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
              placeholder="搜索知识"
              className="w-full rounded-lg bg-white/5 border border-white/10 pl-8 pr-3 py-1.5 text-sm text-white/85 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white/80 hover:bg-white/10 disabled:opacity-40"
            title="导入文件形成知识"
          >
            {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
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
            新增
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".md,.txt,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv"
            onChange={onImportFile}
          />
        </div>
        <div
          className="flex-1 px-4 pb-4 space-y-2"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <div className="text-sm text-white/40 py-6 text-center">加载中…</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-white/35 py-10 text-center">
              暂无知识，点击「新增」沉淀第一条防窜物流业务知识。
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                className="rounded-lg bg-white/3 border border-white/10 px-3 py-2.5 group"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white/90 font-medium truncate">{it.title}</div>
                    <div className="text-xs text-white/45 mt-1 line-clamp-2 whitespace-pre-wrap">
                      {it.content}
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
        <KnowledgeEditorModal
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

function KnowledgeEditorModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ChannelTraceKnowledge | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [tagsInput, setTagsInput] = useState((initial?.tags ?? []).join(', '));
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
    if (!title.trim() || !content.trim()) {
      setError('标题与正文均不能为空');
      return;
    }
    setSaving(true);
    setError('');
    const tags = tagsInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      const res = initial
        ? await updateKnowledge(initial.id, { title: title.trim(), content, tags })
        : await createKnowledge({ title: title.trim(), content, tags });
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
            {initial ? '编辑业务知识' : '新增业务知识'}
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
          <div>
            <label className="text-xs text-white/55">正文（支持 Markdown）</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              className="mt-1 w-full resize-y rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 font-mono leading-relaxed focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          <div>
            <label className="text-xs text-white/55">标签（逗号分隔）</label>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="上码, 关联, 窜货判定"
              className="mt-1 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
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
