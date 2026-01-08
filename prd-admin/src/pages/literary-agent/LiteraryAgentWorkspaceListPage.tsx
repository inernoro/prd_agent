import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { systemDialog } from '@/lib/systemDialog';
import {
  createImageMasterWorkspace,
  deleteImageMasterWorkspace,
  listImageMasterWorkspaces,
  updateImageMasterWorkspace,
} from '@/services';
import type { ImageMasterWorkspace } from '@/services/contracts/imageMaster';
import { Plus, Pencil, Trash2, FileText, SquarePen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

function getArticlePreviewText(ws: ImageMasterWorkspace, maxChars = 60) {
  const raw = ws.articleContent ?? ws.articleContentWithMarkers ?? '';
  let s = String(raw ?? '').trim();
  if (!s) return '';

  // 文学创作 Agent 的文章配图标记：`[插图] : xxx`；列表预览应去掉标记与占位文案
  s = s.replace(/^\s*\[插图\]\s*:\s*.*$/gm, '');
  s = s.replace(/^\s*>\s*配图.*$/gm, '');
  s = s.replace(/\s+/g, ' ').trim();

  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…`;
}

export default function LiteraryAgentWorkspaceListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ImageMasterWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

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

  const grid = (
    <div className="w-full max-w-[1080px] mx-auto space-y-3">
      {items.map((ws) => (
        <Card key={ws.id} className="p-0 overflow-hidden">
          <div
            role="button"
            tabIndex={0}
            title={ws.title || ws.id}
            className={[
              'group relative cursor-pointer select-none',
              'transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15',
            ].join(' ')}
            onClick={() => navigate(`/literary-agent/${ws.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(`/literary-agent/${ws.id}`);
              }
            }}
          >
            <div className="flex items-start gap-4 p-4 pb-14">
              <div
                className="w-12 h-12 rounded flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--accent-primary-alpha)' }}
              >
                <FileText size={24} style={{ color: 'var(--accent-primary)' }} />
              </div>

              <div className="flex-1 min-w-0 text-left">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {ws.title}
                  </div>
                  <div className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                    更新于 {formatDate(ws.updatedAt)}
                  </div>
                </div>

                <div className="mt-2 text-[12px] leading-5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                  {getArticlePreviewText(ws) || '（暂无内容）'}
                </div>
              </div>
            </div>

            {/* hover/focus-within：底部浮出操作条；按钮点击必须阻止冒泡避免触发“进入卡片” */}
            <div
              className={[
                'absolute left-4 right-4 bottom-3 flex items-center justify-start gap-2',
                'opacity-0 translate-y-1 pointer-events-none',
                'transition-all duration-150',
                'group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto',
                'group-focus-within:opacity-100 group-focus-within:translate-y-0 group-focus-within:pointer-events-auto',
              ].join(' ')}
            >
              <Button
                size="sm"
                variant="secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/literary-agent/${ws.id}`);
                }}
                title="编辑"
              >
                <SquarePen size={14} />
                编辑
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  void onRename(ws);
                }}
                title="重命名"
              >
                <Pencil size={14} />
                重命名
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  void onDelete(ws);
                }}
                title="删除"
              >
                <Trash2 size={14} />
                删除
              </Button>
            </div>
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
    </div>
  );
}

