import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { openPlatformService } from '@/services';
import { RefreshCw, Clock, ExternalLink, FileText, Search, CheckCircle, XCircle, Zap, ArrowRight } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { OpenPlatformApp, OpenPlatformRequestLog } from '@/services/contracts/openPlatform';

interface LogsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
}

function fmtTime(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleTimeString('zh-CN');
}

export default function LogsPanel({ onActionsReady }: LogsPanelProps) {
  const [logs, setLogs] = useState<OpenPlatformRequestLog[]>([]);
  const [apps, setApps] = useState<OpenPlatformApp[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);
  const [loading, setLoading] = useState(false);
  const [filterAppId, setFilterAppId] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [selectedLog, setSelectedLog] = useState<OpenPlatformRequestLog | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadApps = async () => {
    try {
      const res = await openPlatformService.getApps(1, 100);
      setApps(res.items);
    } catch (err) {
      console.error('Load apps failed:', err);
    }
  };

  const loadLogs = async () => {
    setLoading(true);
    try {
      const res = await openPlatformService.getLogs(page, pageSize, filterAppId || undefined);
      // 前端过滤状态码
      let filteredItems = res.items;
      if (filterStatus === 'success') {
        filteredItems = res.items.filter(log => log.statusCode >= 200 && log.statusCode < 300);
      } else if (filterStatus === 'error') {
        filteredItems = res.items.filter(log => log.statusCode >= 400);
      }
      setLogs(filteredItems);
      setTotal(filterStatus ? filteredItems.length : res.total);
    } catch (err) {
      toast.error('加载失败', String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadApps(); }, []);
  useEffect(() => { loadLogs(); }, [page, filterAppId, filterStatus]);

  useEffect(() => {
    onActionsReady?.(
      <Button variant="secondary" size="sm" onClick={loadLogs}>
        <RefreshCw size={14} />
      </Button>
    );
  }, [onActionsReady]);

  const openDetail = (log: OpenPlatformRequestLog) => {
    setSelectedLog(log);
    setDetailOpen(true);
  };

  const isSuccess = (code: number) => code >= 200 && code < 300;

  return (
    <div className="h-full overflow-auto p-1">
      <GlassCard glow className="min-h-full">
        {/* 顶部提示栏 */}
        <div className="p-4 border-b border-white/10" style={{ background: 'var(--list-item-bg)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FileText size={18} className="text-muted-foreground" />
              <span>查看 API 调用的请求日志和响应详情</span>
            </div>
            <a href="#" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
              了解更多 <ExternalLink size={12} />
            </a>
          </div>
        </div>

        <div className="p-5 space-y-5">
          {/* 日志列表 */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium">请求日志</h3>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="搜索..."
                    className="h-8 pl-8 pr-3 text-sm rounded-lg outline-none"
                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-default)', width: '140px' }}
                    disabled
                  />
                </div>
                <Select value={filterAppId} onChange={(e) => { setFilterAppId(e.target.value); setPage(1); }} uiSize="sm">
                  <option value="">全部应用</option>
                  {apps.map((app) => <option key={app.id} value={app.id}>{app.appName}</option>)}
                </Select>
                <Select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }} uiSize="sm">
                  <option value="">全部状态</option>
                  <option value="success">成功 (2xx)</option>
                  <option value="error">失败 (4xx/5xx)</option>
                </Select>
              </div>
            </div>

            {/* 日志卡片列表 */}
            <div className="space-y-2">
              {logs.length === 0 && !loading ? (
                <div className="text-center py-8 text-muted-foreground">
                  {filterAppId || filterStatus ? '未找到匹配的日志' : '暂无调用日志'}
                </div>
              ) : (
                logs.map((log) => (
                  <div
                    key={log.id}
                    className="p-4 rounded-lg transition-colors hover:bg-white/[0.03] cursor-pointer"
                    style={{
                      background: isSuccess(log.statusCode) ? 'rgba(34,197,94,0.04)' : 'rgba(239,68,68,0.04)',
                      border: `1px solid ${isSuccess(log.statusCode) ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}`,
                    }}
                    onClick={() => openDetail(log)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 flex-1 min-w-0">
                        {/* 状态图标 */}
                        <div
                          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{
                            background: isSuccess(log.statusCode) ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                          }}
                        >
                          {isSuccess(log.statusCode)
                            ? <CheckCircle size={16} className="text-green-400" />
                            : <XCircle size={16} className="text-red-400" />
                          }
                        </div>

                        {/* 主要信息 */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={log.method === 'POST' ? 'featured' : log.method === 'GET' ? 'success' : 'subtle'}
                              size="sm"
                            >
                              {log.method}
                            </Badge>
                            <code className="text-sm font-mono truncate">{log.path}</code>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span className="font-medium">{log.appName}</span>
                            <span>·</span>
                            <span>{fmtTime(log.startedAt)}</span>
                          </div>
                        </div>

                        {/* 请求 ID */}
                        <code className="text-xs text-muted-foreground px-2 py-1 rounded flex-shrink-0" style={{ background: 'var(--nested-block-bg)' }}>
                          {log.requestId.slice(-12)}
                        </code>
                      </div>

                      {/* 右侧指标 */}
                      <div className="flex items-center gap-6 ml-4">
                        {/* 状态码 */}
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={isSuccess(log.statusCode) ? 'success' : 'discount'}
                            size="sm"
                          >
                            {log.statusCode}
                          </Badge>
                        </div>

                        {/* 耗时 */}
                        <div className="flex items-center gap-1.5 w-[80px]">
                          <Clock size={12} className="text-muted-foreground" />
                          <span className={`text-sm ${(log.durationMs ?? 0) > 1000 ? 'text-yellow-400' : (log.durationMs ?? 0) > 3000 ? 'text-red-400' : ''}`}>
                            {log.durationMs ?? '-'}ms
                          </span>
                        </div>

                        {/* Token */}
                        <div className="flex items-center gap-1.5 w-[100px] text-xs text-muted-foreground">
                          {log.inputTokens !== null && log.outputTokens !== null ? (
                            <>
                              <Zap size={12} />
                              <span className="text-blue-400">{log.inputTokens}</span>
                              <ArrowRight size={10} />
                              <span className="text-green-400">{log.outputTokens}</span>
                            </>
                          ) : (
                            <span>-</span>
                          )}
                        </div>

                        {/* 详情按钮 */}
                        <Button variant="ghost" size="xs" onClick={(e) => { e.stopPropagation(); openDetail(log); }}>
                          <ExternalLink size={12} />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {total > pageSize && (
              <div className="flex justify-between items-center pt-4 mt-4 border-t border-white/10">
                <div className="text-sm text-muted-foreground">共 {total} 条</div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button>
                  <Button variant="secondary" size="sm" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(page + 1)}>下一页</Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </GlassCard>

      {/* 日志详情弹窗 */}
      <Dialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title="请求详情"
        maxWidth={700}
        contentClassName="max-h-[85vh] overflow-y-auto"
        content={
          selectedLog && (
            <div className="space-y-5">
              {/* 状态概览 */}
              <div
                className="p-4 rounded-lg flex items-center justify-between"
                style={{
                  background: isSuccess(selectedLog.statusCode) ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                  border: `1px solid ${isSuccess(selectedLog.statusCode) ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{
                      background: isSuccess(selectedLog.statusCode) ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                    }}
                  >
                    {isSuccess(selectedLog.statusCode)
                      ? <CheckCircle size={20} className="text-green-400" />
                      : <XCircle size={20} className="text-red-400" />
                    }
                  </div>
                  <div>
                    <div className={`text-sm font-medium ${isSuccess(selectedLog.statusCode) ? 'text-green-400' : 'text-red-400'}`}>
                      {isSuccess(selectedLog.statusCode) ? '请求成功' : '请求失败'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      状态码 {selectedLog.statusCode} · 耗时 {selectedLog.durationMs}ms
                    </div>
                  </div>
                </div>
                <Badge
                  variant={isSuccess(selectedLog.statusCode) ? 'success' : 'discount'}
                  size="default"
                >
                  {selectedLog.statusCode}
                </Badge>
              </div>

              <div className="border-t border-white/10" />

              {/* 基本信息 */}
              <div>
                <h4 className="text-sm font-medium mb-3">请求信息</h4>
                <div className="space-y-2">
                  <InfoRow label="请求 ID" value={selectedLog.requestId} mono />
                  <InfoRow label="应用名称" value={selectedLog.appName} />
                  <InfoRow label="请求路径">
                    <div className="flex items-center gap-2">
                      <Badge variant={selectedLog.method === 'POST' ? 'featured' : 'success'} size="sm">
                        {selectedLog.method}
                      </Badge>
                      <code className="text-xs">{selectedLog.path}</code>
                    </div>
                  </InfoRow>
                </div>
              </div>

              <div className="border-t border-white/10" />

              {/* 时间信息 */}
              <div>
                <h4 className="text-sm font-medium mb-3">时间信息</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div
                    className="p-3 rounded-lg"
                    style={{ background: 'var(--nested-block-bg)', border: '1px solid var(--border-subtle)' }}
                  >
                    <div className="text-xs text-muted-foreground mb-1">开始时间</div>
                    <div className="text-sm font-medium">{fmtDate(selectedLog.startedAt)}</div>
                  </div>
                  <div
                    className="p-3 rounded-lg"
                    style={{ background: 'var(--nested-block-bg)', border: '1px solid var(--border-subtle)' }}
                  >
                    <div className="text-xs text-muted-foreground mb-1">结束时间</div>
                    <div className="text-sm font-medium">{fmtDate(selectedLog.endedAt)}</div>
                  </div>
                </div>
              </div>

              {/* Token 使用 */}
              {(selectedLog.inputTokens !== null || selectedLog.outputTokens !== null) && (
                <>
                  <div className="border-t border-white/10" />
                  <div>
                    <h4 className="text-sm font-medium mb-3">Token 使用</h4>
                    <div className="grid grid-cols-3 gap-3">
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)' }}
                      >
                        <div className="text-xl font-bold text-blue-400">{selectedLog.inputTokens ?? '-'}</div>
                        <div className="text-xs text-muted-foreground mt-1">输入 Token</div>
                      </div>
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }}
                      >
                        <div className="text-xl font-bold text-green-400">{selectedLog.outputTokens ?? '-'}</div>
                        <div className="text-xs text-muted-foreground mt-1">输出 Token</div>
                      </div>
                      <div
                        className="p-3 rounded-lg text-center"
                        style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)' }}
                      >
                        <div className="text-xl font-bold text-purple-400">
                          {selectedLog.inputTokens != null && selectedLog.outputTokens != null
                            ? (selectedLog.inputTokens ?? 0) + (selectedLog.outputTokens ?? 0)
                            : '-'}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">总计</div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* 错误信息 */}
              {selectedLog.errorCode && (
                <>
                  <div className="border-t border-white/10" />
                  <div>
                    <h4 className="text-sm font-medium mb-3 text-red-400">错误信息</h4>
                    <div
                      className="p-3 rounded-lg"
                      style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}
                    >
                      <code className="text-sm text-red-400">{selectedLog.errorCode}</code>
                    </div>
                  </div>
                </>
              )}

              {/* 操作按钮 */}
              <div className="flex justify-end pt-4 border-t border-white/10">
                <Button onClick={() => setDetailOpen(false)}>关闭</Button>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
  children,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children || (
        <span className={`text-sm text-right ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
      )}
    </div>
  );
}
