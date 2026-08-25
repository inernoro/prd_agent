import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { viewSiteShare, saveSharedSite } from '@/services';
import type { ShareViewData } from '@/services';
import { listShareComments, getShareSiteContent } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import { Lock, ExternalLink, FileCode2, Eye, EyeOff, AlertCircle, ShieldCheck, Unlock, Download, Check, LogIn, MessageSquare, X, Maximize, Minimize } from 'lucide-react';
import { BlackHoleVortex } from '@/components/effects/BlackHoleVortex';
import { BlurText } from '@/components/reactbits';
import { SHARE_FAILURE_REGISTRY, resolveShareFailure } from '@/components/web-hosting/shareFailure';
import { detectSlideDeck } from '@/components/web-hosting/slideDeck';
import CommentsSection from '@/components/web-hosting/CommentsSection';
import AskWidget from '@/components/web-hosting/ask/AskWidget';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  DIRECT_PREVIEW_SANDBOX,
  SRCDOC_PREVIEW_SANDBOX,
  canUseSrcDocPreview,
  hasFetchableHtml,
  withPreviewBase,
} from '@/components/web-hosting/previewHtml';

/**
 * 幻灯片邀请条：告诉访客这一页能用键盘翻。
 *
 * 为什么要有：deck 的翻页控件通常是右下角两个很淡的箭头，很多人从头到尾用鼠标点，
 * 甚至以为这就是一张长图。一句「方向键翻页」省掉这整段试错。
 *
 * 为什么会自己消失：它是邀请不是控件，说完就该让开——内容才是主角
 * （content-fills-canvas：产物占主导，chrome 压到最少）。
 */
