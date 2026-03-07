import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { viewSiteShare } from '@/services';
import type { ShareViewData } from '@/services';
import { Lock, Globe, ExternalLink, FileCode2 } from 'lucide-react';

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ShareViewPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ShareViewData | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchShare = async (pwd?: string) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    const res = await viewSiteShare(token, pwd);
    setLoading(false);
    if (res.success) {
      setData(res.data);
      setNeedPassword(false);
    } else if (res.error?.code === 'UNAUTHORIZED') {
      setNeedPassword(true);
    } else {
      setError(res.error || { code: 'UNKNOWN', message: '加载失败' });
    }
  };

  useEffect(() => {
    fetchShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await fetchShare(password);
    setSubmitting(false);
  };

  // ── Loading ──
  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>加载中...</div>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>
              {error.code === 'NOT_FOUND' ? '🔗' : error.code === 'EXPIRED' ? '⏰' : '❌'}
            </div>
            <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: 18 }}>
              {error.code === 'NOT_FOUND' ? '链接不存在' : error.code === 'EXPIRED' ? '链接已过期' : '出错了'}
            </h2>
            <p style={{ color: '#999', margin: 0, fontSize: 14 }}>{error.message}</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Password prompt ──
  if (needPassword) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={{ textAlign: 'center', padding: '30px 20px' }}>
            <Lock size={36} color="#888" style={{ marginBottom: 16 }} />
            <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: 18 }}>此链接需要密码</h2>
            <p style={{ color: '#999', margin: '0 0 20px', fontSize: 14 }}>请输入访问密码查看内容</p>
            <form onSubmit={handlePasswordSubmit} style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="访问密码"
                autoFocus
                style={{
                  padding: '8px 14px',
                  borderRadius: 8,
                  border: '1px solid #333',
                  background: '#1a1a1a',
                  color: '#fff',
                  fontSize: 14,
                  outline: 'none',
                  width: 180,
                }}
              />
              <button
                type="submit"
                disabled={submitting || !password.trim()}
                style={{
                  padding: '8px 18px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#3b82f6',
                  color: '#fff',
                  fontSize: 14,
                  cursor: 'pointer',
                  opacity: submitting || !password.trim() ? 0.5 : 1,
                }}
              >
                {submitting ? '验证中...' : '确认'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── Success: show site(s) ──
  if (!data) return null;

  // Single site → directly embed in iframe
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
          background: '#111',
          borderBottom: '1px solid #222',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Globe size={14} color="#888" />
            <span style={{ color: '#fff', fontSize: 14, fontWeight: 500 }}>{data.title || site.title}</span>
          </div>
          <a
            href={site.siteUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#3b82f6', fontSize: 13, textDecoration: 'none' }}
          >
            <ExternalLink size={12} />
            新窗口打开
          </a>
        </div>
        {/* Iframe */}
        <iframe
          src={site.siteUrl}
          title={site.title}
          style={{ flex: 1, border: 'none', width: '100%' }}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    );
  }

  // Collection → list cards
  return (
    <div style={styles.container}>
      <div style={{ maxWidth: 720, width: '100%', padding: '20px 16px' }}>
        <h1 style={{ color: '#fff', fontSize: 22, margin: '0 0 4px', fontWeight: 600 }}>{data.title || '站点合集'}</h1>
        {data.description && <p style={{ color: '#999', margin: '0 0 16px', fontSize: 14 }}>{data.description}</p>}
        <p style={{ color: '#666', fontSize: 12, margin: '0 0 20px' }}>{data.sites.length} 个站点</p>

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
                borderRadius: 10,
                background: '#151515',
                border: '1px solid #222',
                textDecoration: 'none',
                transition: 'border-color 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = '#444')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#222')}
            >
              {site.coverImageUrl ? (
                <img src={site.coverImageUrl} alt="" style={{ width: 56, height: 42, objectFit: 'cover', borderRadius: 6 }} />
              ) : (
                <div style={{ width: 56, height: 42, borderRadius: 6, background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <FileCode2 size={20} color="#555" />
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#fff', fontSize: 15, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {site.title}
                </div>
                {site.description && (
                  <div style={{ color: '#888', fontSize: 13, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {site.description}
                  </div>
                )}
                <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>
                  {site.fileCount} 个文件 · {fmtSize(site.totalSize)}
                </div>
              </div>
              <ExternalLink size={14} color="#555" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a0a',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    maxWidth: 420,
    width: '90%',
    borderRadius: 12,
    background: '#151515',
    border: '1px solid #222',
    overflow: 'hidden',
  },
};
