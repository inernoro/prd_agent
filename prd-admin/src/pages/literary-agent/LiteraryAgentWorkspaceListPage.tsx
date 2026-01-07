import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import {
  createImageMasterWorkspace,
  deleteImageMasterWorkspace,
  getUsers,
  listImageMasterWorkspaces,
  updateImageMasterWorkspace,
} from '@/services';
import type { AdminUser } from '@/types/admin';
import type { ImageMasterWorkspace } from '@/services/contracts/imageMaster';
import { Plus, Users2, Pencil, Trash2, ArrowRight, FileText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

export default function LiteraryAgentWorkspaceListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ImageMasterWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

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
      const res = await listImageMasterWorkspaces({ limit: 50 });
      if (!res.success) {
        setError(res.error?.message || '加载失败');
        return;
      }
      const list = Array.isArray(res.data?.items) ? res.data.items : [];
      // 只显示文章配图类型
      const filtered = list.filter((item) => item.scenarioType === 'article-illustration');
      setItems(filtered);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const onCreate = async () => {
    const title = await systemDialog.prompt({
      title: '新建文章',
      message: '请输入文章标题',
      placeholder: '未命名文章',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (!title) return;
    const res = await createImageMasterWorkspace({
      title,
      scenarioType: 'article-illustration',
      idempotencyKey: `create-literary-${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert({ title: '创建失败', message: res.error?.message || '未知错误', confirmText: '确定' });
      return;
    }
    await reload();
    if (res.data?.workspace?.id) {
      navigate(`/literary-agent/${res.data.workspace.id}`);
    }
  };

  const onRename = async (ws: ImageMasterWorkspace) => {
    const title = await systemDialog.prompt({
      title: '重命名',
      message: '请输入新标题',
      placeholder: ws.title,
      defaultValue: ws.title,
      confirmText: '确定',
      cancelText: '取消',
    });
    if (!title || title === ws.title) return;
    const res = await updateImageMasterWorkspace({ id: ws.id, title, idempotencyKey: `rename-${ws.id}-${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert({ title: '重命名失败', message: res.error?.message || '未知错误', confirmText: '确定' });
      return;
    }
    await reload();
  };

  const onDelete = async (ws: ImageMasterWorkspace) => {
    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除「${ws.title}」吗？此操作不可恢复。`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteImageMasterWorkspace({ id: ws.id, idempotencyKey: `delete-${ws.id}-${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert({ title: '删除失败', message: res.error?.message || '未知错误', confirmText: '确定' });
      return;
    }
    await reload();
  };

  const onShare = async (ws: ImageMasterWorkspace) => {
    setShareWs(ws);
    setMemberSet(new Set(ws.memberUserIds || []));
    setShareOpen(true);
    setUsersLoading(true);
    try {
      const res = await getUsers({ page: 1, pageSize: 200 });
      if (res.success && res.data?.items) {
        setUsers(res.data.items.filter((u) => u.role === 'ADMIN' && u.userId !== ws.ownerUserId));
      }
    } finally {
      setUsersLoading(false);
    }
  };

  const onSaveShare = async () => {
    if (!shareWs) return;
    const res = await updateImageMasterWorkspace({
      id: shareWs.id,
      memberUserIds: memberIds,
      idempotencyKey: `share-${shareWs.id}-${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert({ title: '保存失败', message: res.error?.message || '未知错误', confirmText: '确定' });
      return;
    }
    setShareOpen(false);
    await reload();
  };

  const grid = (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map((ws) => (
        <Card key={ws.id} className="flex flex-col">
          <div className="flex items-start gap-3 mb-3">
            <div
              className="w-12 h-12 rounded flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--accent-primary-alpha)' }}
            >
              <FileText size={24} style={{ color: 'var(--accent-primary)' }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {ws.title}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                更新于 {formatDate(ws.updatedAt)}
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-auto">
            <Button size="sm" variant="primary" className="flex-1" onClick={() => navigate(`/literary-agent/${ws.id}`)}>
              <ArrowRight size={14} />
              打开
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void onRename(ws)}>
              <Pencil size={14} />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void onShare(ws)}>
              <Users2 size={14} />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void onDelete(ws)}>
              <Trash2 size={14} />
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[16px] font-extrabold" style={{ color: 'var(--text-primary)' }}>
              文学创作 Agent
            </div>
            <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              为文章智能生成配图：编辑文章 → AI 插入配图标记 → 一键生成图片 → 导出
            </div>
          </div>
          <Button variant="primary" onClick={() => void onCreate()} disabled={loading}>
            <Plus size={16} />
            新建文章
          </Button>
        </div>
      </Card>

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
      ) : items.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <FileText size={48} className="mx-auto mb-3" style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              还没有文章，点击右上角「新建文章」开始创作
            </div>
          </div>
        </Card>
      ) : (
        grid
      )}

      <Dialog
        open={shareOpen}
        onOpenChange={(o) => {
          setShareOpen(o);
          if (!o) {
            setShareWs(null);
            setMemberSet(new Set());
          }
        }}
        title="共享设置"
        content={
          <div className="p-4">
            <div className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
              选择可以访问此文章的成员
            </div>
            {usersLoading ? (
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                加载中...
              </div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {users.map((u) => (
                  <label key={u.userId} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={memberSet.has(u.userId)}
                      onChange={(e) => {
                        const next = new Set(memberSet);
                        if (e.target.checked) {
                          next.add(u.userId);
                        } else {
                          next.delete(u.userId);
                        }
                        setMemberSet(next);
                      }}
                    />
                    <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                      {u.username}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex gap-2 justify-end mt-4">
              <Button variant="secondary" onClick={() => setShareOpen(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void onSaveShare()}>
                保存
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}

