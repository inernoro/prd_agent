import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  FileText,
  Lock,
  LogIn,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { viewTeamWeekShare, type TeamWeekShareViewData } from '@/services';

/**
 * 团队周报分享链接公开查看页（仍需登录）
 *
 * 访问规则：
 * - 必须登录；未登录时提示并提供登录跳转
 * - 团队成员免密码直接查看
 * - 非团队成员需要输入密码（由后端校验）
 * - 链接过期 / 撤销 / 不存在分别显示对应提示
 */
export default function ReportTeamShareViewPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [data, setData] = useState<TeamWeekShareViewData | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [needPassword, setNeedPassword] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [wrongPassword, setWrongPassword] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchShare = async (pwd?: string) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    setWrongPassword(false);
    const res = await viewTeamWeekShare(token, pwd?.trim());
    setLoading(false);
    if (res.success) {
      setData(res.data);
      setNeedPassword(false);
      setNeedLogin(false);
      return;
    }
    const code = res.error?.code;
    if (code === 'UNAUTHORIZED') {
      if (!isAuthenticated) {
        setNeedLogin(true);
      } else {
        setNeedPassword(true);
        if (pwd !== undefined) {
          setWrongPassword(true);
          setTimeout(() => inputRef.current?.select(), 100);
        }
      }
    } else {
      setError(res.error || { code: 'UNKNOWN', message: '加载失败' });
    }
  };

  useEffect(() => {
    void fetchShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAuthenticated]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setSubmitting(true);
    await fetchShare(password);
    setSubmitting(false);
  };

  const goLogin = () => {
    const currentPath = window.location.pathname + window.location.search;
    navigate(`/login?redirect=${encodeURIComponent(currentPath)}`);
  };

  if (loading) {
    return <div style={{ ...pageStyles.fullScreen, background: '#0a0a0a' }} />;
  }

  // ── Error: Not Found / Expired ──
  if (error) {
    const isNotFound = error.code === 'NOT_FOUND';
    const isExpired = error.code === 'EXPIRED';
    return (
      <div style={pageStyles.fullScreen}>
        <div style={pageStyles.glassCard}>
          <div style={iconCircleStyle(isExpired ? 'rgba(234, 179, 8, 0.15)' : 'rgba(239, 68, 68, 0.15)')}>
            <AlertCircle size={32} color={isExpired ? 'rgba(234, 179, 8, 0.9)' : 'rgba(239, 68, 68, 0.9)'} />
          </div>
          <h2 style={pageStyles.cardTitle}>
            {isNotFound ? '链接不存在' : isExpired ? '链接已过期' : '出错了'}
          </h2>
          <p style={pageStyles.cardDesc}>
            {isNotFound
              ? '该分享链接不存在或已被撤销'
              : isExpired
                ? '该分享链接已超过有效期，请联系分享者重新生成'
                : error.message}
          </p>
        </div>
      </div>
    );
  }

  // ── Need Login ──
  if (needLogin) {
    return (
      <div style={pageStyles.fullScreen}>
        <div style={pageStyles.glassCard}>
          <div style={iconCircleStyle('rgba(59, 130, 246, 0.15)')}>
            <LogIn size={32} color="rgba(59, 130, 246, 0.9)" />
          </div>
          <h2 style={pageStyles.cardTitle}>请登录后查看</h2>
          <p style={pageStyles.cardDesc}>此团队周报分享链接需要登录本系统后才能访问。</p>
          <button type="button" onClick={goLogin} style={pageStyles.primaryBtn}>
            前往登录
          </button>
        </div>
      </div>
    );
  }

  // ── Need Password ──
  if (needPassword) {
    return (
      <div style={pageStyles.fullScreen}>
        <div
          style={{
            ...pageStyles.glassCard,
            animation: wrongPassword ? 'share-shake 0.5s ease-in-out' : undefined,
          }}
          key={wrongPassword ? 'shake' : 'still'}
        >
          <div
            style={iconCircleStyle(
              wrongPassword ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)'
            )}
          >
            {wrongPassword ? (
              <AlertCircle size={32} color="rgba(239, 68, 68, 0.9)" />
            ) : (
              <Lock size={32} color="rgba(59, 130, 246, 0.9)" />
            )}
          </div>
          <h2 style={pageStyles.cardTitle}>{wrongPassword ? '密码不正确' : '此链接需要密码'}</h2>
          <p
            style={{
              ...pageStyles.cardDesc,
              color: wrongPassword ? 'rgba(239, 68, 68, 0.7)' : 'rgba(255,255,255,0.5)',
            }}
          >
            {wrongPassword
              ? '请检查密码后重新输入。如不清楚密码，请联系分享者。'
              : '你不是该团队成员，请输入分享者提供的访问密码。'}
          </p>
          <form onSubmit={handlePasswordSubmit} style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <div style={{ position: 'relative' }}>
              <input
                ref={inputRef}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setWrongPassword(false);
                }}
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
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  color: 'rgba(255,255,255,0.4)',
                  display: 'flex',
                  alignItems: 'center',
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
              }}
            >
              {submitting ? '验证中...' : '确认'}
            </button>
          </form>
        </div>
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

  if (!data) return null;

  // ── Success: render team-week aggregate view ──
  return (
    <div style={pageStyles.successRoot}>
      <div style={pageStyles.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" onClick={() => navigate('/')} style={pageStyles.backBtn}>
            <ArrowLeft size={14} />
          </button>
          <ShieldCheck size={14} color="rgba(34, 197, 94, 0.8)" />
          {data.shareInfo.createdByName && (
            <span style={{ color: 'rgba(34, 197, 94, 0.9)', fontSize: 13, fontWeight: 600 }}>
              {data.shareInfo.createdByName}
            </span>
          )}
          <span style={{ color: '#fff', fontSize: 14, fontWeight: 500 }}>
            分享「{data.team.name}」{data.weekYear} 年第 {data.weekNumber} 周周报
          </span>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>
          {data.shareInfo.expiresAt
            ? `有效期至 ${new Date(data.shareInfo.expiresAt).toLocaleDateString()}`
            : '永不过期'}
        </div>
      </div>

      <div style={pageStyles.scrollBody}>
        <div style={pageStyles.container}>
          {/* Stats */}
          <div style={pageStyles.statsRow}>
            <div style={pageStyles.statCard}>
              <Users size={14} color="rgba(255,255,255,0.5)" />
              <span style={pageStyles.statLabel}>团队人数</span>
              <span style={pageStyles.statValue}>{data.stats.totalMembers}</span>
            </div>
            <div style={pageStyles.statCard}>
              <CheckCircle2 size={14} color="rgba(34,197,94,0.8)" />
              <span style={pageStyles.statLabel}>已提交</span>
              <span style={{ ...pageStyles.statValue, color: 'rgba(34,197,94,0.95)' }}>{data.stats.submittedCount}</span>
            </div>
            <div style={pageStyles.statCard}>
              <Clock size={14} color="rgba(249,115,22,0.8)" />
              <span style={pageStyles.statLabel}>待提交</span>
              <span style={{ ...pageStyles.statValue, color: 'rgba(249,115,22,0.95)' }}>{data.stats.pendingCount}</span>
            </div>
          </div>

          {/* AI Summary */}
          {data.summary && data.summary.sections && data.summary.sections.length > 0 && (
            <div style={pageStyles.section}>
              <div style={pageStyles.sectionHeader}>
                <Sparkles size={16} color="rgba(168,85,247,0.9)" />
                <span style={pageStyles.sectionTitle}>团队 AI 汇总</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {data.summary.sections.map((section, idx) => (
                  <div key={idx} style={pageStyles.summaryCard}>
                    <div style={pageStyles.summaryCardTitle}>{section.title}</div>
                    {section.items.length === 0 ? (
                      <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>（无内容）</div>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 18, color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 1.7 }}>
                        {section.items.map((item, itemIdx) => (
                          <li key={itemIdx}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Member Reports */}
          <div style={pageStyles.section}>
            <div style={pageStyles.sectionHeader}>
              <FileText size={16} color="rgba(59,130,246,0.9)" />
              <span style={pageStyles.sectionTitle}>成员周报 ({data.items.length})</span>
            </div>
            {data.items.length === 0 ? (
              <div style={pageStyles.emptyHint}>本周暂无已提交周报</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {data.items.map((item) => (
                  <div key={item.reportId} style={pageStyles.reportCard}>
                    <div style={pageStyles.reportCardHeader}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>
                        {item.userName || item.userId}
                      </div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                        {item.submittedAt ? `提交于 ${new Date(item.submittedAt).toLocaleString()}` : ''}
                      </div>
                    </div>
                    {item.sections.map((sec, sIdx) => (
                      <div key={sIdx} style={pageStyles.reportSection}>
                        {sec.title && <div style={pageStyles.reportSectionTitle}>{sec.title}</div>}
                        {sec.items.length === 0 ? (
                          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>（无内容）</div>
                        ) : (
                          <ul style={{ margin: 0, paddingLeft: 18, color: 'rgba(255,255,255,0.82)', fontSize: 13, lineHeight: 1.65 }}>
                            {sec.items.map((it, itIdx) => (
                              <li key={itIdx}>{it.content}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function iconCircleStyle(bg: string): React.CSSProperties {
  return {
    width: 64,
    height: 64,
    borderRadius: '50%',
    background: bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 20px',
  };
}

const pageStyles: Record<string, React.CSSProperties> = {
  fullScreen: {
    position: 'relative',
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a0a',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    overflow: 'hidden',
    padding: 24,
  },
  glassCard: {
    position: 'relative',
    maxWidth: 440,
    width: '92%',
    borderRadius: 20,
    padding: '40px 32px',
    background: 'rgba(17, 17, 17, 0.85)',
    backdropFilter: 'blur(40px) saturate(130%)',
    WebkitBackdropFilter: 'blur(40px) saturate(130%)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 8px 32px -4px rgba(0, 0, 0, 0.4)',
    textAlign: 'center',
  },
  cardTitle: {
    color: '#fff',
    margin: '0 0 8px',
    fontSize: 20,
    fontWeight: 600,
  },
  cardDesc: {
    color: 'rgba(255,255,255,0.55)',
    margin: '0 0 24px',
    fontSize: 14,
    lineHeight: 1.6,
  },
  primaryBtn: {
    padding: '10px 24px',
    borderRadius: 10,
    border: 'none',
    background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.8), rgba(99, 102, 241, 0.8))',
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  successRoot: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#0a0a0a',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#fff',
  },
  topBar: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 20px',
    background: 'rgba(17, 17, 17, 0.85)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  backBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 8,
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.7)',
    cursor: 'pointer',
  },
  scrollBody: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
  },
  container: {
    maxWidth: 960,
    margin: '0 auto',
    padding: '20px 20px 60px',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  statsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    flex: '1 1 140px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.06)',
  },
  statLabel: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
  },
  statValue: {
    marginLeft: 'auto',
    fontSize: 18,
    fontWeight: 600,
    color: '#fff',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 15,
    fontWeight: 600,
  },
  sectionTitle: {
    color: '#fff',
  },
  emptyHint: {
    padding: '24px 20px',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    textAlign: 'center',
  },
  summaryCard: {
    padding: '14px 16px',
    borderRadius: 12,
    background: 'rgba(168,85,247,0.06)',
    border: '1px solid rgba(168,85,247,0.16)',
  },
  summaryCardTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#fff',
    marginBottom: 8,
  },
  reportCard: {
    padding: '16px 18px',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.06)',
  },
  reportCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  reportSection: {
    marginTop: 10,
  },
  reportSectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.6)',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
};
