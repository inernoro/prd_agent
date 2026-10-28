import { useState } from 'react';
import { Database, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResourceIcon, type BranchResource } from '@/lib/resources';

export type DatabaseDirectoryEntry = { branchId: string; branchName: string; resource: BranchResource };

export function DatabaseDirectoryDialog({ open, onOpenChange, entries, loading, onOpen }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: DatabaseDirectoryEntry[];
  loading: boolean;
  onOpen: (entry: DatabaseDirectoryEntry, tab: 'data' | 'connection' | 'backups') => void;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const visible = entries.filter(({ branchName, resource }) =>
    `${branchName} ${resource.displayName} ${resource.runtime}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent frame className="max-w-4xl" style={{ height: 'min(80vh, 45rem)' }}>
      <DialogHeader className="shrink-0 border-b p-6 pr-12">
        <DialogTitle className="flex items-center gap-2"><Database className="h-5 w-5" />数据库</DialogTitle>
        <DialogDescription>选择数据库进入操作面板，或查看临时连接与备份。每项标明分支及隔离范围，权限沿用原资源。</DialogDescription>
      </DialogHeader>
      <label className="m-4 flex shrink-0 items-center gap-2 rounded-md border px-3 py-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input aria-label="搜索数据库或分支" className="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="搜索数据库、类型或分支" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="min-h-0 flex-1 space-y-3 px-4 pb-4" style={{ overflowY: 'auto' }}>
        {loading ? <p role="status" className="text-sm text-muted-foreground">正在读取项目数据库…</p> : !visible.length ? <p className="text-sm text-muted-foreground">{entries.length ? '没有匹配的数据库，请调整搜索。' : '项目还没有数据库资源。请在项目设置中添加基础设施，再返回此处。'}</p> : visible.map((entry) => {
          const { resource } = entry;
          return <section key={`${entry.branchId}:${resource.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background p-4" aria-label={`${entry.branchName} ${resource.displayName}`}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-medium"><ResourceIcon resource={resource} /><span className="break-all">{resource.displayName}</span></div>
              <p className="mt-1 break-all text-xs text-muted-foreground">分支 {entry.branchName} · {resource.isolation === 'branch' ? '分支独立' : resource.isolation === 'project-shared' ? '项目共享' : '隔离范围待确认'} · {resource.status === 'running' ? '运行中' : '未运行或异常'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onOpen(entry, 'data')}>操作面板</Button>
              <Button size="sm" variant="outline" onClick={() => onOpen(entry, 'connection')}>连接 / 通行证</Button>
              <Button size="sm" variant="ghost" onClick={() => onOpen(entry, 'backups')}>备份 / 克隆</Button>
            </div>
          </section>;
        })}
      </div>
    </DialogContent>
  </Dialog>;
}
