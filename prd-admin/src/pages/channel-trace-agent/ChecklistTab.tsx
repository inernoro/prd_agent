import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  X,
  ListChecks,
  Copy,
  RotateCcw,
  GripVertical,
} from 'lucide-react';
import {
  getChecklistTemplates,
  listChecklists,
  createChecklist,
  updateChecklist,
  deleteChecklist,
  type ChannelTraceChecklist,
  type ChannelTraceChecklistStep,
  type UpsertChecklistPayload,
} from '@/services/real/channelTraceAgent';

export function ChecklistTab() {
  const [templates, setTemplates] = useState<ChannelTraceChecklist[]>([]);
  const [mine, setMine] = useState<ChannelTraceChecklist[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 勾选进度：checklistId -> 已勾选的步骤索引集合（本地运行态，不入库）
  const [checked, setChecked] = useState<Record<string, Set<number>>>({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelTraceChecklist | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tpl, my] = await Promise.all([getChecklistTemplates(), listChecklists()]);
      if (tpl.success && tpl.data) setTemplates(tpl.data.items);
      if (my.success && my.data) setMine(my.data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const all = useMemo(() => [...templates, ...mine], [templates, mine]);
  const selected = useMemo(() => all.find((c) => c.id === selectedId) ?? null, [all, selectedId]);

  useEffect(() => {
    if (!selectedId && all.length > 0) setSelectedId(all[0].id);
  }, [all, selectedId]);

  const toggleStep = (checklistId: string, idx: number) => {
    setChecked((prev) => {
      const next = { ...prev };
      const set = new Set(next[checklistId] ?? []);
      if (set.has(idx)) set.delete(idx);
      else set.add(idx);
      next[checklistId] = set;
      return next;
    });
  };

  const resetProgress = (checklistId: string) => {
    setChecked((prev) => ({ ...prev, [checklistId]: new Set() }));
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('确定删除该自定义清单？')) return;
    const res = await deleteChecklist(id);
    if (res.success) {
      if (selectedId === id) setSelectedId(null);
      void load();
    }
  };

  const saveAsMine = async (tpl: ChannelTraceChecklist) => {
    const payload: UpsertChecklistPayload = {
      title: `${tpl.title}（副本）`,
      scene: tpl.scene,
      steps: tpl.steps.map((s) => ({ text: s.text, hint: s.hint ?? undefined })),
      tags: tpl.tags,
    };
    const res = await createChecklist(payload);
    if (res.success && res.data) {
      await load();
      setSelectedId(res.data.item.id);
    }
  };

  const checkedSet = selected ? checked[selected.id] ?? new Set<number>() : new Set<number>();
  const doneCount = checkedSet.size;

  return (
    <div className="h-full min-h-0 flex">
      {/* 左：清单列表 */}
      <div className="w-[320px] shrink-0 flex flex-col border-r border-white/10">
        <div className="shrink-0 px-4 pt-5 pb-3 flex items-center gap-2">
          <div className="text-sm font-medium text-white/85 inline-flex items-center gap-1.5 flex-1">
            <ListChecks className="w-4 h-4 text-emerald-400" />
            排查清单
          </div>
          <button
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white/80 hover:bg-white/10"
          >
            <Plus className="w-3.5 h-3.5" />
            新建
          </button>
        </div>
        <div
          className="flex-1 px-4 pb-4 space-y-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <div className="text-sm text-white/40 py-6 text-center">加载中…</div>
          ) : (
            <>
              <Section label="内置模板">
                {templates.map((c) => (
                  <ChecklistCard
                    key={c.id}
                    item={c}
                    active={selectedId === c.id}
                    progress={(checked[c.id]?.size ?? 0) / Math.max(1, c.steps.length)}
                    onClick={() => setSelectedId(c.id)}
                  />
                ))}
              </Section>
              <Section label="我的清单">
                {mine.length === 0 ? (
                  <div className="text-xs text-white/30 px-1 py-2">
                    暂无自定义清单。可「新建」或从内置模板「另存为我的清单」。
                  </div>
                ) : (
                  mine.map((c) => (
                    <ChecklistCard
                      key={c.id}
                      item={c}
                      active={selectedId === c.id}
                      progress={(checked[c.id]?.size ?? 0) / Math.max(1, c.steps.length)}
                      onClick={() => setSelectedId(c.id)}
                    />
                  ))
                )}
              </Section>
            </>
          )}
        </div>
      </div>

      {/* 右：清单详情 + 勾选运行 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-sm text-white/35">
            选择左侧清单查看排查步骤，逐项勾选完成排查。
          </div>
        ) : (
          <>
            <div className="shrink-0 px-6 pt-5 pb-3 border-b border-white/10">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-base font-medium text-white/90">{selected.title}</div>
                  <div className="text-xs text-white/45 mt-1 flex flex-wrap items-center gap-1.5">
                    {selected.scene && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300/80">
                        {selected.scene}
                      </span>
                    )}
                    {selected.isBuiltin ? (
                      <span className="px-1.5 py-0.5 rounded bg-white/5 text-white/50">内置模板</span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded bg-white/5 text-white/50">
                        {selected.createdByName}
                      </span>
                    )}
                    <span>
                      已完成 {doneCount}/{selected.steps.length}
                    </span>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  <button
                    onClick={() => resetProgress(selected.id)}
                    title="重置勾选"
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70 hover:bg-white/10"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                  {selected.isBuiltin ? (
                    <button
                      onClick={() => void saveAsMine(selected)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/75 hover:bg-white/10"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      另存为我的清单
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setEditing(selected);
                          setEditorOpen(true);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70 hover:bg-white/10"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => void onDelete(selected.id)}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70 hover:text-rose-400 hover:bg-white/10"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div
              className="flex-1 px-6 py-4 space-y-2"
              style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
            >
              {selected.steps.map((step, idx) => {
                const isDone = checkedSet.has(idx);
                return (
                  <button
                    key={idx}
                    onClick={() => toggleStep(selected.id, idx)}
                    className={`w-full text-left flex items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
                      isDone
                        ? 'bg-emerald-500/10 border-emerald-500/25'
                        : 'bg-white/3 border-white/10 hover:bg-white/5'
                    }`}
                  >
                    <span
                      className={`shrink-0 mt-0.5 w-5 h-5 rounded border flex items-center justify-center text-[11px] ${
                        isDone
                          ? 'bg-emerald-500/30 border-emerald-400/50 text-emerald-200'
                          : 'border-white/20 text-white/40'
                      }`}
                    >
                      {isDone ? '✓' : idx + 1}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span
                        className={`text-sm ${isDone ? 'text-white/55 line-through' : 'text-white/90'}`}
                      >
                        {step.text}
                      </span>
                      {step.hint && (
                        <span className="block text-xs text-white/45 mt-1 whitespace-pre-wrap">
                          {step.hint}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {editorOpen && (
        <ChecklistEditorModal
          initial={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={(saved) => {
            setEditorOpen(false);
            void load();
            if (saved) setSelectedId(saved);
          }}
        />
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-white/30 px-1 mb-1.5">{label}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function ChecklistCard({
  item,
  active,
  progress,
  onClick,
}: {
  item: ChannelTraceChecklist;
  active: boolean;
  progress: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
        active
          ? 'bg-emerald-500/15 border-emerald-500/30'
          : 'bg-white/3 border-white/10 hover:bg-white/5'
      }`}
    >
      <div className="text-sm text-white/90 font-medium truncate">{item.title}</div>
      <div className="flex items-center gap-2 mt-1.5">
        <div className="flex-1 h-1 rounded bg-white/10 overflow-hidden">
          <div
            className="h-full bg-emerald-400/70"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <span className="text-[10px] text-white/40">{item.steps.length} 步</span>
      </div>
    </button>
  );
}

function ChecklistEditorModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ChannelTraceChecklist | null;
  onClose: () => void;
  onSaved: (savedId?: string) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [scene, setScene] = useState(initial?.scene ?? '');
  const [tagsInput, setTagsInput] = useState((initial?.tags ?? []).join(', '));
  const [steps, setSteps] = useState<ChannelTraceChecklistStep[]>(
    initial?.steps?.length ? initial.steps.map((s) => ({ text: s.text, hint: s.hint ?? '' })) : [{ text: '', hint: '' }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateStep = (idx: number, patch: Partial<ChannelTraceChecklistStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const addStep = () => setSteps((prev) => [...prev, { text: '', hint: '' }]);
  const removeStep = (idx: number) => setSteps((prev) => prev.filter((_, i) => i !== idx));

  const save = async () => {
    const cleanSteps = steps
      .map((s) => ({ text: s.text.trim(), hint: (s.hint ?? '').trim() || undefined }))
      .filter((s) => s.text);
    if (!title.trim()) {
      setError('清单标题不能为空');
      return;
    }
    if (cleanSteps.length === 0) {
      setError('至少需要一个排查步骤');
      return;
    }
    setSaving(true);
    setError('');
    const tags = tagsInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const payload: UpsertChecklistPayload = {
      title: title.trim(),
      scene: scene.trim() || undefined,
      steps: cleanSteps,
      tags,
    };
    try {
      const res = initial ? await updateChecklist(initial.id, payload) : await createChecklist(payload);
      if (res.success) onSaved(res.data?.item.id);
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
            {initial ? '编辑排查清单' : '新建排查清单'}
          </div>
          <button onClick={onClose} className="p-1 rounded text-white/40 hover:text-white/80">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 px-5 py-4 space-y-3" style={{ minHeight: 0, overflowY: 'auto' }}>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-white/55">标题</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 focus:outline-none focus:border-emerald-500/40"
              />
            </div>
            <div className="w-40">
              <label className="text-xs text-white/55">场景</label>
              <input
                value={scene}
                onChange={(e) => setScene(e.target.value)}
                placeholder="如 扫码失败"
                className="mt-1 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-white/55">标签（逗号分隔）</label>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="上码, 扫码失败"
              className="mt-1 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-white/55">排查步骤</label>
              <button
                onClick={addStep}
                className="inline-flex items-center gap-1 text-xs text-emerald-300/80 hover:text-emerald-300"
              >
                <Plus className="w-3 h-3" />
                添加一步
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {steps.map((s, idx) => (
                <div key={idx} className="flex items-start gap-2 rounded-lg bg-white/3 border border-white/10 p-2">
                  <GripVertical className="w-3.5 h-3.5 text-white/20 mt-2 shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <input
                      value={s.text}
                      onChange={(e) => updateStep(idx, { text: e.target.value })}
                      placeholder={`第 ${idx + 1} 步：要检查/操作什么`}
                      className="w-full rounded-md bg-white/5 border border-white/10 px-2.5 py-1.5 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
                    />
                    <input
                      value={s.hint ?? ''}
                      onChange={(e) => updateStep(idx, { hint: e.target.value })}
                      placeholder="提示：怎么查 / 在哪查 / 异常长什么样（可选）"
                      className="w-full rounded-md bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs text-white/70 placeholder:text-white/25 focus:outline-none focus:border-emerald-500/40"
                    />
                  </div>
                  <button
                    onClick={() => removeStep(idx)}
                    className="shrink-0 p-1 rounded text-white/30 hover:text-rose-400 mt-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
          {error && <div className="text-xs text-rose-400">{error}</div>}
        </div>
        <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-white/10">
          <button onClick={onClose} className="px-3.5 py-1.5 rounded-lg text-sm text-white/70 hover:bg-white/5">
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
