import { useCallback, useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { RefreshCw, Trash2, Zap, CheckCircle2, Clock, AlertCircle, Download } from 'lucide-react';
import {
  getDesktopUpdateCaches,
  triggerDesktopUpdateCache,
  deleteDesktopUpdateCache,
  type DesktopUpdateCacheItem,
} from '@/services/real/desktopUpdateCache';

const KNOWN_TARGETS = [
  'x86_64-pc-windows-msvc',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'i686-pc-windows-msvc',
];

const TARGET_LABELS: Record<string, string> = {
  'x86_64-pc-windows-msvc': 'Windows 64-bit',
  'i686-pc-windows-msvc': 'Windows 32-bit',
  'aarch64-apple-darwin': 'macOS Apple Silicon',
  'x86_64-apple-darwin': 'macOS Intel',
  'x86_64-unknown-linux-gnu': 'Linux x64',
  'aarch64-unknown-linux-gnu': 'Linux ARM64',
};

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
    ready: { icon: CheckCircle2, color: 'var(--success)', label: '已就绪' },
    downloading: { icon: Download, color: 'var(--warning, #f59e0b)', label: '下载中' },
    pending: { icon: Clock, color: 'var(--text-muted)', label: '等待中' },
    failed: { icon: AlertCircle, color: 'var(--destructive, #ef4444)', label: '失败' },
  };
  const { icon: Icon, color, label } = config[status] ?? config.pending;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color }}>
      <Icon size={12} />
      {label}
    </span>
  );
}

function formatBytes(bytes?: number) {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function UpdateAccelerationSettings() {
  const [items, setItems] = useState<DesktopUpdateCacheItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getDesktopUpdateCaches();
      if (res.ok && res.data) setItems(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleTrigger = async (target: string) => {
    setTriggering(target);
    try {
      await triggerDesktopUpdateCache(target);
      // 延迟刷新，给后台一点时间
      setTimeout(() => void load(), 1500);
    } finally {
      setTriggering(null);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteDesktopUpdateCache(id);
    setItems((prev) => prev.filter((x) => x.id !== id));
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-y-auto">
      {/* 说明 */}
      <GlassCard animated glow accentHue={45}>
        <div className="flex items-start gap-3">
          <Zap size={20} style={{ color: 'var(--warning, #f59e0b)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              桌面客户端更新加速
            </h3>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              将 GitHub Release 安装包缓存到 COS，加速国内用户下载。桌面客户端会先尝试加速地址（3 秒超时），
              失败后自动回退 GitHub。首次请求时后台异步下载并上传 COS，后续请求直接返回 COS 链接。
            </p>
          </div>
        </div>
      </GlassCard>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          刷新
        </Button>
        {KNOWN_TARGETS.slice(0, 3).map((target) => (
          <Button
            key={target}
            variant="secondary"
            size="sm"
            onClick={() => void handleTrigger(target)}
            disabled={triggering === target}
          >
            {triggering === target ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
            缓存 {TARGET_LABELS[target] ?? target}
          </Button>
        ))}
      </div>

      {/* 缓存列表 */}
      <GlassCard animated>
        <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
          缓存记录
        </h3>

        {items.length === 0 ? (
          <div className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>
            {loading ? '加载中...' : '暂无缓存记录，点击上方按钮触发缓存'}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                style={{
                  background: 'var(--nested-block-bg)',
                  border: '1px solid var(--nested-block-border)',
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
                      v{item.version}
                    </span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--bg-input)', color: 'var(--text-secondary)' }}
                    >
                      {TARGET_LABELS[item.target] ?? item.target}
                    </span>
                    <StatusBadge status={item.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span>{formatBytes(item.packageSizeBytes)}</span>
                    <span>更新于 {formatTime(item.updatedAt)}</span>
                    {item.errorMessage && (
                      <span style={{ color: 'var(--destructive, #ef4444)' }} title={item.errorMessage}>
                        {item.errorMessage.slice(0, 50)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {item.cosPackageUrl && (
                    <a
                      href={item.cosPackageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 rounded hover:bg-[var(--bg-input)] transition-colors"
                      title="打开 COS 链接"
                    >
                      <Download size={14} style={{ color: 'var(--text-muted)' }} />
                    </a>
                  )}
                  <button
                    onClick={() => void handleDelete(item.id)}
                    className="p-1.5 rounded hover:bg-[var(--bg-input)] transition-colors"
                    title="删除缓存"
                  >
                    <Trash2 size={14} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
