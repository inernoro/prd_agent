import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

interface InstallData {
  name: string;
  icon: string;
  color: string;
  token: string;
  iCloudUrl?: string;
  serverUrl: string;
}

/**
 * 公开安装引导页 — iPhone 扫码后打开此页面
 * 路由: /s/shortcut/:id?t=scs-xxx
 *
 * 两种模式:
 * - 有 iCloud 模板: 复制配置 → 安装 iCloud 模板 → 首次运行自动绑定
 * - 无 iCloud 模板: 复制配置 → 手动创建快捷指令（3 步引导）
 */
export default function ShortcutInstallPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t') || '';

  const [data, setData] = useState<InstallData | null>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState(0); // 0=初始, 1=已复制配置, 2=已打开App

  useEffect(() => {
    if (!id || !token) {
      setError('链接无效');
      return;
    }
    fetch(`/api/shortcuts/${id}/install-data?t=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const json = await res.json();
        if (json.success && json.data) {
          setData(json.data);
        } else {
          setError(json.message || '加载失败');
        }
      })
      .catch(() => setError('网络错误，请稍后重试'));
  }, [id, token]);

  const doCopy = (text: string) => {
    return navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  };

  // 复制配置 JSON 到剪贴板
  const copyConfig = async () => {
    if (!data) return;
    const config = JSON.stringify({
      token,
      endpoint: `${data.serverUrl}/api/shortcuts/collect`,
      name: data.name,
    });
    await doCopy(config);
    setStep(1);
  };

  if (error) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>😕</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{error}</h1>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }}>
            请确认链接是否正确，或联系管理员
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
          <p style={{ fontSize: 16, color: 'rgba(255,255,255,0.7)' }}>加载中...</p>
        </div>
      </div>
    );
  }

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

        {/* ── Step 1: 复制配置 ── */}
        <button
          onClick={copyConfig}
          style={{
            ...btnStyle,
            background: step >= 1 ? '#34c759' : '#007aff',
            marginBottom: 10,
          }}
        >
          {step >= 1 ? '✅ 配置已复制到剪贴板' : '📋 复制配置到剪贴板'}
        </button>

        {/* ── Step 2: 安装 ── */}
        {hasICloud ? (
          // 有 iCloud 模板 → 直接跳转安装
          <a
            href={data.iCloudUrl}
            onClick={() => setStep(2)}
            style={{
              ...btnStyle,
              textDecoration: 'none',
              background: step >= 1 ? '#007aff' : 'rgba(255,255,255,0.12)',
              color: step >= 1 ? '#fff' : 'rgba(255,255,255,0.4)',
              pointerEvents: step >= 1 ? 'auto' : 'none',
            }}
          >
            📲 安装快捷指令
          </a>
        ) : (
          // 无 iCloud 模板 → 打开快捷指令 App
          <a
            href="shortcuts://"
            onClick={() => setStep(2)}
            style={{
              ...btnStyle,
              textDecoration: 'none',
              background: step >= 1 ? '#007aff' : 'rgba(255,255,255,0.12)',
              color: step >= 1 ? '#fff' : 'rgba(255,255,255,0.4)',
              pointerEvents: step >= 1 ? 'auto' : 'none',
            }}
          >
            📲 打开「快捷指令」App
          </a>
        )}

        {step < 1 && (
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginTop: 6 }}>
            请先复制配置
          </p>
        )}

        {/* ── 操作说明 ── */}
        <div style={{ marginTop: 20, textAlign: 'left' }}>
          {hasICloud ? (
            // iCloud 模式说明
            <>
              <StepItem n={1} done={step >= 1}>
                点击上方「复制配置」
              </StepItem>
              <StepItem n={2} done={step >= 2}>
                点击「安装快捷指令」，在弹框中点「添加」
              </StepItem>
              <StepItem n={3}>
                首次使用时会自动从剪贴板读取配置
              </StepItem>
            </>
          ) : (
            // 手动创建说明
            <>
              <StepItem n={1} done={step >= 1}>
                点击上方「复制配置」
              </StepItem>
              <StepItem n={2} done={step >= 2}>
                打开「快捷指令」App → 点右上角 <strong>+</strong> 新建
              </StepItem>
              <StepItem n={3}>
                搜索并添加「获取URL内容」操作
              </StepItem>
              <StepItem n={4}>
                <strong>URL</strong>: 粘贴收藏接口地址<br/>
                <strong>方法</strong>: POST<br/>
                <strong>头部</strong>: Authorization = Bearer {token.slice(0, 8)}...
              </StepItem>
            </>
          )}
        </div>

        {/* ── Token / API 信息 ── */}
        <div style={{
          marginTop: 20, paddingTop: 16,
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <InfoRow label="Token" value={token} onCopy={() => doCopy(token)} mono />
          <InfoRow label="收藏接口" value={`${data.serverUrl}/api/shortcuts/collect`} onCopy={() => doCopy(`${data.serverUrl}/api/shortcuts/collect`)} />
        </div>

        {/* ── 功能 ── */}
        <div style={{
          marginTop: 16, paddingTop: 14,
          borderTop: '1px solid rgba(255,255,255,0.06)',
          fontSize: 12, color: 'rgba(255,255,255,0.4)',
        }}>
          ✅ 分享菜单一键收藏 &nbsp;&nbsp; ✅ 系统通知反馈 &nbsp;&nbsp; ✅ 自动版本检查
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

function InfoRow({ label, value, onCopy, mono }: {
  label: string; value: string; onCopy: () => void; mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
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
        onClick={() => {
          onCopy();
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
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
