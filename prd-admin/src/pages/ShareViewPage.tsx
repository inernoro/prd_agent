import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { viewSiteShare, saveSharedSite } from '@/services';
import type { ShareViewData } from '@/services';
import { listShareComments, getShareSiteContent, type HostedSite } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import { Lock, ExternalLink, FileCode2, Eye, EyeOff, AlertCircle, ShieldCheck, Unlock, Download, FileDown, Check, LogIn, MessageSquare, X, Maximize, Minimize } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { BlackHoleVortex } from '@/components/effects/BlackHoleVortex';
import { BlurText } from '@/components/reactbits';
import { SHARE_FAILURE_REGISTRY, resolveShareFailure } from '@/components/web-hosting/shareFailure';
import { detectSlideDeck } from '@/components/web-hosting/slideDeck';
import CommentsSection from '@/components/web-hosting/CommentsSection';
import AskWidget from '@/components/web-hosting/ask/AskWidget';
import ShareSiteEditDock from '@/components/web-hosting/ShareSiteEditDock';
import type { AskDockState } from '@/components/web-hosting/ask/askDockGeometry';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  getNativeFullscreenElement,
  subscribeNativeFullscreen,
  tryEnterNativeFullscreen,
  tryExitNativeFullscreen,
} from '@/components/web-hosting/shareFullscreen';
import {
  DIRECT_PREVIEW_SANDBOX,
  SRCDOC_PREVIEW_SANDBOX,
  canUseSrcDocPreview,
  hasFetchableHtml,
  resolvePreviewSource,
  stripInjectedTelemetry,
  withPreviewBase,
} from '@/components/web-hosting/previewHtml';
import type { PreviewSource } from '@/components/web-hosting/previewHtml';
import {
  planSourceDownload,
  describeDownloadResult,
  describeDownloadFailure,
  saveTextAsFile,
} from '@/components/web-hosting/sourceDownload';

/**
 * 幻灯片邀请条：告诉访客这一页能用键盘翻。
 *
 * 为什么要有：deck 的翻页控件通常是右下角两个很淡的箭头，很多人从头到尾用鼠标点，
 * 甚至以为这就是一张长图。一句「方向键翻页」省掉这整段试错。
 *
 * 为什么会自己消失：它是邀请不是控件，说完就该让开——内容才是主角
 * （content-fills-canvas：产物占主导，chrome 压到最少）。
 */
function SlideKeyboardInvite({ yield: stepAside }: { yield?: boolean }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGone(true), 6000);
    return () => clearTimeout(t);
  }, []);

  const key: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 20, height: 20, padding: '0 5px', borderRadius: 5,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)',
    fontSize: 11, fontFamily: 'ui-monospace, monospace', lineHeight: 1,
  };

  return (
    // surface-tone-dark：这一条永远浮在托管内容之上，两个主题下都必须是深色药丸，
    // 走 token 而不是写死颜色（admin-dual-theme 的暗岛机制）
    <div
      className="surface-tone-dark"
      style={{
        position: 'absolute', left: '50%', bottom: 18, transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 14px', borderRadius: 999,
        background: 'var(--panel-solid)', color: 'var(--text-primary)',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        fontSize: 12.5, whiteSpace: 'nowrap',
        // 邀请条永远不该拦住底下 deck 的点击
        pointerEvents: 'none',
        // 邀请条和提问坞的额度小条都站在底部正中。这一条是邀请不是控件，
        // 用户一展开提问长条它就该让开——不然两枚药丸直接叠在一起，看着像渲染坏了。
        opacity: gone || stepAside ? 0 : 1,
        transition: 'opacity 600ms ease',
      }}
    >
      {/* 只写方向键：四种 deck 框架都绑了它。F 全屏之类各家不一，
          与其猜一个按下去没反应的快捷键，不如让顶栏那个全屏按钮去负责。 */}
      <span style={key}>←</span>
      <span style={key}>→</span>
      <span>方向键翻页，点一下页面再按</span>
    </div>
  );
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 等正文最多等多久，到点就转直链。
 *
 * 这个常量替代了原来那个 1500ms 的「遮罩让位」窗口，两者要解决的问题不是同一个：
 *
 * 旧写法里 iframe 首帧就挂着直链地址，遮罩只是盖在它上面，所以 1.5s 让位是对的——
 * 底下那一页已经加载了 1.5 秒，多半画好了。但**那次直链请求本身**正是 2026-09-18
 * 事故的来源（某 App 的内置浏览器把它当成下载，弹「Download：(null) 599KB」）。
 * 现在 pending 期间 iframe 是空的，没有「底下那一页」可以露出来，让位也就无从谈起。
 *
 * 于是窗口的语义变成「等正文的耐心上限」：到点说明代理慢或不可达，此时才挂直链。
 * 取值 6 秒——服务端代理自己的超时是 20 秒，而正常一趟 1~3 秒；定太短会把大量本来
 * 一两秒就能内联的页面推去发那次跨域请求，定太长会让真出问题时干等。
 */
export const DIRECT_FALLBACK_TIMEOUT_MS = 6000;
/**
 * 直链露出之后，还有多久可以把原文换上去。
 *
 * **起算点是「直链露出的那一刻」，不是「开始取正文的那一刻」**——这两者差一个
 * DIRECT_FALLBACK_TIMEOUT_MS，写错就等于把宽限期变成 0。
 *
 * 上一版正是这么错的（Codex 第三轮 P2）：那时判据写成 `Date.now() - fetchStartedAt >
 * LATE_SWAP_GUARD_MS`，而两个常量都是 6000、都从取正文开始算。于是 fallback 一触发，
 * elapsed 就已经 ≥ 6000，此后**任何**回来的正文都判成「迟到」不自动换——哪怕直链才刚
 * 开始加载、访客一秒钟状态都没攒下。本该救场的那条路（用原文顶掉可能白屏的直链）
 * 被自己关死了。我还在 commit message 里把它当成「设计得当」，判断反了。
 *
 * 语义本身没变：访客眼前已经是直链页面时，换成 srcDoc 就是换一个文档，滚动位置、输入、
 * PPT 翻到第几页全部清零。窗口之内他还没来得及攒下什么，宁可换文档也要把内容显示出来；
 * 超过了才保他的现场，把原文留在手里并给一个看得见的出口。
 */
export const LATE_SWAP_GUARD_MS = 6000;

/**
 * 盖在预览之上的浮层小片（角落里的一行字 / 一个按钮）共用同一套观感。
 * 抽出来是为了让这两处永远长得一样——两份各写一遍时，改了一处忘一处就会一深一浅。
 */
