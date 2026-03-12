import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

interface InstallData {
  name: string;
  icon: string;
  color: string;
  token: string;
  downloadUrl: string;
  iCloudUrl?: string;
  serverUrl: string;
}

/**
 * 公开安装引导页 — iPhone 扫码后打开此页面
 * 路由: /s/shortcut/:id?t=scs-xxx
 */
export default function ShortcutInstallPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t') || '';

  const [data, setData] = useState<InstallData | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

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

  const copyToken = () => {
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = token;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>{data.icon || '⚡'}</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>{data.name}</h1>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, marginBottom: 32 }}>
          PrdAgent 快捷指令 · 一键安装
        </div>

        {/* Steps */}
        <div style={stepStyle}>
          <div style={stepNumStyle}>1</div>
          <div style={{ fontSize: 15, lineHeight: 1.5 }}>点击下方按钮下载快捷指令（密钥已内置）</div>
        </div>
        <div style={stepStyle}>
          <div style={stepNumStyle}>2</div>
          <div style={{ fontSize: 15, lineHeight: 1.5 }}>iOS 弹出提示，点击「添加快捷指令」</div>
        </div>
        <div style={stepStyle}>
          <div style={stepNumStyle}>3</div>
          <div style={{ fontSize: 15, lineHeight: 1.5 }}>
            在任意 App 点击<strong>分享 → {data.name}</strong>即可收藏
          </div>
        </div>

        {/* Download Button */}
        <a href={data.downloadUrl} style={primaryBtnStyle}>
          📲 下载并安装快捷指令
        </a>

        {/* iCloud fallback */}
        {data.iCloudUrl && (
          <div style={{ marginTop: 16 }}>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginBottom: 8 }}>
              或使用 iCloud 模板（需手动配置 token）
            </p>
            <a href={data.iCloudUrl} style={secondaryBtnStyle}>
              iCloud 模板
            </a>
          </div>
        )}

        {/* Features */}
        <div style={{
          marginTop: 24, paddingTop: 24,
          borderTop: '1px solid rgba(255,255,255,0.1)', textAlign: 'left',
        }}>
          <h3 style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>内置功能</h3>
          {['密钥已预置，无需手动配置', '自动版本检查，有更新时提醒', '分享菜单一键收藏 URL/文本', '收藏成功后系统通知反馈'].map((f) => (
            <div key={f} style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 6, paddingLeft: 8 }}>
              ✅ {f}
            </div>
          ))}
        </div>

        {/* Android */}
        <div style={{
          marginTop: 24, paddingTop: 24,
          borderTop: '1px solid rgba(255,255,255,0.1)',
        }}>
          <h3 style={{ fontSize: 16, marginBottom: 12, color: 'rgba(255,255,255,0.7)' }}>Android 用户</h3>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
            安装 <strong>HTTP Shortcuts</strong> 应用，新建快捷方式：<br />
            URL: <code style={{ color: '#007aff' }}>{data.serverUrl}/api/shortcuts/collect</code><br />
            方法: POST · Header: Authorization: Bearer {token.slice(0, 12)}...
          </p>
          <button onClick={copyToken} style={copyBtnStyle}>
            {copied ? '✅ 已复制' : '📋 复制完整 Token'}
          </button>
        </div>
      </div>
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
  padding: '40px 32px',
  maxWidth: 420,
  width: '100%',
  textAlign: 'center',
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
};

const stepStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  borderRadius: 16,
  padding: 16,
  marginBottom: 12,
  textAlign: 'left',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
};

const stepNumStyle: React.CSSProperties = {
  background: '#007aff',
  color: 'white',
  width: 28,
  height: 28,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 700,
  fontSize: 14,
  flexShrink: 0,
};

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 24,
  padding: '16px 32px',
  background: '#007aff',
  color: 'white',
  textDecoration: 'none',
  borderRadius: 14,
  fontSize: 18,
  fontWeight: 600,
};

const secondaryBtnStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '10px 20px',
  background: 'rgba(255,255,255,0.1)',
  color: 'rgba(255,255,255,0.7)',
  textDecoration: 'none',
  borderRadius: 10,
  fontSize: 14,
  border: '1px solid rgba(255,255,255,0.15)',
};

const copyBtnStyle: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 8,
  padding: '10px 24px',
  background: 'rgba(255,255,255,0.12)',
  color: 'white',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 10,
  fontSize: 14,
  cursor: 'pointer',
};
