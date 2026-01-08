import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { PageHeader } from '@/components/design/PageHeader';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import {
  createImageMasterWorkspace,
  deleteImageMasterWorkspace,
  getUsers,
  listImageMasterWorkspaces,
  refreshImageMasterWorkspaceCover,
  updateImageMasterWorkspace,
} from '@/services';
import type { AdminUser } from '@/types/admin';
import type { ImageMasterWorkspace } from '@/services/contracts/imageMaster';
import { Plus, Users2, Pencil, Trash2, ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

function CoverMosaic(props: { title: string; assets: ImageMasterWorkspace['coverAssets'] }) {
  const assets = Array.isArray(props.assets) ? props.assets : [];
  const n = assets.length;

  const Tile = (p: { idx: number; style?: React.CSSProperties }) => {
    const a = assets[p.idx];
    return a?.url ? (
      <img
        src={a.url}
        alt=""
        className="h-full w-full object-cover"
        style={p.style}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    ) : (
      <div
        className="h-full w-full"
        style={{
          ...p.style,
          background: 'linear-gradient(135deg, rgba(250,204,21,0.06) 0%, rgba(255,255,255,0.02) 45%, rgba(0,0,0,0.05) 100%)',
        }}
      />
    );
  };

  if (n <= 0) return null;
  if (n === 1) {
    return (
      <img
        src={assets[0]?.url}
        alt={props.title || 'workspace cover'}
        className="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }

  // 2 张：左右两栏（更直观）
  if (n === 2) {
    return (
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(1, minmax(0, 1fr))',
          gap: 1,
          background: 'var(--border-subtle)',
        }}
      >
        <Tile idx={0} />
        <Tile idx={1} />
      </div>
    );
  }

  // 3 张：左边全高大图，右边上下两半
  if (n === 3) {
    return (
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
          gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
          gap: 1,
          background: 'var(--border-subtle)',
        }}
      >
        <Tile idx={0} style={{ gridColumn: '1', gridRow: '1 / span 2' }} />
        <Tile idx={1} style={{ gridColumn: '2', gridRow: '1' }} />
        <Tile idx={2} style={{ gridColumn: '2', gridRow: '2' }} />
      </div>
    );
  }

  // 4+ 张：保持四宫格（取前 4 张），避免过密
  return (
    <div
      className="absolute inset-0 grid"
      style={{
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
        gap: 1,
        background: 'var(--border-subtle)',
      }}
    >
      <Tile idx={0} />
      <Tile idx={1} />
      <Tile idx={2} />
      <Tile idx={3} />
    </div>
  );
}

export default function VisualAgentWorkspaceListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ImageMasterWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const refreshBusyRef = useRef<Set<string>>(new Set());
  const lastRefreshHashRef = useRef<Map<string, string>>(new Map());

  const [shareOpen, setShareOpen] = useState(false);
  const [shareWs, setShareWs] = useState<ImageMasterWorkspace | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [memberSet, setMemberSet] = useState<Set<string>>(new Set());

  const memberIds = useMemo(() => Array.from(memberSet), [memberSet]);

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listImageMasterWorkspaces({ limit: 30 });
      if (!res.success) {
        setError(res.error?.message || '加载 workspace 失败');
        return;
      }
      const list = Array.isArray(res.data?.items) ? res.data.items : [];
      // 只显示非文章配图类型（排除文学创作的数据）
      const filtered = list.filter((item) => item.scenarioType !== 'article-illustration');
      setItems(filtered);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  // 仅对“进入视口”的卡片做封面 refresh（无人观察就不刷新）
  useEffect(() => {
    if (items.length === 0) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-ws-card="1"][data-ws-id]'));
    if (els.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          const el = ent.target as HTMLElement;
          const wid = String(el.getAttribute('data-ws-id') || '').trim();
          if (!wid) continue;

          const ws = items.find((x) => x.id === wid);
          if (!ws) continue;
          if (!ws.coverStale) continue;

          const contentHash = String(ws.contentHash ?? '').trim();
          const last = lastRefreshHashRef.current.get(wid) ?? '';
          if (contentHash && last === contentHash) continue;
          if (refreshBusyRef.current.has(wid)) continue;

          refreshBusyRef.current.add(wid);
          lastRefreshHashRef.current.set(wid, contentHash);

          void (async () => {
            try {
              const res = await refreshImageMasterWorkspaceCover({
                id: wid,
                limit: 6,
                idempotencyKey: contentHash ? `ws_cover_${wid}_${contentHash}` : `ws_cover_${wid}_${Date.now()}`,
              });
              if (res.success && res.data?.workspace) {
                const next = res.data.workspace;
                setItems((prev) => prev.map((x) => (x.id === wid ? { ...x, ...next } : x)));
              }
            } finally {
              refreshBusyRef.current.delete(wid);
            }
          })();
        }
      },
      { root: null, threshold: 0.15 }
    );

    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [items]);

  const onCreate = async () => {
    const title = await systemDialog.prompt({
      title: '新建 Workspace',
      message: '请输入项目名称',
      defaultValue: '未命名',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (title == null) return;
    const res = await createImageMasterWorkspace({ title: title.trim() || '未命名', idempotencyKey: `ws_create_${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '创建失败');
      return;
    }
    const ws = res.data.workspace;
    navigate(`/visual-agent/${encodeURIComponent(ws.id)}`);
  };

  const onRename = async (ws: ImageMasterWorkspace) => {
    const title = await systemDialog.prompt({
      title: '重命名',
      message: '请输入新名称',
      defaultValue: ws.title || '',
      confirmText: '保存',
      cancelText: '取消',
    });
    if (title == null) return;
    const res = await updateImageMasterWorkspace({
      id: ws.id,
      title: title.trim() || '未命名',
      idempotencyKey: `ws_rename_${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '重命名失败');
      return;
    }
    await reload();
  };

  const onDelete = async (ws: ImageMasterWorkspace) => {
    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确认删除「${ws.title || '未命名'}」？（将删除画布与消息，资产记录会被清理）`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteImageMasterWorkspace({ id: ws.id, idempotencyKey: `ws_del_${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '删除失败');
      return;
    }
    await reload();
  };

  const openShare = async (ws: ImageMasterWorkspace) => {
    setShareWs(ws);
    setMemberSet(new Set((ws.memberUserIds ?? []).filter(Boolean)));
    setShareOpen(true);
    if (users.length === 0 && !usersLoading) {
      setUsersLoading(true);
      try {
        const res = await getUsers({ page: 1, pageSize: 200, role: 'ADMIN' });
        if (res.success) {
          setUsers(Array.isArray(res.data?.items) ? res.data.items : []);
        }
      } finally {
        setUsersLoading(false);
      }
    }
  };

  const saveShare = async () => {
    const ws = shareWs;
    if (!ws) return;
    const res = await updateImageMasterWorkspace({
      id: ws.id,
      memberUserIds: memberIds,
      idempotencyKey: `ws_share_${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '保存共享失败');
      return;
    }
    setShareOpen(false);
    setShareWs(null);
    await reload();
  };

  const grid = (
    <div
      className="grid gap-4"
      style={{
        // 屏幕越大列越多会导致单卡片更窄，按钮文字被压缩后发生“字内换行/折叠”
        // 用更合理的最小卡片宽度，并用 min(,100%) 避免小屏溢出
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
      }}
    >
      <Card className="p-0 overflow-hidden">
        <button
          type="button"
          className="w-full h-full min-h-[180px] flex flex-col items-center justify-center gap-2"
          onClick={() => void onCreate()}
          style={{ color: 'var(--text-secondary)' }}
        >
          <div
            className="h-12 w-12 rounded-[16px] flex items-center justify-center"
            style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
          >
            <Plus size={22} />
          </div>
          <div className="text-sm font-semibold">新建项目</div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Workspace
          </div>
        </button>
      </Card>

      {items.map((ws) => (
        <Card key={ws.id} className="p-0 overflow-hidden">
          <button
            type="button"
            className="w-full text-left"
            onClick={() => navigate(`/visual-agent/${encodeURIComponent(ws.id)}`)}
            title={ws.title || ws.id}
          >
            <div
              className="h-[150px] w-full relative overflow-hidden"
              data-ws-card="1"
              data-ws-id={ws.id}
              style={{
                background:
                  'linear-gradient(135deg, rgba(250,204,21,0.10) 0%, rgba(255,255,255,0.03) 40%, rgba(0,0,0,0.05) 100%)',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <CoverMosaic title={ws.title || ws.id} assets={ws.coverAssets} />
              {/* subtle overlay to keep text contrast consistent even with bright covers */}
              <div
                className="absolute inset-0"
                style={{
                  background: 'linear-gradient(180deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.20) 100%)',
                }}
              />
            </div>
            <div className="p-3">
              <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {ws.title || '未命名'}
              </div>
              <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                更新于 {formatDate(ws.updatedAt)}
              </div>
            </div>
          </button>

          <div className="px-3 pb-3 flex flex-wrap items-center gap-2">
            <Button size="xs" variant="secondary" className="shrink-0 whitespace-nowrap" onClick={() => void onRename(ws)}>
              <Pencil size={14} />
              重命名
            </Button>
            <Button
              size="xs"
              variant="secondary"
              className="shrink-0 whitespace-nowrap"
              onClick={() => void openShare(ws)}
              title="共享（添加/移除成员）"
            >
              <Users2 size={14} />
              共享
            </Button>
            <Button size="xs" variant="danger" className="ml-auto shrink-0 whitespace-nowrap" onClick={() => void onDelete(ws)}>
              <Trash2 size={14} />
              删除
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <PageHeader
        title="视觉创作 Agent"
        description="Workspace 列表：创建、共享与继续编辑（自动保存）"
        actions={
          <Button variant="primary" onClick={() => void onCreate()} disabled={loading}>
            <Plus size={16} />
            新建 Workspace
          </Button>
        }
      />

      {error ? (
        <Card>
          <div className="text-sm" style={{ color: 'rgba(255,120,120,0.95)' }}>
            {error}
          </div>
        </Card>
      ) : null}

      {loading ? (
        <Card>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            加载中...
          </div>
        </Card>
      ) : (
        grid
      )}

      <Dialog
        open={shareOpen}
        onOpenChange={(o) => {
          setShareOpen(o);
          if (!o) setShareWs(null);
        }}
        title="共享 Workspace"
        description="选择可访问该 Workspace 的管理员账号（最小共享：成员可编辑）。"
        maxWidth={720}
        content={
          <div className="h-full min-h-0 flex flex-col gap-3">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              当前项目：{shareWs?.title || '未命名'}
            </div>
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              已选成员：{memberIds.length} 个
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-[12px]" style={{ border: '1px solid var(--border-subtle)' }}>
              {usersLoading ? (
                <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  加载管理员列表中...
                </div>
              ) : users.length === 0 ? (
                <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  未加载到管理员用户
                </div>
              ) : (
                <div className="p-2 space-y-1">
                  {users.map((u) => {
                    const checked = memberSet.has(u.userId);
                    return (
                      <button
                        key={u.userId}
                        type="button"
                        className="w-full flex items-center gap-3 rounded-[10px] px-3 py-2 hover:bg-white/5"
                        style={{ border: '1px solid transparent', color: 'var(--text-primary)' }}
                        onClick={() => {
                          setMemberSet((prev) => {
                            const next = new Set(prev);
                            if (next.has(u.userId)) next.delete(u.userId);
                            else next.add(u.userId);
                            return next;
                          });
                        }}
                      >
                        <input type="checkbox" checked={checked} readOnly />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold truncate">{u.displayName || u.username}</div>
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {u.userId}
                          </div>
                        </div>
                        <ArrowRight size={16} style={{ opacity: 0.6 }} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setShareOpen(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void saveShare()} disabled={!shareWs}>
                保存
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}


