import { useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { openPlatformService } from '@/services';
import { RefreshCw, Clock, ExternalLink } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { OpenPlatformApp, OpenPlatformRequestLog } from '@/services/contracts/openPlatform';

interface LogsPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

function fmtDate(v?: string | null) {
  if (!v) return '-';
  return new Date(v).toLocaleString('zh-CN');
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

  // 传递 actions 给父容器
  useEffect(() => {
    onActionsReady?.(
      <>
        <Select value={filterAppId} onChange={(e) => { setFilterAppId(e.target.value); setPage(1); }} uiSize="sm">
          <option value="">全部应用</option>
          {apps.map((app) => <option key={app.id} value={app.id}>{app.appName}</option>)}
        </Select>
        <Select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }} uiSize="sm">
          <option value="">全部状态</option>
          <option value="success">成功 (2xx)</option>
          <option value="error">失败 (4xx/5xx)</option>
        </Select>
        <Button variant="secondary" size="sm" onClick={loadLogs}>
          <RefreshCw size={14} />
        </Button>
      </>
    );
  }, [filterAppId, filterStatus, apps, onActionsReady]);

  const openDetail = (log: OpenPlatformRequestLog) => {
    setSelectedLog(log);
    setDetailOpen(true);
  };

  return (
    <div className="h-full flex flex-col gap-4">
      <GlassCard glow className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0" style={{ background: 'rgba(0,0,0,0.4)' }}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">时间</th>
                <th className="px-4 py-3 text-left text-sm font-medium">应用</th>
                <th className="px-4 py-3 text-left text-sm font-medium">路径</th>
                <th className="px-4 py-3 text-left text-sm font-medium">状态</th>
                <th className="px-4 py-3 text-left text-sm font-medium">耗时</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Token</th>
                <th className="px-4 py-3 text-right text-sm font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.id}
                  className="transition-colors hover:bg-white/[0.02] cursor-pointer"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                  onClick={() => openDetail(log)}
                >
                  <td className="px-4 py-3 text-sm text-muted-foreground">{fmtDate(log.startedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-sm">{log.appName}</div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs bg-muted px-2 py-1 rounded">{log.path}</code>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={log.statusCode >= 200 && log.statusCode < 300 ? 'success' : 'subtle'} size="sm">
                      {log.statusCode}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock size={12} />
                      <span>{log.durationMs}ms</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {log.inputTokens !== null && log.outputTokens !== null
                      ? `${log.inputTokens} / ${log.outputTokens}`
                      : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <Button variant="ghost" size="xs" onClick={(e) => { e.stopPropagation(); openDetail(log); }}>
                        <ExternalLink size={12} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {logs.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">暂无调用日志</div>
          )}
        </div>

        {total > pageSize && (
          <div className="p-4 border-t flex justify-between items-center" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <div className="text-sm text-muted-foreground">共 {total} 条</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button>
              <Button variant="secondary" size="sm" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(page + 1)}>下一页</Button>
            </div>
          </div>
        )}
      </GlassCard>

      {/* 日志详情弹窗 */}
      <Dialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title="请求详情"
        maxWidth={700}
        content={
          selectedLog && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs font-medium mb-1 text-muted-foreground">请求 ID</div>
                  <code className="text-xs px-2 py-1 rounded block bg-black/30">{selectedLog.requestId}</code>
                </div>
                <div>
                  <div className="text-xs font-medium mb-1 text-muted-foreground">应用名称</div>
                  <div className="text-sm font-medium">{selectedLog.appName}</div>
                </div>
                <div>
                  <div className="text-xs font-medium mb-1 text-muted-foreground">请求时间</div>
                  <div className="text-sm">{fmtDate(selectedLog.startedAt)}</div>
                </div>
                <div>
                  <div className="text-xs font-medium mb-1 text-muted-foreground">完成时间</div>
                  <div className="text-sm">{fmtDate(selectedLog.endedAt)}</div>
                </div>
                <div>
                  <div className="text-xs font-medium mb-1 text-muted-foreground">状态码</div>
                  <Badge variant={selectedLog.statusCode >= 200 && selectedLog.statusCode < 300 ? 'success' : 'subtle'}>
                    {selectedLog.statusCode}
                  </Badge>
                </div>
                <div>
                  <div className="text-xs font-medium mb-1 text-muted-foreground">耗时</div>
                  <div className="text-sm font-medium">{selectedLog.durationMs}ms</div>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium mb-1 text-muted-foreground">请求路径</div>
                <code className="text-xs px-2 py-1 rounded block bg-black/30">
                  {selectedLog.method} {selectedLog.path}
                </code>
              </div>

              {(selectedLog.inputTokens !== null || selectedLog.outputTokens !== null) && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-medium mb-1 text-muted-foreground">输入 Token</div>
                    <div className="text-sm font-medium">{selectedLog.inputTokens ?? '-'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium mb-1 text-muted-foreground">输出 Token</div>
                    <div className="text-sm font-medium">{selectedLog.outputTokens ?? '-'}</div>
                  </div>
                </div>
              )}

              {selectedLog.errorCode && (
                <div>
                  <div className="text-xs font-medium mb-1 text-red-400">错误码</div>
                  <code className="text-xs px-2 py-1 rounded block bg-red-500/10 text-red-400">
                    {selectedLog.errorCode}
                  </code>
                </div>
              )}

              <div className="flex justify-end pt-4">
                <Button onClick={() => setDetailOpen(false)}>关闭</Button>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}
