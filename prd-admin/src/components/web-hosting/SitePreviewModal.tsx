import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, FileWarning, History, MessageSquare, MessageCircleQuestion, Settings2, WandSparkles } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import type { HostedSite } from '../../services/real/webPages';
import { setSiteCommentsEnabled } from '../../services/real/webPages';
import CommentsSection from './CommentsSection';
import AskPanelInline from './ask/AskPanelInline';
import AskConfigDrawer from './ask/AskConfigDrawer';
import { resolveSitePreviewSource, supportsNativePdfViewer } from './sitePreviewSource';
import { DIRECT_PREVIEW_SANDBOX, SRCDOC_PREVIEW_SANDBOX } from './previewHtml';
import { useSitePreviewHtml } from './useSitePreviewHtml';
import SiteEditPanel from './SiteEditPanel';

/** 多久之后提示「加载较慢」。只影响提示，不影响是否判定失败。 */
const SLOW_HINT_MS = 8000;

/**
 * 最多等多久服务端代理把入口正文取回来。到点就先挂直链——代理慢不该换成一屏空白。
 * 与 ShareViewPage 的 PREVIEW_MASK_TIMEOUT_MS 取同一个量级，理由相同。
 */
const SRCDOC_WAIT_MS = 1500;

interface Props {
  site: HostedSite;
  onClose: () => void;
  /** 评论开关变更后回传给父组件，避免关闭再打开时从 stale site.commentsEnabled 重新初始化 */
  onCommentsEnabledChange?: (siteId: string, enabled: boolean) => void;
  /** 提问开关同理：只改弹窗内的 state，关掉再打开会从 stale site.askEnabled 退回旧值 */
  onAskEnabledChange?: (siteId: string, enabled: boolean) => void;
  /** 页面内容发布后回填父级站点 SSOT，使预览与卡片立即切到新版本。 */
  onSiteChange?: (site: HostedSite) => void;
  /** 是否可改「允许访客评论」开关（仅 owner/editor）。viewer 角色只读评论、不显示开关 */
  canToggleComments?: boolean;
  /** 卡片可直接打开修改面板，避免用户必须先预览、再猜“帮我修改”在哪里。 */
  initialPanel?: 'none' | 'edit';
  /** 卡片的“版本记录”入口直接把修改面板定位到历史区。 */
  initialEditSection?: 'compose' | 'history';
}

/**
 * 站点预览模态框 —— 在 iframe 中加载站点入口 URL，右侧可展开评论面板
 * 遵循 frontend-modal.md 三硬约束: inline style 高度 + createPortal + min-h-0
 */
