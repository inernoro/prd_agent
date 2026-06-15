import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Info,
} from 'lucide-react';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/lib/toast';

interface InstallData {
  name: string;
  icon: string;
  color: string;
  token: string;
  downloadUrl?: string;
  canDownloadSigned?: boolean;
  iCloudUrl?: string;
  serverUrl: string;
}

// ─── 可操作的错误视图：每种失败都有「为什么 + 下一步怎么办」，不留死胡同 ───
interface InstallError {
  title: string;
  hint: string;
  canRetry: boolean;
}

const ERROR_VIEWS = {
  invalidLink: {
    title: '链接不完整',
    hint: '这个安装链接缺少必要信息。请重新扫一次分享者发给你的二维码，或让对方再发一次完整链接。',
    canRetry: false,
  },
  expired: {
    title: '授权已过期',
    hint: '这个快捷指令的授权到期了。请让分享者在「快捷指令」页面点一下「延长 3 年」，再把新的二维码发给你。',
    canRetry: true,
  },
  invalidToken: {
    title: '链接已失效',
    hint: '密钥不匹配，通常是分享者重新生成过快捷指令。请向对方要一张新的二维码。',
    canRetry: false,
  },
  notFound: {
    title: '快捷指令不存在',
    hint: '这个快捷指令可能已被分享者删除。请向对方确认，或让其重新创建后再发你。',
    canRetry: false,
  },
  network: {
    title: '网络不稳定',
    hint: '没能连上服务器。请检查手机网络后点下方「重试」。',
    canRetry: true,
  },
} satisfies Record<string, InstallError>;

function resolveInstallError(code?: string): InstallError {
  switch (code) {
    case 'EXPIRED':
      return ERROR_VIEWS.expired;
    case 'TOKEN_MISMATCH':
    case 'INVALID_TOKEN':
      return ERROR_VIEWS.invalidToken;
    case 'NOT_FOUND':
      return ERROR_VIEWS.notFound;
    default:
      return ERROR_VIEWS.network;
  }
}

/**
 * 公开安装引导页 — iPhone 扫码后打开此页面
 * 路由: /s/shortcut/:id?t=scs-xxx
 *
 * 安装优先级:
 * - 签名 .shortcut 下载: token 已内置，扫码后直接安装
 * - iCloud 模板: 复制配置后安装模板
 * - 手动配置: 最后兜底
 */
