/**
 * CapacityFullDialog — 部署被容量限制拒绝时弹出,让用户**勾选**当前 running
 * 分支(自己之外)中要停止的几个,确认后顺序调 stop 端点 + 自动重试当前部署。
 *
 * 2026-05-07 wave 1.3 (plan.cds.legacy-feature-rollup):
 * legacy app.js 的 checkCapacityAndDeploy + toggleCapacityStopList +
 * capacityChoiceForce 三件套,React 化收敛到一个 dialog。
 */
import { useState, useMemo } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface CapacityCandidate {
  id: string;
  branch: string;
  /** 该分支当前占用了几个容器(running 服务数) */
  serviceCount: number;
  /** 是否被钉住(钉住的不应该被停) */
  isPinned?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 触发部署的分支(自己),不会出现在候选列表里 */
  selfBranchId: string;
  selfBranchName: string;
  /** 当前总容量 / 已占用容量 — 文案展示 */
  capacity?: { runningContainers: number; maxContainers: number };
  /** 部署该分支预计需要新增几个容器 */
  needSlots: number;
  /** 候选列表(已 running 但不是自己) */
  candidates: CapacityCandidate[];
  /** 用户确认后:顺序调 stop 这些分支,然后回调让外层重试 deploy */
  onConfirm: (idsToStop: string[]) => Promise<void>;
}

export function CapacityFullDialog({
  open, onClose, selfBranchName, capacity, needSlots, candidates, onConfirm,
}: Props): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  // 选中的容器数能腾出多少 — 实时算
  const willFreeSlots = useMemo(
    () => candidates
      .filter((c) => selected.has(c.id))
      .reduce((sum, c) => sum + (c.serviceCount || 1), 0),
    [candidates, selected],
  );
  const enough = willFreeSlots >= needSlots;

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async (): Promise<void> => {
    if (!enough || submitting) return;
    setSubmitting(true);
    setErr('');
    try {
      await onConfirm(Array.from(selected));
      onClose();
      setSelected(new Set());
    } catch (e) {
      setErr((e as Error).message || '停止 + 重试失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>容量已满 — 选择停止哪些分支</DialogTitle>
          <DialogDescription>
            部署 <span className="font-mono text-foreground">{selfBranchName}</span> 需要 {needSlots} 个容器,
            当前 {capacity ? `${capacity.runningContainers}/${capacity.maxContainers}` : '未知'} 已占用。
            勾选要停止的分支腾出空间,确认后会**先停后部署**。
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            没有可停止的分支(其他全都钉住或在重要状态)。请先扩容或手动操作。
          </div>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
            {candidates.map((c) => {
              const checked = selected.has(c.id);
              const disabled = !!c.isPinned;
              return (
                <li key={c.id}>
                  <label
                    className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm ${
                      disabled
                        ? 'border-muted bg-muted/10 opacity-50 cursor-not-allowed'
                        : checked
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(c.id)}
                      className="h-4 w-4"
                    />
                    <span className="flex-1 font-mono">{c.branch}</span>
                    <span className="text-xs text-muted-foreground">{c.serviceCount} 容器</span>
                    {disabled ? <span className="text-xs text-muted-foreground">已钉住</span> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <div className={`text-sm ${enough ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300'}`}>
          已选 {selected.size} 项,腾出 {willFreeSlots} 个容器 / 需要 {needSlots} 个
          {enough ? ' — 够用' : ' — 还差 ' + (needSlots - willFreeSlots) + ' 个'}
        </div>

        {err ? <div className="text-sm text-destructive">{err}</div> : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
          <Button onClick={() => void handleConfirm()} disabled={!enough || submitting}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            停止 {selected.size} 个并重试部署
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
