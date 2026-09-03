import { useCallback, useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { listMcpCalls } from '@/services';
import type { McpCallLogDto, McpClientDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';

const STATUS_STYLE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  success: {
    label: '成功',
    color: 'var(--semantic-success-text)',
    bg: 'var(--semantic-success-soft)',
    border: 'var(--semantic-success-border)',
  },
  denied: {
    label: '被挡下',
    color: 'var(--semantic-warning-text)',
    bg: 'var(--semantic-orange-soft)',
    border: 'var(--semantic-orange-border)',
  },
  error: {
    label: '失败',
    color: 'var(--semantic-danger-text)',
    bg: 'var(--semantic-danger-soft)',
    border: 'var(--semantic-danger-border)',
  },
};

/**
 * 调用记录：智能体替你做的每一件事，包括它想做但被挡下来的。
 * 有产物的直接给可点开的地址 —— 记录不给产物入口就等于让人自己去翻。
 */
export function McpCallsPanel({ clients }: { clients: McpClientDto[] }) {
  const [items, setItems] = useState<McpCallLogDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [keyId, setKeyId] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listMcpCalls({ keyId: keyId || undefined, status: status || undefined, limit: 50 });
    if (!res.success || !res.data) {
      toast.error('调用记录加载失败', res.error?.message);
      setLoading(false);
      return;
    }
    setItems(res.data.items);
    setTotal(res.data.total);
    setLoading(false);
  }, [keyId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 筛选 */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={keyId}
          onChange={(e) => setKeyId(e.target.value)}
          className="h-8 rounded-[9px] px-2.5 text-[12px]"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        >
          <option value="">全部客户端</option>
          {clients.map((c) => (
            <option key={c.keyId} value={c.keyId}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8 rounded-[9px] px-2.5 text-[12px]"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        >
          <option value="">全部结果</option>
          <option value="success">成功</option>
          <option value="denied">被挡下</option>
          <option value="error">失败</option>
        </select>
        <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          共 {total} 条，最多显示最近 50 条
        </span>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <PrdLoader size={36} />
        </div>
      ) : items.length === 0 ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[14px] p-8 text-center"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
        >
          <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            还没有调用记录
          </p>
          <p className="max-w-[420px] text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            连上客户端后，对它说一句「把这周的周报做成一页网页托管上去」，它调用平台能力的每一步都会出现在这里。
          </p>
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-auto rounded-[14px]"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
        >
          {items.map((item) => {
            const st = STATUS_STYLE[item.status] ?? STATUS_STYLE.success;
            const expanded = expandedId === item.id;
            return (
              <div key={item.id} className="flex flex-col" style={{ borderBottom: '1px solid var(--border-faint)' }}>
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : item.id)}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover-bg-soft"
                >
                  <span
                    className="w-[52px] shrink-0 text-[11px] tabular-nums"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {new Date(item.createdAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span
                    className="w-[120px] shrink-0 truncate text-[12px]"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {item.keyName}
                  </span>
                  <code
                    className="w-[200px] shrink-0 truncate text-[11.5px]"
                    style={{
                      color: 'var(--text-primary)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    }}
                  >
                    {item.toolName}
                  </code>
                  <span
                    className="min-w-0 flex-1 truncate text-[12px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {item.status === 'success'
                      ? item.artifact?.title || item.argumentsPreview || '—'
                      : item.errorMessage || item.argumentsPreview || '—'}
                  </span>
                  {item.artifact?.url && (
                    <a
                      href={item.artifact.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium"
                      style={{ color: 'var(--accent-primary)' }}
                    >
                      <ExternalLink size={12} aria-hidden />
                      打开
                    </a>
                  )}
                  <span
                    className="w-[52px] shrink-0 text-right text-[11px] tabular-nums"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {item.durationMs > 0 ? `${(item.durationMs / 1000).toFixed(1)}s` : '—'}
                  </span>
                  <span
                    className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{ background: st.bg, border: `1px solid ${st.border}`, color: st.color }}
                  >
                    {st.label}
                  </span>
                </button>

                {expanded && (
                  <div className="flex flex-col gap-2 px-4 pb-3.5" style={{ background: 'var(--bg-sunken)' }}>
                    <DetailRow label="它发过来的参数" value={item.argumentsPreview || '（无参数）'} mono />
                    {item.errorMessage && <DetailRow label="失败原因" value={item.errorMessage} />}
                    {item.artifact?.url && (
                      <DetailRow label="产物地址" value={item.artifact.url} mono />
                    )}
                    <div className="flex flex-wrap gap-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <span>HTTP {item.httpStatus || '—'}</span>
                      <span>{item.isWrite ? '写入类动作' : '只读动作'}</span>
                      {item.imageCount > 0 && <span>{item.imageCount} 张图</span>}
                      <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span
        className="break-all text-[11.5px] leading-relaxed"
        style={{
          color: 'var(--text-secondary)',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}
