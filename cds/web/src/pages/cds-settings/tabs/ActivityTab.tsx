import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsReadRequest } from '@/components/project/ProjectSettingsRefresh';
import { Activity, RefreshCw, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ApiError, listUserActivity, type CdsUserActivity } from '@/lib/api';
import { Section, LoadingBlock, ErrorBlock, EmptyBlock } from '../components';
import { AccountAudit } from '../components/AccountAudit';

const ACTION_LABEL: Record<string, string> = {
  login: '登录',
  logout: '退出登录',
  bootstrap: '初始化系统所有者',
  'change-password': '修改密码',
  'create-user': '创建用户',
  'reset-password': '重置密码',
  'disable-user': '禁用用户',
  'enable-user': '启用用户',
  'grant-project': '授权项目',
  'revoke-project': '撤销项目授权',
  'link-identity': '绑定登录身份',
  'link-identity-denied': '绑定登录身份失败',
  'unlink-identity': '解除登录身份绑定',
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] || action;
}

export function ActivityTab({ canViewAll, canFilterAccounts }: { canViewAll: boolean; canFilterAccounts?: boolean }): JSX.Element {
  const [rows, setRows] = useState<CdsUserActivity[] | null>(null);
  const [error, setError] = useState('');
  const [errorDetail, setErrorDetail] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const beginRead = useSettingsReadRequest();
  const load = useCallback(async (): Promise<void> => {
    const signal = beginRead(); setError(''); setErrorDetail(''); setRefreshing(true);
    try {
      const next = await listUserActivity({ limit: 200 });
      if (!signal.aborted) setRows(next);
    } catch (err) {
      if (!signal.aborted) {
        setError(err instanceof ApiError && err.status === 403 ? '没有读取操作记录的权限，请联系系统所有者。' : err instanceof ApiError && err.status === 401 ? '未登录，请登录后重新读取操作记录。' : '操作记录读取失败，请重新读取。');
        setErrorDetail(err instanceof Error ? err.message : String(err));
      }
    } finally { if (!signal.aborted) setRefreshing(false); }
  }, [beginRead]);
  useEffect(() => { void load(); }, [load]);
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (rows || []).filter(row => !needle || [row.userLogin,row.userId,row.action,actionLabel(row.action),row.summary,row.targetId,row.ip].some(value => value?.toLocaleLowerCase().includes(needle)));
  }, [rows, query]);
  return (
    <div className="space-y-6">
    <AccountAudit canViewAll={canViewAll} canFilterAccounts={canFilterAccounts} />
    <Section
      title="用户操作痕迹"
      description={
        canViewAll
          ? '系统所有者可查看全部用户的关键操作记录（登录、改密、用户管理等）。'
          : '展示你自己的关键操作记录。系统所有者可查看全部用户记录。'
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="min-w-0 flex-1"><span className="sr-only">搜索操作记录</span><input aria-label="搜索操作记录" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用户、操作、对象或说明" className="min-h-[3.25rem] w-full rounded-md border border-input bg-background px-3 text-sm lg:min-h-9" /></label>
          <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}>
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            刷新
          </Button>
        </div>

        {error ? (
          <div className="space-y-2"><ErrorBlock message={error} />{errorDetail?<details className="group/activity-error text-sm text-muted-foreground"><summary className="flex min-h-[3.25rem] cursor-pointer items-center gap-2"><ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open/activity-error:rotate-90" />查看读取错误详情</summary><pre className="whitespace-pre-wrap break-all font-mono text-xs">{errorDetail}</pre></details>:null}</div>
        ) : rows === null ? (
          <LoadingBlock label="加载操作记录" />
        ) : rows.length === 0 ? (
          <EmptyBlock title="暂无操作记录" description="登录、修改密码、用户管理等关键操作会记录在这里。" />
        ) : (
          <><p className="text-sm text-muted-foreground">本次读取 {rows.length} 条{query ? `，匹配 ${visibleRows.length} 条` : '，最多显示最近 200 条'}。</p>{visibleRows.length===0?<p className="py-3 text-sm text-muted-foreground">没有匹配记录，请调整搜索。</p>:null}<div className="hidden overflow-x-auto rounded-md border border-border xl:block">
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
                {visibleRows.map((r) => (
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
          </div><div className="divide-y divide-border xl:hidden">{visibleRows.map(row => <article key={row.id} data-user-activity-id={row.id} className="space-y-2 py-3"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-medium">{actionLabel(row.action)}</h3><time className="text-xs text-muted-foreground">{new Date(row.at).toLocaleString()}</time></div><p className="break-all text-sm">{row.userLogin}<span className="text-muted-foreground"> · {row.userId}</span></p><p className="break-words text-sm text-muted-foreground">{row.summary}</p>{row.targetId?<p className="break-all text-xs text-muted-foreground">对象：{row.targetId}</p>:null}<p className="break-all text-xs text-muted-foreground">IP：{row.ip || '未提供'}</p></article>)}</div></>
        )}
      </div>
    </Section>
    </div>
  );
}
