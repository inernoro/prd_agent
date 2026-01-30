import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { getApiLogDetail, getApiLogs, getApiLogsMeta, getLlmLogs } from '@/services';
import type { ApiLogsListItem, ApiRequestLog } from '@/services/contracts/apiLogs';
import type { LlmRequestLogListItem } from '@/types/admin';
import { CheckCircle, ChevronRight, Clock, Copy, Filter, Hash, Loader2, Server, XCircle, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

function codeBoxStyle(): React.CSSProperties {
  return {
    background: 'rgba(0,0,0,0.28)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 14,
    padding: 12,
    overflow: 'auto',
    maxHeight: '30vh',  // 限制最大高度，超出滚动
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
}

function formatLocalTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function fmtNum(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

function buildMetaLabel(args: {
  clientType: string | null;
  clientId: string | null;
  appId: string | null;
  appName: string | null;
}): string {
  const clientType = (args.clientType ?? '').trim();
  const showClientType = clientType.length > 0 && clientType.toLowerCase() !== 'unknown';
  const parts: string[] = [];
  if (showClientType) {
    parts.push(args.clientId ? `${clientType}(${args.clientId})` : clientType);
  } else if (args.clientId) {
    parts.push(args.clientId);
  }
  if (args.appId || args.appName) {
    const appName = (args.appName ?? '').trim();
    parts.push(appName.length > 0 ? `app=${appName}` : 'app=unknown');
  }
  if (parts.length === 0) return '';
  return ` · ${parts.join(' · ')}`;
}

function statusBadge(statusCode: number, status?: string | null) {
  // 请求状态优先（running/timeout）
  if (status === 'running') return <Badge variant="new" size="sm" icon={<Clock size={10} />}>进行中</Badge>;
  if (status === 'timeout') return <Badge variant="subtle" size="sm" icon={<XCircle size={10} />}>超时</Badge>;
  // HTTP 状态码
  if (statusCode >= 200 && statusCode < 300) return <Badge variant="success" size="sm" icon={<CheckCircle size={10} />}>成功</Badge>;
  if (statusCode >= 400 && statusCode < 500) return <Badge variant="subtle" size="sm" icon={<XCircle size={10} />}>失败</Badge>;
  if (statusCode >= 500) return <Badge variant="subtle" size="sm" icon={<XCircle size={10} />}>异常</Badge>;
  return <Badge variant="subtle" size="sm">{statusCode || '?'}</Badge>;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

export default function SystemLogsTab() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ApiLogsListItem[]>([]);  // 非进行中的列表
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);

  // 进行中任务（独立管理）
  const [runningItems, setRunningItems] = useState<ApiLogsListItem[]>([]);
  const [runningLoading, setRunningLoading] = useState(false);
  const [fadingOutIds, setFadingOutIds] = useState<Set<string>>(new Set());
  const prevRunningIdsRef = useRef<Set<string>>(new Set());

  const [qUserId, setQUserId] = useState(() => searchParams.get('userId') ?? '');
  const [qPath, setQPath] = useState('');
  const [qRequestId, setQRequestId] = useState('');
  const [qStatusCode, setQStatusCode] = useState('');
  const [qFrom, setQFrom] = useState('');
  const [qTo, setQTo] = useState('');

  const [metaClientTypes, setMetaClientTypes] = useState<string[]>([]);
  const [metaMethods, setMetaMethods] = useState<string[]>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  const [metaUserIds, setMetaUserIds] = useState<string[]>([]);
  const [metaAppNames, setMetaAppNames] = useState<string[]>([]);
  // 请求状态使用固定选项，不依赖数据库
  const fixedStatuses = [
    { value: 'running', label: '进行中' },
    { value: 'completed', label: '完成' },
    { value: 'failed', label: '失败' },
    { value: 'timeout', label: '超时' },
  ];
  const [qClientType, setQClientType] = useState('');
  const [qMethod, setQMethod] = useState('');
  const [qAppName, setQAppName] = useState('');
  const [qDirection, setQDirection] = useState('');
  const [qStatus, setQStatus] = useState('');
  const commonStatusCodes = [200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];
  const [excludeNoise, setExcludeNoise] = useState(true);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiRequestLog | null>(null);
  const [copiedHint, setCopiedHint] = useState('');
  const [relatedLlmLogs, setRelatedLlmLogs] = useState<LlmRequestLogListItem[]>([]);
  const [relatedLlmLoading, setRelatedLlmLoading] = useState(false);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);

  const loadMeta = async () => {
    const res = await getApiLogsMeta();
    if (res.success) {
      setMetaClientTypes(res.data.clientTypes ?? []);
      setMetaMethods(res.data.methods ?? metaMethods);
      setMetaUserIds(res.data.userIds ?? []);
      setMetaAppNames(res.data.appNames ?? []);
    }
  };

  // 加载进行中任务（独立请求，用于自动刷新）
  const loadRunning = useCallback(async () => {
    // 如果用户筛选了非 running 状态，则不显示进行中区域
    if (qStatus && qStatus !== 'running') {
      setRunningItems([]);
      return;
    }
    setRunningLoading(true);
    try {
      const statusCodeValue = qStatusCode.trim() ? Number(qStatusCode) : undefined;
      const statusCode = Number.isFinite(statusCodeValue ?? NaN) ? statusCodeValue : undefined;
      const res = await getApiLogs({
        page: 1,
        pageSize: 100, // 进行中任务通常不会太多
        userId: qUserId || undefined,
        path: qPath || undefined,
        requestId: qRequestId || undefined,
        statusCode,
        clientType: qClientType || undefined,
        method: qMethod || undefined,
        appName: qAppName || undefined,
        direction: qDirection || undefined,
        status: 'running', // 固定筛选进行中
        from: qFrom || undefined,
        to: qTo || undefined,
        excludeNoise: excludeNoise || undefined,
      });
      if (res.success) {
        const newItems = res.data.items;
        const newIds = new Set(newItems.map((it) => it.id));
        const prevIds = prevRunningIdsRef.current;

        // 检测完成的任务（之前存在，现在不存在）
        const completedIds = [...prevIds].filter((id) => !newIds.has(id));
        if (completedIds.length > 0) {
          // 触发消失动画
          setFadingOutIds((prev) => new Set([...prev, ...completedIds]));
          // 动画结束后移除
          setTimeout(() => {
            setFadingOutIds((prev) => {
              const next = new Set(prev);
              completedIds.forEach((id) => next.delete(id));
              return next;
            });
          }, 500);
        }

        prevRunningIdsRef.current = newIds;
        setRunningItems(newItems);
      }
    } finally {
      setRunningLoading(false);
    }
  }, [qUserId, qPath, qRequestId, qStatusCode, qClientType, qMethod, qAppName, qDirection, qStatus, qFrom, qTo, excludeNoise]);

  // 加载非进行中任务（分页）
  const load = useCallback(async (opts?: { resetPage?: boolean }) => {
    if (opts?.resetPage) setPage(1);
    setLoading(true);
    try {
      const statusCodeValue = qStatusCode.trim() ? Number(qStatusCode) : undefined;
      const statusCode = Number.isFinite(statusCodeValue ?? NaN) ? statusCodeValue : undefined;
      // 如果用户筛选了 running，则下栏不显示
      const effectiveStatus = qStatus === 'running' ? '__none__' : (qStatus || undefined);
      const res = await getApiLogs({
        page: opts?.resetPage ? 1 : page,
        pageSize,
        userId: qUserId || undefined,
        path: qPath || undefined,
        requestId: qRequestId || undefined,
        statusCode,
        clientType: qClientType || undefined,
        method: qMethod || undefined,
        appName: qAppName || undefined,
        direction: qDirection || undefined,
        status: effectiveStatus,
        excludeRunning: !qStatus || qStatus !== 'running', // 排除 running
        from: qFrom || undefined,
        to: qTo || undefined,
        excludeNoise: excludeNoise || undefined,
      });
      if (res.success) {
        setItems(res.data.items);
        setTotal(res.data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, qUserId, qPath, qRequestId, qStatusCode, qClientType, qMethod, qAppName, qDirection, qStatus, qFrom, qTo, excludeNoise]);

  const loadDetail = async (id: string) => {
    setSelectedId(id);
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    setCopiedHint('');
    setRelatedLlmLogs([]);
    setRelatedLlmLoading(false);
    try {
      const res = await getApiLogDetail(id);
      if (res.success) {
        setDetail(res.data);
        // 如果有 requestId，则加载关联 LLM 日志
        if (res.data.requestId) {
          setRelatedLlmLoading(true);
          const llmRes = await getLlmLogs({ requestId: res.data.requestId, pageSize: 50 });
          if (llmRes.success) {
            setRelatedLlmLogs(llmRes.data.items);
          }
          setRelatedLlmLoading(false);
        }
      }
    } finally {
      setDetailLoading(false);
    }
  };

  // 初始化加载
  useEffect(() => {
    void loadMeta();
    void loadRunning();
    void load({ resetPage: true });
  }, [load, loadRunning]);

  // 分页变化时重新加载
  useEffect(() => {
    void load();
  }, [page, load]);

  // 自动刷新进行中任务（每 3 秒）
  useEffect(() => {
    const interval = setInterval(() => {
      void loadRunning();
    }, 3000);
    return () => clearInterval(interval);
  }, [loadRunning]);

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <GlassCard glow className="p-4 flex-1 min-h-0 flex flex-col">
        <div className="grid gap-3 grid-cols-2 md:grid-cols-7">
          <Select
            value={qUserId}
            onChange={(e) => setQUserId(e.target.value)}
            uiSize="sm"
            style={inputStyle}
          >
            <option value="">用户</option>
            {metaUserIds.map((uid) => (
              <option key={uid} value={uid}>{uid}</option>
            ))}
          </Select>
          <Select
            value={qAppName}
            onChange={(e) => setQAppName(e.target.value)}
            uiSize="sm"
            style={inputStyle}
          >
            <option value="">应用</option>
            {metaAppNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </Select>
          <Select
            value={qMethod}
            onChange={(e) => setQMethod(e.target.value)}
            uiSize="sm"
            style={inputStyle}
          >
            <option value="">方法</option>
            {metaMethods.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </Select>
          <Select
            value={qStatusCode}
            onChange={(e) => setQStatusCode(e.target.value)}
            uiSize="sm"
            style={inputStyle}
          >
            <option value="">状态</option>
            {commonStatusCodes.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </Select>
          <Select
            value={qClientType}
            onChange={(e) => setQClientType(e.target.value)}
            uiSize="sm"
            style={inputStyle}
          >
            <option value="">客户端</option>
            {metaClientTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
          <Select
            value={qDirection}
            onChange={(e) => setQDirection(e.target.value)}
            uiSize="sm"
            style={inputStyle}
          >
            <option value="">方向</option>
            <option value="inbound">入站</option>
            <option value="outbound">出站</option>
          </Select>
          <Select
            value={qStatus}
            onChange={(e) => setQStatus(e.target.value)}
            uiSize="sm"
            style={inputStyle}
          >
            <option value="">请求状态</option>
            {fixedStatuses.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>
        </div>
        <div className="mt-3 grid gap-3 grid-cols-2 md:grid-cols-4">
          <div className="relative">
            <Server size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qPath}
              onChange={(e) => setQPath(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="path"
            />
          </div>
          <div className="relative">
            <Hash size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qRequestId}
              onChange={(e) => setQRequestId(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="requestId"
            />
          </div>
          <input
            type="datetime-local"
            value={qFrom}
            onChange={(e) => setQFrom(e.target.value)}
            className="h-9 w-full rounded-[12px] px-3 text-sm outline-none"
            style={inputStyle}
            placeholder="开始时间"
          />
          <input
            type="datetime-local"
            value={qTo}
            onChange={(e) => setQTo(e.target.value)}
            className="h-9 w-full rounded-[12px] px-3 text-sm outline-none"
            style={inputStyle}
            placeholder="结束时间"
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              共 {total} 条 · 第 {page}/{totalPages} 页
            </div>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={excludeNoise}
                onChange={(e) => setExcludeNoise(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-[var(--color-primary)]"
              />
              过滤噪声日志
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => load({ resetPage: true })} disabled={loading}>
              <Filter size={16} />
              应用过滤
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQUserId('');
                setQPath('');
                setQRequestId('');
                setQClientType('');
                setQMethod('');
                setQStatusCode('');
                setQAppName('');
                setQDirection('');
                setQStatus('');
                setQFrom('');
                setQTo('');
              }}
              disabled={loading}
            >
              清空
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={loading || page <= 1}>
              上一页
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={loading || page >= totalPages}>
              下一页
            </Button>
          </div>
        </div>

        {/* 进行中任务区域（上栏） */}
        {(runningItems.length > 0 || fadingOutIds.size > 0) && qStatus !== 'completed' && qStatus !== 'failed' && qStatus !== 'timeout' && (
          <div
            className="mt-4 rounded-[14px] p-3"
            style={{
              background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, rgba(147, 51, 234, 0.08) 100%)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              maxHeight: '50%',
              overflow: 'auto',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Zap size={14} style={{ color: 'rgba(59, 130, 246, 0.9)' }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                进行中 ({runningItems.length})
              </span>
              {runningLoading && <Loader2 size={12} className="animate-spin" style={{ color: 'var(--text-muted)' }} />}
            </div>
            <div className="grid gap-2">
              {runningItems.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => void loadDetail(it.id)}
                  className={`text-left rounded-[12px] px-3 py-2 transition-all hover:bg-white/10 ${
                    fadingOutIds.has(it.id) ? 'animate-fade-out' : ''
                  }`}
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(59, 130, 246, 0.2)',
                    animation: fadingOutIds.has(it.id) ? 'fadeOut 0.5s ease-out forwards' : undefined,
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex items-center gap-2">
                      {statusBadge(it.statusCode, it.status)}
                      <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {it.method} {it.path}
                      </span>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {buildMetaLabel(it)}
                      </span>
                    </div>
                    <div className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                      <Clock size={12} className="animate-pulse" />
                      {formatLocalTime(it.startedAt)}
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    userId={it.userId}{it.clientIp ? ` · IP=${it.clientIp}` : ''}{it.groupId ? ` · groupId=${it.groupId}` : ''}{it.sessionId ? ` · sessionId=${it.sessionId}` : ''}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 已完成任务区域（下栏） */}
        {qStatus !== 'running' && (
          <div className="mt-4 flex-1 min-h-0 overflow-auto grid gap-2 content-start">
            {loading && (
              <div className="text-sm flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                <Loader2 size={16} className="animate-spin" />
                加载中…
              </div>
            )}
            {!loading && items.length === 0 && (
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
            )}
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => void loadDetail(it.id)}
                className="text-left rounded-[14px] px-3 py-2 transition-colors hover:bg-white/5"
                style={{ border: '1px solid var(--border-subtle)' }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    {statusBadge(it.statusCode, it.status)}
                    <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {it.method} {it.path}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {buildMetaLabel(it)}
                    </span>
                  </div>
                  <div className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                    <Clock size={12} />
                    {formatLocalTime(it.startedAt)}{it.durationMs != null ? ` · ${fmtNum(it.durationMs)}ms` : ''}
                  </div>
                </div>
                <div className="mt-1 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                  userId={it.userId}{it.clientIp ? ` · IP=${it.clientIp}` : ''}{it.groupId ? ` · groupId=${it.groupId}` : ''}{it.sessionId ? ` · sessionId=${it.sessionId}` : ''}{it.apiSummary ? ` · ${it.apiSummary}` : ''}
                </div>
                {(it.requestBodyPreview || it.curlPreview) && (
                  <div className="mt-2 text-[11px] grid gap-1">
                    {it.requestBodyPreview && (
                      <div className="truncate" style={{ color: 'rgba(231,206,151,0.85)' }}>
                        req：{it.requestBodyPreview}{it.requestBodyTruncated ? '（截断）' : ''}
                      </div>
                    )}
                    {it.curlPreview && (
                      <div className="truncate" style={{ color: 'rgba(231,206,151,0.65)' }}>
                        curl：{it.curlPreview}
                      </div>
                    )}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}

        {/* 淡出动画样式 */}
        <style>{`
          @keyframes fadeOut {
            0% { opacity: 1; transform: translateX(0); }
            100% { opacity: 0; transform: translateX(20px); }
          }
        `}</style>
      </GlassCard>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => setDetailOpen(open)}
        title="API 请求日志详情"
        maxWidth={980}
        content={
          <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {detail?.method || '-'} {detail?.path || '-'}
              </div>
              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                id={selectedId || '-'} · requestId={detail?.requestId || '-'} · userId={detail?.userId || '-'}{detail?.clientIp ? ` · IP=${detail.clientIp}` : ''}
              </div>
            </div>
            {detail?.curl && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void copyToClipboard(detail.curl || '');
                  setCopiedHint('已复制 curl');
                  setTimeout(() => setCopiedHint(''), 1200);
                }}
              >
                <Copy size={16} />
                复制 curl
              </Button>
            )}
          </div>

          {copiedHint && (
            <div className="text-xs" style={{ color: 'rgba(34,197,94,0.95)' }}>{copiedHint}</div>
          )}

          {detailLoading && (
            <div className="text-sm flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <Loader2 size={16} className="animate-spin" />
              加载详情中…
            </div>
          )}

          {!detailLoading && detail && (
            <>
              <div className="grid gap-2 md:grid-cols-3">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  status：{detail.statusCode} · durationMs：{fmtNum(detail.durationMs)}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  startedAt：{formatLocalTime(detail.startedAt)}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  client：{detail.clientType || '—'}{detail.clientId ? `(${detail.clientId})` : ''} · app：{detail.appId || detail.appName ? (detail.appName || 'unknown') : '—'}{detail.appId ? `(${detail.appId})` : ''}
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  IP：{detail.clientIp || '—'}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  UserAgent：{detail.userAgent || '—'}
                </div>
              </div>

              {detail.requestBody && (
                <div>
                  <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                    Request Body{detail.requestBodyTruncated ? '（已截断）' : ''}
                  </div>
                  <div style={codeBoxStyle()}>{detail.requestBody}</div>
                </div>
              )}

              {detail.responseBody && (
                <div>
                  <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                    Response Body{detail.responseBodyTruncated ? '（已截断）' : ''}{detail.responseBodyBytes ? ` · ${detail.responseBodyBytes} bytes` : ''}
                  </div>
                  <div style={codeBoxStyle()}>{detail.responseBody}</div>
                </div>
              )}

              {detail.curl && (
                <div>
                  <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>cURL</div>
                  <div style={codeBoxStyle()}>{detail.curl}</div>
                </div>
              )}

              {/* 关联 LLM 日志 */}
              {detail.requestId && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      关联 LLM 日志（通过 requestId 查询）
                    </div>
                    <a
                      href={`/llm-logs?requestId=${encodeURIComponent(detail.requestId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-xs hover:underline"
                      style={{ color: 'var(--text-link)' }}
                    >
                      查看关联日志
                      <ChevronRight size={12} />
                    </a>
                  </div>
                  <div
                    style={{
                      background: 'rgba(0,0,0,0.2)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 12,
                      padding: 12,
                      maxHeight: '20vh',
                      overflow: 'auto',
                    }}
                  >
                    {relatedLlmLoading ? (
                      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        <Loader2 size={14} className="animate-spin" />
                        加载中...
                      </div>
                    ) : relatedLlmLogs.length === 0 ? (
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        未找到关联的 LLM 请求日志
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          找到 {relatedLlmLogs.length} 条关联的 LLM 请求日志
                        </div>
                        {relatedLlmLogs.map((llm) => (
                          <div
                            key={llm.id}
                            className="flex items-center gap-3 text-xs p-2 rounded-lg"
                            style={{ background: 'rgba(255,255,255,0.05)' }}
                          >
                            <Badge
                              variant={llm.status === 'succeeded' ? 'success' : llm.status === 'failed' ? 'subtle' : 'new'}
                              size="sm"
                            >
                              {llm.status === 'succeeded' ? '成功' : llm.status === 'failed' ? '失败' : llm.status === 'running' ? '运行中' : llm.status}
                            </Badge>
                            <span style={{ color: 'var(--text-primary)' }}>{llm.model || '—'}</span>
                            <span style={{ color: 'var(--text-muted)' }}>
                              {(llm.inputTokens ?? 0) + (llm.outputTokens ?? 0)} tokens
                            </span>
                            <span style={{ color: 'var(--text-muted)' }}>
                              {llm.durationMs != null ? `${(llm.durationMs / 1000).toFixed(1)}s` : '—'}
                            </span>
                            {llm.requestPurpose && (
                              <span style={{ color: 'var(--text-muted)' }}>{llm.requestPurpose}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          </div>
        }
      />
    </div>
  );
}
