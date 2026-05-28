/*
 * PendingImportInbox — Agent 导入审批全局徽章 + 抽屉
 *
 * 2026-05-28 用户反馈:
 *   "另外那个面板我没办法主观打开 Agent 导入记录 面板,必须 agent 告诉我一个地址
 *    我才打开,这个非常不好,其实就应该审批流弹窗即可,我能在例如站内信的地方
 *    看到这个申请,或者右下角吧,右下角有一个明显的批准我同意就可以了"
 *
 * 设计:
 *   - 右下角悬浮 button(只在 pendingCount > 0 时显示),点击展开 Dialog
 *   - Dialog 列出全部 pending,每项一个 「批准 / 拒绝」按钮 + YAML 折叠预览
 *   - 订阅 useCdsEvents 的 lastPendingImportEvent / lastFlapEvent
 *     - import event → 自动刷新列表
 *     - flap event → 顶部 toast banner 告警
 *   - 复用 ProjectListPage 原有 endpoint,无后端新代码
 *   - 挂在 AppShell,任何页面可见(同 OperatorApprovalModal / GlobalUpdateBadge)
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, Inbox, Loader2, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { useCdsEvents } from '@/hooks/useCdsEvents';

interface PendingImportSummary {
  addedProfiles: string[];
  addedInfra: string[];
  addedEnvKeys: string[];
}

interface PendingImport {
  id: string;
  projectId: string;
  agentName: string;
  purpose: string;
  composeYaml?: string;
  summary?: PendingImportSummary;
  submittedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  rejectReason?: string;
  decidedAt?: string;
}

interface PendingImportsResponse {
  imports?: PendingImport[];
  pendingCount?: number;
  degraded?: boolean;
}

export function PendingImportInbox(): JSX.Element | null {
  const events = useCdsEvents();
  const [pending, setPending] = useState<PendingImport[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [flapDismissedAt, setFlapDismissedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiRequest<PendingImportsResponse>('/api/pending-imports');
      const list = (data.imports || []).filter((i) => i.status === 'pending');
      setPending(list);
    } catch {
      // 静默 — degraded / 401 之类不该让这个组件爆错
    }
  }, []);

  // 初始拉一次
  useEffect(() => { void refresh(); }, [refresh]);

  // 事件驱动:agent 提交新 import / approve / reject 后立即 refresh
  useEffect(() => {
    if (events.lastPendingImportEvent) {
      void refresh();
    }
  }, [events.lastPendingImportEvent, refresh]);

  const approve = useCallback(async (importId: string) => {
    if (busy) return;
    setBusy(importId);
    try {
      await apiRequest(`/api/pending-imports/${encodeURIComponent(importId)}/approve`, {
        method: 'POST',
      });
      setPending((prev) => prev.filter((i) => i.id !== importId));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const reject = useCallback(async (importId: string) => {
    if (busy) return;
    setBusy(importId);
    try {
      await apiRequest(`/api/pending-imports/${encodeURIComponent(importId)}/reject`, {
        method: 'POST',
        body: {},
      });
      setPending((prev) => prev.filter((i) => i.id !== importId));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const flap = events.lastFlapEvent;
  const showFlap = flap && flap.ts !== flapDismissedAt;

  const count = pending.length;

  // 没 pending + 没 flap toast → 完全不渲染
  if (count === 0 && !showFlap) return null;

  return (
    <>
      {/* flap 熔断告警 — 右下角持久 toast,直到用户点 X */}
      {showFlap && flap ? (
        <div
          className="fixed bottom-20 right-4 z-50 max-w-md cds-surface-elevated cds-hairline rounded-lg shadow-lg p-4"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
            <div className="flex-1 text-sm">
              <div className="font-semibold text-foreground">infra 容器熔断</div>
              <div className="mt-1 text-foreground/80">
                <code className="font-mono text-xs">{flap.containerName}</code> 因频繁重启(
                RestartCount {flap.restartCount})已被自动 docker stop。请检查 yaml 的 command/entrypoint。
              </div>
            </div>
            <button
              type="button"
              onClick={() => setFlapDismissedAt(flap.ts)}
              className="text-foreground/50 hover:text-foreground"
              aria-label="dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      {/* 右下角徽章 — 只在 count > 0 时显示 */}
      {count > 0 ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full
                     cds-surface-elevated cds-hairline shadow-lg px-4 py-2 text-sm font-medium
                     text-foreground hover:scale-105 transition-transform"
          aria-label={`${count} 个待审批的 Agent 导入`}
        >
          <Inbox className="h-4 w-4" />
          <span>Agent 导入 {count}</span>
          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full
                           bg-destructive text-destructive-foreground text-[11px] px-1.5">
            {count}
          </span>
        </button>
      ) : null}

      {/* 审批抽屉(Dialog) */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Agent 导入待审批
            </DialogTitle>
            <DialogDescription>
              来自外部 Agent(cds-project-scan / claude-code 等)提交的 CDS compose 配置。
              批准会写入 build profiles / infra services / 环境变量到对应项目。
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto space-y-3" style={{ minHeight: 0 }}>
            {pending.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">没有待审批的导入</div>
            ) : (
              pending.map((item) => {
                const isBusy = busy === item.id;
                return (
                  <div key={item.id} className="cds-surface-sunken cds-hairline rounded-md p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 text-sm">
                        <div className="font-semibold text-foreground">
                          {item.agentName || '未知 Agent'}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          项目: <code className="font-mono">{item.projectId}</code>
                          {' · '}
                          {new Date(item.submittedAt).toLocaleString('zh-CN')}
                        </div>
                        {item.purpose ? (
                          <div className="mt-1 text-xs text-foreground/80">{item.purpose}</div>
                        ) : null}
                        {item.summary ? (
                          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                            {(item.summary.addedProfiles || []).map((p) => (
                              <span key={`p-${p}`} className="rounded bg-blue-500/10 text-blue-700 dark:text-blue-300 px-1.5 py-0.5">
                                profile: {p}
                              </span>
                            ))}
                            {(item.summary.addedInfra || []).map((s) => (
                              <span key={`i-${s}`} className="rounded bg-purple-500/10 text-purple-700 dark:text-purple-300 px-1.5 py-0.5">
                                infra: {s}
                              </span>
                            ))}
                            {(item.summary.addedEnvKeys || []).length > 0 ? (
                              <span className="rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 px-1.5 py-0.5">
                                env: {item.summary.addedEnvKeys.length}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {item.composeYaml ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[11px] text-foreground/70">查看 YAML</summary>
                            <pre
                              className="mt-1 max-h-60 overflow-auto rounded p-2 text-[10px]"
                              style={{
                                background: 'var(--bg-base, var(--surface-sunken))',
                                color: 'var(--text-primary, inherit)',
                              }}
                            >
                              {item.composeYaml}
                            </pre>
                          </details>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => reject(item.id)}
                        disabled={isBusy}
                      >
                        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        拒绝
                      </Button>
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={() => approve(item.id)}
                        disabled={isBusy}
                      >
                        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        批准
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
