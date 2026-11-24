import { useState } from 'react';
import { Archive, Loader2, Trash2 } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DropdownDivider, DropdownItem, DropdownMenu } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Mode = 'all' | 'incomplete';
type Plan = { mode: Mode; candidates: Array<{ id: string; branch: string; running: boolean }>; skipped: Array<{ id: string; reason: string }> };
export interface BranchArchiveView { archivedAt: string; retireAt: string; reason: string; actor: string }

export function BranchLifecycleControls(props: {
  projectId: string; archivedCount: number; showArchived: boolean; onToggleArchive: () => void;
  damagedCount: number; damagedBusy: boolean; onDamaged: () => void;
  onRefresh: () => Promise<void>; onToast: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const endpoint = `/api/projects/${encodeURIComponent(props.projectId)}/branches/lifecycle-cleanup`;
  const prepare = async (mode: Mode) => {
    if (busy) return;
    setBusy(true);
    try { setPlan({ ...await apiRequest<Omit<Plan, 'mode'>>(endpoint, { method: 'POST', body: { mode, dryRun: true } }), mode }); }
    catch (error) { props.onToast(error instanceof Error ? error.message : '未能读取清理范围'); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ archivedCount: number; failed: unknown[]; skipped: unknown[] }>(endpoint,
        { method: 'POST', body: { mode: plan.mode, confirm: true } });
      props.onToast(`已归档 ${result.archivedCount} 个分支，保留30天；跳过 ${result.skipped.length} 个，未完成 ${result.failed.length} 个`);
      setPlan(null); await props.onRefresh();
    } catch (error) { props.onToast(error instanceof Error ? error.message : '清理未完成，请查看记录'); }
    finally { setBusy(false); }
  };
  return <>
    <Button variant={props.showArchived ? 'outline' : 'ghost'} size="sm" onClick={props.onToggleArchive}><Archive />{props.showArchived ? '返回分支' : `归档 ${props.archivedCount}`}</Button>
    {!props.showArchived ? <DropdownMenu width={260} trigger={<Button variant="outline" size="sm" disabled={busy || props.damagedBusy}><Trash2 />清理分支</Button>}>
      <DropdownItem onSelect={() => void prepare('incomplete')}>清理未完全启动的（主要）</DropdownItem>
      <DropdownItem disabled={props.damagedCount === 0 || props.damagedBusy} onSelect={props.onDamaged}>清理损坏的{props.damagedCount ? ` ${props.damagedCount}` : ''}</DropdownItem>
      <DropdownDivider />
      <DropdownItem destructive onSelect={() => void prepare('all')}>清理所有</DropdownItem>
    </DropdownMenu> : null}
    <Dialog open={Boolean(plan)} onOpenChange={open => { if (!open && !busy) setPlan(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{plan?.mode === 'all' ? '清理所有普通分支' : '清理未完全启动的分支'}</DialogTitle>
          <DialogDescription>先停止这些分支自己的容器，再归档隐藏。工作区和数据保留30天，可从归档列表恢复；主分支、固定分支和忙碌分支会跳过。</DialogDescription>
        </DialogHeader>
        <p>将归档 {plan?.candidates.length || 0} 个分支，其中 {plan?.candidates.filter(branch => branch.running).length || 0} 个有活跃服务；跳过 {plan?.skipped.length || 0} 个受保护或忙碌分支。</p>
        <div className="max-h-48 overflow-auto text-sm">{plan?.candidates.map(branch => <p key={branch.id} className="truncate" title={branch.branch}>{branch.branch}</p>)}</div>
        <Button disabled={busy || !plan?.candidates.length} onClick={() => void execute()}>{busy ? '正在停止并归档…' : '确认停止并归档'}</Button>
      </DialogContent>
    </Dialog>
  </>;
}

export function ArchivedBranchCard({ branch, projectId, onRefresh, onToast }: {
  branch: { id: string; branch: string; archive: BranchArchiveView }; projectId: string; onRefresh: () => Promise<void>; onToast: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch.id)}/restore-archive`, { method: 'POST' });
      onToast(`已恢复 ${branch.branch}，可按需启动`); await onRefresh();
    } catch (error) { onToast(error instanceof Error ? error.message : '恢复未完成'); }
    finally { setBusy(false); }
  };
  return <article data-archived-branch-id={branch.id} className="rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface))] p-4">
    <h3 className="truncate font-mono text-sm" title={branch.branch}>{branch.branch}</h3>
    <p className="mt-2 text-sm text-muted-foreground">{branch.archive.reason}</p>
    <p className="mt-2 text-xs text-muted-foreground">归档：{new Date(branch.archive.archivedAt).toLocaleString('zh-CN')} · 保留至：{new Date(branch.archive.retireAt).toLocaleString('zh-CN')}</p>
    <Button className="mt-3" size="sm" disabled={busy} onClick={() => void restore()}>{busy ? <Loader2 className="animate-spin" /> : null}恢复分支</Button>
  </article>;
}
