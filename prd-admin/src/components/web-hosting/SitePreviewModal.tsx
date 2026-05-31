import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, Loader2, FileWarning, MessageSquare } from 'lucide-react';
import type { HostedSite } from '../../services/real/webPages';
import { setSiteCommentsEnabled } from '../../services/real/webPages';
import CommentsSection from './CommentsSection';

interface Props {
  site: HostedSite;
  onClose: () => void;
  /** 评论开关变更后回传给父组件，避免关闭再打开时从 stale site.commentsEnabled 重新初始化 */
  onCommentsEnabledChange?: (siteId: string, enabled: boolean) => void;
}

/**
 * 站点预览模态框 —— 在 iframe 中加载站点入口 URL，右侧可展开评论面板
 * 遵循 frontend-modal.md 三硬约束: inline style 高度 + createPortal + min-h-0
 */
export default function SitePreviewModal({ site, onClose, onCommentsEnabledChange }: Props) {
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [commentsEnabled, setCommentsEnabled] = useState(site.commentsEnabled !== false);
  const [togglingComments, setTogglingComments] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // 加载超时检测 (10s 未触发 onLoad 视为可能失败)
  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading((prev) => {
        if (prev) setErrored(true);
        return false;
      });
    }, 10000);
    return () => clearTimeout(timer);
  }, []);

  const handleOpenExternal = () => {
    window.open(site.siteUrl, '_blank');
  };

  const handleToggleCommentsEnabled = async () => {
    if (togglingComments) return;
    const next = !commentsEnabled;
    setTogglingComments(true);
    const res = await setSiteCommentsEnabled(site.id, next);
    if (res.success) {
      setCommentsEnabled(next);
      // 回传父组件，更新其持有的 site 快照（修复关闭再打开开关回退到旧值）
      onCommentsEnabledChange?.(site.id, next);
    }
    setTogglingComments(false);
  };

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col rounded-xl border border-white/10 bg-[#0f1014] shadow-2xl"
        style={{ width: '90vw', height: '90vh', maxWidth: '1400px' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-white truncate">{site.title}</h3>
            <p className="text-xs text-white/40 truncate">{site.siteUrl}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowComments((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                showComments ? 'bg-blue-600/80 text-white' : 'bg-white/5 hover:bg-white/10 text-white/70'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              评论
            </button>
            <button
              onClick={handleOpenExternal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 text-xs transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              新窗口打开
            </button>
            <button
              onClick={onClose}
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 transition-colors"
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 主体：iframe + 可选评论面板 */}
        <div className="flex-1 min-h-0 flex">
          {/* iframe 容器（底色用面板深色，避免站点白底加载瞬间在暗色后台里突兀闪白） */}
          <div className="flex-1 min-w-0 relative bg-[#0f1014]">
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0f1014]">
                <Loader2 className="w-8 h-8 animate-spin text-white/40" />
              </div>
            )}
            {errored && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f1014] gap-3">
                <FileWarning className="w-12 h-12 text-amber-400/70" />
                <p className="text-sm text-white/60">站点加载超时或失败</p>
                <button
                  onClick={handleOpenExternal}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm"
                >
                  在新窗口打开
                </button>
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={site.siteUrl}
              className="w-full h-full"
              onLoad={() => {
                // iframe 成功加载：清 loading 同时清 errored
                // 修复"超时已置 errored，但站点随后加载成功，错误遮罩却一直盖住"（Cursor medium）
                setLoading(false);
                setErrored(false);
              }}
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
              title={site.title}
            />
          </div>

          {/* 评论面板 */}
          {showComments && (
            <aside
              className="w-[360px] shrink-0 border-l border-white/10 flex flex-col min-h-0 bg-[#0f1014]"
            >
              {/* 允许评论开关 */}
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10 shrink-0">
                <span className="text-xs text-white/60">允许访客评论</span>
                <button
                  onClick={handleToggleCommentsEnabled}
                  disabled={togglingComments}
                  role="switch"
                  aria-checked={commentsEnabled}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                    commentsEnabled ? 'bg-blue-600' : 'bg-white/15'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      commentsEnabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              <div
                className="flex-1 min-h-0 overflow-y-auto p-3"
                style={{ overscrollBehavior: 'contain' }}
              >
                {/* key 随开关变化，强制刷新评论区的 commentsEnabled 态 */}
                <CommentsSection key={String(commentsEnabled)} mode="site" siteId={site.id} />
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
