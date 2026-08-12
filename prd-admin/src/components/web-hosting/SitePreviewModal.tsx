import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, FileWarning, MessageSquare, MessageCircleQuestion, Settings2 } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import type { HostedSite } from '../../services/real/webPages';
import { setSiteCommentsEnabled } from '../../services/real/webPages';
import CommentsSection from './CommentsSection';
import AskPanelInline from './ask/AskPanelInline';
import AskConfigDrawer from './ask/AskConfigDrawer';
import { resolveSitePreviewSource, supportsNativePdfViewer } from './sitePreviewSource';

/** 多久之后提示「加载较慢」。只影响提示，不影响是否判定失败。 */
const SLOW_HINT_MS = 8000;

interface Props {
  site: HostedSite;
  onClose: () => void;
  /** 评论开关变更后回传给父组件，避免关闭再打开时从 stale site.commentsEnabled 重新初始化 */
  onCommentsEnabledChange?: (siteId: string, enabled: boolean) => void;
  /** 提问开关同理：只改弹窗内的 state，关掉再打开会从 stale site.askEnabled 退回旧值 */
  onAskEnabledChange?: (siteId: string, enabled: boolean) => void;
  /** 是否可改「允许访客评论」开关（仅 owner/editor）。viewer 角色只读评论、不显示开关 */
  canToggleComments?: boolean;
}

/**
 * 站点预览模态框 —— 在 iframe 中加载站点入口 URL，右侧可展开评论面板
 * 遵循 frontend-modal.md 三硬约束: inline style 高度 + createPortal + min-h-0
 */
