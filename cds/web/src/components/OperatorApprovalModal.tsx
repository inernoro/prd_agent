/*
 * 运维操作审批全局弹窗(挂在 AppShell,任何页面都能弹)
 *
 * 2026-05-28 用户反馈:不希望进 UI 一个个点 op,要 AI 发起 + 全局弹窗 +
 * 「允许本次 / 允许本 session 所有同类 / 拒绝」三按钮。
 *
 * 工作原理:
 *   - 订阅 useCdsEvents.lastOperatorRequest(从 self.status 之外的 operator.*
 *     事件投影来)
 *   - 看到 pending request → 显示 Modal
 *   - 用户点按钮 → POST approve/reject + 关闭 Modal
 *   - 显示 caller 来源 / op danger 等级 / args / 估时
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, ShieldCheck, ShieldX, Wrench } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { useCdsEvents } from '@/hooks/useCdsEvents';

interface PendingRequest {
  id: string;
  opId: string;
  opName: string;
  opDanger: 'safe' | 'sensitive' | 'destructive';
  args?: Record<string, unknown>;
  requestedBy: string;
  requestedFromIp?: string;
  requestedAt: string;
  callerKey: string;
  status: string;
}

const DANGER_META: Record<string, { label: string; tone: string; icon: React.ReactNode }> = {
  safe: { label: '安全/只读', tone: 'text-emerald-700 dark:text-emerald-300', icon: <ShieldCheck className="h-4 w-4" /> },
  sensitive: { label: '会改运行时', tone: 'text-amber-700 dark:text-amber-300', icon: <AlertTriangle className="h-4 w-4" /> },
  destructive: { label: '高危', tone: 'text-destructive', icon: <ShieldX className="h-4 w-4" /> },
};

export function OperatorApprovalModal(): JSX.Element | null {
  const events = useCdsEvents();
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [busy, setBusy] = useState(false);

  // 拿当前所有 pending request,选最新一条展示
  const refresh = useCallback(async () => {
    try {
      const data = await apiRequest<{ pending: PendingRequest[] }>('/api/cds-system/operator/requests');
      const list = (data.pending || []).filter((r) => r.status === 'pending');
      if (list.length > 0) setPending(list[0]);
      else setPending(null);
    } catch {
      // 静默 — 服务不可达不应弹错
    }
  }, []);

  // 初始进页面拉一次
  useEffect(() => { void refresh(); }, [refresh]);

  // 订阅 cds-events 总线:operator.request.* 事件一来立即 refresh(实时弹窗)。
  // Codex review(PR #684, P2):此前只盯 lastHeartbeatAt → 新审批请求最多隐身 25s。
  // 现在 useCdsEvents 单独路由 operator.request.* 到 lastOperatorRequestEvent,
  // 这里观察它即可秒级反应;heartbeat 仍保留作兜底刷新。
  useEffect(() => {
    void refresh();
  }, [events.lastOperatorRequestEvent, events.lastHeartbeatAt, refresh]);

  const approve = useCallback(async (scope: 'once' | 'session') => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await apiRequest(`/api/cds-system/operator/requests/${encodeURIComponent(pending.id)}/approve`, {
        method: 'POST',
        body: { scope },
      });
      setPending(null);
      // 给后端一点时间 publish completed,再 refresh
      window.setTimeout(() => void refresh(), 500);
    } finally {
      setBusy(false);
    }
  }, [pending, busy, refresh]);

  const reject = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await apiRequest(`/api/cds-system/operator/requests/${encodeURIComponent(pending.id)}/reject`, {
        method: 'POST',
      });
      setPending(null);
    } finally {
      setBusy(false);
    }
  }, [pending, busy]);

  if (!pending) return null;
  const meta = DANGER_META[pending.opDanger] ?? DANGER_META.safe;

  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            AI 智能体请求执行运维操作
          </DialogTitle>
          <DialogDescription>
            发起者:<code className="font-mono">{pending.requestedBy}</code>
            {pending.requestedFromIp ? <> · IP <code className="font-mono">{pending.requestedFromIp}</code></> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="cds-surface-sunken cds-hairline rounded-md p-3">
            <div className="mb-2 flex items-center gap-2">
              <Wrench className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">{pending.opName}</span>
              <span className={`ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${meta.tone}`}>
                {meta.icon}
                {meta.label}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              <code className="font-mono">{pending.opId}</code>
            </div>
            {pending.args && Object.keys(pending.args).length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-foreground/70">参数</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/50 p-2 text-[10px]">
                  {JSON.stringify(pending.args, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            选择「<strong>允许本次</strong>」只放行这一次请求。<br />
            选择「<strong>授权 7 天</strong>」放行接下来 7 天内同一发起方(同一 access key)+ 同一 op 的所有请求,免重复点击。
          </p>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={reject} disabled={busy}>
            拒绝
          </Button>
          <Button type="button" variant="default" onClick={() => approve('once')} disabled={busy}>
            允许本次
          </Button>
          <Button
            type="button"
            variant={pending.opDanger === 'destructive' ? 'destructive' : 'default'}
            onClick={() => approve('session')}
            disabled={busy}
          >
            授权 7 天
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
