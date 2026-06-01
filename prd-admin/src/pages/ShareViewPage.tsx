import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { viewSiteShare, saveSharedSite } from '@/services';
import type { ShareViewData } from '@/services';
import { listShareComments } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import { Lock, ExternalLink, FileCode2, Eye, EyeOff, AlertCircle, ShieldCheck, Unlock, Download, Check, LogIn, MessageSquare, X } from 'lucide-react';
import { BlackHoleVortex } from '@/components/effects/BlackHoleVortex';
import { BlurText } from '@/components/reactbits';
import CommentsSection from '@/components/web-hosting/CommentsSection';

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
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

  // 顶栏「评论 N」初始计数：单站点分享 + token 就绪后拉一次（抽屉打开后由 onCountChange 接管）
  useEffect(() => {
    if (!token || !data || data.sites.length !== 1) return;
    let alive = true;
    listShareComments(token, password || undefined)
      .then((res) => { if (alive && res.success && res.data) setCommentCount(res.data.comments.length); })
      .catch(() => {});
    return () => { alive = false; };
  }, [token, password, data]);

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
                  border: `1px solid ${wrongPassword ? 'rgba(239, 68, 68, 0.5)' : 'rgba(255,255,255,0.12)'}`,
                  background: 'rgba(255,255,255,0.06)',
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
    return (
      <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0a' }}>
        {/* Top bar */}
        <div style={{
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(17, 17, 17, 0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={14} color="rgba(34, 197, 94, 0.8)" />
            {/* 不再展示「{用户} 分享给你的」前缀，直接显示站点标题 */}
            <span style={{ color: '#fff', fontSize: 14, fontWeight: 500 }}>
              {data.title || site.title}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!isOwner && (
              <button
                onClick={handleSave}
                disabled={saving || saveStatus !== 'idle'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 10px', borderRadius: 6, border: 'none',
                  fontSize: 13, cursor: saving || saveStatus !== 'idle' ? 'default' : 'pointer',
                  background: saveStatus === 'saved' ? 'rgba(34, 197, 94, 0.2)'
                    : saveStatus === 'already' ? 'rgba(234, 179, 8, 0.2)'
                    : 'rgba(59, 130, 246, 0.15)',
                  color: saveStatus === 'saved' ? 'rgba(34, 197, 94, 0.9)'
                    : saveStatus === 'already' ? 'rgba(234, 179, 8, 0.9)'
                    : 'rgba(59, 130, 246, 0.9)',
                  transition: 'all 0.2s',
                }}
              >
                {saving ? (
                  <><div style={{ ...styles.miniSpinner }} /> 保存中...</>
                ) : saveStatus === 'saved' ? (
                  <><Check size={12} /> 已保存</>
                ) : saveStatus === 'already' ? (
                  <><Check size={12} /> 你已经保存过了</>
                ) : !isAuthenticated ? (
                  <><LogIn size={12} /> 登录并保存</>
                ) : (
                  <><Download size={12} /> 保存到我的托管</>
                )}
              </button>
            )}
            <a
              href={site.pdfAssetUrl || site.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#3b82f6', fontSize: 13, textDecoration: 'none' }}
            >
              <ExternalLink size={12} />
              新窗口打开
            </a>
            {/* 评论入口放在顶栏（MAP 自己的 chrome）：PPT/全屏页无滚动条，底部放评论区不可达；
                浮动按钮又会盖住 PPT 右下角的翻页控件。顶栏按钮零侵入页面布局，点击从右侧抽屉打开。 */}
            {token && (
              <button
                onClick={() => setShowComments(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'transparent', color: '#3b82f6', fontSize: 13, cursor: 'pointer' }}
              >
                <MessageSquare size={12} />
                评论{commentCount != null && commentCount > 0 ? ` ${commentCount}` : ''}
              </button>
            )}
          </div>
        </div>
        {/* Iframe
            PDF 包装站走直链：后端把 PDF 包装成 index.html + .pdf 的双文件结构，
            如果这里仍 iframe 到 siteUrl(index.html) + sandbox，壳子里的 <iframe src=".pdf">
            会被 Chrome 屏蔽 PDF Viewer。直接指向 PDF URL、不加 sandbox，让浏览器原生 PDF Viewer 接管。 */}
        <iframe
          src={site.pdfAssetUrl || site.siteUrl}
          title={site.title}
          style={{ flex: 1, border: 'none', width: '100%' }}
          sandbox={site.pdfAssetUrl ? undefined : 'allow-scripts allow-same-origin allow-popups allow-forms'}
        />

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
              style={{
                position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 61,
                width: 'min(420px, 92vw)', display: 'flex', flexDirection: 'column',
                background: '#0f1014', borderLeft: '1px solid rgba(255,255,255,0.1)',
                boxShadow: '-12px 0 40px rgba(0,0,0,0.5)',
              }}
            >
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
              }}>
                <span style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>评论</span>
                <button
                  onClick={() => setShowComments(false)}
                  title="关闭"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)',
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
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
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
                <div style={{ width: 56, height: 42, borderRadius: 8, background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
    background: 'rgba(0, 0, 0, 0.55)',
    backdropFilter: 'blur(40px) saturate(130%)',
    WebkitBackdropFilter: 'blur(40px) saturate(130%)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 8px 32px -4px rgba(0, 0, 0, 0.4), 0 1px 0 0 rgba(255, 255, 255, 0.06) inset',
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid rgba(255,255,255,0.1)',
    borderTop: '3px solid rgba(59, 130, 246, 0.8)',
    borderRadius: '50%',
    animation: 'share-spin 0.8s linear infinite',
    margin: '0 auto',
  },
  miniSpinner: {
    width: 12,
    height: 12,
    border: '2px solid rgba(255,255,255,0.1)',
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
