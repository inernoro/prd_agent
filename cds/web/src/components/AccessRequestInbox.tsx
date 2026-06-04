/*
 * AccessRequestInbox — 被动授权审批盒(右下角)
 *
 * 背景:agent 持永久「请求密钥」发起授权申请,用户在右下角一键「批准」即派发一把
 * 全权「授权密钥」,agent 凭它做接下来的所有事(含直接拉项目环境变量/参数),用户
 * 再不用反复手动喂参数。设计完全对齐 PendingImportInbox(同一个右下角被动审批底座):
 *   - 右下角悬浮 button(只在 pendingCount > 0 时显示),点击展开 Dialog
 *   - Dialog 列出全部 pending,每项一个「批准 / 拒绝」按钮
 *   - 订阅 useCdsEvents.lastAccessRequestEvent → 自动刷新
 *   - 挂在 AppShell,任何页面可见
 *
 * 安全:操作员永远看不到授权密钥明文(批准后由持请求密钥的 agent 轮询取走一次)。
 */

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { useCdsEvents } from '@/hooks/useCdsEvents';

interface AccessRequest {
  id: string;
  projectId: string;
  agentName: string;
  purpose: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

interface AccessRequestsResponse {
  requests?: AccessRequest[];
  pendingCount?: number;
}

export function AccessRequestInbox(): JSX.Element | null {
  const events = useCdsEvents();
  const [pending, setPending] = useState<AccessRequest[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiRequest<AccessRequestsResponse>('/api/access-requests');
      setPending((data.requests || []).filter((r) => r.status === 'pending'));
    } catch {
      // 静默 — degraded / 401 不该让这个组件爆错
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 事件驱动:agent 发起新申请 / 批准 / 拒绝后立即 refresh
  useEffect(() => {
    if (events.lastAccessRequestEvent) void refresh();
  }, [events.lastAccessRequestEvent, refresh]);

  const approve = useCallback(async (reqId: string) => {
    if (busy) return;
    setBusy(reqId);
    try {
      await apiRequest(`/api/access-requests/${encodeURIComponent(reqId)}/approve`, { method: 'POST' });
      setPending((prev) => prev.filter((r) => r.id !== reqId));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const reject = useCallback(async (reqId: string) => {
    if (busy) return;
    setBusy(reqId);
    try {
      await apiRequest(`/api/access-requests/${encodeURIComponent(reqId)}/reject`, { method: 'POST', body: {} });
      setPending((prev) => prev.filter((r) => r.id !== reqId));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const count = pending.length;
  if (count === 0) return null;

  return (
    <>
      {/* 右下角徽章 — pending-import 用 bottom-4,这里上移避免重叠 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-16 right-4 z-40 inline-flex items-center gap-2 rounded-full
                   cds-surface-elevated cds-hairline shadow-lg px-4 py-2 text-sm font-medium
                   text-foreground hover:scale-105 transition-transform"
        aria-label={`${count} 个待批准的授权申请`}
      >
        <KeyRound className="h-4 w-4" />
        <span>授权申请 {count}</span>
        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full
                         bg-destructive text-destructive-foreground text-[11px] px-1.5">
          {count}
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              授权申请待批准
            </DialogTitle>
            <DialogDescription>
              外部 Agent 用「请求密钥」发起的授权申请。批准会当场签发一把该项目的全权
              「授权密钥」交给 Agent —— Agent 凭它做接下来的所有操作(含直接读取项目环境
              变量),你无需再手动提供参数。授权密钥明文只交付给 Agent 一次,此处不显示。
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto space-y-3" style={{ minHeight: 0 }}>
            {pending.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">没有待批准的授权申请</div>
            ) : (
              pending.map((item) => {
                const isBusy = busy === item.id;
                return (
                  <div key={item.id} className="cds-surface-sunken cds-hairline rounded-md p-3">
                    <div className="text-sm">
                      <div className="font-semibold text-foreground">{item.agentName || '未知 Agent'}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        项目: <code className="font-mono">{item.projectId}</code>
                        {' · '}
                        {new Date(item.createdAt).toLocaleString('zh-CN')}
                      </div>
                      {item.purpose ? (
                        <div className="mt-1 text-xs text-foreground/80">{item.purpose}</div>
                      ) : null}
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => reject(item.id)} disabled={isBusy}>
                        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        拒绝
                      </Button>
                      <Button type="button" variant="default" size="sm" onClick={() => approve(item.id)} disabled={isBusy}>
                        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        批准并签发授权密钥
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