export default function ShortcutInstallPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t') || '';

  const [data, setData] = useState<InstallData | null>(null);
  const [error, setError] = useState<InstallError | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0); // 0=初始, 1=已复制配置, 2=已打开App

  const loadData = useCallback(async () => {
    if (!id || !token) {
      setError(ERROR_VIEWS.invalidLink);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/shortcuts/${id}/install-data?t=${encodeURIComponent(token)}`);
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      } else {
        // ApiResponse 的错误码在 error.code，不是顶层 message
        setError(resolveInstallError(json?.error?.code));
      }
    } catch {
      setError(ERROR_VIEWS.network);
    } finally {
      setLoading(false);
    }
  }, [id, token]);

  useEffect(() => { loadData(); }, [loadData]);

  // 复制配置 JSON 到剪贴板，返回是否成功
  const copyConfig = async (): Promise<boolean> => {
    if (!data) return false;
    const config = JSON.stringify({
      token,
      endpoint: `${data.serverUrl}/api/shortcuts/collect`,
      name: data.name,
    });
    const ok = await copyToClipboard(config);
    if (ok) {
      setStep(1);
      toast.success('配置已复制到剪贴板');
    } else {
      toast.error('复制失败', '当前环境不支持自动复制，请长按下方 Token / 接口地址手动复制');
    }
    return ok;
  };

  const installICloudTemplate = async () => {
    if (!data?.iCloudUrl) return;
    // 配置必须先进剪贴板，模板首次运行才能读到；复制失败就不跳转，避免装出来用不了
    const ok = await copyConfig();
    if (!ok) return;
    setStep(2);
    window.location.href = data.iCloudUrl;
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <MapSectionLoader />
      </div>
    );
  }

  if (error || !data) {
    const view = error ?? ERROR_VIEWS.network;
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <AlertTriangle size={44} style={{ color: '#ff9500', marginBottom: 14 }} />
          <h1 style={{ fontSize: 19, fontWeight: 700, marginBottom: 10 }}>{view.title}</h1>
          <p style={{
            fontSize: 14, color: 'rgba(255,255,255,0.6)', lineHeight: 1.6,
            marginBottom: view.canRetry ? 20 : 0,
          }}>
            {view.hint}
          </p>
          {view.canRetry && (
            <button
              onClick={loadData}
              style={{
                ...btnStyle, background: '#007aff',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              <RefreshCw size={16} /> 重试
            </button>
          )}
        </div>
      </div>
    );
  }

  const canDownloadSigned = !!data.canDownloadSigned && !!data.downloadUrl;
  const hasICloud = !!data.iCloudUrl;

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        {/* Header */}
        <div style={{ fontSize: 56, marginBottom: 12 }}>{data.icon || '⚡'}</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{data.name}</h1>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 24 }}>
          PrdAgent 快捷指令
        </div>

        {/* 纯手动兜底场景：诚实告知用户为什么要多走几步，降低挫败感 */}
        {!canDownloadSigned && !hasICloud && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left',
            padding: '12px 14px', marginBottom: 16, borderRadius: 12,
            background: 'rgba(255,149,0,0.1)', border: '1px solid rgba(255,149,0,0.22)',
          }}>
            <Info size={16} style={{ color: '#ff9500', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.72)', lineHeight: 1.55 }}>
              这条快捷指令还没配「一键安装模板」，需要手动添加一次（约 1 分钟）。
              照下面步骤做完，再用底部「连接自检」确认即可——不是你的问题，跟着做一定能成。
            </span>
          </div>
        )}

        {canDownloadSigned ? (
          <>
            <a
              href={data.downloadUrl}
              onClick={() => setStep(2)}
              style={{
                ...btnStyle,
                textDecoration: 'none',
                background: '#007aff',
              }}
            >
              安装签名快捷指令
            </a>
            <button
              onClick={copyConfig}
              style={{
                ...secondaryBtnStyle,
                marginTop: 10,
              }}
            >
              复制 iCloud 模板配置
            </button>
          </>
        ) : (
          <>
            <button
              onClick={copyConfig}
              style={{
                ...btnStyle,
                background: step >= 1 ? '#34c759' : '#007aff',
                marginBottom: 10,
              }}
            >
              {step >= 1 ? '配置已复制到剪贴板' : '复制配置到剪贴板'}
            </button>

            {hasICloud ? (
              <button
                onClick={installICloudTemplate}
                style={{
                  ...btnStyle,
                  background: '#007aff',
                }}
              >
                复制配置并安装 iCloud 模板
              </button>
            ) : (
              <a
                href="shortcuts://create-shortcut"
                onClick={() => setStep(2)}
                style={{
                  ...btnStyle,
                  textDecoration: 'none',
                  background: step >= 1 ? '#007aff' : 'rgba(255,255,255,0.12)',
                  color: step >= 1 ? '#fff' : 'rgba(255,255,255,0.4)',
                  pointerEvents: step >= 1 ? 'auto' : 'none',
                }}
              >
                打开快捷指令编辑器
              </a>
            )}

            {step < 1 && (
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginTop: 6 }}>
                请先复制配置
              </p>
            )}
          </>
        )}

        {/* ── 操作说明 ── */}
        <div style={{ marginTop: 20, textAlign: 'left' }}>
          {canDownloadSigned ? (
            <>
              <StepItem n={1} done={step >= 2}>
                点击「安装签名快捷指令」
              </StepItem>
              <StepItem n={2}>
                在 iOS 弹窗中添加到「快捷指令」
              </StepItem>
              <StepItem n={3}>
                任意 App 分享内容时选择「{data.name}」
              </StepItem>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 8, lineHeight: 1.5 }}>
                如改用 iCloud 模板，请先复制“iCloud 模板配置”。只复制 Token 无法完成配置。
              </p>
            </>
          ) : hasICloud ? (
            <>
              <StepItem n={1} done={step >= 2}>
                点击「复制配置并安装 iCloud 模板」
              </StepItem>
              <StepItem n={2} done={step >= 2}>
                系统会把 key 和当前站点接口地址放入剪贴板
              </StepItem>
              <StepItem n={3}>
                添加快捷指令后首次运行，它会自动读取剪贴板配置
              </StepItem>
            </>
          ) : (
            <>
              <StepItem n={1} done={step >= 1}>
                点击上方「复制配置到剪贴板」
              </StepItem>
              <StepItem n={2} done={step >= 2}>
                打开「快捷指令」App → 点右上角 <strong>+</strong> 新建
              </StepItem>
              <StepItem n={3}>
                搜索并添加「获取 URL 内容」操作
              </StepItem>
              <StepItem n={4}>
                展开操作里的<strong>「显示更多」</strong>，按下方信息填：<br/>
                <strong>URL</strong>：粘贴下方「收藏接口」地址<br/>
                <strong>方法</strong>：POST<br/>
                <strong>请求体</strong>：JSON，加一项 <code style={{ fontFamily: 'monospace' }}>url</code> = 要收藏的链接<br/>
                <strong>头部</strong>：Authorization = Bearer +下方完整 Token
              </StepItem>
              <StepItem n={5}>
                保存并命名，运行一次后用下方「连接自检」确认是否成功
              </StepItem>
            </>
          )}
        </div>

        {/* ── Token / API 信息 ── */}
        <div style={{
          marginTop: 20, paddingTop: 16,
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <InfoRow label="Token" value={token} mono />
          <InfoRow label="收藏接口" value={`${data.serverUrl}/api/shortcuts/collect`} />
        </div>

        {/* ── 连接自检：装完点一下就知道通没通，不用瞎猜 ── */}
        <VerifyConnection token={token} shortcutName={data.name} />

        {/* ── 遇到问题（常见卡点自助排查） ── */}
        <HelpFaq />

        {/* ── 功能 ── */}
        <div style={{
          marginTop: 16, paddingTop: 14,
          borderTop: '1px solid rgba(255,255,255,0.06)',
          fontSize: 12, color: 'rgba(255,255,255,0.4)',
        }}>
          分享菜单一键收藏 &nbsp;&nbsp; 系统通知反馈 &nbsp;&nbsp; 自动版本检查
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───

function StepItem({ n, done, children }: { n: number; done?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      padding: '8px 0', fontSize: 14, lineHeight: 1.5,
      color: done ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.8)',
      textDecoration: done ? 'line-through' : 'none',
    }}>
      <span style={{
        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 700,
        background: done ? '#34c759' : 'rgba(255,255,255,0.12)',
        color: done ? '#fff' : 'rgba(255,255,255,0.6)',
      }}>
        {done ? '✓' : n}
      </span>
      <span>{children}</span>
    </div>
  );
}

function InfoRow({ label, value, mono }: {
  label: string; value: string; mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('复制失败', '请长按上方文本手动复制');
    }
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', marginBottom: 6, borderRadius: 10,
      background: 'rgba(255,255,255,0.05)',
    }}>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', width: 50, flexShrink: 0 }}>
        {label}
      </span>
      <span style={{
        flex: 1, fontSize: 11, wordBreak: 'break-all',
        color: mono ? 'rgba(255,255,255,0.7)' : '#007aff',
        fontFamily: mono ? 'monospace' : 'inherit',
      }}>
        {value}
      </span>
      <button
        onClick={handleCopy}
        style={{
          padding: '4px 10px', borderRadius: 6, fontSize: 11, border: 'none',
          cursor: 'pointer', flexShrink: 0,
          background: copied ? 'rgba(52,199,89,0.2)' : 'rgba(255,255,255,0.1)',
          color: copied ? '#34c759' : 'rgba(255,255,255,0.6)',
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

// ─── 连接自检 ───
// 装完快捷指令后，点一下就知道密钥通不通、收藏有没有到，省得用户对着手机干瞪眼。
// 走 GET /collections（带 token），非破坏性：只验证授权 + 读回收藏数，不会写脏数据。
type VerifyState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; total: number; latest?: string }
  | { kind: 'unauthorized' }
  | { kind: 'network' };

function VerifyConnection({ token, shortcutName }: { token: string; shortcutName: string }) {
  const [state, setState] = useState<VerifyState>({ kind: 'idle' });

  const check = async () => {
    setState({ kind: 'checking' });
    try {
      // 相对路径走当前站点，避免跨域；token 通过 Authorization 头校验（与快捷指令实际收藏同一把锁）
      const res = await fetch('/api/shortcuts/collections?page=1&pageSize=3', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setState({ kind: 'unauthorized' });
        return;
      }
      const json = await res.json();
      if (json?.success && json.data) {
        const total: number = json.data.total ?? json.data.Total ?? 0;
        const items: Array<{ url?: string; text?: string }> = json.data.items ?? json.data.Items ?? [];
        const first = items[0];
        const latest = first?.url || first?.text || undefined;
        setState({ kind: 'ok', total, latest });
      } else {
        setState({ kind: json?.error?.code ? 'unauthorized' : 'network' });
      }
    } catch {
      setState({ kind: 'network' });
    }
  };

  return (
    <div style={{
      marginTop: 16, padding: '14px 14px 16px', borderRadius: 12,
      background: 'rgba(0,122,255,0.08)', border: '1px solid rgba(0,122,255,0.18)',
      textAlign: 'left',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <ShieldCheck size={15} style={{ color: '#0a84ff', flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
          装完了？点这里自检
        </span>
      </div>
      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, marginBottom: 10 }}>
        建议先在任意 App 点一次分享 → 选「{shortcutName}」，再来点下方按钮，确认收藏真的通了。
      </p>

      <button
        onClick={check}
        disabled={state.kind === 'checking'}
        style={{
          width: '100%', padding: '11px 0', borderRadius: 10, border: 'none',
          fontSize: 14, fontWeight: 600, cursor: state.kind === 'checking' ? 'default' : 'pointer',
          background: 'rgba(0,122,255,0.85)', color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          opacity: state.kind === 'checking' ? 0.7 : 1,
        }}
      >
        {state.kind === 'checking'
          ? <><MapSpinner size={15} /> 检测中…</>
          : <><RefreshCw size={14} /> 检查连接是否正常</>}
      </button>

      {state.kind === 'ok' && (
        <ResultLine tone="ok">
          连接正常，已收藏 {state.total} 条。
          {state.latest
            ? <> 最新一条：<span style={{ color: 'rgba(255,255,255,0.85)' }}>{truncate(state.latest, 40)}</span>，安装成功！</>
            : <> 还没有收藏记录，去任意 App 点分享 → 选「{shortcutName}」试一下。</>}
        </ResultLine>
      )}
      {state.kind === 'unauthorized' && (
        <ResultLine tone="bad">
          连接失败：密钥无效或已过期。请向分享给你的人要一张新的二维码。
        </ResultLine>
      )}
      {state.kind === 'network' && (
        <ResultLine tone="bad">网络不稳定，没连上服务器。请检查网络后再点一次。</ResultLine>
      )}
    </div>
  );
}

function ResultLine({ tone, children }: { tone: 'ok' | 'bad'; children: React.ReactNode }) {
  const color = tone === 'ok' ? '#34c759' : '#ff453a';
  const Icon = tone === 'ok' ? CheckCircle2 : XCircle;
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10,
      fontSize: 12.5, lineHeight: 1.5, color: 'rgba(255,255,255,0.7)',
    }}>
      <Icon size={15} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

// ─── 常见卡点自助排查（折叠，不抢主流程） ───
const FAQ_ITEMS: { q: string; a: React.ReactNode }[] = [
  {
    q: '点了安装没反应？',
    a: <>需要 iPhone 系统 iOS 15 及以上，且已安装系统自带的「快捷指令」App（误删可在 App Store 重新下载）。</>,
  },
  {
    q: '提示「不受信任的快捷指令」无法添加？',
    a: <>打开 iPhone 设置 → 快捷指令 → 打开「允许不受信任的快捷指令」（需先在快捷指令 App 至少运行过一次）。</>,
  },
  {
    q: '分享菜单里找不到它？',
    a: <>打开「快捷指令」App → 长按这条快捷指令 → 详情 → 打开「在分享表单中显示」。</>,
  },
  {
    q: '运行后提示没有网络权限？',
    a: <>首次运行 iOS 会询问是否允许访问网络/剪贴板，请全部选「允许」，否则收藏发不出去。</>,
  },
];

function HelpFaq() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 14, textAlign: 'left' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer',
          color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: 600,
        }}
      >
        <HelpCircle size={15} style={{ color: 'rgba(255,255,255,0.6)' }} />
        <span style={{ flex: 1, textAlign: 'left' }}>遇到问题？点我看常见排查</span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 6px' }}>
          {FAQ_ITEMS.map((item, i) => (
            <div key={i}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.8)', marginBottom: 3 }}>
                {item.q}
              </div>
              <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.55)', lineHeight: 1.6 }}>
                {item.a}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─── Styles ───

const containerStyle: React.CSSProperties = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
  background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
  color: 'white',
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
};

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderRadius: 24,
  padding: '36px 24px',
  maxWidth: 400,
  width: '100%',
  textAlign: 'center',
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
};

const btnStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '14px 20px',
  borderRadius: 14,
  fontSize: 16,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
  color: '#fff',
  textAlign: 'center',
  boxSizing: 'border-box',
};

const secondaryBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: 'rgba(255,255,255,0.1)',
  color: 'rgba(255,255,255,0.72)',
};
