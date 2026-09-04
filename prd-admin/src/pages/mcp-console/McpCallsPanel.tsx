import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { listMcpCalls } from '@/services';
import type { McpCallLogDto, McpClientDto } from '@/services/contracts/mcpConsole';

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
export function McpCallsPanel({
  clients,
  refreshToken = 0,
}: {
  clients: McpClientDto[];
  /** 页面顶部「刷新」每点一次加一。记录列表自己拉自己的数据，不进依赖就永远是旧的。 */
  refreshToken?: number;
}) {
  const [items, setItems] = useState<McpCallLogDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [keyId, setKeyId] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 读失败要留一个**持续存在**的错误态。只弹一下 toast 的话，界面会退到两种更糟的样子：
  // 首次加载显示「还没有调用记录」（把「没读到」说成「你还没用过」），
  // 换筛选条件失败则把上一次的行留在新条件下面（把别的客户端的记录说成这个客户端的）。
  // 审计面板一旦开始说谎，用户还不如没有它。
  const [loadError, setLoadError] = useState<string | null>(null);

  // 筛选条件连改两次时会有两个 load 同时在飞，谁后回来谁覆盖 items —— 慢的那个是旧条件的结果，
  // 于是当前筛选下会显示别的客户端/别的结果状态的记录。给每次请求发一个代次号，
  // 回来时不是最新那次就整段丢弃（错误态同理，否则旧请求的失败会盖掉新请求的成功）。
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    const res = await listMcpCalls({ keyId: keyId || undefined, status: status || undefined, limit: 50 });
    if (gen !== loadGenRef.current) return;
    if (!res.success || !res.data) {
      setLoadError(res.error?.message || '调用记录没读到，可能是网络断开或服务端异常。');
      setItems([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoadError(null);
    setItems(res.data.items);
    setTotal(res.data.total);
    setLoading(false);
  }, [keyId, status]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

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
      ) : loadError ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[14px] p-8 text-center"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--semantic-warning-border)' }}
        >
          <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            调用记录没读到
          </p>
          <p className="max-w-[420px] text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {loadError}
            <br />
            这不是「你还没用过」——已经发生过的调用都还在，只是这次没取回来。
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-[8px] px-3.5 py-1.5 text-[12.5px] font-medium"
            style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
          >
            重试
          </button>
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
                    {/* 没有可点地址时至少把 id 露出来（如还没跑完的生图 run）：
                        既没有「打开」又看不到 id，这条记录就等于只告诉用户「有个东西」。 */}
                    {!item.artifact?.url && item.artifact?.id && (
                      <DetailRow
                        label="产物"
                        value={`${item.artifact.kind ?? '产物'} · ${item.artifact.id}`}
                        mono
                      />
                    )}
                    <div className="flex flex-wrap gap-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {/* 不显示原始 HTTP 状态码：这是给普通用户（access 权限）看的页面，不是管理员诊断面。
                          结果本身上面那枚状态徽章已经说了（成功 / 被挡下 / 失败），失败原因由 errorMessage
                          用人话给出；状态码只对排障有意义，它留在服务端的 mcp_call_logs 里。 */}
                      <span>{item.isWrite ? '写入类动作' : '只读动作'}</span>
                      {item.imageCount > 0 && <span>{item.imageCount} 张图</span>}
                      {/* 这一行的动作分类照实写（这次要干的确实是写入/出图），额度没动的事实由这个标记说出来。
                          不这么分开的话，只能把分类抹成「只读动作·0 张图」——记录就跟它实际干的事不符了。 */}
                      {item.deduplicated && (
                        <span style={{ color: 'var(--semantic-info-text)' }}>
                          幂等命中 · 未计额度
                        </span>
                      )}
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
