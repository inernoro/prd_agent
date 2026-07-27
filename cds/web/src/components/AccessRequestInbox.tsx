/*
 * AccessRequestInbox — 被动授权审批提醒(右下角)
 *
 * 背景:agent 免密直接发起授权申请,用户在右下角一键「批准」即派发一把
 * 全权「授权密钥」,agent 凭它做接下来的所有事(含直接拉项目环境变量/参数),用户
 * 再不用反复手动喂参数。授权属于必须由用户决策的高优先级消息:
 *   - 有 pending 时直接展开首条申请,展示来源、范围和目的
 *   - 卡片上直接提供「批准 / 拒绝」按钮,无需先点开一个小徽章
 *   - Dialog 负责查看全部 pending 和补充说明
 *   - 订阅 useCdsEvents.lastAccessRequestEvent → 自动刷新
 *   - 挂在 AppShell,任何页面可见
 *
 * 安全:操作员永远看不到授权密钥明文(批准后由发起方凭 pollToken 轮询取走一次)。
 */

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { useCdsEvents } from '@/hooks/useCdsEvents';

interface AccessRequest {
  id: string;
  kind?: 'project' | 'bootstrap';
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
  const primary = pending[0];
  const primaryBusy = busy === primary.id;

  return (
    <>
      <section
        className="relative w-full overflow-hidden rounded-xl border border-amber-500/45
                   bg-[hsl(var(--surface-raised))] shadow-2xl"
        role="alert"
        aria-live="assertive"
        aria-label={`${count} 个授权申请需要处理`}
      >
        <div className="absolute inset-y-0 left-0 w-1 bg-amber-500" aria-hidden />
        <div className="p-4 pl-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full
                            bg-amber-500/15 text-amber-700 dark:text-amber-300">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-foreground">需要你的授权</h2>
                <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full
                                 bg-amber-500 px-2 text-xs font-bold text-black">
                  {count}
                </span>
              </div>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                <strong className="text-foreground">{primary.agentName || '未知 Agent'}</strong>
                {' '}申请
                {primary.kind === 'bootstrap' ? '创建一个新项目' : (
                  <>访问项目 <code className="font-mono text-foreground">{primary.projectId}</code></>
                )}
              </p>
              {primary.purpose ? (
                <p className="mt-2 rounded-md bg-[hsl(var(--surface-sunken))] px-3 py-2
                              text-xs leading-5 text-foreground/85">
                  {primary.purpose}
                </p>
              ) : null}
              <p className="mt-2 text-[11px] text-muted-foreground">
                {new Date(primary.createdAt).toLocaleString('zh-CN')}，授权内容只会交付给发起方一次
              </p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-10"
              onClick={() => { void reject(primary.id); }}
              disabled={primaryBusy}
            >
              {primaryBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              拒绝
            </Button>
            <Button
              type="button"
              variant="default"
              className="min-h-10"
              onClick={() => { void approve(primary.id); }}
              disabled={primaryBusy}
            >
              {primaryBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {primary.kind === 'bootstrap' ? '批准一次建项目' : '批准项目访问'}
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-2 min-h-10 w-full rounded-md text-xs font-medium text-muted-foreground
                       transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
          >
            {count > 1 ? `查看全部 ${count} 条申请` : '查看申请详情'}
          </button>
        </div>
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-3xl overflow-hidden"
          style={{ maxHeight: 'min(780px, calc(100dvh - 32px))' }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              需要你的明确授权
            </DialogTitle>
            <DialogDescription>
              外部 Agent 可以在没有预置密钥时发起申请。已有项目会签发该项目的授权；首次接入
              只签发一次性建项目权限，项目创建后自动失效。授权内容只交付给发起方一次，此处不显示。
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
                        {item.kind === 'bootstrap' ? (
                          <span className="font-medium text-foreground">范围: 创建一个新项目</span>
                        ) : (
                          <>项目: <code className="font-mono">{item.projectId}</code></>
                        )}
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
                        {item.kind === 'bootstrap' ? '批准一次建项目' : '批准项目访问'}
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
