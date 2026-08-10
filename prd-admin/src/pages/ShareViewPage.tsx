import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { viewSiteShare, saveSharedSite } from '@/services';
import type { ShareViewData } from '@/services';
import { listShareComments, getShareSiteContent } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import { Lock, ExternalLink, FileCode2, Eye, EyeOff, AlertCircle, ShieldCheck, Unlock, Download, Check, LogIn, MessageSquare, X, Maximize, Minimize } from 'lucide-react';
import { BlackHoleVortex } from '@/components/effects/BlackHoleVortex';
import { BlurText } from '@/components/reactbits';
import CommentsSection from '@/components/web-hosting/CommentsSection';
import AskWidget from '@/components/web-hosting/ask/AskWidget';
import { useIsMobile } from '@/hooks/useBreakpoint';

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtmlAttr(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isHtmlEntry(siteUrl: string, entryFile?: string) {
  const target = entryFile || siteUrl.split('?')[0].split('#')[0];
  return /\.html?$/i.test(target);
}

/**
 * 这份 HTML 能不能安全地走 srcDoc 预览。
 *
 * srcDoc 路径刻意不给 allow-same-origin（否则用户上传的任意 HTML 就拿到 MAP 同源能力），
 * 代价是文档处于**不透明源**。经典 `<script src>` 跨域不需要 CORS，照常能加载；
 * 但 `<script type="module">` 是按 CORS 模式取的——而托管域名不返回
 * Access-Control-Allow-Origin（正是本文件到处在说的那件事），模块脚本会被浏览器拦掉。
 *
 * 后果很具体：Vite/webpack 打包出来的 SPA 入口恰恰是 `<script type="module" src="...">`，
 * 走 srcDoc 会白屏。这类站点必须留在直链 iframe 上——直链是同源加载，模块脚本没问题。
 *
 * 所以判据是「有没有外链的模块脚本」，而不是「是不是 HTML」。
 * 内联的 `<script type="module">`（没有 src）不受影响，不必排除。
 */
export function canUseSrcDocPreview(html: string): boolean {
  if (!html) return false;
  // 匹配带 src 且 type=module 的 script 标签，属性顺序两种都要认
  const moduleWithSrc =
    /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=/i.test(html) ||
    /<script\b[^>]*\bsrc\s*=[^>]*\btype\s*=\s*["']module["']/i.test(html);
  return !moduleWithSrc;
}

function withPreviewBase(html: string, siteUrl: string) {
  if (/<base\b/i.test(html)) return html;
  const baseHref = new URL('.', siteUrl).toString();
  const baseTag = `<base href="${escapeHtmlAttr(baseHref)}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, `<head$1>${baseTag}`);
  }
  return `${baseTag}${html}`;
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
  /** 取回原文失败的原因；非空时仍回退直链 iframe，但角标把原因显式说出来（不静默吞） */
  const [embeddedHtmlError, setEmbeddedHtmlError] = useState<string | null>(null);

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
    const res = await viewSiteShare(token, pwd?.trim());
    setLoading(false);
    if (res.success) {
      setData(res.data);
      setNeedPassword(false);
    } else if (res.error?.code === 'UNAUTHORIZED') {
      setNeedPassword(true);
      // 如果是带密码重试的，说明密码错误
      if (pwd !== undefined) {
        setWrongPassword(true);
        setShakeKey(k => k + 1);
        // 选中输入框内容方便重新输入
        setTimeout(() => inputRef.current?.select(), 100);
      }
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
    if (!site || !token || site.pdfAssetUrl || !isHtmlEntry(site.siteUrl, site.entryFile)) {
      setEmbeddedHtml(null);
      setEmbeddedHtmlError(null);
      setEmbeddedHtmlLoading(false);
      return;
    }

    let alive = true;
    setEmbeddedHtml(null);
    setEmbeddedHtmlError(null);
    setEmbeddedHtmlLoading(true);
    getShareSiteContent(token, site.id, password || undefined)
      .then((res) => {
        if (!alive) return;
        if (res.success && res.data?.html) {
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

    return () => { alive = false; };
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
    const isNotFound = error.code === 'NOT_FOUND';
    const isExpired = error.code === 'EXPIRED';
    const isVisibilityDenied = error.code === 'visibility_denied' || error.code === 'VISIBILITY_DENIED';
    const titleText = isNotFound
      ? '链接不存在'
      : isExpired
        ? '链接已过期'
        : isVisibilityDenied
          ? '需要权限访问'
          : '出错了';
    const detailText = isNotFound
      ? '该分享链接不存在或已被撤销'
      : isExpired
        ? '该分享链接已超过有效期，请联系分享者重新创建或续期'
        : isVisibilityDenied
          ? (error.message || '此链接仅限创建者或团队成员访问')
          : error.message;
    const currentPath = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
    return (
      <div style={styles.fullScreen}>
        <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}><BlackHoleVortex /></div>
        <div style={styles.overlay} />
        <div style={{ ...styles.glassCard, textAlign: 'center', padding: '40px 32px' }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: isVisibilityDenied ? 'rgba(96, 165, 250, 0.15)' : 'rgba(239, 68, 68, 0.15)',
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
          <p style={{ color: 'rgba(255,255,255,0.5)', margin: 0, fontSize: 14, lineHeight: 1.6 }}>
            {detailText}
          </p>
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
            sandbox={iframeHtml
              ? 'allow-scripts allow-popups allow-forms allow-fullscreen'
              : 'allow-scripts allow-same-origin allow-popups allow-forms allow-fullscreen'}
            allowFullScreen
          />
          {embeddedHtmlLoading && !iframeHtml && (
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
