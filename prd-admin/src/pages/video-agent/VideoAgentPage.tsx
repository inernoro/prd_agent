/**
 * 视频生成 Agent 主页
 *
 * 两种创作模式：
 * - direct（一镜直出）：输入一段 prompt → OpenRouter 直接生成 5-15s 短视频
 * - storyboard（高级创作）：上传文章/PRD → LLM 拆分镜 → 用户编辑每镜 → 逐镜调 OpenRouter
 *
 * 顶部「创作」按钮弹出选项；选定后弹相应创建表单。
 * selectedRunId 持久化到 sessionStorage，进入页面自动恢复。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { History as HistoryIcon, Plus, Wand2, Sparkles, X, Upload, FileText } from 'lucide-react';
import { listVideoGenRunsReal, createVideoGenRunReal } from '@/services/real/videoAgent';
import type { VideoGenRunListItem } from '@/services/contracts/videoAgent';
import { VideoGenDirectPanel } from './VideoGenDirectPanel';
import { VideoStoryboardEditor } from './VideoStoryboardEditor';
import { HistoryDrawer } from './HistoryDrawer';
import { toast } from '@/lib/toast';

const SELECTED_RUN_KEY = 'video-agent.selectedRunId';
const ACTIVE_STATUSES = new Set(['Queued', 'Scripting', 'Editing', 'Rendering']);

type CreateModalMode = null | 'direct' | 'storyboard';

export const VideoAgentPage: React.FC = () => {
  const [runs, setRuns] = useState<VideoGenRunListItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(SELECTED_RUN_KEY); } catch { return null; }
  });
  const [selectedMode, setSelectedMode] = useState<'direct' | 'storyboard' | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createModal, setCreateModal] = useState<CreateModalMode>(null);
  const createBtnRef = useRef<HTMLButtonElement>(null);

  // 持久化 selectedRunId
  useEffect(() => {
    try {
      if (selectedRunId) sessionStorage.setItem(SELECTED_RUN_KEY, selectedRunId);
      else sessionStorage.removeItem(SELECTED_RUN_KEY);
    } catch { /* ignore */ }
  }, [selectedRunId]);

  // 选中 run 后查它的 mode（决定渲染哪个面板）
  // 关键：切到新 runId 时立即把 selectedMode 设回 null，避免用 stale mode 渲染
  // 错的 panel 闪一下。null 期间主区显示 loading。
  // 失败兜底：404 / 网络错误 / mode 字段缺失时清空 selectedRunId 退回陈物架，
  // 避免无限「加载任务中…」死锁。
  useEffect(() => {
    if (!selectedRunId) { setSelectedMode(null); return; }
    setSelectedMode(null); // 立即 reset，等下面 fetch 回来才有值
    let cancelled = false;
    (async () => {
      try {
        const { getVideoGenRunReal } = await import('@/services/real/videoAgent');
        const res = await getVideoGenRunReal(selectedRunId);
        if (cancelled) return;
        if (res.success && res.data?.mode) {
          setSelectedMode(res.data.mode);
        } else {
          // 任务不存在 / 已删除 / 字段缺失 — 退回陈物架并提示
          toast.warning('该任务已不可用，已返回作品架');
          setSelectedRunId(null);
        }
      } catch (err) {
        if (cancelled) return;
        toast.error('加载任务失败', err instanceof Error ? err.message : '网络错误');
        setSelectedRunId(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedRunId]);

  const loadRuns = useCallback(async () => {
    try {
      const res = await listVideoGenRunsReal({ limit: 50 });
      if (res.success) setRuns(res.data.items);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const autoSelectAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoSelectAttemptedRef.current) return;
    if (runs.length === 0) return;
    if (selectedRunId && runs.some(r => r.id === selectedRunId)) {
      autoSelectAttemptedRef.current = true;
      return;
    }
    if (selectedRunId) setSelectedRunId(null);
    const active = runs.find(r => ACTIVE_STATUSES.has(r.status));
    const target = active ?? runs[0];
    if (target) setSelectedRunId(target.id);
    autoSelectAttemptedRef.current = true;
  }, [runs, selectedRunId]);

  const handleNewTask = useCallback(() => {
    setSelectedRunId(null);
    autoSelectAttemptedRef.current = true;
  }, []);

  const handleSelectFromHistory = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setHistoryOpen(false);
  }, []);

  const handleRunCreated = useCallback((runId: string) => {
    setSelectedRunId(runId);
    autoSelectAttemptedRef.current = true;
    void loadRuns();
  }, [loadRuns]);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0 p-4">
      {/* 顶部工具条 */}
      <GlassCard variant="subtle" className="px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            视频创作智能体
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            · OpenRouter · Veo / Kling / Wan / Sora
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button ref={createBtnRef} size="sm" variant="primary" onClick={() => setCreateMenuOpen(v => !v)}>
            <Plus size={14} />
            创作
          </Button>
          {createMenuOpen && (
            <CreateMenu
              triggerRef={createBtnRef}
              onPickDirect={() => { setCreateMenuOpen(false); setCreateModal('direct'); }}
              onPickStoryboard={() => { setCreateMenuOpen(false); setCreateModal('storyboard'); }}
              onClose={() => setCreateMenuOpen(false)}
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { setHistoryOpen(true); loadRuns(); }}
            title="查看历史任务"
          >
            <HistoryIcon size={14} />
            历史 ({runs.length})
          </Button>
        </div>
      </GlassCard>

      {/* 主区：根据 selectedRun 的 mode 渲染对应面板
       *  selectedMode === null && selectedRunId !== null 期间：mode fetch 中，显示 loading
       *  selectedMode === 'storyboard'                  : 高级创作页
       *  selectedMode === 'direct'                      : 直出面板
       *  selectedRunId === null                         : 陈物架（未选中态）
       */}
      <div className="flex-1 min-h-0 overflow-auto">
        {!selectedRunId ? (
          <ShowcaseGrid runs={runs} onSelect={setSelectedRunId} onCreate={() => setCreateMenuOpen(true)} />
        ) : selectedMode === null ? (
          <GlassCard className="h-full flex flex-col items-center justify-center gap-3 p-8">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>加载任务中…</span>
            <Button size="sm" variant="secondary" onClick={handleNewTask}>返回作品架</Button>
          </GlassCard>
        ) : selectedMode === 'storyboard' ? (
          <VideoStoryboardEditor runId={selectedRunId} onBack={handleNewTask} />
        ) : (
          <VideoGenDirectPanel
            externalRunId={selectedRunId}
            onReset={handleNewTask}
            onRunCreated={handleRunCreated}
          />
        )}
      </div>

      {/* 历史抽屉 */}
      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        runs={runs}
        selectedRunId={selectedRunId}
        onSelect={handleSelectFromHistory}
      />

      {/* 创建弹窗：direct（在 Hero 里直接做）/ storyboard（弹 modal） */}
      {createModal === 'direct' && (
        <DirectCreateModal
          onClose={() => setCreateModal(null)}
          onCreated={(runId) => { setCreateModal(null); handleRunCreated(runId); }}
        />
      )}
      {createModal === 'storyboard' && (
        <StoryboardCreateModal
          onClose={() => setCreateModal(null)}
          onCreated={(runId) => { setCreateModal(null); handleRunCreated(runId); }}
        />
      )}
    </div>
  );
};

// ─── 创作下拉菜单（portal 到 body，避免被父容器层级遮挡） ───
const CreateMenu: React.FC<{
  triggerRef: React.RefObject<HTMLButtonElement>;
  onPickDirect: () => void;
  onPickStoryboard: () => void;
  onClose: () => void;
}> = ({ triggerRef, onPickDirect, onPickStoryboard, onClose }) => {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [triggerRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!pos) return null;

  const node = (
    <>
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={onClose} />
      <div
        className="fixed rounded-lg shadow-lg overflow-hidden"
        style={{
          top: pos.top,
          right: pos.right,
          zIndex: 9999,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          minWidth: 240,
        }}
      >
        <button
          onClick={onPickStoryboard}
          className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left hover:bg-white/5 transition-colors"
        >
          <Wand2 size={16} style={{ color: '#f472b6' }} />
          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>🎬 创作分镜（高级）</div>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>上传文案 → AI 拆分镜 → 编辑每镜</div>
          </div>
        </button>
        <button
          onClick={onPickDirect}
          className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left hover:bg-white/5 transition-colors"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <Sparkles size={16} style={{ color: '#a78bfa' }} />
          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>✨ 大模型直出（初级）</div>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>一段 prompt → 5-15s 短视频</div>
          </div>
        </button>
      </div>
    </>
  );
  return createPortal(node, document.body);
};

// ─── 陈物架（已完成视频网格） ───
const ShowcaseGrid: React.FC<{ runs: VideoGenRunListItem[]; onSelect: (id: string) => void; onCreate: () => void }> = ({
  runs, onSelect, onCreate,
}) => {
  const completed = runs.filter(r => r.videoAssetUrl);

  if (completed.length === 0) {
    return (
      <GlassCard className="h-full flex flex-col items-center justify-center p-12 text-center">
        <Wand2 size={40} style={{ color: '#f472b6' }} className="mb-4" />
        <div className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          还没有视频作品
        </div>
        <div className="text-xs mb-6" style={{ color: 'var(--text-muted)' }}>
          点上方「创作」开始你的第一个视频
        </div>
        <Button onClick={onCreate} variant="primary">
          <Plus size={14} />
          开始创作
        </Button>
      </GlassCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          作品架（{completed.length} 个）
        </div>
        <div
          className="flex gap-3 overflow-x-auto pb-2"
          style={{ scrollbarWidth: 'thin' }}
        >
          {completed.map(run => (
            <ShowcaseCard key={run.id} run={run} onClick={() => onSelect(run.id)} />
          ))}
        </div>
      </div>
    </div>
  );
};

const ShowcaseCard: React.FC<{ run: VideoGenRunListItem; onClick: () => void }> = ({ run, onClick }) => (
  <button
    onClick={onClick}
    className="flex-shrink-0 rounded-[14px] overflow-hidden text-left hover:ring-2 hover:ring-pink-400/40 transition-all"
    style={{
      width: 220,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
    }}
  >
    {run.videoAssetUrl ? (
      <video
        src={run.videoAssetUrl}
        muted
        playsInline
        preload="metadata"
        className="w-full block"
        style={{ aspectRatio: '16/9', background: 'rgba(0,0,0,0.2)', objectFit: 'cover' }}
      />
    ) : (
      <div style={{ aspectRatio: '16/9', background: 'rgba(0,0,0,0.2)' }} />
    )}
    <div className="p-2.5">
      <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
        {run.articleTitle || '未命名'}
      </div>
      <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
        {run.totalDurationSeconds.toFixed(0)}s · {new Date(run.createdAt).toLocaleDateString('zh-CN')}
      </div>
    </div>
  </button>
);

// ─── 直出创建 modal（极简：一个 prompt 输入框） ───
const DirectCreateModal: React.FC<{ onClose: () => void; onCreated: (runId: string) => void }> = ({
  onClose, onCreated,
}) => {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      toast.warning('请输入视频描述');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createVideoGenRunReal({ mode: 'direct', directPrompt: trimmed });
      if (res.success && res.data) {
        onCreated(res.data.runId);
      } else {
        toast.error('创建失败', (res as { error?: { message?: string } }).error?.message);
      }
    } catch (err) {
      toast.error('请求异常', err instanceof Error ? err.message : '网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-[16px] flex flex-col"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          width: 'min(90vw, 540px)',
          maxHeight: '85vh',
        }}
      >
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <Sparkles size={16} style={{ color: '#a78bfa' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>大模型直出</span>
          </div>
          <button onClick={onClose}><X size={16} style={{ color: 'var(--text-muted)' }} /></button>
        </div>
        <div className="p-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto' }}>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="比如：一只金毛在落日海滩奔跑追逐海浪，电影级光影，慢动作镜头"
            className="w-full text-sm rounded-md px-3 py-2 outline-none resize-none"
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
              minHeight: 120,
            }}
          />
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            提示：默认用 Wan 2.6（约 $0.04/秒），生成时长约 1-3 分钟。详细参数可在生成后调整。
          </div>
        </div>
        <div className="px-4 py-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>取消</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting || !prompt.trim()}>
            {submitting ? '提交中…' : '立即生成'}
          </Button>
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
};

// ─── 高级创作 modal：拖/选文件上传 + 风格胶囊（标题由 AI 自动取名） ───
const STYLE_PRESETS: { key: string; label: string; emoji: string }[] = [
  { key: 'cinematic', label: '电影级光影', emoji: '🎞️' },
  { key: '3d-cartoon', label: '3D 卡通', emoji: '🧸' },
  { key: 'documentary', label: '写实纪录片', emoji: '📽️' },
  { key: 'pixel', label: '像素风', emoji: '👾' },
  { key: 'ink', label: '水墨国风', emoji: '🖌️' },
  { key: 'cyberpunk', label: '赛博朋克', emoji: '🌃' },
  { key: 'minimal', label: '极简插画', emoji: '✏️' },
  { key: 'retro-film', label: '复古胶片', emoji: '📷' },
];

const ACCEPT_TEXT = '.md,.markdown,.txt,text/plain,text/markdown';
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const StoryboardCreateModal: React.FC<{ onClose: () => void; onCreated: (runId: string) => void }> = ({
  onClose, onCreated,
}) => {
  const [article, setArticle] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [styleKey, setStyleKey] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const readFile = useCallback(async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.warning('文件过大', '请上传 2 MB 以内的文本/Markdown 文档');
      return;
    }
    const lower = file.name.toLowerCase();
    const ok = lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')
      || file.type.startsWith('text/');
    if (!ok) {
      toast.warning('暂只支持 .md / .txt 文档', 'PDF/Word 请先复制文本，点下方"或粘贴文本"');
      return;
    }
    try {
      const text = await file.text();
      const trimmed = text.trim();
      if (!trimmed) {
        toast.warning('文档内容为空');
        return;
      }
      setArticle(trimmed);
      setFileName(file.name);
      setPasteOpen(false);
    } catch (err) {
      toast.error('读取失败', err instanceof Error ? err.message : '');
    }
  }, []);

  const handleSubmit = async () => {
    const trimmedArticle = article.trim();
    if (!trimmedArticle) {
      toast.warning('请上传或粘贴文章/PRD 内容');
      return;
    }
    const styleLabel = STYLE_PRESETS.find(s => s.key === styleKey)?.label;
    setSubmitting(true);
    try {
      const res = await createVideoGenRunReal({
        mode: 'storyboard',
        articleMarkdown: trimmedArticle,
        styleDescription: styleLabel,
        // 标题留空，让后端 AI 自动从内容中取名
      });
      if (res.success && res.data) {
        onCreated(res.data.runId);
      } else {
        toast.error('创建失败', (res as { error?: { message?: string } }).error?.message);
      }
    } catch (err) {
      toast.error('请求异常', err instanceof Error ? err.message : '网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  };

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-[16px] flex flex-col"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          width: 'min(92vw, 720px)',
          maxHeight: '85vh',
        }}
      >
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <Wand2 size={16} style={{ color: '#f472b6' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>高级创作（拆分镜）</span>
          </div>
          <button onClick={onClose}><X size={16} style={{ color: 'var(--text-muted)' }} /></button>
        </div>

        <div className="p-4 flex flex-col gap-4" style={{ minHeight: 0, overflowY: 'auto' }}>
          {/* 文章上传区 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                文章 / PRD 内容（必填）
              </label>
              {article && (
                <button
                  onClick={() => { setArticle(''); setFileName(null); setPasteOpen(false); }}
                  className="text-[11px] hover:underline"
                  style={{ color: 'var(--text-muted)' }}
                >
                  重新上传
                </button>
              )}
            </div>

            {!article ? (
              <>
                <div
                  onDragEnter={onDragEnter}
                  onDragLeave={onDragLeave}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onClick={() => inputRef.current?.click()}
                  className="rounded-lg border border-dashed cursor-pointer transition-all flex flex-col items-center justify-center gap-2 px-4 py-8"
                  style={{
                    background: dragging ? 'rgba(244,114,182,0.08)' : 'var(--bg-base)',
                    borderColor: dragging ? '#f472b6' : 'var(--border-default)',
                  }}
                >
                  <Upload size={28} style={{ color: dragging ? '#f472b6' : 'var(--text-muted)' }} />
                  <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    拖拽文件到此处，或点击选择
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    支持 .md / .markdown / .txt（≤ 2 MB）
                  </div>
                  <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPT_TEXT}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void readFile(f);
                      e.target.value = '';
                    }}
                  />
                </div>
                <div className="mt-2 text-center">
                  <button
                    onClick={() => setPasteOpen(v => !v)}
                    className="text-[11px] hover:underline"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {pasteOpen ? '收起粘贴框' : '或直接粘贴文本'}
                  </button>
                </div>
                {pasteOpen && (
                  <textarea
                    autoFocus
                    value={article}
                    onChange={e => { setArticle(e.target.value); setFileName(null); }}
                    placeholder="把 PDF / Word 里的正文复制粘贴到这里"
                    className="w-full mt-2 text-sm rounded-md px-3 py-2 outline-none resize-none"
                    style={{
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                      minHeight: 140,
                    }}
                  />
                )}
              </>
            ) : (
              <div
                className="rounded-lg px-3 py-2.5 flex items-center gap-2.5"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-default)',
                }}
              >
                <FileText size={18} style={{ color: '#f472b6' }} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {fileName ?? '已粘贴文本'}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {article.length.toLocaleString('zh-CN')} 字 · AI 将自动取名 + 拆 3-8 个分镜
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 风格胶囊 */}
          <div>
            <label className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              视觉风格（可选，统一所有分镜）
            </label>
            <div className="flex flex-wrap gap-1.5 mt-2">
              <button
                onClick={() => setStyleKey(null)}
                className="px-2.5 py-1 rounded-full text-[11px] transition-all"
                style={{
                  background: styleKey === null ? 'rgba(244,114,182,0.18)' : 'var(--bg-base)',
                  border: `1px solid ${styleKey === null ? '#f472b6' : 'var(--border-default)'}`,
                  color: styleKey === null ? '#f472b6' : 'var(--text-secondary)',
                }}
              >
                AI 自动选
              </button>
              {STYLE_PRESETS.map(s => (
                <button
                  key={s.key}
                  onClick={() => setStyleKey(s.key)}
                  className="px-2.5 py-1 rounded-full text-[11px] transition-all"
                  style={{
                    background: styleKey === s.key ? 'rgba(244,114,182,0.18)' : 'var(--bg-base)',
                    border: `1px solid ${styleKey === s.key ? '#f472b6' : 'var(--border-default)'}`,
                    color: styleKey === s.key ? '#f472b6' : 'var(--text-secondary)',
                  }}
                >
                  {s.emoji} {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            提示：AI 拆分镜约 30 秒；之后可逐镜编辑、重写 prompt、调模型/时长，按需点单镜「渲染」生成视频。
          </div>
        </div>

        <div className="px-4 py-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>取消</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting || !article.trim()}>
            {submitting ? '提交中…' : '开始拆分镜'}
          </Button>
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
};

export default VideoAgentPage;
