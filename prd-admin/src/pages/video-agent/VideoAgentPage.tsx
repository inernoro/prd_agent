/**
 * 视频生成 Agent 主页（列表 + 详情两层结构，对齐文学创作）
 *
 * 顶层路由：
 * - selectedRunId === null → 作品列表（纵向，每行一作品）
 * - selectedRunId !== null → 详情页：
 *     - storyboard：左预览 / 右分镜（VideoStoryboardEditor）
 *     - direct：单一播放器（VideoGenDirectPanel）
 *
 * 历史不再用抽屉——列表本身就是历史。
 *
 * 创作模式：
 * - direct（直出）：一段 prompt → OpenRouter
 * - storyboard（高级）：上传文章 → 拆分镜 → 逐镜渲染
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Plus, Wand2, Sparkles, X, Upload, FileText, ChevronRight, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { listVideoGenRunsReal, createVideoGenRunReal } from '@/services/real/videoAgent';
import type { VideoGenRunListItem } from '@/services/contracts/videoAgent';
import { VideoGenDirectPanel } from './VideoGenDirectPanel';
import { VideoStoryboardEditor } from './VideoStoryboardEditor';
import { resolveVideoTitle } from './titleUtils';
import { toast } from '@/lib/toast';

const SELECTED_RUN_KEY = 'video-agent.selectedRunId';

type CreateModalMode = null | 'direct' | 'storyboard';

export const VideoAgentPage: React.FC = () => {
  const [runs, setRuns] = useState<VideoGenRunListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
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

  // 选中后查 mode（决定渲染哪种详情面板）。失败兜底：清空 selectedRunId 退回列表
  useEffect(() => {
    if (!selectedRunId) { setSelectedMode(null); return; }
    setSelectedMode(null);
    let cancelled = false;
    (async () => {
      try {
        const { getVideoGenRunReal } = await import('@/services/real/videoAgent');
        const res = await getVideoGenRunReal(selectedRunId);
        if (cancelled) return;
        if (res.success && res.data?.mode) {
          setSelectedMode(res.data.mode);
        } else {
          toast.warning('该任务已不可用，已返回列表');
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
    } catch { /* ignore */ } finally { setLoadingList(false); }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // 列表自动轮询（活跃任务可见进度推进）；详情页里 Editor/Panel 自己各有轮询
  useEffect(() => {
    if (selectedRunId) return; // 详情页时不在外层重复轮询
    const hasActive = runs.some(r => ['Queued', 'Scripting', 'Editing', 'Rendering'].includes(r.status));
    if (!hasActive) return;
    const t = setInterval(() => { void loadRuns(); }, 5000);
    return () => clearInterval(t);
  }, [runs, selectedRunId, loadRuns]);

  const handleBackToList = useCallback(() => {
    setSelectedRunId(null);
  }, []);

  const handleRunCreated = useCallback((runId: string) => {
    setSelectedRunId(runId);
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
          {selectedRunId && (
            <Button size="sm" variant="secondary" onClick={handleBackToList}>
              ← 返回列表
            </Button>
          )}
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
        </div>
      </GlassCard>

      {/* 主区：列表 OR 详情 */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {!selectedRunId ? (
          <RunListView
            runs={runs}
            loading={loadingList}
            onSelect={setSelectedRunId}
            onCreate={() => setCreateMenuOpen(true)}
          />
        ) : selectedMode === null ? (
          <GlassCard className="h-full flex flex-col items-center justify-center gap-3 p-8">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>加载任务中…</span>
            <Button size="sm" variant="secondary" onClick={handleBackToList}>返回列表</Button>
          </GlassCard>
        ) : selectedMode === 'storyboard' ? (
          <VideoStoryboardEditor runId={selectedRunId} onBack={handleBackToList} />
        ) : (
          <VideoGenDirectPanel
            externalRunId={selectedRunId}
            onReset={handleBackToList}
            onRunCreated={handleRunCreated}
          />
        )}
      </div>

      {/* 创建弹窗 */}
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

// ─── 作品列表（纵向，对齐文学创作） ───
const RunListView: React.FC<{
  runs: VideoGenRunListItem[];
  loading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}> = ({ runs, loading, onSelect, onCreate }) => {
  if (loading) {
    return (
      <GlassCard className="h-full flex items-center justify-center p-12">
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
      </GlassCard>
    );
  }

  if (runs.length === 0) {
    return (
      <GlassCard className="h-full flex flex-col items-center justify-center p-12 text-center">
        <Wand2 size={40} style={{ color: '#f472b6' }} className="mb-4" />
        <div className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          还没有视频作品
        </div>
        <div className="text-xs mb-6" style={{ color: 'var(--text-muted)' }}>
          点右上「创作」开始你的第一个视频
        </div>
        <Button onClick={onCreate} variant="primary">
          <Plus size={14} />
          开始创作
        </Button>
      </GlassCard>
    );
  }

  return (
    <div className="flex flex-col gap-2 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
      <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
        共 {runs.length} 个任务（最新在前）
      </div>
      {runs.map(run => (
        <RunListRow key={run.id} run={run} onClick={() => onSelect(run.id)} />
      ))}
    </div>
  );
};

const RunListRow: React.FC<{ run: VideoGenRunListItem; onClick: () => void }> = ({ run, onClick }) => {
  const title = resolveVideoTitle(run.articleTitle, run.createdAt, 40);
  const status = run.status;
  return (
    <button
      onClick={onClick}
      className="rounded-[14px] flex items-stretch gap-3 p-3 text-left hover:ring-2 hover:ring-pink-400/40 transition-all"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {/* 缩略图 */}
      <div
        className="flex-shrink-0 rounded-[10px] overflow-hidden flex items-center justify-center"
        style={{
          width: 144,
          aspectRatio: '16/9',
          background: 'rgba(0,0,0,0.18)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {run.videoAssetUrl ? (
          <video
            src={run.videoAssetUrl}
            muted
            playsInline
            preload="metadata"
            className="w-full h-full"
            style={{ objectFit: 'cover' }}
          />
        ) : (
          <RunThumbPlaceholder status={status} />
        )}
      </div>

      {/* 元信息 */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5 justify-between py-0.5">
        <div className="flex items-start gap-2 min-w-0">
          <span className="text-sm font-semibold truncate flex-1" style={{ color: 'var(--text-primary)' }}>
            {title}
          </span>
          <RunStatusBadge status={status} />
        </div>
        <div className="text-[11px] flex items-center gap-3 flex-wrap" style={{ color: 'var(--text-muted)' }}>
          <span>{run.totalDurationSeconds > 0 ? `约 ${run.totalDurationSeconds.toFixed(0)} 秒` : '时长未知'}</span>
          <span>·</span>
          <span>{new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          {run.errorMessage && (
            <>
              <span>·</span>
              <span style={{ color: '#f87171' }} className="truncate max-w-[260px]">{run.errorMessage}</span>
            </>
          )}
        </div>
      </div>

      <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} className="self-center flex-shrink-0" />
    </button>
  );
};

const RunThumbPlaceholder: React.FC<{ status: string }> = ({ status }) => {
  if (status === 'Failed') {
    return <AlertCircle size={20} style={{ color: '#f87171' }} />;
  }
  if (['Queued', 'Scripting', 'Editing', 'Rendering'].includes(status)) {
    return <Loader2 size={18} className="animate-spin" style={{ color: '#a78bfa' }} />;
  }
  if (status === 'Completed') {
    return <CheckCircle2 size={20} style={{ color: '#4ade80' }} />;
  }
  return <Wand2 size={18} style={{ color: 'var(--text-muted)' }} />;
};

const STATUS_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  Queued:    { label: '排队中',  color: 'rgba(148,163,184,0.95)', bg: 'rgba(148,163,184,0.14)' },
  Scripting: { label: '拆分镜中', color: '#a78bfa',                bg: 'rgba(167,139,250,0.14)' },
  Editing:   { label: '待编辑',  color: '#fbbf24',                bg: 'rgba(251,191,36,0.14)'  },
  Rendering: { label: '渲染中',  color: '#f472b6',                bg: 'rgba(236,72,153,0.14)'  },
  Completed: { label: '已完成',  color: '#4ade80',                bg: 'rgba(34,197,94,0.14)'   },
  Failed:    { label: '失败',    color: '#f87171',                bg: 'rgba(239,68,68,0.14)'   },
  Cancelled: { label: '已取消',  color: 'rgba(148,163,184,0.85)', bg: 'rgba(148,163,184,0.14)' },
};

const RunStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const m = STATUS_LABEL[status] ?? STATUS_LABEL.Queued;
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0"
      style={{ background: m.bg, color: m.color }}
    >
      {m.label}
    </span>
  );
};

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
