import { useEffect, useState } from 'react';
import { Share2, ExternalLink, Copy, Check, Eye, AlertCircle, FilterX } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { listMyShares } from '@/services';
import type { MyShareItem } from '@/services';
import { toast } from '@/lib/toast';

/**
 * 我的分享（个人总管理）
 *
 * 用户提的核心诉求：
 *   "我一共分享了什么，我得知道。分享的地方很多，方便进行分类。"
 *
 * 跨 4 类（网页托管 / 周报 / 知识库 / 工作流）聚合列出当前用户所有分享。
 * 每条提供主链接（带分类前缀）+ 超短链 + 字母统一长链 三种 URL 形态可复制。
 */

const TYPE_META: Record<string, { label: string; color: string; bg: string }> = {
  web_page:       { label: '网页托管', color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.12)' },
  report:         { label: '周报',     color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.12)' },
  document_store: { label: '知识库',   color: '#34d399', bg: 'rgba(52, 211, 153, 0.12)' },
  workflow:       { label: '工作流',   color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.12)' },
};

function getTypeMeta(t: string) {
  return TYPE_META[t] ?? { label: t, color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.04)' };
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isExpired(iso?: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}

export default function MySharesPage() {
  const [items, setItems] = useState<MyShareItem[]>([]);
  const [byType, setByType] = useState<Array<{ targetType: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [showRevoked, setShowRevoked] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const res = await listMyShares({
      targetType: filter || undefined,
      includeRevoked: showRevoked,
    });
    setLoading(false);
    if (!res.success || !res.data) {
      setError(res.error?.message || '加载失败');
      return;
    }
    setItems(res.data.items);
    setByType(res.data.byType);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, showRevoked]);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      toast.success('已复制', text);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="flex flex-col gap-5 h-full min-h-0 p-6 overflow-y-auto">
      <PageHeader
        title="我的分享"
        description={
          <span className="flex items-center gap-2">
            <Share2 size={14} />
            跨网页托管 / 周报 / 知识库 / 工作流的所有分享统一管理
          </span>
        }
      />

      {/* 分类概览 */}
      {byType.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setFilter('')}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition"
            style={{
              background: filter === '' ? 'var(--accent-primary)' : 'var(--bg-card)',
              color: filter === '' ? '#fff' : 'var(--text-primary)',
              border: '1px solid var(--border-default)',
            }}
          >
            全部（{byType.reduce((sum, t) => sum + t.count, 0)}）
          </button>
          {byType.map((t) => {
            const meta = getTypeMeta(t.targetType);
            const active = filter === t.targetType;
            return (
              <button
                key={t.targetType}
                onClick={() => setFilter(active ? '' : t.targetType)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5"
                style={{
                  background: active ? meta.color : meta.bg,
                  color: active ? '#fff' : meta.color,
                  border: `1px solid ${active ? meta.color : 'transparent'}`,
                }}
              >
                {meta.label}（{t.count}）
              </button>
            );
          })}
          <button
            onClick={() => setShowRevoked((v) => !v)}
            className="ml-auto px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5"
            style={{
              background: 'var(--bg-card)',
              color: showRevoked ? 'var(--text-primary)' : 'var(--text-muted)',
              border: '1px solid var(--border-default)',
            }}
          >
            <FilterX size={12} />
            {showRevoked ? '含已撤销' : '隐藏已撤销'}
          </button>
        </div>
      )}

      {/* 状态 */}
      {loading && <MapSectionLoader text="正在拉取我的分享…" />}

      {error && !loading && (
        <GlassCard className="p-5" style={{ borderColor: 'rgba(239, 68, 68, 0.5)' }}>
          <div className="flex items-center gap-2">
            <AlertCircle size={18} style={{ color: '#ef4444' }} />
            <span className="text-sm" style={{ color: '#ef4444' }}>{error}</span>
          </div>
        </GlassCard>
      )}

      {!loading && !error && items.length === 0 && (
        <GlassCard className="p-12 text-center">
          <Share2 size={48} className="mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            还没有分享。去网页托管 / 周报 / 知识库 / 工作流任一处创建你的第一条分享。
          </div>
        </GlassCard>
      )}

      {/* 分享列表 */}
      {!loading && !error && items.length > 0 && (
        <div className="flex flex-col gap-3">
          {items.map((s) => {
            const meta = getTypeMeta(s.targetType);
            const expired = isExpired(s.expiresAt);
            const primaryUrl = origin + s.primaryPath;
            const shortUrl = s.shortSeq > 0 ? `${origin}/s/${s.shortSeq}` : null;
            const unifiedUrl = `${origin}/s/${s.token}`;
            const itemKey = `${s.targetType}-${s.token}`;

            return (
              <GlassCard
                key={itemKey}
                className="p-4"
                style={
                  s.isRevoked
                    ? { opacity: 0.55, borderColor: 'rgba(239, 68, 68, 0.3)' }
                    : expired
                    ? { opacity: 0.75, borderColor: 'rgba(245, 158, 11, 0.3)' }
                    : undefined
                }
              >
                {/* 标题行 */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span
                        className="px-2 py-0.5 rounded text-xs font-medium"
                        style={{ background: meta.bg, color: meta.color }}
                      >
                        {meta.label}
                      </span>
                      {s.isRevoked && <Badge variant="danger">已撤销</Badge>}
                      {!s.isRevoked && expired && <Badge variant="warning">已过期</Badge>}
                      {s.accessLevel === 'password' && <Badge variant="subtle">需密码</Badge>}
                      {s.accessLevel === 'team-member' && <Badge variant="subtle">团队限定</Badge>}
                    </div>
                    <div
                      className="font-medium text-sm truncate"
                      style={{ color: 'var(--text-primary)' }}
                      title={s.title}
                    >
                      {s.title}
                    </div>
                    {s.subtitle && (
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {s.subtitle}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                    <div className="flex items-center gap-1 justify-end">
                      <Eye size={12} />
                      {s.viewCount} 次访问
                    </div>
                    <div className="mt-0.5">创建 {formatDate(s.createdAt)}</div>
                    {s.expiresAt && (
                      <div className="mt-0.5">
                        过期 {formatDate(s.expiresAt)}
                      </div>
                    )}
                  </div>
                </div>

                {/* 3 种 URL 形态 */}
                <div className="flex flex-col gap-2">
                  <UrlRow
                    label="主链接（带分类前缀）"
                    url={primaryUrl}
                    copyKey={`${itemKey}-primary`}
                    activeCopy={copiedKey}
                    onCopy={(t) => handleCopy(t, `${itemKey}-primary`)}
                    recommended
                  />
                  {shortUrl && (
                    <UrlRow
                      label="超短链（数字，需配密码）"
                      url={shortUrl}
                      copyKey={`${itemKey}-short`}
                      activeCopy={copiedKey}
                      onCopy={(t) => handleCopy(t, `${itemKey}-short`)}
                    />
                  )}
                  <UrlRow
                    label="字母统一长链"
                    url={unifiedUrl}
                    copyKey={`${itemKey}-unified`}
                    activeCopy={copiedKey}
                    onCopy={(t) => handleCopy(t, `${itemKey}-unified`)}
                  />
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

function UrlRow({
  label,
  url,
  copyKey,
  activeCopy,
  onCopy,
  recommended,
}: {
  label: string;
  url: string;
  copyKey: string;
  activeCopy: string | null;
  onCopy: (url: string) => void;
  recommended?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded text-xs"
      style={{
        background: 'var(--bg-sunken)',
        border: recommended ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid transparent',
      }}
    >
      <span style={{ color: 'var(--text-muted)', minWidth: 180 }}>
        {label}
        {recommended && <Badge variant="success" className="ml-1.5">推荐</Badge>}
      </span>
      <code
        className="flex-1 truncate font-mono"
        style={{ color: 'var(--text-primary)' }}
        title={url}
      >
        {url}
      </code>
      <Button size="sm" variant="ghost" onClick={() => onCopy(url)}>
        {activeCopy === copyKey ? <Check size={12} /> : <Copy size={12} />}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => window.open(url, '_blank', 'noopener')}>
        <ExternalLink size={12} />
      </Button>
    </div>
  );
}
