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
 * 流程: 复制 Token → 安装 iCloud 模板 → 首次运行自动读取剪贴板
 */
export default function ShortcutInstallPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t') || '';

  const [data, setData] = useState<InstallData | null>(null);
  const [error, setError] = useState('');
  const [tokenCopied, setTokenCopied] = useState(false);
  const [configCopied, setConfigCopied] = useState(false);

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

  const doCopy = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text).then(() => {
      setter(true);
      setTimeout(() => setter(false), 3000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setter(true);
      setTimeout(() => setter(false), 3000);
    });
  };

  // 一键复制配置 JSON（Token + ServerUrl），快捷指令首次运行时从剪贴板读取
  const copyConfigAndInstall = () => {
    if (!data) return;
    const config = JSON.stringify({
      token: token,
      endpoint: `${data.serverUrl}/api/shortcuts/collect`,
      name: data.name,
    });
    doCopy(config, setConfigCopied);
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
        <div style={{ fontSize: 64, marginBottom: 16 }}>{data.icon || '⚡'}</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>{data.name}</h1>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, marginBottom: 28 }}>
          PrdAgent 快捷指令
        </div>

        {hasICloud ? (
          <>
            {/* iCloud 安装流程 */}
            <div style={stepStyle}>
              <div style={stepNumStyle}>1</div>
              <div style={{ fontSize: 15, lineHeight: 1.5, flex: 1 }}>
                点击下方按钮<strong>复制配置</strong>到剪贴板
              </div>
            </div>
            <div style={stepStyle}>
              <div style={stepNumStyle}>2</div>
              <div style={{ fontSize: 15, lineHeight: 1.5, flex: 1 }}>
                点击「安装快捷指令」，在 iOS 弹框中点「添加」
              </div>
            </div>
            <div style={stepStyle}>
              <div style={stepNumStyle}>3</div>
              <div style={{ fontSize: 15, lineHeight: 1.5, flex: 1 }}>
                首次运行时会自动从剪贴板读取配置，完成绑定
              </div>
            </div>

            {/* 主按钮：复制配置 + 安装 */}
            <button
              onClick={copyConfigAndInstall}
              style={{
                ...primaryBtnStyle,
                background: configCopied ? '#34c759' : '#007aff',
                border: 'none',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              {configCopied ? '✅ 已复制配置' : '📋 第一步：复制配置'}
            </button>

            <a
              href={data.iCloudUrl}
              style={{
                ...primaryBtnStyle,
                marginTop: 12,
                width: '100%',
                background: configCopied ? '#007aff' : 'rgba(255,255,255,0.15)',
                color: configCopied ? 'white' : 'rgba(255,255,255,0.5)',
                boxSizing: 'border-box',
              }}
            >
              📲 第二步：安装快捷指令
            </a>

            {!configCopied && (
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 8 }}>
                请先复制配置，再点安装
              </p>
            )}
          </>
        ) : (
          <>
            {/* 无 iCloud 模板：显示手动配置 */}
            <div style={{
              padding: 16, borderRadius: 14,
              background: 'rgba(255, 149, 0, 0.12)',
              border: '1px solid rgba(255, 149, 0, 0.25)',
              marginBottom: 20, textAlign: 'left',
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#ff9500', marginBottom: 6 }}>
                管理员尚未配置 iCloud 模板
              </div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
                iOS 15+ 要求通过 iCloud 链接安装快捷指令。
                请联系管理员在「快捷指令 → 模板管理」中添加 iCloud 模板链接。
              </div>
            </div>

            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', marginBottom: 12, textAlign: 'left' }}>
              你也可以手动创建快捷指令，复制以下信息配置：
            </div>
          </>
        )}

        {/* Token 区域 */}
        <div style={{
          width: '100%', marginTop: 20, padding: 14, borderRadius: 12,
          background: 'rgba(255,255,255,0.06)', textAlign: 'left',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>
            Token
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{
              flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.8)',
              wordBreak: 'break-all', fontFamily: 'monospace',
            }}>
              {token}
            </code>
            <button
              onClick={() => doCopy(token, setTokenCopied)}
              style={{
                ...copyBtnStyle,
                padding: '6px 12px', fontSize: 12, marginTop: 0,
                background: tokenCopied ? 'rgba(52,199,89,0.2)' : 'rgba(255,255,255,0.12)',
              }}
            >
              {tokenCopied ? '✅' : '复制'}
            </button>
          </div>
        </div>

        {/* API 端点 */}
        <div style={{
          width: '100%', marginTop: 10, padding: 14, borderRadius: 12,
          background: 'rgba(255,255,255,0.06)', textAlign: 'left',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>
            收藏接口
          </div>
          <code style={{
            fontSize: 11, color: '#007aff',
            wordBreak: 'break-all', fontFamily: 'monospace',
          }}>
            {data.serverUrl}/api/shortcuts/collect
          </code>
        </div>

        {/* Features */}
        <div style={{
          marginTop: 24, paddingTop: 20,
          borderTop: '1px solid rgba(255,255,255,0.08)', textAlign: 'left',
        }}>
          <h3 style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 10 }}>功能</h3>
          {['分享菜单一键收藏 URL/文本', '收藏成功后系统通知反馈', '自动版本检查'].map((f) => (
            <div key={f} style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 5, paddingLeft: 8 }}>
              ✅ {f}
            </div>
          ))}
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
  padding: '40px 28px',
  maxWidth: 420,
  width: '100%',
  textAlign: 'center',
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
};

const stepStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  borderRadius: 14,
  padding: 14,
  marginBottom: 10,
  textAlign: 'left',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
};

const stepNumStyle: React.CSSProperties = {
  background: '#007aff',
  color: 'white',
  width: 26,
  height: 26,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 700,
  fontSize: 13,
  flexShrink: 0,
};

const primaryBtnStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 20,
  padding: '15px 24px',
  background: '#007aff',
  color: 'white',
  textDecoration: 'none',
  borderRadius: 14,
  fontSize: 16,
  fontWeight: 600,
  textAlign: 'center',
};

const copyBtnStyle: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 8,
  padding: '8px 16px',
  background: 'rgba(255,255,255,0.12)',
  color: 'white',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 8,
  fontSize: 13,
  cursor: 'pointer',
};
