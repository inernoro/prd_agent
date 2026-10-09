import { useEffect, useState } from 'react';
import { apiRequest, type CdsPublicUser } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { LoadingBlock, ErrorBlock, EmptyBlock } from '../components';

interface UserProjects {
  userId: string;
  allProjects: boolean;
  projects: Array<{ id: string; name: string; authorized: boolean }>;
}

export function UserProjectAccessDialog({ user, onClose, onToast }: {
  user: CdsPublicUser | null;
  onClose: () => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const [data, setData] = useState<UserProjects | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setData(null);
    setSelected([]);
    setError('');
    if (!user) return;
    const ctrl = new AbortController();
    apiRequest<UserProjects>(`/api/auth/users/${encodeURIComponent(user.id)}/projects`, { signal: ctrl.signal })
      .then(result => {
        setData(result);
        setSelected(result.projects.filter(p => p.authorized).map(p => p.id));
      })
      .catch(err => { if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err)); });
    return () => ctrl.abort();
  }, [user]);

  const save = async (): Promise<void> => {
    if (!user || !data || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<UserProjects>(`/api/auth/users/${encodeURIComponent(user.id)}/projects`, {
        method: 'PUT', body: { projectIds: selected },
      });
      setData(result);
      onToast(`已更新 ${user.username || user.githubLogin} 的项目授权，后续请求立即生效`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={Boolean(user)} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent frame className="max-w-xl" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
          <DialogTitle>项目授权 · {user?.username || user?.githubLogin}</DialogTitle>
          <DialogDescription>勾选可访问的项目。保存后，账号只能查看这些项目并操作其分支；取消勾选即撤销访问。</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {error ? <ErrorBlock message={error} /> : null}
          {!data && !error ? <LoadingBlock label="加载项目授权" /> : null}
          {data?.allProjects ? <p className="text-sm text-muted-foreground">系统所有者始终可访问全部项目，无需逐项授权。</p> : null}
          {data && !data.allProjects ? (
            <>
              <p className="text-sm text-muted-foreground">已选择 {selected.length} / {data.projects.length} 个项目。未选择项目时，此账号仍可登录和修改自己的密码。</p>
              {data.projects.length === 0 ? <EmptyBlock title="还没有项目" description="先创建项目，再回来为账号分配访问权限。" /> : (
                <div className="space-y-2">
                  {data.projects.map(project => (
                    <label key={project.id} className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-card px-3 py-3">
                      <input type="checkbox" checked={selected.includes(project.id)} disabled={busy}
                        onChange={event => setSelected(ids => event.target.checked ? [...ids, project.id] : ids.filter(id => id !== project.id))}
                        className="h-4 w-4 shrink-0 accent-primary" />
                      <span className="min-w-0 break-words text-sm text-foreground">{project.name}</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs leading-5 text-muted-foreground">项目授权不包含系统管理、创建或删除项目、修改服务配置、绑定域名、签发 Agent 凭证及正式发布。</p>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter className="shrink-0 border-t border-border px-5 py-4">
          <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button disabled={!data || data.allProjects || busy} onClick={() => void save()}>{busy ? '保存中' : '保存授权'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
