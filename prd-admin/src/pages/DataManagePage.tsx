import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { Tooltip } from '@/components/ui/Tooltip';
import { getDataSummary, previewUsersPurge, purgeData, purgeUsers } from '@/services';
import type { AdminUserPreviewItem, AdminUsersPurgePreviewResponse, DataSummaryResponse } from '@/services/contracts/data';
import { DataTransferDialog } from '@/pages/model-manage/DataTransferDialog';
import { ChevronDown, ChevronRight, Database, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

function safeIdempotencyKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && 'randomUUID' in c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fmtNum(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function MetricCard({
  title,
  value,
  hint,
  loading,
  accent,
}: {
  title: string;
  value: string;
  hint?: string;
  loading?: boolean;
  accent?: 'gold' | 'green';
}) {
  return (
    <Card className="p-5" variant={accent === 'gold' ? 'gold' : 'default'}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            {title}
          </div>
          {hint && (
            <div className="mt-1 text-[12px] truncate" style={{ color: 'var(--text-secondary)' }}>
              {hint}
            </div>
          )}
        </div>
        {loading ? <Badge size="sm">加载中</Badge> : <Badge size="sm" variant="new">已更新</Badge>}
      </div>
      <div className="mt-4 flex items-baseline gap-2">
        <div
          className="text-[34px] font-semibold tracking-[-0.03em] leading-none"
          style={{ color: accent === 'green' ? 'var(--accent-green)' : 'var(--text-primary)' }}
        >
          {loading ? '—' : value}
        </div>
      </div>
    </Card>
  );
}

type OverviewTreeGroup = {
  key: string;
  title: string;
  count: number;
  items: Array<{ label: string; value: string }>;
};

function OverviewTreeList({
  groups,
  loading,
}: {
  groups: OverviewTreeGroup[];
  loading?: boolean;
}) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set(groups.map((g) => g.key)));

  // 仅在首屏初始化时使用 groups 默认值；后续保持用户展开状态不抖动
  useEffect(() => {
    setOpenKeys((prev) => {
      if (prev.size > 0) return prev;
      return new Set(groups.map((g) => g.key));
    });
  }, [groups]);

  const toggle = (k: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <div
      className="rounded-[14px] overflow-hidden"
      style={{
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div className="divide-y divide-white/15">
        {groups.map((g) => {
          const open = openKeys.has(g.key);
          return (
            <div key={g.key}>
              <button
                type="button"
                onClick={() => toggle(g.key)}
                className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-white/2"
                disabled={loading}
                aria-expanded={open}
              >
                <div className="min-w-0 flex items-center gap-2">
                  <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {g.title}
                    </div>
                    <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                      {loading ? '加载中…' : `${fmtNum(g.count)} 项`}
                    </div>
                  </div>
                </div>
                <Badge size="sm" variant="subtle">{loading ? '—' : fmtNum(g.count)}</Badge>
              </button>

              {open && (
                <div className="px-4 pb-3">
                  <div
                    className="rounded-[12px] overflow-hidden"
                    style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.10)' }}
                  >
                    <div className="divide-y divide-white/10">
                      {g.items.map((it) => (
                        <div key={it.label} className="px-3 py-2 flex items-center justify-between gap-3">
                          <div className="min-w-0 text-sm truncate" style={{ color: 'var(--text-secondary)' }}>
                            {it.label}
                          </div>
                          <div className="shrink-0 text-sm font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                            {loading ? '—' : it.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DataManagePage() {
  const [summary, setSummary] = useState<DataSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [transferOpen, setTransferOpen] = useState(false);

  const [usersPurgeOpen, setUsersPurgeOpen] = useState(false);
  const [usersPurgeStep, setUsersPurgeStep] = useState<1 | 2>(1);
  const [usersPreviewLoading, setUsersPreviewLoading] = useState(false);
  const [usersPreview, setUsersPreview] = useState<AdminUsersPurgePreviewResponse | null>(null);
  const [usersConfirmText, setUsersConfirmText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await getDataSummary();
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载失败'}`);
        return;
      }
      setSummary(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const domainCards = useMemo(() => {
    const s = summary;
    const llmLogs = s ? s.llmRequestLogs : 0;
    const sessionsMessages = s ? (s.messages + s.imageMasterSessions + s.imageMasterMessages) : 0;
    const docsKb = s ? (s.documents + s.attachments + s.contentGaps + s.prdComments) : 0;
    return [
      { key: 'llmLogs', title: '请求日志（LLM）', count: llmLogs, domains: ['llmLogs'] },
      { key: 'sessionsMessages', title: '会话/消息/对话记录', count: sessionsMessages, domains: ['sessionsMessages'] },
      { key: 'documents', title: '文档/解析/知识库类', count: docsKb, domains: ['documents'] },
    ] as Array<{ key: string; title: string; count: number; domains: string[] }>;
  }, [summary]);

  const coreCounts = useMemo(() => {
    const s = summary;
    return {
      users: fmtNum(s?.users ?? 0),
      platforms: fmtNum(s?.llmPlatforms ?? 0),
      enabledModels: fmtNum(s?.llmModelsEnabled ?? 0),
      totalModels: fmtNum(s?.llmModelsTotal ?? 0),
    };
  }, [summary]);

  const doPurge = async (domains: string[]) => {
    setMsg(null);
    setErr(null);
    const idem = safeIdempotencyKey();
    const res = await purgeData({ domains }, idem);
    if (!res.success) {
      setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '清理失败'}`);
      return;
    }
    
    // 判断是否为 devReset 模式
    const isDevReset = domains.some(d => d.toLowerCase().includes('devreset') || d.toLowerCase().includes('resetkeepmodels'));
    
    if (isDevReset) {
      setMsg(`已执行清理：devReset（本次删除：${res.data.otherDeleted ?? 0}个集合 llmLogs=${fmtNum(res.data.llmRequestLogs)} messages=${fmtNum(res.data.messages)} documents=${fmtNum(res.data.documents)}）`);
    } else {
      setMsg(`已执行清理：${domains.join(', ')}（本次删除：llmLogs=${fmtNum(res.data.llmRequestLogs)} messages=${fmtNum(res.data.messages)} documents=${fmtNum(res.data.documents)}）`);
    }
    
    await load();
  };

  const openUsersPurge = async () => {
    setUsersPurgeOpen(true);
    setUsersPurgeStep(1);
    setUsersConfirmText('');
    setUsersPreview(null);

    setUsersPreviewLoading(true);
    try {
      const res = await previewUsersPurge(20);
      if (!res.success) {
        setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '加载预览失败'}`);
        return;
      }
      setUsersPreview(res.data);
    } finally {
      setUsersPreviewLoading(false);
    }
  };

  const doPurgeUsers = async () => {
    setMsg(null);
    setErr(null);
    const idem = safeIdempotencyKey();
    const res = await purgeUsers({ confirmed: true }, idem);
    if (!res.success) {
      setErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '清理失败'}`);
      return;
    }
    setMsg(`已清理用户数据：usersDeleted=${fmtNum(res.data.usersDeleted)} groupMembersDeleted=${fmtNum(res.data.groupMembersDeleted)}`);
    setUsersPurgeOpen(false);
    await load();
  };

  const UserRow = ({ u }: { u: AdminUserPreviewItem }) => {
    return (
      <div
        className="grid gap-2 rounded-[12px] px-3 py-2 hover:bg-white/3"
        style={{
          gridTemplateColumns: '1.1fr 1.1fr 0.8fr 0.8fr 1.2fr',
          border: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{u.username || '—'}</div>
          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{u.displayName || '—'}</div>
        </div>
        <div className="min-w-0 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <span className="font-mono">{u.userId || '—'}</span>
        </div>
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{u.role}</div>
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{u.status}</div>
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{fmtDate(u.createdAt)}</div>
      </div>
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <PageHeader
        title="数据管理"
        description="配置迁移（导入/导出）与数据概览/清理，仅管理员可用"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
              <RefreshCw size={16} />
              刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => setTransferOpen(true)}>
              <Database size={16} />
              配置导入/导出
            </Button>
          </>
        }
      />

      {err && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(255,120,120,0.95)' }}>
          {err}
        </div>
      )}
      {msg && (
        <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'rgba(34,197,94,0.95)' }}>
          {msg}
        </div>
      )}

      {/* 删除/危险操作置顶：保持小屏样式，宽屏下两列排布减少“很高很挤” */}
      <Card className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>危险操作</div>
            <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              这些操作会删除核心或账号相关数据，请谨慎。
            </div>
          </div>
          <Badge variant="featured">Danger</Badge>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <div
            className="rounded-[14px] px-4 py-3"
            style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.12)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  用户数据：清理非管理员账号
                </div>
              </div>
              <Tooltip content="该操作不可恢复" side="top" align="end">
                <span className="inline-flex shrink-0">
                  <Button variant="danger" size="sm" disabled={loading} onClick={openUsersPurge}>
                    <Trash2 size={16} />
                    预览并删除
                  </Button>
                </span>
              </Tooltip>
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              先预览将删除的用户列表，再二次确认执行（ADMIN 会保留）。
            </div>
          </div>

          <div
            className="rounded-[14px] px-4 py-3"
            style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.12)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  开发期：一键删除（保留核心）
                </div>
              </div>

              <ConfirmTip
                title="确认执行开发清库？"
                description="将删除除 users / llmplatforms / 启用 llmmodels 外的所有数据，并清掉相关缓存（不可恢复）。"
                confirmText="确认删除"
                onConfirm={async () => {
                  await doPurge(['devReset']);
                }}
                disabled={loading}
                side="top"
                align="end"
              >
                <Button variant="danger" size="sm" disabled={loading}>
                  <Trash2 size={16} />
                  一键删除
                </Button>
              </ConfirmTip>
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              将删除除 users/llmplatforms/启用 llmmodels 外的所有集合；并删除未启用模型。
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-4">
        <div className="min-w-0 grid gap-4">
          {/* KPI：避免 auto-fit 在临界宽度出现 3+1 断行；改为稳定的 2×2 / 宽屏 4×1 */}
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
            <MetricCard title="Users" hint="users（核心保留）" value={coreCounts.users} loading={loading} />
            <MetricCard title="Platforms" hint="llmplatforms（核心保留）" value={coreCounts.platforms} loading={loading} />
            <MetricCard title="Enabled Models" hint="llmmodels.enabled=true（核心保留）" value={coreCounts.enabledModels} loading={loading} accent="gold" />
            <MetricCard title="Total Models" hint="llmmodels（核心保留）" value={coreCounts.totalModels} loading={loading} />
          </div>

          <Card className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>数据概览</div>
                <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                  以“文件夹分组”的方式展示集合数据量：点击分组可展开查看子项。
                </div>
              </div>
              <Badge variant="subtle">{loading ? '同步中' : '已同步'}</Badge>
            </div>

            <div className="mt-5">
              <OverviewTreeList
                loading={loading}
                groups={[
                  {
                    key: 'llmLogs',
                    title: 'LLM / Logs',
                    count: Number(summary?.llmRequestLogs ?? 0),
                    items: [{ label: 'LLM 请求日志', value: fmtNum(summary?.llmRequestLogs ?? 0) }],
                  },
                  {
                    key: 'sessions',
                    title: '会话 / 消息',
                    count:
                      Number(summary?.messages ?? 0) +
                      Number(summary?.imageMasterSessions ?? 0) +
                      Number(summary?.imageMasterMessages ?? 0),
                    items: [
                      { label: '消息', value: fmtNum(summary?.messages ?? 0) },
                      { label: 'ImageMaster 会话', value: fmtNum(summary?.imageMasterSessions ?? 0) },
                      { label: 'ImageMaster 消息', value: fmtNum(summary?.imageMasterMessages ?? 0) },
                    ],
                  },
                  {
                    key: 'docsKb',
                    title: '文档 / 知识库',
                    count:
                      Number(summary?.documents ?? 0) +
                      Number(summary?.attachments ?? 0) +
                      Number(summary?.contentGaps ?? 0) +
                      Number(summary?.prdComments ?? 0),
                    items: [
                      { label: '文档', value: fmtNum(summary?.documents ?? 0) },
                      { label: '附件', value: fmtNum(summary?.attachments ?? 0) },
                      { label: '内容缺口', value: fmtNum(summary?.contentGaps ?? 0) },
                      { label: 'PRD 评论', value: fmtNum(summary?.prdComments ?? 0) },
                    ],
                  },
                ]}
              />
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>按领域快速清理</div>
                <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                  对业务数据做定向清空（不可恢复），不影响核心保留数据。
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-3">
              {domainCards.map((it) => (
                <div
                  key={it.key}
                  className="flex items-center justify-between gap-3 rounded-[14px] px-4 py-3"
                  style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.02)' }}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{it.title}</div>
                      <Badge size="sm">{fmtNum(it.count)}</Badge>
                    </div>
                    <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      当前数量：{fmtNum(it.count)}
                    </div>
                  </div>

                  <Tooltip content="该操作不可恢复" side="top" align="end">
                    <span className="inline-flex">
                      <ConfirmTip
                        title="确认清理？"
                        description={`将清空：${it.title}（不可恢复）`}
                        confirmText="确认清理"
                        onConfirm={async () => {
                          await doPurge(it.domains);
                        }}
                        disabled={loading}
                        side="top"
                        align="end"
                      >
                        <Button variant="danger" size="sm" disabled={loading}>
                          <Trash2 size={16} />
                          清空
                        </Button>
                      </ConfirmTip>
                    </span>
                  </Tooltip>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Dialog
        open={usersPurgeOpen}
        onOpenChange={(open) => {
          setUsersPurgeOpen(open);
          if (!open) {
            setUsersPurgeStep(1);
            setUsersConfirmText('');
            setUsersPreview(null);
          }
        }}
        title={usersPurgeStep === 1 ? '预览：清理用户数据' : '二次确认：删除用户数据'}
        description={usersPurgeStep === 1 ? '将删除非管理员用户账号（ADMIN 保留）。' : '该操作不可恢复。'}
        maxWidth={900}
        content={
          <div className="min-h-0 flex flex-col gap-4">
            {usersPurgeStep === 1 ? (
              <>
                <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)' }}>
                  {usersPreviewLoading ? (
                    '加载预览中...'
                  ) : usersPreview ? (
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                      <div><span style={{ color: 'var(--text-muted)' }}>总用户</span> <span style={{ color: 'var(--text-primary)' }}>{fmtNum(usersPreview.totalUsers)}</span></div>
                      <div><span style={{ color: 'var(--text-muted)' }}>管理员</span> <span style={{ color: 'var(--text-primary)' }}>{fmtNum(usersPreview.adminUsers)}</span></div>
                      <div><span style={{ color: 'var(--text-muted)' }}>将删除</span> <span style={{ color: 'rgba(239,68,68,0.95)' }}>{fmtNum(usersPreview.willDeleteUsers)}</span></div>
                      <div><span style={{ color: 'var(--text-muted)' }}>将保留</span> <span style={{ color: 'var(--text-primary)' }}>{fmtNum(usersPreview.willKeepUsers)}</span></div>
                    </div>
                  ) : (
                    '暂无预览数据'
                  )}
                </div>

                {usersPreview?.notes?.length ? (
                  <div className="grid gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {usersPreview.notes.map((t, idx) => (
                      <div key={idx}>- {t}</div>
                    ))}
                  </div>
                ) : null}

                <div className="grid gap-3">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>将删除的用户（示例）</div>
                  <div className="grid gap-2 rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.10)' }}>
                    <div
                      className="grid gap-2 px-3 py-2 rounded-[12px]"
                      style={{
                        gridTemplateColumns: '1.1fr 1.1fr 0.8fr 0.8fr 1.2fr',
                        color: 'var(--text-muted)',
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-wider">账号</div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider">UserId</div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider">Role</div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider">Status</div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider">CreatedAt</div>
                    </div>
                    {usersPreviewLoading ? (
                      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
                    ) : usersPreview?.sampleWillDeleteUsers?.length ? (
                      usersPreview.sampleWillDeleteUsers.map((u) => <UserRow key={u.userId} u={u} />)
                    ) : (
                      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>无（可能只有管理员账号）</div>
                    )}
                  </div>
                </div>

                <div className="grid gap-3">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>将保留的管理员（示例）</div>
                  <div className="grid gap-2 rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.10)' }}>
                    {usersPreview?.sampleWillKeepAdmins?.length ? (
                      usersPreview.sampleWillKeepAdmins.map((u) => <UserRow key={u.userId} u={u} />)
                    ) : (
                      <div className="text-sm" style={{ color: 'var(--text-muted)' }}>无管理员账号（异常）</div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-[14px] px-4 py-3 text-sm" style={{ border: '1px solid rgba(239,68,68,0.28)', background: 'rgba(239,68,68,0.10)', color: 'rgba(239,68,68,0.95)' }}>
                  将删除非管理员用户账号，该操作不可恢复。
                </div>
                <div className="grid gap-2">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>请输入 DELETE 以确认</div>
                  <input
                    value={usersConfirmText}
                    onChange={(e) => setUsersConfirmText(e.target.value)}
                    placeholder="DELETE"
                    className="h-[42px] rounded-[12px] px-3 text-sm outline-none"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.14)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
              </>
            )}

            <div className="pt-2 flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (usersPurgeStep === 1) {
                    setUsersPurgeOpen(false);
                  } else {
                    setUsersPurgeStep(1);
                    setUsersConfirmText('');
                  }
                }}
              >
                {usersPurgeStep === 1 ? '取消' : '返回预览'}
              </Button>
              {usersPurgeStep === 1 ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={usersPreviewLoading}
                  onClick={() => setUsersPurgeStep(2)}
                >
                  下一步
                </Button>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={usersConfirmText !== 'DELETE' || loading}
                  onClick={doPurgeUsers}
                >
                  确认删除
                </Button>
              )}
            </div>
          </div>
        }
      />

      <DataTransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onImported={async () => {
          await load();
        }}
      />
    </div>
  );
}