function SlideKeyboardInvite() {
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
        opacity: gone ? 0 : 1,
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
 * 取回原文期间，那层「正在准备预览...」的白色遮罩最多盖多久。
 *
 * 遮罩本身是为了避免「先闪一下直链 iframe、再跳成 srcDoc」的跳变，但它是**不透明全屏**的：
 * 底下的直链 iframe 其实一直在加载，代理慢或不可达时，一个本来能正常显示的页面会被白屏
 * 盖住整个 HTTP 超时。这正是本 PR 要修的那个毛病（超时不等于坏了，别拿遮罩盖住已经画出来
 * 的页面）——在自己新加的遮罩上重犯一次就说不过去了。所以给它一个短窗口，到点必让位。
 */
export const PREVIEW_MASK_TIMEOUT_MS = 1500;

/**
 * 该不该用遮罩盖住直链 iframe。抽成纯函数是为了能被测到「加载永远不结束时遮罩必须让位」。
 *
 * 三个条件缺一不可：确实在取原文、还没拿到可用的 srcDoc、短窗口没到点。
 */
export function shouldMaskDirectPreview(opts: {
  loading: boolean;
  hasSrcDoc: boolean;
  maskExpired: boolean;
}): boolean {
  return opts.loading && !opts.hasSrcDoc && !opts.maskExpired;
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
  // 评论抽屉：由顶栏「评论 N」按钮打开（PPT/全屏页无滚动条，评论不能放底部）
  const [showComments, setShowComments] = useState(false);
  // 顶栏按钮上展示的评论数。初始拉一次，抽屉打开后由 CommentsSection 的 onCountChange 接管实时同步
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [embeddedHtml, setEmbeddedHtml] = useState<{ siteUrl: string; html: string } | null>(null);
  const [embeddedHtmlLoading, setEmbeddedHtmlLoading] = useState(false);
  /** 遮罩的短窗口是否已到点。到点后不再遮挡底下的直链 iframe，见 PREVIEW_MASK_TIMEOUT_MS */
  const [previewMaskExpired, setPreviewMaskExpired] = useState(false);
  /** 直链 iframe 是否**真的加载出了内容**（有真实 src 且 load 事件到过）。
   *  丢弃迟到 srcDoc 的前提是「用户已经在用底下那一页」——如果底下那页压根没加载
   *  （站点没有入口地址、或直链本身就白屏），丢掉迟到的 srcDoc 等于让用户一直盯着空白。 */
  const directLoadedRef = useRef(false);
  /** 直链 iframe 是否已经露给用户看过（遮罩到点即为真）。异步回调读它，不读 state */
  const exposedDirectRef = useRef(false);
  /** 取回原文失败的原因；非空时仍回退直链 iframe，但角标把原因显式说出来（不静默吞） */
  const [embeddedHtmlError, setEmbeddedHtmlError] = useState<string | null>(null);
  /**
   * 这份托管内容是不是一套幻灯片（决定要不要出键盘邀请条）。
   * 取回原文时立刻判、单独存：它不能跟着 embeddedHtml 走，那个值在遮罩让位后会被丢弃。
   */
  const [isDeck, setIsDeck] = useState(false);

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

  // 全屏演示：对单站点视图容器 requestFullscreen，全屏时隐藏 MAP 顶栏（Esc / 系统手势退出由
  // fullscreenchange 同步回 state）。iframe 另加 allowFullScreen，让 deck 自带的全屏按钮也能用。
  const singleViewRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const togglePresentFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      singleViewRef.current?.requestFullscreen?.().catch(() => {});
    }
  }, []);

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
      setEmbeddedHtml(null);
      setEmbeddedHtmlError(null);
      setEmbeddedHtmlLoading(false);
      setPreviewMaskExpired(false);
      return;
    }

    let alive = true;
    setEmbeddedHtml(null);
    setIsDeck(false);
    setEmbeddedHtmlError(null);
    setEmbeddedHtmlLoading(true);
    // 遮罩只挡一小会儿。到点后即便原文还没回来，也把底下的直链 iframe 露出来——
    // 它多半已经把页面画好了，继续盖着就是拿「可能更好的预览」换「确定看不见」。
    setPreviewMaskExpired(false);
    // 同一个「到点了」要被两处读：渲染读 state，异步回调读 ref。
    // 回调闭包里的 state 是发起那一刻的旧值，永远看不到超时后的 true。
    exposedDirectRef.current = false;
    directLoadedRef.current = false;
    const maskTimer = window.setTimeout(() => {
      if (!alive) return;
      exposedDirectRef.current = true;
      setPreviewMaskExpired(true);
    }, PREVIEW_MASK_TIMEOUT_MS);
    getShareSiteContent(token, site.id, password || undefined)
      .then((res) => {
        if (!alive) return;
        if (res.success && res.data?.html) {
          // 「是不是幻灯片」必须在这里就判掉，不能等 embeddedHtml。
          // 下面那条早退（遮罩已让位就丢弃原文）会让 embeddedHtml 永远是 null，
          // 于是 deck 邀请条在「原文回得比 1.5s 慢」的每一次都静默消失——
          // 判据挂在一个会被丢弃的中间产物上，正是形状 2（链路只建到一半）。
          setIsDeck(detectSlideDeck(res.data.html));
          // 遮罩已经让位 = 直链 iframe 已经在用户眼前跑起来了。此时再换成 srcDoc，
          // 对浏览器就是换一个文档：滚动位置、表单里敲的字、PPT 翻到第几页全部清零。
          // 代理最慢可以拖到 20s 才回来，那时候用户早就在用这个页面了——
          // 「可能更好的预览」不值一次当面重载，迟到就直接丢弃。
          // 两个条件都成立才丢：遮罩已让位**且**直链真的加载出了东西。
          // 只判前者会在「直链本来就白屏」时把唯一能救场的 srcDoc 也丢掉。
          if (exposedDirectRef.current && directLoadedRef.current) return;
          setEmbeddedHtml({ siteUrl: site.siteUrl, html: withPreviewBase(res.data.html, site.siteUrl) });
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
        if (alive) setEmbeddedHtmlLoading(false);
      });

    return () => { alive = false; window.clearTimeout(maskTimer); };
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
    // 认不出的码才把后端原文露出来——认得出的那几档，我们自己的话说得更清楚
    const serverDetail = failure === 'unknown' ? error.message : null;
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
    return (
      <div
        ref={singleViewRef}
        style={{
          width: '100vw',
          height: '100vh',
          minHeight: 0,
          display: 'grid',
          gridTemplateRows: isFullscreen ? 'minmax(0, 1fr)' : 'auto minmax(0, 1fr)',
          background: '#0a0a0a',
          overflow: 'hidden',
        }}
      >
        {/* Top bar —— 全屏演示时隐藏，让 PPT 占满整屏 */}
        <div className="border-b border-b-token-subtle" style={{ padding: isMobile ? '6px 10px' : '8px 16px', display: isFullscreen ? 'none' : 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'rgba(17, 17, 17, 0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', flexShrink: 0 }}>
          {/* 标题区必须可收缩（minWidth:0 + 省略号），否则手机端它会把右侧按钮挤扁 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            <ShieldCheck size={14} color="rgba(34, 197, 94, 0.8)" style={{ flexShrink: 0 }} />
            {/* 不再展示「{用户} 分享给你的」前缀，直接显示站点标题 */}
            <span style={{ color: '#fff', fontSize: isMobile ? 13 : 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {data.title || site.title}
            </span>
          </div>
          {/* 手机端四个按钮并排会互相挤压（mobile-first-density：进内容前 ≤1 条控制条）。
              这里不换行、不堆叠，改为「仅图标 + title 提示」，桌面端维持带文字的原样。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 2 : 12, flexShrink: 0 }}>
            {!site.pdfAssetUrl && (
              <button
                onClick={togglePresentFullscreen}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: isMobile ? '6px 8px' : '4px 10px', borderRadius: 6, border: 'none', background: isMobile ? 'transparent' : 'var(--nested-block-bg)', color: 'rgba(255,255,255,0.85)', fontSize: 13, cursor: 'pointer' }}
                title="全屏演示（Esc 退出）"
                aria-label="全屏演示"
              >
                {isFullscreen ? <Minimize size={isMobile ? 15 : 12} /> : <Maximize size={isMobile ? 15 : 12} />}
                {!isMobile && '全屏演示'}
              </button>
            )}
            {!isOwner && (
              <button
                onClick={handleSave}
                disabled={saving || saveStatus !== 'idle'}
                title={saveStatus === 'saved' ? '已保存' : saveStatus === 'already' ? '你已经保存过了' : !isAuthenticated ? '登录并保存' : '保存到我的托管'}
                aria-label="保存到我的托管"
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: isMobile ? '6px 8px' : '4px 10px', borderRadius: 6, border: 'none',
                  fontSize: 13, cursor: saving || saveStatus !== 'idle' ? 'default' : 'pointer',
                  background: isMobile ? 'transparent'
                    : saveStatus === 'saved' ? 'rgba(34, 197, 94, 0.2)'
                    : saveStatus === 'already' ? 'rgba(234, 179, 8, 0.2)'
                    : 'rgba(59, 130, 246, 0.15)',
                  color: saveStatus === 'saved' ? 'rgba(34, 197, 94, 0.9)'
                    : saveStatus === 'already' ? 'rgba(234, 179, 8, 0.9)'
                    : 'rgba(59, 130, 246, 0.9)',
                  transition: 'all 0.2s',
                }}
              >
                {saving ? (
                  <><div style={{ ...styles.miniSpinner }} /> {!isMobile && '保存中...'}</>
                ) : saveStatus === 'saved' ? (
                  <><Check size={isMobile ? 15 : 12} /> {!isMobile && '已保存'}</>
                ) : saveStatus === 'already' ? (
                  <><Check size={isMobile ? 15 : 12} /> {!isMobile && '你已经保存过了'}</>
                ) : !isAuthenticated ? (
                  <><LogIn size={isMobile ? 15 : 12} /> {!isMobile && '登录并保存'}</>
                ) : (
                  <><Download size={isMobile ? 15 : 12} /> {!isMobile && '保存到我的托管'}</>
                )}
              </button>
            )}
            <a
              href={site.pdfAssetUrl || site.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="新窗口打开"
              aria-label="新窗口打开"
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: isMobile ? '6px 8px' : 0, color: '#3b82f6', fontSize: 13, textDecoration: 'none' }}
            >
              <ExternalLink size={isMobile ? 15 : 12} />
              {!isMobile && '新窗口打开'}
            </a>
            {/* 评论入口放在顶栏（MAP 自己的 chrome）：PPT/全屏页无滚动条，底部放评论区不可达；
                浮动按钮又会盖住 PPT 右下角的翻页控件。顶栏按钮零侵入页面布局，点击从右侧抽屉打开。 */}
            {token && (
              <button
                onClick={() => setShowComments(true)}
                title="评论"
                aria-label="评论"
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: isMobile ? '6px 8px' : 0, border: 'none', background: 'transparent', color: '#3b82f6', fontSize: 13, cursor: 'pointer' }}
              >
                <MessageSquare size={isMobile ? 15 : 12} />
                {isMobile
                  ? (commentCount != null && commentCount > 0 ? commentCount : '')
                  : `评论${commentCount != null && commentCount > 0 ? ` ${commentCount}` : ''}`}
              </button>
            )}
          </div>
        </div>
        <div style={{ position: 'relative', minHeight: 0, background: '#fff' }}>
          {/* Iframe
              普通 HTML 托管页优先走 srcDoc：COS 直链在 Chrome iframe 中可能只绘制空白，
              但同一 HTML 下载后可正常打开。srcDoc 注入 base 后保留相对资源路径，同时不加
              allow-same-origin，避免用户上传 HTML 获得 MAP 同源能力。
              PDF 壳子仍保留 siteUrl 路径：它需要以 COS 文档源加载同目录 PDF。 */}
          <iframe
            src={iframeHtml ? undefined : site.siteUrl}
            srcDoc={iframeHtml || undefined}
            title={site.title}
            style={{ border: 'none', width: '100%', height: '100%', minHeight: 0, display: 'block', background: '#fff' }}
            sandbox={iframeHtml ? SRCDOC_PREVIEW_SANDBOX : DIRECT_PREVIEW_SANDBOX}
            // 全屏权限归 `allow`（Permissions Policy）管，**不是** sandbox 的取值。
            // 这里原先写的 `allow-fullscreen` 不是合法 sandbox flag，Chrome 会报
            // "Error while parsing the 'sandbox' attribute: 'allow-fullscreen' is an
            // invalid sandbox flag." 并忽略它——写了两个月，deck 自带的全屏按钮一天没生效过。
            allow="fullscreen"
            allowFullScreen
            onLoad={() => {
              // 只有「直链 + 有真实地址」这一种组合才算「用户已经在看底下那一页」。
              // srcDoc 分支与 about:blank（没有入口地址时的空 iframe）都不记账。
              if (!iframeHtml && site.siteUrl) directLoadedRef.current = true;
            }}
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
          {/* 遮罩是为了避免「先闪直链、再跳 srcDoc」的跳变，但它不透明且全屏：代理慢或不可达时
              会把底下那个其实已经渲染好的直链页面白屏盖住整个 HTTP 超时。所以只挡一小会儿，
              到点让位——判据抽在 shouldMaskDirectPreview，守卫见 ShareViewPage.preview.test.ts。 */}
          {shouldMaskDirectPreview({
            loading: embeddedHtmlLoading,
            hasSrcDoc: !!iframeHtml,
            maskExpired: previewMaskExpired,
          }) && (
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#fff',
              color: '#475569',
              fontSize: 14,
            }}>
              正在准备预览...
            </div>
          )}
          {/* 幻灯片邀请条：这是一套 deck，告诉访客键盘能翻页，几秒后自己淡出不挡内容 */}
          {isDeck && <SlideKeyboardInvite />}

          {/* 取回原文失败：不遮住 iframe（页面多半仍能直接加载出来），只在角落把原因说清楚。
              静默吞掉失败正是「明明打不开、却不知道为什么」的来源。 */}
          {embeddedHtmlError && !iframeHtml && !embeddedHtmlLoading && (
            <div style={{
              position: 'absolute',
              left: 12,
              bottom: 12,
              maxWidth: 'min(420px, calc(100% - 24px))',
              padding: '6px 10px',
              borderRadius: 8,
              background: 'rgba(17,17,17,0.82)',
              color: 'rgba(255,255,255,0.86)',
              fontSize: 12,
              lineHeight: 1.5,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}>
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
