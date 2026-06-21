import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiRequest, ApiError, listUserActivity, type CdsUserActivity } from '@/lib/api';
import { Section, LoadingBlock, ErrorBlock, EmptyBlock } from '../components';

interface MeUser {
  id: string;
  username: string | null;
  isSystemOwner: boolean;
}

const ACTION_LABEL: Record<string, string> = {
  login: '登录',
  logout: '退出登录',
  bootstrap: '初始化系统所有者',
  'change-password': '修改密码',
  'create-user': '创建用户',
  'reset-password': '重置密码',
  'disable-user': '禁用用户',
  'enable-user': '启用用户',
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] || action;
}

export function ActivityTab(): JSX.Element {
  const [me, setMe] = useState<MeUser | null>(null);
  const [rows, setRows] = useState<CdsUserActivity[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError('');
    setRefreshing(true);
    try {
      setRows(await listUserActivity({ limit: 200 }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<{ user: MeUser }>('/api/me', { signal: ctrl.signal })
      .then((data) => setMe(data.user))
      .catch(() => setMe(null));
    void load();
    return () => ctrl.abort();
  }, [load]);

  return (
    <Section
      title="用户操作痕迹"
      description={
        me?.isSystemOwner
          ? '系统所有者可查看全部用户的关键操作记录（登录、改密、用户管理等）。'
          : '展示你自己的关键操作记录。系统所有者可查看全部用户记录。'
      }
    >
      <div className="space-y-4">
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}>
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            刷新
          </Button>
        </div>

        {error ? (
          <ErrorBlock message={error} />
        ) : rows === null ? (
          <LoadingBlock label="加载操作记录" />
        ) : rows.length === 0 ? (
          <EmptyBlock title="暂无操作记录" description="登录、修改密码、用户管理等关键操作会记录在这里。" />
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-normal text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">时间</th>
                  <th className="px-3 py-2 font-semibold">用户</th>
                  <th className="px-3 py-2 font-semibold">操作</th>
                  <th className="px-3 py-2 font-semibold">说明</th>
                  <th className="px-3 py-2 font-semibold">IP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                      {new Date(r.at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-medium text-foreground">{r.userLogin}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-foreground">
                        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                        {actionLabel(r.action)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{r.summary}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}