export default function SitePreviewModal({
  site,
  onClose,
  onCommentsEnabledChange,
  onAskEnabledChange,
  onSiteChange,
  canToggleComments = true,
  initialPanel = 'none',
  initialEditSection = 'compose',
}: Props) {
  const [loading, setLoading] = useState(true);
  /** 只在 iframe 真的 onError 时为 true —— 不由超时推断（见下方 effect 注释） */
  const [errored, setErrored] = useState(false);
  /** 加载偏慢：只挂一条角标提示，不遮挡已经绘制出来的内容 */
  const [slow, setSlow] = useState(false);
  // 右侧面板同一时刻只开一个：评论与提问互斥，两个都塞进来会把 iframe 挤成窄条
  const [rightPanel, setRightPanel] = useState<'none' | 'comments' | 'ask' | 'edit'>(initialPanel);
  const [editSection, setEditSection] = useState<'compose' | 'history'>(initialEditSection);
  const showComments = rightPanel === 'comments';
  const setShowComments = (next: boolean | ((v: boolean) => boolean)) => {
    const want = typeof next === 'function' ? next(rightPanel === 'comments') : next;
    setRightPanel(want ? 'comments' : 'none');
  };
  /** 提问设置抽屉（owner/editor 才有入口） */
  const [showAskConfig, setShowAskConfig] = useState(false);
  /** 提问面板打开过至少一次；之后常驻挂载，切走只藏不卸（见渲染处注释） */
  const [askEverOpened, setAskEverOpened] = useState(false);
  const [editEverOpened, setEditEverOpened] = useState(initialPanel === 'edit');
  /** 站点提问开关的本地镜像：配置抽屉保存后即时回填，不必等父级刷新列表 */
  // 三态：undefined = owner 从没表过态（默认开），true = 明确开，false = 明确关。
  // 曾经写的是 === true，于是「没表过态」被当成关——默认全开的口径下这会让
  // 弹窗里的开关和阅读页的真实状态对不上。
  const [askEnabled, setAskEnabled] = useState(site.askEnabled !== false);
  const [commentsEnabled, setCommentsEnabled] = useState(site.commentsEnabled !== false);
  const [togglingComments, setTogglingComments] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 能不能把 PDF 直接丢给浏览器原生阅读器，问的是**浏览器有没有这个能力**，
  // 既不是弹窗多大，也不是视口宽度——768px 断点会把 iPad、横屏手机、平板 WebView
  // 一并算成桌面，它们照样白屏。判据见 supportsNativePdfViewer。
  const previewSource = resolveSitePreviewSource(site, { nativePdfViewer: supportsNativePdfViewer() });
  // 直链 iframe 在 Chrome 里存在「只绘制空白」的已知形态，可靠路径是服务端代理取回正文走 srcDoc
  // （分享页 PR #1356 已这么修）。取不回就如实退回直链，见 useSitePreviewHtml。
  // PDF 直连路径不参与：那是交给浏览器原生阅读器的静态资源，没有 HTML 正文可取。
  const { srcDoc, loading: htmlLoading } = useSitePreviewHtml(
    previewSource.usingNativePdfViewer ? null : site,
    true,
  );
  /**
   * 渲染路径**只决定一次**，定了就不再变。
   *
   * 等窗口（SRCDOC_WAIT_MS）内拿到正文就走 srcDoc；超时或取不回就挂直链，之后**迟到的正文一律丢弃**。
   * 换文档 = 整页重载，PPT 翻到第几页、表单里敲的字全部清零——「可能更好的预览」不值一次当面重载
   * （与 ShareViewPage 的取舍一致）。这里必须是latch，不能写成 `srcDoc && !超时` 这种会翻回去的表达式。
   */
  const [renderMode, setRenderMode] = useState<'waiting' | 'srcdoc' | 'direct'>('waiting');
  useEffect(() => {
    if (renderMode !== 'waiting') return;
    if (srcDoc) { setRenderMode('srcdoc'); return; }
    if (!htmlLoading) setRenderMode('direct');
  }, [renderMode, srcDoc, htmlLoading]);
  const useSrcDoc = renderMode === 'srcdoc';

  // 发布新版本后 siteUrl 的版本指纹会变化。预览组件不卸载，因此必须显式重开
  // srcDoc/direct 的一次性判定，否则 iframe 会继续停在发布前的旧内容。
  useEffect(() => {
    setRenderMode('waiting');
    setLoading(true);
    setErrored(false);
    setSlow(false);
    const timer = window.setTimeout(() => setRenderMode((mode) => (mode === 'waiting' ? 'direct' : mode)), SRCDOC_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [site.siteUrl]);

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
  }, [site.siteUrl]);

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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-1 sm:p-4"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col rounded-xl border border-token-subtle bg-token-card text-token-primary shadow-2xl"
        style={{ width: '90vw', height: '90vh', maxWidth: '1400px' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex shrink-0 flex-col gap-2 border-b border-token-subtle px-3 py-2 sm:flex-row sm:items-center sm:gap-3 sm:px-4 sm:py-3">
          <div className="flex min-w-0 w-full flex-1 items-center gap-2 sm:w-auto">
            <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-token-primary truncate">{site.title}</h3>
            <p className="hidden text-xs text-token-muted truncate sm:block">{site.siteUrl}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg bg-token-nested text-token-secondary transition-colors hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:hidden"
              title="关闭"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 overflow-x-auto pb-0.5 sm:w-auto sm:overflow-visible sm:pb-0">
            <button
              type="button"
              onClick={() => setShowComments((v) => !v)}
              className={`flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                showComments ? 'bg-blue-600/80 text-white' : 'bg-token-nested hover-bg-soft text-token-secondary'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              评论
            </button>
            {askEnabled && (
              <button
                type="button"
                onClick={() => {
                  setAskEverOpened(true);
                  setRightPanel((p) => (p === 'ask' ? 'none' : 'ask'));
                }}
                className={`flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  rightPanel === 'ask' ? 'bg-blue-600/80 text-white' : 'bg-token-nested hover-bg-soft text-token-secondary'
                }`}
              >
                <MessageCircleQuestion className="w-3.5 h-3.5" />
                提问
              </button>
            )}
            {canToggleComments && !site.wrappedAssetType && (
              <button
                type="button"
                onClick={() => {
                  const shouldOpen = rightPanel !== 'edit' || editSection !== 'compose';
                  setEditEverOpened(true);
                  setEditSection('compose');
                  setRightPanel(shouldOpen ? 'edit' : 'none');
                }}
                className={`flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  rightPanel === 'edit' ? 'bg-blue-600/80 text-white' : 'bg-token-nested hover-bg-soft text-token-secondary'
                }`}
              >
                <WandSparkles className="w-3.5 h-3.5" />
                帮我修改
              </button>
            )}
            {canToggleComments && !site.wrappedAssetType && (
              <button
                type="button"
                onClick={() => {
                  setEditEverOpened(true);
                  setEditSection('history');
                  setRightPanel('edit');
                }}
                className={`flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  rightPanel === 'edit' && editSection === 'history' ? 'bg-blue-600/80 text-white' : 'bg-token-nested hover-bg-soft text-token-secondary'
                }`}
              >
                <History className="h-3.5 w-3.5" />
                版本记录
              </button>
            )}
            {canToggleComments && (
              <button
                type="button"
                onClick={() => setShowAskConfig(true)}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg bg-token-nested text-token-secondary transition-colors hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                title="提问设置"
                aria-label="提问设置"
              >
                <Settings2 className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={handleOpenExternal}
              className="flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-token-nested px-3 text-xs text-token-secondary transition-colors hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              新窗口打开
            </button>
            <button
              type="button"
              onClick={onClose}
              className="hidden min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg bg-token-nested text-token-secondary transition-colors hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:inline-flex"
              title="关闭"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 主体：iframe + 可选评论面板 */}
        <div className="relative flex-1 min-h-0 flex overflow-hidden">
          {/* iframe 容器（底色用面板深色，避免站点白底加载瞬间在暗色后台里突兀闪白） */}
          <div className="flex-1 min-w-0 relative bg-token-nested">
            {/* loading 遮罩只在「还没到慢提示阈值」时盖住——超过阈值就让位给 iframe，
                因为此时页面大概率已经画出来了，只是 load 事件还没来。 */}
            {loading && !slow && (
              <div className="absolute inset-0 flex items-center justify-center bg-token-nested">
                <MapSectionLoader text="正在加载站点…" />
              </div>
            )}
            {/* 真失败（onError）才铺满遮罩 */}
            {errored && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-token-nested gap-3">
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
              <div className="absolute left-3 bottom-3 z-10 flex items-center gap-2 rounded-lg border border-token-subtle bg-token-card px-3 py-1.5 text-[12px] text-token-secondary shadow-lg backdrop-blur-sm">
                <MapSpinner size={14} />
                <span>加载较慢，内容可能仍在陆续显示</span>
                <button onClick={handleOpenExternal} className="text-blue-400 hover:text-blue-300">
                  新窗口打开
                </button>
              </div>
            )}
            <iframe
              ref={iframeRef}
              key={renderMode}
              src={useSrcDoc ? undefined : previewSource.src}
              srcDoc={useSrcDoc ? srcDoc! : undefined}
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
                : `${useSrcDoc ? SRCDOC_PREVIEW_SANDBOX : DIRECT_PREVIEW_SANDBOX} allow-modals`}
              title={site.title}
            />
          </div>

          {/* 评论面板 */}
          {showComments && (
            <aside
              className="absolute inset-0 z-20 flex w-full min-h-0 flex-col bg-token-card sm:static sm:inset-auto sm:z-auto sm:w-[360px] sm:shrink-0 sm:border-l sm:border-token-subtle"
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
              className="absolute inset-0 z-20 flex w-full min-h-0 flex-col sm:static sm:inset-auto sm:z-auto sm:w-[380px] sm:shrink-0 sm:border-l sm:border-token-subtle"
              style={{
                background: 'var(--panel-solid, var(--bg-elevated))',
                display: rightPanel === 'ask' ? 'flex' : 'none',
              }}
            >
              <AskPanelInline siteId={site.id} title={site.title} />
            </aside>
          )}

          {editEverOpened && (
            <aside
              className="absolute inset-0 z-20 flex w-full min-h-0 flex-col sm:static sm:inset-auto sm:z-auto sm:w-[440px] sm:shrink-0 sm:border-l sm:border-token-subtle"
              style={{
                background: 'var(--panel-solid, var(--bg-elevated))',
                display: rightPanel === 'edit' ? 'flex' : 'none',
              }}
            >
              <SiteEditPanel
                site={site}
                focusSection={editSection}
                onPublished={(updated) => onSiteChange?.(updated)}
              />
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