export default function SitePreviewModal({ site, onClose, onCommentsEnabledChange, onAskEnabledChange, canToggleComments = true }: Props) {
  const [loading, setLoading] = useState(true);
  /** 只在 iframe 真的 onError 时为 true —— 不由超时推断（见下方 effect 注释） */
  const [errored, setErrored] = useState(false);
  /** 加载偏慢：只挂一条角标提示，不遮挡已经绘制出来的内容 */
  const [slow, setSlow] = useState(false);
  // 右侧面板同一时刻只开一个：评论与提问互斥，两个都塞进来会把 iframe 挤成窄条
  const [rightPanel, setRightPanel] = useState<'none' | 'comments' | 'ask'>('none');
  const showComments = rightPanel === 'comments';
  const setShowComments = (next: boolean | ((v: boolean) => boolean)) => {
    const want = typeof next === 'function' ? next(rightPanel === 'comments') : next;
    setRightPanel(want ? 'comments' : 'none');
  };
  /** 提问设置抽屉（owner/editor 才有入口） */
  const [showAskConfig, setShowAskConfig] = useState(false);
  /** 提问面板打开过至少一次；之后常驻挂载，切走只藏不卸（见渲染处注释） */
  const [askEverOpened, setAskEverOpened] = useState(false);
  /** 站点提问开关的本地镜像：配置抽屉保存后即时回填，不必等父级刷新列表 */
  const [askEnabled, setAskEnabled] = useState(site.askEnabled === true);
  const [commentsEnabled, setCommentsEnabled] = useState(site.commentsEnabled !== false);
  const [togglingComments, setTogglingComments] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 能不能把 PDF 直接丢给浏览器原生阅读器，问的是**浏览器有没有这个能力**，
  // 既不是弹窗多大，也不是视口宽度——768px 断点会把 iPad、横屏手机、平板 WebView
  // 一并算成桌面，它们照样白屏。判据见 supportsNativePdfViewer。
  const previewSource = resolveSitePreviewSource(site, { nativePdfViewer: supportsNativePdfViewer() });

  const focusPreviewFrame = () => {
    const frame = iframeRef.current;
    if (!frame) return;
    // PPT/幻灯片类托管页的快捷键通常绑在 iframe 内部 window 上。
    // 弹窗打开后焦点仍可能停在后台按钮/关闭按钮上，需要把键盘焦点交给预览内容。
    requestAnimationFrame(() => frame.focus());
    window.setTimeout(() => frame.focus(), 80);
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // 加载慢 ≠ 加载失败。
  //
  // iframe 的 load 事件要等**所有子资源**结算才触发；托管的 AI 生成页普遍外链 Google Fonts 等
  // 三方域名，这些域名在部分网络里是「挂起」而不是快速失败——页面正文其实早就画出来了，
  // load 却迟迟不来。旧实现「10s 没 load 就判 errored」会把一层错误遮罩盖在**已经渲染好的页面**上，
  // 用户看到的就是「无法预览」。判据必须换成真正能证明失败的信号：iframe onError。
  // 超时只降级为一条非阻断的角标提示，绝不遮挡内容。
  // 参见 .claude/rules/predicate-and-wiring-discipline.md 形状 1（判据比它该管的范围窄）。
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => clearTimeout(timer);
  }, []);

  const handleOpenExternal = () => {
    // 与 iframe 同源同 URL：PDF 站在新窗口里也直接给原始 PDF，和 ShareViewPage 顶栏一致
    window.open(previewSource.src, '_blank');
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
        className="relative flex flex-col rounded-xl border border-token-subtle bg-[#0f1014] shadow-2xl"
        style={{ width: '90vw', height: '90vh', maxWidth: '1400px' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-token-subtle shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-token-primary truncate">{site.title}</h3>
            <p className="text-xs text-token-muted truncate">{site.siteUrl}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowComments((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                showComments ? 'bg-blue-600/80 text-white' : 'bg-token-nested hover-bg-soft text-token-secondary'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              评论
            </button>
            {askEnabled && (
              <button
                onClick={() => {
                  setAskEverOpened(true);
                  setRightPanel((p) => (p === 'ask' ? 'none' : 'ask'));
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  rightPanel === 'ask' ? 'bg-blue-600/80 text-white' : 'bg-token-nested hover-bg-soft text-token-secondary'
                }`}
              >
                <MessageCircleQuestion className="w-3.5 h-3.5" />
                提问
              </button>
            )}
            {canToggleComments && (
              <button
                onClick={() => setShowAskConfig(true)}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-token-nested hover-bg-soft text-token-secondary transition-colors"
                title="提问设置"
              >
                <Settings2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={handleOpenExternal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-token-nested hover-bg-soft text-token-secondary text-xs transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              新窗口打开
            </button>
            <button
              onClick={onClose}
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-token-nested hover-bg-soft text-token-secondary transition-colors"
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
            {/* loading 遮罩只在「还没到慢提示阈值」时盖住——超过阈值就让位给 iframe，
                因为此时页面大概率已经画出来了，只是 load 事件还没来。 */}
            {loading && !slow && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0f1014]">
                <MapSectionLoader text="正在加载站点…" />
              </div>
            )}
            {/* 真失败（onError）才铺满遮罩 */}
            {errored && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f1014] gap-3">
                <FileWarning className="w-12 h-12 text-amber-400/70" />
                <p className="text-sm text-token-secondary">站点加载失败</p>
                <button
                  onClick={handleOpenExternal}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm"
                >
                  在新窗口打开
                </button>
              </div>
            )}
            {/* 加载慢：角标提示，不遮挡内容。措辞只说「较慢」，不谎报「失败」。 */}
            {loading && slow && !errored && (
              <div className="absolute left-3 bottom-3 z-10 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-[12px] text-token-secondary backdrop-blur-sm">
                <MapSpinner size={14} />
                <span>加载较慢，内容可能仍在陆续显示</span>
                <button onClick={handleOpenExternal} className="text-blue-400 hover:text-blue-300">
                  新窗口打开
                </button>
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={previewSource.src}
              className="w-full h-full"
              tabIndex={-1}
              onLoad={() => {
                // iframe 成功加载：清 loading 同时清 errored
                // 修复"超时已置 errored，但站点随后加载成功，错误遮罩却一直盖住"（Cursor medium）
                setLoading(false);
                setErrored(false);
                focusPreviewFrame();
              }}
              onError={() => {
                setLoading(false);
                setErrored(true);
              }}
              // 直连 PDF 时不加 sandbox：文档是浏览器原生 PDF 阅读器接管的静态资源，不是用户上传的可执行 HTML，
              // 而 sandbox 会在部分 Chrome 版本里把内置阅读器一起屏蔽掉（"此页面已被 Chrome 屏蔽"）。
              // 跨域这一层隔离仍在（PDF 来自托管域名，拿不到 MAP 的同源能力）。
              sandbox={previewSource.usingNativePdfViewer
                ? undefined
                : 'allow-scripts allow-same-origin allow-popups allow-forms allow-modals'}
              title={site.title}
            />
          </div>

          {/* 评论面板 */}
          {showComments && (
            <aside
              className="w-[360px] shrink-0 border-l border-token-subtle flex flex-col min-h-0 bg-[#0f1014]"
            >
              {/* 允许评论开关：仅 owner/editor 显示（viewer 无权改，显示了点不动反而困惑） */}
              {canToggleComments && (
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-token-subtle shrink-0">
                <span className="text-xs text-token-secondary">允许访客评论</span>
                <button
                  onClick={handleToggleCommentsEnabled}
                  disabled={togglingComments}
                  role="switch"
                  aria-checked={commentsEnabled}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                    commentsEnabled ? 'bg-blue-600' : 'bg-token-card'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      commentsEnabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              )}
              <div
                className="flex-1 min-h-0 overflow-y-auto p-3"
                style={{ overscrollBehavior: 'contain' }}
              >
                {/* key 随开关变化，强制刷新评论区的 commentsEnabled 态；
                    onStateLoaded 用服务端权威值回填开关，消除"开关 ON 但面板显示已关闭"的 stale 偏差（Cursor medium） */}
                <CommentsSection
                  key={String(commentsEnabled)}
                  mode="site"
                  siteId={site.id}
                  onStateLoaded={(serverEnabled) => {
                    if (serverEnabled !== commentsEnabled) {
                      setCommentsEnabled(serverEnabled);
                      onCommentsEnabledChange?.(site.id, serverEnabled);
                    }
                  }}
                />
              </div>
            </aside>
          )}

          {/* 提问面板：与评论共用右侧 aside 位置，互斥切换 */}
          {/* 与 AskWidget 同理：打开过就常驻挂载，切走只藏不卸。
              卸载会销毁 useAskStream 的对话与 sessionId，切到评论再切回来就是空的；
              流式输出中途切走还会让那次请求无人认领地跑完。 */}
          {askEverOpened && (
            <aside
              className="w-[380px] shrink-0 border-l border-token-subtle flex flex-col min-h-0"
              style={{
                background: 'var(--panel-solid, var(--bg-elevated))',
                display: rightPanel === 'ask' ? 'flex' : 'none',
              }}
            >
              <AskPanelInline siteId={site.id} title={site.title} />
            </aside>
          )}
        </div>
      </div>

      {showAskConfig && (
        <AskConfigDrawer
          siteId={site.id}
          siteTitle={site.title}
          onClose={() => setShowAskConfig(false)}
          onSaved={(cfg) => {
            setAskEnabled(cfg.enabled);
            // 同步父组件持有的 site 快照 + 列表，避免关闭再开时退回旧值（与评论开关同一处理）
            onAskEnabledChange?.(site.id, cfg.enabled);
          }}
        />
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
