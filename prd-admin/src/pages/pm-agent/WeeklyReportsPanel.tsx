import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, Upload, Image as ImageIcon, FileText, Eye, Columns, Download, Target, ListTodo, Link2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { toast } from '@/lib/toast';
import {
  listPmWeeklyReports, createPmWeeklyReport, updatePmWeeklyReport, deletePmWeeklyReport, uploadPmWeeklyReportImage,
  listPmGoals, getPmProject,
} from '@/services';
import type { PmWeeklyReport, PmGoal, PmTask } from '@/services/contracts/pmAgent';
import { ImportPersonalReportModal } from './ImportPersonalReportModal';

interface Props {
  projectId: string;
  /** 从目标画布跳转定位到某条周报 */
  targetReportId?: string;
  onTargetConsumed?: () => void;
}

function fmtDate(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 项目周报 — 左列周报列表 + 右侧 Markdown 阅读/编辑。
 * 支持 md 文档导入（客户端读取文本）、内嵌图片上传插入、舒适版式渲染（reading variant）。
 */
export function WeeklyReportsPanel({ projectId, targetReportId, onTargetConsumed }: Props) {
  const [reports, setReports] = useState<PmWeeklyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // null=未编辑；'new'=新建；其它=编辑该 id
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftWeekStart, setDraftWeekStart] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // 关联目标/任务候选 + 草稿选中
  const [goals, setGoals] = useState<PmGoal[]>([]);
  const [tasks, setTasks] = useState<PmTask[]>([]);
  const [draftGoalIds, setDraftGoalIds] = useState<string[]>([]);
  const [draftTaskIds, setDraftTaskIds] = useState<string[]>([]);
  const [relateOpen, setRelateOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const res = await listPmWeeklyReports(projectId);
    if (res.success) {
      setReports(res.data.items);
      setSelectedId((cur) => cur ?? res.data.items[0]?.id ?? null);
    } else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);

  // 加载关联候选（目标 + 任务），供周报标注关联使用
  const loadRefs = useCallback(async () => {
    const [gr, pr] = await Promise.all([listPmGoals(projectId), getPmProject(projectId)]);
    if (gr.success) setGoals(gr.data.items);
    if (pr.success) setTasks(pr.data.tasks);
  }, [projectId]);

  useEffect(() => { load(); loadRefs(); }, [load, loadRefs]);

  // 从目标画布跳转定位到指定周报（待列表载入后选中）
  useEffect(() => {
    if (!targetReportId) return;
    if (reports.some((r) => r.id === targetReportId)) {
      setEditing(null);
      setSelectedId(targetReportId);
      onTargetConsumed?.();
    }
  }, [targetReportId, reports, onTargetConsumed]);

  const selected = reports.find((r) => r.id === selectedId) || null;
  const goalTitle = (id: string) => goals.find((g) => g.id === id)?.title ?? '（已删除目标）';
  const taskTitle = (id: string) => tasks.find((t) => t.id === id)?.title ?? '（已删除任务）';
  const toggleId = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const startCreate = (title = '', content = '') => {
    setEditing('new'); setDraftTitle(title); setDraftWeekStart(''); setDraftContent(content); setPreviewMode(false);
    setDraftGoalIds([]); setDraftTaskIds([]); setRelateOpen(false);
  };
  const startEdit = (r: PmWeeklyReport) => {
    setEditing(r.id); setDraftTitle(r.title); setDraftWeekStart(r.weekStart ? fmtDate(r.weekStart) : ''); setDraftContent(r.content); setPreviewMode(false);
    setDraftGoalIds(r.relatedGoalIds ?? []); setDraftTaskIds(r.relatedTaskIds ?? []); setRelateOpen(false);
  };
  const cancelEdit = () => { setEditing(null); };

  const handleImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const name = file.name.replace(/\.(md|markdown|txt)$/i, '');
      startCreate(name, text);
      toast.success('已导入', '请确认标题与内容后保存');
    };
    reader.onerror = () => toast.error('读取失败', '无法读取该文件');
    reader.readAsText(file);
  };

  const insertAtCursor = (snippet: string) => {
    const ta = textareaRef.current;
    if (!ta) { setDraftContent((c) => c + snippet); return; }
    const start = ta.selectionStart ?? draftContent.length;
    const end = ta.selectionEnd ?? draftContent.length;
    const next = draftContent.slice(0, start) + snippet + draftContent.slice(end);
    setDraftContent(next);
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + snippet.length; });
  };

  const handleInsertImage = async (file: File) => {
    setUploadingImg(true);
    const res = await uploadPmWeeklyReportImage(projectId, file);
    setUploadingImg(false);
    if (res.success) insertAtCursor(`\n![${file.name}](${res.data.url})\n`);
    else toast.error('图片上传失败', res.error?.message || '');
  };

  const saveDraft = async () => {
    if (!draftTitle.trim()) { toast.error('请填写周报标题', ''); return; }
    setSaving(true);
    const payload = { title: draftTitle.trim(), content: draftContent, weekStart: draftWeekStart || undefined, relatedGoalIds: draftGoalIds, relatedTaskIds: draftTaskIds };
    if (editing === 'new') {
      const res = await createPmWeeklyReport(projectId, payload);
      if (res.success) { toast.success('已创建', ''); setEditing(null); setSelectedId(res.data.id); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    } else if (editing) {
      const res = await updatePmWeeklyReport(editing, payload);
      if (res.success) { toast.success('已保存', ''); setEditing(null); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    }
    setSaving(false);
  };

  const handleDelete = async (r: PmWeeklyReport) => {
    if (!window.confirm(`确定删除周报「${r.title}」？`)) return;
    const res = await deletePmWeeklyReport(r.id);
    if (res.success) {
      setReports((prev) => prev.filter((x) => x.id !== r.id));
      if (selectedId === r.id) setSelectedId(null);
    } else toast.error('删除失败', res.error?.message || '');
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载周报…" /></div>;

  const inEditor = editing !== null;

  return (
    <div className="flex-1 min-h-0 flex gap-3">
      {/* 左列：周报列表 */}
      <div className="w-[256px] shrink-0 flex flex-col min-h-0 rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="flex items-center gap-1.5 px-3 py-2.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <FileText size={14} style={{ color: '#3B82F6' }} />
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目周报</span>
          <span className="text-[11px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{reports.length}</span>
        </div>
        <div className="flex flex-col gap-1.5 px-2.5 py-2 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <input ref={importRef} type="file" accept=".md,.markdown,.txt,text/markdown" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImport(f); e.currentTarget.value = ''; }} />
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="flex-1" onClick={() => importRef.current?.click()}><Upload size={13} />导入 md</Button>
            <Button variant="primary" size="sm" className="flex-1" onClick={() => startCreate()}><Plus size={13} />新建</Button>
          </div>
          <Button variant="secondary" size="sm" className="w-full" onClick={() => setShowImport(true)}><Download size={13} />导入个人周报</Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1" style={{ overscrollBehavior: 'contain' }}>
          {reports.length === 0 ? (
            <div className="text-[11px] text-center py-8" style={{ color: 'var(--text-muted)' }}>还没有周报，点「导入 md」或「新建」</div>
          ) : reports.map((r) => {
            const active = selectedId === r.id && !inEditor;
            return (
              <button key={r.id} onClick={() => { setEditing(null); setSelectedId(r.id); }}
                className="group text-left rounded-lg px-2.5 py-2 border" title={r.title}
                style={{ borderColor: active ? '#3B82F6' : 'transparent', background: active ? 'rgba(59,130,246,0.12)' : 'var(--bg-elevated)' }}>
                <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{r.title}</div>
                <div className="text-[10.5px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                  {r.weekStart ? `${fmtDate(r.weekStart)} · ` : ''}{r.authorName || '—'}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右侧：阅读 / 编辑 */}
      <div className="flex-1 min-h-0 flex flex-col rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        {inEditor ? (
          <>
            <div className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b flex-wrap" style={{ borderColor: 'var(--border-subtle)' }}>
              <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="周报标题（如：第 22 周 / 2026-05-26 ~ 05-30）"
                className="flex-1 min-w-[180px] text-[13px] rounded-md px-2.5 py-1.5 outline-none border"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
              <input type="date" value={draftWeekStart} onChange={(e) => setDraftWeekStart(e.target.value)} title="周起始日"
                className="text-[12px] rounded-md px-2 py-1.5 outline-none border"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <input ref={imgRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleInsertImage(f); e.currentTarget.value = ''; }} />
              <Button variant="ghost" size="sm" onClick={() => imgRef.current?.click()} disabled={uploadingImg}>
                {uploadingImg ? <MapSpinner size={12} /> : <ImageIcon size={12} />}插入图片
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPreviewMode((v) => !v)}>
                {previewMode ? <Columns size={12} /> : <Eye size={12} />}{previewMode ? '编辑' : '预览'}
              </Button>
              <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>支持 Markdown + 图片，排版自动美化</span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={cancelEdit}><X size={13} />取消</Button>
                <Button variant="primary" size="sm" onClick={saveDraft} disabled={saving}>{saving ? <MapSpinner size={13} /> : <Check size={13} />}保存</Button>
              </div>
            </div>
            {/* 关联目标 / 任务 */}
            <div className="shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <button onClick={() => setRelateOpen((o) => !o)} className="flex items-center gap-1.5 px-3 py-1.5 w-full text-left">
                <Link2 size={12} style={{ color: '#A855F7' }} />
                <span className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>关联目标 / 任务</span>
                {(draftGoalIds.length + draftTaskIds.length) > 0 && (
                  <span className="text-[10px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{draftGoalIds.length + draftTaskIds.length}</span>
                )}
                <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{relateOpen ? '收起' : '展开'}</span>
              </button>
              {relateOpen && (
                <div className="px-3 pb-2.5 grid gap-3" style={{ gridTemplateColumns: '1fr 1fr', maxHeight: 200, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                  <div>
                    <div className="text-[10.5px] mb-1 flex items-center gap-1" style={{ color: '#3B82F6' }}><Target size={11} />目标</div>
                    <div className="flex flex-col gap-0.5">
                      {goals.length === 0 ? <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>本项目暂无目标</span>
                        : goals.map((g) => (
                          <label key={g.id} className="flex items-center gap-2 text-[12px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                            <input type="checkbox" checked={draftGoalIds.includes(g.id)} onChange={() => setDraftGoalIds((l) => toggleId(l, g.id))} />
                            <span className="truncate" title={g.title}>{g.title}</span>
                          </label>
                        ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10.5px] mb-1 flex items-center gap-1" style={{ color: '#F59E0B' }}><ListTodo size={11} />任务</div>
                    <div className="flex flex-col gap-0.5">
                      {tasks.length === 0 ? <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>本项目暂无任务</span>
                        : tasks.map((t) => (
                          <label key={t.id} className="flex items-center gap-2 text-[12px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                            <input type="checkbox" checked={draftTaskIds.includes(t.id)} onChange={() => setDraftTaskIds((l) => toggleId(l, t.id))} />
                            <span className="truncate" title={t.title}>{t.title}</span>
                          </label>
                        ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 flex">
              {!previewMode && (
                <textarea ref={textareaRef} value={draftContent} onChange={(e) => setDraftContent(e.target.value)} placeholder="在此粘贴或编写 Markdown 周报内容…"
                  className="flex-1 min-h-0 resize-none outline-none px-4 py-3 text-[13px] font-mono leading-relaxed border-r"
                  style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
              )}
              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4" style={{ overscrollBehavior: 'contain' }}>
                {draftContent.trim()
                  ? <MarkdownContent content={draftContent} variant="reading" />
                  : <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>预览区 — 左侧输入 Markdown 后这里实时渲染</div>}
              </div>
            </div>
          </>
        ) : selected ? (
          <>
            <div className="flex items-center gap-2 px-4 py-2.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{selected.title}</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {selected.weekStart ? `${fmtDate(selected.weekStart)} · ` : ''}{selected.authorName || '—'} · 更新于 {fmtDate(selected.updatedAt)}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => startEdit(selected)}><Pencil size={13} />编辑</Button>
              <Button variant="ghost" size="sm" onClick={() => handleDelete(selected)}><Trash2 size={13} />删除</Button>
            </div>
            {(selected.sourceType === 'report-agent' || (selected.relatedGoalIds?.length ?? 0) + (selected.relatedTaskIds?.length ?? 0) > 0) && (
              <div className="shrink-0 px-4 py-2 border-b flex items-center gap-1.5 flex-wrap" style={{ borderColor: 'var(--border-subtle)' }}>
                {selected.sourceType === 'report-agent' && (
                  <span className="text-[10.5px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'rgba(59,130,246,0.12)', color: '#3B82F6' }}><Download size={10} />来自个人周报</span>
                )}
                {selected.relatedGoalIds?.map((id) => (
                  <span key={id} className="text-[10.5px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'rgba(59,130,246,0.10)', color: '#3B82F6' }}><Target size={10} />{goalTitle(id)}</span>
                ))}
                {selected.relatedTaskIds?.map((id) => (
                  <span key={id} className="text-[10.5px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'rgba(245,158,11,0.10)', color: '#F59E0B' }}><ListTodo size={10} />{taskTitle(id)}</span>
                ))}
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5" style={{ overscrollBehavior: 'contain' }}>
              {selected.content.trim()
                ? <MarkdownContent content={selected.content} variant="reading" />
                : <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>本周报暂无内容，点「编辑」补充</div>}
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-muted)' }}>
            <FileText size={32} style={{ opacity: 0.4 }} />
            <div className="text-[12px]">从左侧选择一篇周报查看，或「导入 md」/「新建」</div>
          </div>
        )}
      </div>

      {showImport && (
        <ImportPersonalReportModal
          projectId={projectId}
          onClose={() => setShowImport(false)}
          onImported={(rep) => { setShowImport(false); setEditing(null); setSelectedId(rep.id); load(); }}
        />
      )}
    </div>
  );
}
