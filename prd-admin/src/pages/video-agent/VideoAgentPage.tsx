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
import { History as HistoryIcon, Plus, Wand2, Sparkles, X } from 'lucide-react';
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

  // 持久化 selectedRunId
  useEffect(() => {
    try {
      if (selectedRunId) sessionStorage.setItem(SELECTED_RUN_KEY, selectedRunId);
      else sessionStorage.removeItem(SELECTED_RUN_KEY);
    } catch { /* ignore */ }
  }, [selectedRunId]);

  // 选中 run 后查它的 mode（决定渲染哪个面板）
  // 关键：切到新 runId 时立即把 selectedMode 设回 null，避免用 stale mode 渲染
  // 错的 panel 闪一下（Bugbot review #1）。null 期间主区显示 loading。
  useEffect(() => {
    if (!selectedRunId) { setSelectedMode(null); return; }
    setSelectedMode(null); // 立即 reset，等下面 fetch 回来才有值
    let cancelled = false;
    (async () => {
      try {
        const { getVideoGenRunReal } = await import('@/services/real/videoAgent');
        const res = await getVideoGenRunReal(selectedRunId);
        if (!cancelled && res.success && res.data) setSelectedMode(res.data.mode);
      } catch { /* ignore */ }
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
        <div className="flex items-center gap-2 relative">
          <Button size="sm" variant="primary" onClick={() => setCreateMenuOpen(v => !v)}>
            <Plus size={14} />
            创作
          </Button>
          {createMenuOpen && (
            <CreateMenu
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
          <GlassCard className="h-full flex items-center justify-center p-8">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>加载任务中…</span>
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

// ─── 创作下拉菜单 ───
const CreateMenu: React.FC<{ onPickDirect: () => void; onPickStoryboard: () => void; onClose: () => void }> = ({
  onPickDirect, onPickStoryboard, onClose,
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute top-full right-0 mt-1 z-50 rounded-lg shadow-lg overflow-hidden"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          minWidth: 220,
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

// ─── 高级创作 modal：上传文章 + 风格 ───
const StoryboardCreateModal: React.FC<{ onClose: () => void; onCreated: (runId: string) => void }> = ({
  onClose, onCreated,
}) => {
  const [article, setArticle] = useState('');
  const [style, setStyle] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmedArticle = article.trim();
    if (!trimmedArticle) {
      toast.warning('请输入或粘贴文章/PRD 内容');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createVideoGenRunReal({
        mode: 'storyboard',
        articleMarkdown: trimmedArticle,
        styleDescription: style.trim() || undefined,
        articleTitle: title.trim() || undefined,
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
        <div className="p-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto' }}>
          <div>
            <label className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>视频标题（可选）</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="留空则用文章首句"
              className="w-full mt-1 text-xs rounded-md px-2 py-1.5 outline-none"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>
          <div>
            <label className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>风格描述（可选，统一所有分镜的视觉风格）</label>
            <input
              value={style}
              onChange={e => setStyle(e.target.value)}
              placeholder="比如：电影级光影、3D 卡通、写实纪录片、像素风..."
              className="w-full mt-1 text-xs rounded-md px-2 py-1.5 outline-none"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>
          <div>
            <label className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>文章 / PRD 内容（必填）</label>
            <textarea
              value={article}
              onChange={e => setArticle(e.target.value)}
              placeholder="粘贴文章或 PRD 文档，AI 会自动拆解为 3-8 个适合短视频的分镜"
              className="w-full mt-1 text-sm rounded-md px-3 py-2 outline-none resize-none"
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
                minHeight: 200,
              }}
            />
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