const OVERLAY_CHIP: React.CSSProperties = {
  position: 'absolute',
  padding: '7px 11px',
  borderRadius: 8,
  background: 'rgba(17,17,17,0.82)',
  color: 'rgba(255,255,255,0.86)',
  fontSize: 12,
  lineHeight: 1.5,
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

/**
 * 该不该显示「正在准备预览」。
 *
 * 判据整个收敛到 resolvePreviewSource 之后，这里只剩一句话：**pending 才遮**。
 * 原先它是三个条件的与（在取 / 没 srcDoc / 窗口没到点），因为那时遮罩盖的是一个
 * 已经在加载的直链 iframe，要小心别把能看的页面盖住；现在 pending 期间 iframe 本来
 * 就是空的，遮罩不是「盖住什么」，而是这一刻唯一的内容。
 *
 * 原来那条不变量（loading 永不结束时不能永远遮着）没有丢，只是挪了位置：
 * resolvePreviewSource 的 waitedOut 到点就转 direct，pending 自然结束。
 */
export function shouldMaskDirectPreview(opts: { source: PreviewSource }): boolean {
  return opts.source === 'pending';
}

interface ShareViewPageProps {
  /** 显式注入 token；若未传，则从 useParams().token 读取（兼容旧路由 /s/wp/:token） */
  tokenOverride?: string;
}

export default function ShareViewPage({ tokenOverride }: ShareViewPageProps = {}) {
  const params = useParams<{ token: string }>();
  const token = tokenOverride ?? params.token;
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const currentUserId = useAuthStore(s => s.user?.userId);
  const isMobile = useIsMobile();
  const [data, setData] = useState<ShareViewData | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');
  /**
   * 密码试太频繁被 429 挡下时的提示（后端文案自带「请 N 秒后再试」）。
   * 之前这一档会掉进整屏的「出错了」，把人踢出密码表单——他刚才输的密码没了，
   * 也看不出来是被限流还是链接坏了。现在留在原地，只在表单上方多一条提示。
   */
  const [rateLimitedHint, setRateLimitedHint] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [wrongPassword, setWrongPassword] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'already'>('idle');
  /** 正在取源文件 */
  const [downloading, setDownloading] = useState(false);
  /**
   * 下载之后要不要多说一句：多文件站下到的只是入口那一份，失败了要说清为什么。
   * 不做成一闪而过的 toast——它是结论，用户得来得及读完。
   */
  const [downloadNote, setDownloadNote] = useState<{ text: string; tone: 'info' | 'error'; detail?: string } | null>(null);
  // 评论抽屉：由顶栏「评论 N」按钮打开（PPT/全屏页无滚动条，评论不能放底部）
  const [showComments, setShowComments] = useState(false);
  /** 提问坞现在是哪一态。只用来让底部的浮层互相让位，不参与别的判断 */
  const [askState, setAskState] = useState<AskDockState>('collapsed');
  // 顶栏按钮上展示的评论数。初始拉一次，抽屉打开后由 CommentsSection 的 onCountChange 接管实时同步
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [embeddedHtml, setEmbeddedHtml] = useState<{ siteUrl: string; html: string } | null>(null);
  /**
   * 取正文这一趟走到哪了 —— **必须带上它说的是哪个 siteUrl**。
   *
   * 两个坑叠在一起：
   * ① 不能用 loading 布尔。effect 要等一次渲染之后才跑，而 `loading=false` 在「还没开始」
   *    与「已经结束」上读起来一模一样；首帧把前者读成后者，resolvePreviewSource 就判 direct，
   *    那正好是这次要消灭的那一次跨域请求。
   * ② 光有三态还不够。换密码重进、data 刷新时 effect 同样晚一帧，那一帧读到的是**上一趟**
   *    的 settled，于是又判一次 direct、又发一次请求——判据漏掉了「重新开始」这个状态
   *    （predicate-and-wiring-discipline 形状 1）。带上 siteUrl 之后，对不上就一律当没开始。
   */
  const [previewFetch, setPreviewFetch] = useState<{ siteUrl: string; settled: boolean } | null>(null);
  /** 等正文超时的那个 siteUrl。带 URL 同理：上一趟的超时不许污染下一趟 */
  const [directFallbackFor, setDirectFallbackFor] = useState<string | null>(null);
  /** 直链 iframe 是否**真的加载出了内容**（有真实 src 且 load 事件到过）。
   *  丢弃迟到 srcDoc 的前提是「用户已经在用底下那一页」——如果底下那页压根没加载
   *  （站点没有入口地址、或直链本身就白屏），丢掉迟到的 srcDoc 等于让用户一直盯着空白。 */
  /**
   * 直链是什么时候露给访客的（0 = 还没露出）。迟到多久由**它**算，不是由「开始取正文」算。
   *
   * 合并了原来的 `fetchStartedAtRef` + `exposedDirectRef` 两个 ref：时间戳本身就带
   * 「有没有露出」的信息，两个状态各存一份正是上一版把起算点搞错的温床。
   * 异步回调读 ref 不读 state——回调闭包里的 state 是发起那一刻的旧值。
   */
  const directExposedAtRef = useRef(0);
  /** 取回原文失败的原因；非空时仍回退直链 iframe，但角标把原因显式说出来（不静默吞） */
  const [embeddedHtmlError, setEmbeddedHtmlError] = useState<string | null>(null);
  /**
   * 迟到的原文——**不自动换上去，但也绝不丢掉**。
   *
   * 「该不该换」需要两个我们都拿不到的答案：直链那一帧到底画出东西没有（跨源，读不了），
   * 以及访客攒了多少状态（滚动发生在那一帧里，同样看不到）。上一版拿 iframe 的 load
   * 当「画出来了」，那是形状 8；改成按已过时间判，同样证明不了白屏没白屏——它只是把
   * 一个不成立的证据换成了另一个。
   *
   * 两个判据都不可知时，正确的做法不是替用户猜，而是把这份能救场的原文留在手里，
   * 给他一个看得见的出口。丢掉它就意味着：直链白屏 + 原文回得慢 = 这个人永远停在一片白，
   * 而那正是这条兜底本来要修的页面。
   */
  const [lateHtml, setLateHtml] = useState<{ siteUrl: string; html: string } | null>(null);
  /**
   * 这份托管内容是不是一套幻灯片（决定要不要出键盘邀请条）。
   * 取回原文时立刻判、单独存：它不能跟着 embeddedHtml 走，那个值在遮罩让位后会被丢弃。
   */
  const [isDeck, setIsDeck] = useState(false);

  const handleOwnerSitePublished = useCallback((updated: HostedSite) => {
    setData((current) => current ? {
      ...current,
      sites: current.sites.map((item) => item.id === updated.id ? {
        ...item,
        title: updated.title,
        description: updated.description,
        siteUrl: updated.siteUrl,
        entryFile: updated.entryFile,
        totalSize: updated.totalSize,
        fileCount: updated.files.length,
        coverImageUrl: updated.coverImageUrl,
        pdfAssetUrl: updated.pdfAssetUrl,
        wrappedAssetType: updated.wrappedAssetType,
      } : item),
    } : current);
  }, []);

  const handleSave = useCallback(async () => {
    if (!token) return;
    if (!isAuthenticated) {
      // 记住当前页面，跳转登录
      const currentPath = window.location.pathname + window.location.search;
      navigate(`/login?redirect=${encodeURIComponent(currentPath)}`);
      return;
    }
    setSaving(true);
    const res = await saveSharedSite(token, password || undefined);
    setSaving(false);
    if (res.success) {
      if (res.data.alreadySaved) {
        setSaveStatus('already');
      } else {
        setSaveStatus('saved');
      }
      // 3秒后恢复
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [token, password, isAuthenticated, navigate]);

  /**
   * 下载源文件。
   *
   * 正文走**服务端同源代理**再从 Blob 落盘，而不是给托管直链挂一个 a[download]：
   * 托管内容在独立域名，跨域的 download 属性会被浏览器忽略、退化成导航打开——
   * 而「导航打开一份 text/html」正是某些 App 内置浏览器弹「Download：(null)」的那条路径。
   * 从同源拿内容，浏览器不必再为这份内容发一次跨域请求。
   */
  const handleDownloadSource = useCallback(async () => {
    if (!token || !data || data.sites.length !== 1) return;
    const site = data.sites[0];
    const plan = planSourceDownload(site);

    if (plan.kind === 'unavailable') {
      setDownloadNote({ text: plan.reason, tone: 'error' });
      return;
    }
    if (plan.kind === 'open') {
      // 独立资产（PDF 等）只能在新窗口打开，由浏览器内联显示、用户自己另存——
      // 跨域的 a[download] 会被忽略，而 fetch 到 Blob 又受制于按域名配的 CORS 白名单
      // （预览域名不在里面）。按钮文案对这一档也是「打开源文件」，不宣称下载。
      window.open(plan.url, '_blank', 'noopener');
      setDownloadNote(null);
      return;
    }

    setDownloading(true);
    setDownloadNote(null);
    const res = await getShareSiteContent(token, site.id, password || undefined);
    setDownloading(false);
    if (!res.success || !res.data?.html) {
      // 后端那句是协议口径的（「站点内容读取失败（HTTP 404）」），不能原样端给访客：
      // 第一句要人话 + 下一步，原文降级成附注（external-cause-first）
      const failure = describeDownloadFailure(res.error?.message);
      setDownloadNote({ text: failure.text, detail: failure.detail, tone: 'error' });
      return;
    }
    // 取回来的是「托管域名对外服务的那一份」，不是存进对象存储的那一份：托管域名前面挂着
    // CDN，它会往每一份 HTML 里塞一条 cloudflareinsights 的 beacon（见 previewHtml.ts 的
    // stripInjectedTelemetry）。那段脚本不是分享者写的，下载下来只会变成一条跟着文件跑的
    // 第三方请求，所以落盘前按同一份判据剥掉——预览与下载共用一个出口，不另起判据。
    // 仍然剥不掉的差异（上传时注入的翻页垫片、路径重写、后端剥掉的 UTF-8 BOM）要拿存储
    // 原字节才能避免，那需要一个专用的流式下载端点，已记进 PR 的后续事项。
    saveTextAsFile(stripInjectedTelemetry(res.data.html), plan.fileName);
    const note = describeDownloadResult(plan);
    setDownloadNote(note ? { text: note, tone: 'info' } : null);
  }, [token, data, password]);

  const fetchShare = async (pwd?: string) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    setWrongPassword(false);
    setRateLimitedHint(null);
    const res = await viewSiteShare(token, pwd?.trim());
    setLoading(false);
    if (res.success) {
      setData(res.data);
      setNeedPassword(false);
    } else if (res.error?.code === 'UNAUTHORIZED') {
      setNeedPassword(true);
      setRateLimitedHint(null);
      // 如果是带密码重试的，说明密码错误
      if (pwd !== undefined) {
        setWrongPassword(true);
        setShakeKey(k => k + 1);
        // 选中输入框内容方便重新输入
        setTimeout(() => inputRef.current?.select(), 100);
      }
    } else if (res.error?.code === 'RATE_LIMITED') {
      // 留在密码屏：这不是链接坏了，是他自己试太快，等一会儿还能进
      setNeedPassword(true);
      setWrongPassword(false);
      setShakeKey(k => k + 1);
      setRateLimitedHint(res.error.message || SHARE_FAILURE_REGISTRY['rate-limited'].body);
    } else {
      setError(res.error || { code: 'UNKNOWN', message: '加载失败' });
    }
  };

  useEffect(() => {
    fetchShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // 全屏演示：优先请求浏览器原生全屏。iPhone WebKit 不支持普通元素 requestFullscreen，
  // 此时降级为页面级沉浸模式：固定铺满可视视口并隐藏 MAP 顶栏，同时提供退出按钮。
  const singleViewRef = useRef<HTMLDivElement>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const isFullscreen = nativeFullscreen || pageFullscreen;
  useEffect(() => {
    const onFsChange = () => setNativeFullscreen(!!getNativeFullscreenElement());
    return subscribeNativeFullscreen(onFsChange);
  }, []);
  useEffect(() => {
    if (!pageFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [pageFullscreen]);
  const togglePresentFullscreen = useCallback(async () => {
    if (pageFullscreen) {
      setPageFullscreen(false);
      return;
    }
    if (getNativeFullscreenElement()) {
      await tryExitNativeFullscreen();
      return;
    }
    const target = singleViewRef.current;
    if (!target || !await tryEnterNativeFullscreen(target)) setPageFullscreen(true);
  }, [pageFullscreen]);

  // 顶栏「评论 N」初始计数：单站点分享 + token 就绪后拉一次（抽屉打开后由 onCountChange 接管）
  useEffect(() => {
    if (!token || !data || data.sites.length !== 1) return;
    let alive = true;
    listShareComments(token, password || undefined)
      .then((res) => { if (alive && res.success && res.data) setCommentCount(res.data.comments.length); })
      .catch(() => {});
    return () => { alive = false; };
  }, [token, password, data]);

  // 取回入口 HTML 走**服务端同源代理**（getShareSiteContent），不是浏览器直接 fetch(site.siteUrl)。
  // 托管内容在独立域名且不返回 Access-Control-Allow-Origin，浏览器侧跨域 fetch 一律被拦，
  // 于是 srcDoc 分支永远拿不到内容、静默退化成「Chrome 里只绘制空白」的直链 iframe——
  // 这就是「三个网页无法预览」的根因之一。改回浏览器 fetch 会让这条兜底再次变成死代码，
  // 守卫见 ShareViewPage.preview.test.ts。
  useEffect(() => {
    const site = data?.sites.length === 1 ? data.sites[0] : null;
    if (!site || !token || !hasFetchableHtml(site)) {
      // 包装资产站（PDF/视频）注定走直链，没有可等的正文——直接落到 settled，
      // 让 resolvePreviewSource 立刻给 direct，不要让这类站点白等一个超时窗口。
      setEmbeddedHtml(null);
      setEmbeddedHtmlError(null);
      setPreviewFetch(site ? { siteUrl: site.siteUrl, settled: true } : null);
      setDirectFallbackFor(null);
      return;
    }

    let alive = true;
    setEmbeddedHtml(null);
    setIsDeck(false);
    setEmbeddedHtmlError(null);
    setLateHtml(null);
    setPreviewFetch({ siteUrl: site.siteUrl, settled: false });
    setDirectFallbackFor(null);
    // 同一个「到点了」要被两处读：渲染读 state，异步回调读 ref。
    // 回调闭包里的 state 是发起那一刻的旧值，永远看不到超时后的 true。
    directExposedAtRef.current = 0;
    // 到点转直链：此时才第一次向托管域名发文档请求（pending 期间一次都没发过）。
    const fallbackTimer = window.setTimeout(() => {
      if (!alive) return;
      directExposedAtRef.current = Date.now();
      setDirectFallbackFor(site.siteUrl);
    }, DIRECT_FALLBACK_TIMEOUT_MS);
    getShareSiteContent(token, site.id, password || undefined)
      .then((res) => {
        if (!alive) return;
        if (res.success && res.data?.html) {
          // 「是不是幻灯片」必须在这里就判掉，不能等 embeddedHtml。
          // 下面那条早退（已经转直链就不自动换）会让 embeddedHtml 停在 null，
          // 于是 deck 邀请条在「原文回得比那个窗口慢」的每一次都静默消失——
          // 判据挂在一个可能被搁置的中间产物上，正是形状 2（链路只建到一半）。
          setIsDeck(detectSlideDeck(res.data.html));
          // 丢弃迟到原文的理由，从头到尾只有一个：**用户已经在这一页上攒下了状态**
          // （滚到哪、输了什么、PPT 翻到第几页），换 srcDoc 等于换一个文档，全部清零。
          //
          // 所以判据必须冲着「攒了多少状态」去，而 iframe 的 load 事件不是它的证据：
          // 直链白屏时 load 照样会触发，两个条件双双成立，于是把唯一能救场的原文丢掉，
          // 访客就永远停在那一片白——正是这条兜底本来要修的那种页面。
          // 「文档加载完了」证明不了「画出了东西」，拿它当证据是形状 8。
          //
          // 换成按已过时间判：这几秒里用户还没来得及攒下什么，宁可换文档也要把内容显示出来；
          // 拖到很久之后才回来，人多半已经在用了，才保他的现场。两种误判的代价不对等——
          // 丢错了是「什么都看不到」，换错了只是「滚动位置没了」。
          // 还没露出直链（exposedAt === 0）就一律直接换上——那时访客看的是「准备中」，
          // 没有任何现场可保。露出之后才按「露出至今多久」判。
          const exposedAt = directExposedAtRef.current;
          const shownFor = exposedAt > 0 ? Date.now() - exposedAt : 0;
          const ready = { siteUrl: site.siteUrl, html: withPreviewBase(res.data.html, site.siteUrl) };
          if (exposedAt > 0 && shownFor > LATE_SWAP_GUARD_MS) {
            // 迟到了：不自动换（他可能已经滚到一半），但留着并给出口。
            // 直接 return 会让「直链白屏 + 原文迟到」变成一片永远的白。
            setLateHtml(ready);
            return;
          }
          setEmbeddedHtml(ready);
          return;
        }
        // 取不回原文时仍回退直链 iframe（多数情况仍能显示），但把原因显式说出来，
        // 不再静默吞掉——用户至少知道「为什么这页可能是空白的」。
        setEmbeddedHtmlError(res.error?.message || '未能取回网页原文，已回退直接加载');
      })
      .catch(() => {
        if (alive) setEmbeddedHtmlError('未能取回网页原文，已回退直接加载');
      })
      .finally(() => {
        if (alive) setPreviewFetch({ siteUrl: site.siteUrl, settled: true });
      });

    return () => { alive = false; window.clearTimeout(fallbackTimer); };
  }, [data, token, password]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setSubmitting(true);
    await fetchShare(password);
    setSubmitting(false);
  };

  // ── Loading ── (纯黑背景，无动画，避免闪烁)
  if (loading) {
    return (
      <div style={{ ...styles.fullScreen, background: '#0a0a0a' }} />
    );
  }

  // ── Error: Not Found / Expired / Visibility Denied ──
  if (error) {
    // 失败态判定收在 resolveShareFailure（有守卫）：后端两层给的可见性拒绝码大小写不同，
    // 写在这儿的三元一定会漏掉其中一种
    const failure = resolveShareFailure(error.code);
    const cfg = SHARE_FAILURE_REGISTRY[failure];
    const isVisibilityDenied = failure === 'visibility-denied';
    const titleText = cfg.title;
    const detailText = cfg.body;
    // 认不出的码才把后端原文露出来——认得出的那几档，我们自己的话说得更清楚。
    //
    // 例外是可见性拒绝：后端把两种完全不同的策略压成同一个码回来——「登录可见」只是
    // 没登录（登录一下就能看），「仅我和协作者」是团队外真进不去。注册表里只能放一段话，
    // 于是一个只差登录的访客被告知「可能还需要团队成员身份」，照着这句话他会放弃。
    // 这一档后端那句原文恰恰把两者分得清清楚楚，所以在这里显式保留它。
    const serverDetail = failure === 'unknown' || isVisibilityDenied ? error.message : null;
    const currentPath = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
    return (
      <div style={styles.fullScreen}>
        <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}><BlackHoleVortex /></div>
        <div style={styles.overlay} />
        <div style={{ ...styles.glassCard, textAlign: 'center', padding: '40px 32px' }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: cfg.tone === 'auth'
              ? 'rgba(96, 165, 250, 0.15)'
              : cfg.tone === 'wait'
                ? 'var(--semantic-warning-soft)'
                : 'rgba(239, 68, 68, 0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 20px',
          }}>
            {isVisibilityDenied
              ? <Lock size={32} color="rgba(96, 165, 250, 0.9)" />
              : <AlertCircle size={32} color="rgba(239, 68, 68, 0.9)" />}
          </div>
          <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: 20, fontWeight: 600 }}>
            {titleText}
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.5)', margin: 0, fontSize: 14, lineHeight: 1.7 }}>
            {detailText}
          </p>
          {serverDetail && (
            <p className="surface-tone-dark" style={{ color: 'var(--text-muted)', margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.6 }}>
              {serverDetail}
            </p>
          )}
          {isVisibilityDenied && !isAuthenticated && (
            <button
              type="button"
              onClick={() => navigate(`/login?redirect=${encodeURIComponent(currentPath)}`)}
              style={{
                marginTop: 20,
                padding: '10px 24px',
                borderRadius: 10,
                border: '1px solid rgba(96, 165, 250, 0.5)',
                background: 'rgba(96, 165, 250, 0.18)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 14,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <LogIn size={14} />
              登录后再试
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Password Required ──
  if (needPassword) {
    return (
      <div style={styles.fullScreen}>
        <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}><BlackHoleVortex /></div>
        <div style={styles.overlay} />
        <div
          key={shakeKey}
          style={{
            ...styles.glassCard,
            textAlign: 'center',
            padding: '40px 32px',
            animation: wrongPassword ? 'share-shake 0.5s ease-in-out' : undefined,
          }}
        >
          {/* Icon */}
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: wrongPassword ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 20px',
            transition: 'background 0.3s',
          }}>
            {wrongPassword
              ? <AlertCircle size={32} color="rgba(239, 68, 68, 0.9)" />
              : <Lock size={32} color="rgba(59, 130, 246, 0.9)" />
            }
          </div>

          <div style={{ color: '#fff', margin: '0 0 8px', fontSize: 20, fontWeight: 600 }}>
            <BlurText
              text={wrongPassword ? '密码不正确' : '此链接需要密码'}
              delay={80}
              animateBy="letters"
              direction="top"
              className="justify-center"
              animationFrom={{ filter: 'blur(10px)', opacity: 0, y: -15 }}
              animationTo={[
                { filter: 'blur(4px)', opacity: 0.6, y: 3 },
                { filter: 'blur(0px)', opacity: 1, y: 0 },
              ]}
              stepDuration={0.35}
            />
          </div>
          <div style={{
            color: wrongPassword ? 'rgba(239, 68, 68, 0.7)' : 'rgba(255,255,255,0.5)',
            margin: '0 0 24px',
            fontSize: 14,
            transition: 'color 0.3s',
          }}>
            <BlurText
              text={wrongPassword ? '请检查密码后重新输入' : '请输入访问密码以查看内容'}
              delay={60}
              animateBy="letters"
              direction="top"
              className="justify-center"
              animationFrom={{ filter: 'blur(8px)', opacity: 0, y: -10 }}
              animationTo={[
                { filter: 'blur(3px)', opacity: 0.5, y: 2 },
                { filter: 'blur(0px)', opacity: 1, y: 0 },
              ]}
              stepDuration={0.3}
            />
          </div>

          {/* 限流不是「链接坏了」，所以留在这一屏，只多一条提示 + 说清口径 */}
          {rateLimitedHint && (
            <div
              className="surface-tone-dark"
              style={{
                margin: '0 0 20px', padding: '10px 14px', borderRadius: 10, textAlign: 'left',
                background: 'var(--semantic-warning-soft)', border: '1px solid var(--semantic-warning-border)',
                color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.65,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 2, color: 'var(--accent-fg-warning)' }}>{rateLimitedHint}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {SHARE_FAILURE_REGISTRY['rate-limited'].body}
              </div>
            </div>
          )}

          <form onSubmit={handlePasswordSubmit} style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <div style={{ position: 'relative' }}>
              <input
                ref={inputRef}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => { setPassword(e.target.value); setWrongPassword(false); }}
                placeholder="输入访问密码"
                autoFocus
                style={{
                  padding: '10px 40px 10px 16px',
                  borderRadius: 10,
                  border: `1px solid ${wrongPassword ? 'rgba(239, 68, 68, 0.5)' : 'var(--border-subtle)'}`,
                  background: 'var(--nested-block-bg)',
                  color: '#fff',
                  fontSize: 14,
                  outline: 'none',
                  width: 220,
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  transition: 'border-color 0.3s',
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                  color: 'rgba(255,255,255,0.4)',
                  display: 'flex', alignItems: 'center',
                }}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <button
              type="submit"
              disabled={submitting || !password.trim()}
              style={{
                padding: '10px 20px',
                borderRadius: 10,
                border: 'none',
                background: wrongPassword
                  ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.8), rgba(239, 68, 68, 0.6))'
                  : 'linear-gradient(135deg, rgba(59, 130, 246, 0.8), rgba(99, 102, 241, 0.8))',
                color: '#fff',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
                opacity: submitting || !password.trim() ? 0.5 : 1,
                transition: 'background 0.3s, opacity 0.2s',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
              }}
            >
              {submitting ? '验证中...' : '确认'}
            </button>
          </form>

          {/* 团队成员免密指引：后端凭登录态识别团队成员并放行密码门控；
              未登录访客在系统眼里与外部人无异，必须给一条「去登录」的出路 */}
          {!isAuthenticated ? (
            <button
              type="button"
              onClick={() => navigate(`/login?returnUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`)}
              style={{
                marginTop: 20,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'rgba(59, 130, 246, 0.9)',
                fontSize: 13,
              }}
            >
              团队成员？登录后可免密访问 →
            </button>
          ) : (
            <p style={{ marginTop: 20, fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
              当前账号不在该网页所属的团队内，需输入密码访问
            </p>
          )}
        </div>

        {/* Shake animation */}
        <style>{`
          @keyframes share-shake {
            0%, 100% { transform: translateX(0); }
            10%, 30%, 50%, 70%, 90% { transform: translateX(-6px); }
            20%, 40%, 60%, 80% { transform: translateX(6px); }
          }
        `}</style>
      </div>
    );
  }

  // ── Success: show site(s) ──
  if (!data) return null;

  const isOwner = isAuthenticated && currentUserId && data.createdBy === currentUserId;

  // Single site -> directly embed in iframe
  if (data.sites.length === 1) {
    const site = data.sites[0];
    // 打包型 SPA（入口是外链 module 脚本）必须留在直链 iframe：srcDoc 的不透明源会让
    // 模块脚本因缺 CORS 被拦，整页白屏。判据见 canUseSrcDocPreview。
    const fetchedHtml = embeddedHtml?.siteUrl === site.siteUrl ? embeddedHtml.html : null;
    const iframeHtml = fetchedHtml && canUseSrcDocPreview(fetchedHtml) ? fetchedHtml : null;
    /**
     * 这一刻 iframe 该拿什么当内容源。pending 时**什么都不给**——不知道走哪条路之前
     * 不向托管域名发文档请求，那一次请求正是 2026-09-18 弹窗事故的来源。
     * 判据本体在 previewHtml.ts 的 resolvePreviewSource（那里有完整缘由）。
     */
    const previewSource = resolvePreviewSource({
      fetchable: hasFetchableHtml(site),
      inlineHtml: iframeHtml,
      // 对不上 siteUrl 就当这一趟还没开始，绝不拿上一趟的结论去判 direct
      settled: previewFetch?.siteUrl === site.siteUrl && previewFetch.settled,
      waitedOut: directFallbackFor === site.siteUrl,
    });
    // 按钮的提示语在**按下之前**就说清会拿到什么：多文件站下到的只是入口那一份，
    // 包装站根本不是网页。点一次换一个报错是最差的那种交代方式。
    const downloadPlan = planSourceDownload(site);
    const downloadHint =
      downloadPlan.kind === 'unavailable' ? downloadPlan.reason
        : downloadPlan.kind === 'open' ? '在新窗口打开源文件，可在浏览器里另存'
        : downloadPlan.partial ? `下载入口文件 ${downloadPlan.fileName}（本站共 ${downloadPlan.fileCount} 个文件）`
        : `下载源文件（${downloadPlan.fileName}）`;
    /**
     * 顶栏说明条有两种来源，这里合成一条。
     *
     * 常驻的那一种（unavailable）：这一档根本取不到源文件（视频包装站、入口超过代理上限），
     * 原因在**交互之前**就摆在这里，不必点任何东西。按钮那一档干脆不渲染。
     *
     * 为什么不是一个灰着的按钮：宣称 disabled、却必须点它才能知道为什么——屏读用户被告知
     * 不可用会跳过，视觉用户看到禁用光标也会跳过，两边都拿不到那句原因，键盘激活还与宣称
     * 的状态自相矛盾（Codex 第六轮 P2）。此前在「不渲染」与「可点的 aria-disabled」之间
     * 来回过两轮，两版各丢一头：前者丢了原因，后者把原因锁在一次点击后面。真正该做的是
     * 把原因从按钮里搬出来——交互前可见，于是那个假的可点控件不再需要存在。
     *
     * 一次性的那一种（downloadNote）：下载的结论或失败原因，用户可以关掉。常驻那条不给
     * 关闭按钮——它是这一屏的状态，不是一次操作的回执。
     */
    const visibleNote: { text: string; tone: 'info' | 'error'; detail?: string; dismissible: boolean } | null =
      downloadNote
        ? { ...downloadNote, dismissible: true }
        : isAuthenticated && downloadPlan.kind === 'unavailable'
          ? { text: downloadPlan.reason, tone: 'info', dismissible: false }
          : null;
    return (
      <div
        ref={singleViewRef}
        style={{
          width: '100vw',
          height: pageFullscreen ? '100dvh' : '100vh',
          minHeight: 0,
          position: pageFullscreen ? 'fixed' : 'relative',
          inset: pageFullscreen ? 0 : undefined,
          zIndex: pageFullscreen ? 2147483000 : undefined,
          display: 'grid',
          gridTemplateRows: isFullscreen ? 'minmax(0, 1fr)' : 'auto minmax(0, 1fr)',
          background: '#0a0a0a',
          overflow: 'hidden',
        }}
      >
        {/* Top bar —— 全屏演示时隐藏，让 PPT 占满整屏。
            观感收在 styles/share-topbar.css：这条栏永远浮在访客上传的网页之上，所以带
            surface-tone-dark 钉死深色，按钮一律走 token（admin-dual-theme）。原先四个按钮
            各写一套内联 style、各自一个亮蓝、都没有 hover——顶栏比它托着的内容还抢眼。
            现在只有「保存到我的托管」是实心主操作，其余一律安静。 */}
        <div style={{ display: isFullscreen ? 'none' : 'block' }}>
          <div className="share-topbar surface-tone-dark border-b border-b-token-subtle">
            {/* 不再展示「{用户} 分享给你的」前缀，直接显示站点标题 */}
            <div className="share-topbar-title">
              <ShieldCheck size={14} color="var(--accent-fg-success)" style={{ flexShrink: 0 }} />
              <span>{data.title || site.title}</span>
            </div>
            {/* 手机端四个按钮并排会互相挤压（mobile-first-density：进内容前 ≤1 条控制条）。
                这里不换行、不堆叠，改为「仅图标 + title 提示」，桌面端维持带文字的原样。 */}
            <div className="share-topbar-actions">
              {!site.pdfAssetUrl && (
                <button
                  className="share-topbar-btn"
                  onClick={togglePresentFullscreen}
                  title="全屏演示（Esc 退出）"
                  aria-label="全屏演示"
                >
                  {isFullscreen ? <Minimize size={isMobile ? 15 : 13} /> : <Maximize size={isMobile ? 15 : 13} />}
                  {!isMobile && '全屏演示'}
                </button>
              )}
              {!isOwner && (
                <button
                  onClick={handleSave}
                  disabled={saving || saveStatus !== 'idle'}
                  title={saveStatus === 'saved' ? '已保存' : saveStatus === 'already' ? '你已经保存过了' : !isAuthenticated ? '登录并保存' : '保存到我的托管'}
                  aria-label="保存到我的托管"
                  className={
                    saveStatus === 'saved' ? 'share-topbar-btn share-topbar-btn--success'
                      : saveStatus === 'already' ? 'share-topbar-btn share-topbar-btn--warning'
                      : 'share-topbar-btn share-topbar-btn--primary'
                  }
                >
                  {saving ? (
                    <><MapSpinner size={isMobile ? 15 : 13} /> {!isMobile && '保存中...'}</>
                  ) : saveStatus === 'saved' ? (
                    <><Check size={isMobile ? 15 : 13} /> {!isMobile && '已保存'}</>
                  ) : saveStatus === 'already' ? (
                    <><Check size={isMobile ? 15 : 13} /> {!isMobile && '你已经保存过了'}</>
                  ) : !isAuthenticated ? (
                    <><LogIn size={isMobile ? 15 : 13} /> {!isMobile && '登录并保存'}</>
                  ) : (
                    <><Download size={isMobile ? 15 : 13} /> {!isMobile && '保存到我的托管'}</>
                  )}
                </button>
              )}
              {/* 下载源文件：登录用户可见。
                  为什么要有：拿到一个分享链接之后，想把这份 HTML 本身要回来（换个人发、
                  存档、二次编辑）此前没有任何入口——只能右键另存，而托管内容在独立域名，
                  存下来的常常不是那一份。
                  为什么限登录：源文件就是这份内容的全部，门槛与「保存到我的托管」保持一致。 */}
              {/* 取不到源文件的那一档（视频包装站、超过代理上限的大站）不渲染按钮——
                  原因由上面那条常驻说明在交互前就给出，不需要一个点了才肯说话的假控件。 */}
              {isAuthenticated && downloadPlan.kind !== 'unavailable' && (
                <button
                  className="share-topbar-btn"
                  onClick={handleDownloadSource}
                  disabled={downloading}
                  title={downloadHint}
                  aria-label={downloadPlan.kind === 'open' ? '打开源文件' : '下载源文件'}
                >
                  {downloading
                    ? <MapSpinner size={isMobile ? 15 : 13} />
                    : downloadPlan.kind === 'open'
                      ? <ExternalLink size={isMobile ? 15 : 13} />
                      : <FileDown size={isMobile ? 15 : 13} />}
                  {!isMobile && (downloading ? '取源文件…' : downloadPlan.kind === 'open' ? '打开源文件' : '下载源文件')}
                </button>
              )}
              <span className="share-topbar-divider" />
              <a
                className="share-topbar-btn"
                href={site.pdfAssetUrl || site.siteUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="新窗口打开"
                aria-label="新窗口打开"
              >
                <ExternalLink size={isMobile ? 15 : 13} />
                {!isMobile && '新窗口打开'}
              </a>
              {/* 评论入口放在顶栏（MAP 自己的 chrome）：PPT/全屏页无滚动条，底部放评论区不可达；
                  浮动按钮又会盖住 PPT 右下角的翻页控件。顶栏按钮零侵入页面布局，点击从右侧抽屉打开。 */}
              {token && (
                <button
                  className="share-topbar-btn"
                  onClick={() => setShowComments(true)}
                  title="评论"
                  aria-label="评论"
                >
                  <MessageSquare size={isMobile ? 15 : 13} />
                  {isMobile
                    ? (commentCount != null && commentCount > 0 ? commentCount : '')
                    : `评论${commentCount != null && commentCount > 0 ? ` ${commentCount}` : ''}`}
                </button>
              )}
            </div>
          </div>
          {/* 一闪而过的 toast 读不完，所以两种说明都占一行。来源见 visibleNote 的注释。 */}
          {visibleNote && (
            <div
              className={`share-topbar-note surface-tone-dark${visibleNote.tone === 'error' ? ' share-topbar-note--error' : ''}`}
              role="status"
            >
              <span>
                {visibleNote.text}
                {visibleNote.detail && (
                  <span className="share-topbar-note-detail">{visibleNote.detail}</span>
                )}
              </span>
              {visibleNote.dismissible && (
                <button onClick={() => setDownloadNote(null)} title="知道了" aria-label="关闭说明">
                  <X size={14} />
                </button>
              )}
            </div>
          )}
        </div>
        <div style={{ position: 'relative', minHeight: 0, background: '#fff' }}>
          {pageFullscreen && (
            <button
              type="button"
              onClick={() => setPageFullscreen(false)}
              title="退出全屏"
              aria-label="退出全屏"
              className="border border-token-subtle"
              style={{
                position: 'absolute',
                zIndex: 20,
                top: 'max(10px, env(safe-area-inset-top))',
                right: 'max(10px, env(safe-area-inset-right))',
                width: 38,
                height: 38,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 10,
                background: 'var(--panel-solid)',
                color: 'var(--text-primary)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.24)',
              }}
            >
              <Minimize size={17} />
            </button>
          )}
          {/* Iframe —— 三态，由 resolvePreviewSource 决定，**不再有「先挂直链再说」这一档**。
              普通 HTML 托管页优先走 srcDoc：直链 iframe 在 Chrome 里可能只绘制空白，
              而在某些 App 的内置浏览器里那次跨域文档请求会被当成下载（2026-09-18 事故）。
              srcDoc 注入 base 后保留相对资源路径，同时不加 allow-same-origin，
              避免用户上传 HTML 获得 MAP 同源能力。
              PDF 壳子仍走 siteUrl：它需要以托管域名为文档源才加载得到同目录那份 PDF。 */}
          <iframe
            // siteUrl 为空时必须给 undefined 而不是 ''：空串在 HTML 里是「相对当前文档」，
            // iframe 会把分享页自己再加载一遍。下面那块空态提示正是为这种站点准备的。
            src={previewSource === 'direct' && site.siteUrl ? site.siteUrl : undefined}
            srcDoc={previewSource === 'srcdoc' ? iframeHtml || undefined : undefined}
            title={site.title}
            style={{ border: 'none', width: '100%', height: '100%', minHeight: 0, display: 'block', background: '#fff' }}
            sandbox={previewSource === 'srcdoc' ? SRCDOC_PREVIEW_SANDBOX : DIRECT_PREVIEW_SANDBOX}
            // 全屏权限归 `allow`（Permissions Policy）管，**不是** sandbox 的取值。
            // 这里原先写的 `allow-fullscreen` 不是合法 sandbox flag，Chrome 会报
            // "Error while parsing the 'sandbox' attribute: 'allow-fullscreen' is an
            // invalid sandbox flag." 并忽略它——写了两个月，deck 自带的全屏按钮一天没生效过。
            allow="fullscreen"
            allowFullScreen
          />
          {/* 既没有取回的正文、也没有入口地址 —— iframe 会停在 about:blank，
              用户看到的就是标题栏下面一片白、控制台一条错都没有，无从判断发生了什么。
              这种时候必须把「为什么是空的」说出来（no-rootless-tree / expectation-management）。 */}
          {!iframeHtml && !site.siteUrl && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 8,
              background: '#fff', color: '#475569', fontSize: 14, padding: 24, textAlign: 'center',
            }}>
              <div style={{ fontWeight: 600 }}>这个站点没有可加载的入口地址</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.7, maxWidth: 460 }}>
                它的托管地址是空的，浏览器没有东西可以打开。多半是上传中断或内容已被清理，
                请让分享者重新上传一次。
              </div>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, opacity: 0.65 }}>
                站点 ID {site.id}
              </div>
            </div>
          )}
          {/* 准备中：这一刻 iframe 是空的（还没决定走 srcDoc 还是直链，就不向托管域名
              发任何请求），所以这块不是「盖住什么」，而是这一刻屏幕上唯一的内容。
              等待有上限——DIRECT_FALLBACK_TIMEOUT_MS 到点即转直链，不会永远停在这里。
              判据抽在 shouldMaskDirectPreview，守卫见 ShareViewPage.preview.test.ts。 */}
          {shouldMaskDirectPreview({ source: previewSource }) && (
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              background: '#fff',
              color: '#475569',
              fontSize: 14,
            }}>
              {/* 静止的「加载中」超过 2 秒就是体验缺陷（CLAUDE.md §6），这一段最长可到 6 秒 */}
              <MapSpinner size={22} />
              <div>正在取回网页原文…</div>
            </div>
          )}
          {/* 幻灯片邀请条：这是一套 deck，告诉访客键盘能翻页，几秒后自己淡出不挡内容 */}
          {isDeck && <SlideKeyboardInvite yield={askState === 'bar'} />}

          {/* 取回原文失败：不遮住 iframe（页面多半仍能直接加载出来），只在角落把原因说清楚。
              静默吞掉失败正是「明明打不开、却不知道为什么」的来源。 */}
          {/* 迟到的原文没自动换上去时，给一个看得见的出口。
              直链那一帧到底画出东西没有，我们跨源读不到；访客攒了多少状态，同样看不到。
              两个判据都不可知，就不该替他猜——把手里这份能救场的原文摆出来，他自己点。
              没有这个出口时，「直链白屏 + 原文迟到」就是一片永远的白。 */}
          {lateHtml && !iframeHtml && (
            <button
              className="border border-token-subtle"
              onClick={() => { setEmbeddedHtml(lateHtml); setLateHtml(null); }}
              style={{ ...OVERLAY_CHIP, right: 12, bottom: 12, cursor: 'pointer' }}
            >
              这一页没显示出来？用原文重新加载
            </button>
          )}

          {embeddedHtmlError && !iframeHtml && previewSource !== 'pending' && (
            <div style={{ ...OVERLAY_CHIP, left: 12, bottom: 12, maxWidth: 'min(420px, calc(100% - 24px))' }}>
              {embeddedHtmlError}
            </div>
          )}
        </div>

        {/* 评论：右侧滑出抽屉（由顶栏「评论」按钮打开）。不占页面布局、不盖 PPT 控件（token 必有） */}
        {token && showComments && (
          <>
            {/* 遮罩：点击关闭 */}
            <div
              onClick={() => setShowComments(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.4)' }}
            />
            {/* 右侧抽屉 */}
            <aside
              className="border-l border-l-token-subtle" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 61, width: 'min(420px, 92vw)', display: 'flex', flexDirection: 'column', background: '#0f1014', boxShadow: '-12px 0 40px rgba(0,0,0,0.5)' }}
            >
              <div className="border-b border-b-token-subtle" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', flexShrink: 0 }}>
                <span style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>评论</span>
                <button
                  onClick={() => setShowComments(false)}
                  title="关闭"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: 'var(--nested-block-bg)', color: 'rgba(255,255,255,0.7)',
                  }}
                >
                  <X size={16} />
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 16 }}>
                <CommentsSection mode="share" token={token} password={password || undefined} onCountChange={setCommentCount} />
              </div>
            </aside>
          </>
        )}

        {/* 右下角「向我提问」。全屏演示态隐藏——PPT 放映时右下角是翻页控件的地盘。
            开场问题由后端算好（分享自选优先于站点题库），这里直接渲染。 */}
        {token && data.ask?.enabled && (
          <AskWidget
            source={{ mode: 'share', token, siteId: data.ask.siteId, password: password || undefined }}
            title={site.title || data.title || '这个页面'}
            welcome={data.ask.welcome}
            openingQuestions={data.ask.openingQuestions ?? []}
            allowAnonymous={data.ask.allowAnonymous}
            hidden={isFullscreen || showComments}
            onStateChange={setAskState}
          />
        )}
        {/*
          编辑坞的门走后端给的结论，不用 isOwner（那是「谁建了这条分享链接」）。
          下面「存一份副本」那类提示仍然用 isOwner——在那里它问的正是「这条链接是不是我建的」，
          两个判据服务的是两个问题，不能互相顶替。
        */}
        {site.viewerCanEdit && !site.wrappedAssetType && (
          <ShareSiteEditDock
            siteId={site.id}
            isMobile={isMobile}
            adjacentToAsk={Boolean(token && data.ask?.enabled)}
            hidden={isFullscreen || showComments || askState !== 'collapsed'}
            onPublished={handleOwnerSitePublished}
          />
        )}
      </div>
    );
  }

  // Collection -> list cards
  return (
    <div style={{ ...styles.fullScreen, alignItems: 'flex-start', paddingTop: 60 }}>
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}><BlackHoleVortex /></div>
      <div style={styles.overlay} />
      <div style={{ maxWidth: 720, width: '100%', padding: '20px 16px', position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Unlock size={18} color="rgba(34, 197, 94, 0.8)" />
            {/* 不再展示「{用户} 分享的」前缀，直接显示合集标题 */}
            <h1 style={{ color: '#fff', fontSize: 22, margin: 0, fontWeight: 600 }}>
              {data.title || `${data.sites.length} 个站点合集`}
            </h1>
          </div>
          {!isOwner && (
            <button
              onClick={handleSave}
              disabled={saving || saveStatus !== 'idle'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                padding: '6px 14px', borderRadius: 8, border: 'none',
                fontSize: 13, cursor: saving || saveStatus !== 'idle' ? 'default' : 'pointer',
                background: saveStatus === 'saved' ? 'rgba(34, 197, 94, 0.2)'
                  : saveStatus === 'already' ? 'rgba(234, 179, 8, 0.2)'
                  : 'rgba(59, 130, 246, 0.15)',
                color: saveStatus === 'saved' ? 'rgba(34, 197, 94, 0.9)'
                  : saveStatus === 'already' ? 'rgba(234, 179, 8, 0.9)'
                  : 'rgba(59, 130, 246, 0.9)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                transition: 'all 0.2s',
              }}
            >
              {saving ? (
                <><div style={{ ...styles.miniSpinner }} /> 保存中...</>
              ) : saveStatus === 'saved' ? (
                <><Check size={13} /> 已保存</>
              ) : saveStatus === 'already' ? (
                <><Check size={13} /> 你已经保存过了</>
              ) : !isAuthenticated ? (
                <><LogIn size={13} /> 登录并保存</>
              ) : (
                <><Download size={13} /> 保存到我的托管</>
              )}
            </button>
          )}
        </div>
        {data.description && <p style={{ color: 'rgba(255,255,255,0.5)', margin: '0 0 16px', fontSize: 14 }}>{data.description}</p>}
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, margin: '0 0 20px' }}>{data.sites.length} 个站点</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.sites.map(site => (
            <a
              key={site.id}
              href={site.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: 16,
                borderRadius: 14,
                background: 'var(--nested-block-bg)',
                border: '1px solid var(--border-subtle)',
                textDecoration: 'none',
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                transition: 'border-color 0.2s, background 0.2s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
                e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
              }}
            >
              {site.coverImageUrl ? (
                <img src={site.coverImageUrl} alt="" style={{ width: 56, height: 42, objectFit: 'cover', borderRadius: 8 }} />
              ) : (
                <div style={{ width: 56, height: 42, borderRadius: 8, background: 'var(--nested-block-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <FileCode2 size={20} color="rgba(255,255,255,0.3)" />
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#fff', fontSize: 15, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {site.title}
                </div>
                {site.description && (
                  <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {site.description}
                  </div>
                )}
                <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, marginTop: 4 }}>
                  {site.fileCount} 个文件 · {fmtSize(site.totalSize)}
                </div>
              </div>
              <ExternalLink size={14} color="rgba(255,255,255,0.3)" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  fullScreen: {
    position: 'relative',
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#000',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    overflow: 'hidden',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.6) 100%)',
    zIndex: 1,
    pointerEvents: 'none',
  },
  glassCard: {
    position: 'relative',
    zIndex: 2,
    maxWidth: 440,
    width: '90%',
    borderRadius: 20,
    // 素色材质会全局清除 backdrop-filter：底色必须自身够不透明（承载密码表单），不能靠 blur 救可读性
    background: 'rgba(14, 15, 20, 0.92)',
    backdropFilter: 'blur(40px) saturate(130%)',
    WebkitBackdropFilter: 'blur(40px) saturate(130%)',
    border: '1px solid var(--border-subtle)',
    boxShadow: '0 8px 32px -4px rgba(0, 0, 0, 0.4), 0 1px 0 0 rgba(255, 255, 255, 0.06) inset',
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid var(--border-subtle)',
    borderTop: '3px solid rgba(59, 130, 246, 0.8)',
    borderRadius: '50%',
    animation: 'share-spin 0.8s linear infinite',
    margin: '0 auto',
  },
  miniSpinner: {
    width: 12,
    height: 12,
    border: '2px solid var(--border-subtle)',
    borderTop: '2px solid currentColor',
    borderRadius: '50%',
    animation: 'share-spin 0.8s linear infinite',
  },
};

// Global styles for spinner animation
if (typeof document !== 'undefined' && !document.getElementById('share-view-styles')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'share-view-styles';
  styleEl.textContent = `@keyframes share-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(styleEl);
}
