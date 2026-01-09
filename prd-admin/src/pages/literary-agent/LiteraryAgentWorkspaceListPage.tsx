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


function getArticlePreviewText(ws: ImageMasterWorkspace, maxChars = 200) {
  const raw = ws.articleContent ?? ws.articleContentWithMarkers ?? '';
  let s = String(raw ?? '').trim();
  if (!s) return '';

  // 文学创作 Agent 的文章配图标记：`[插图] : xxx`；列表预览应去掉标记与占位文案
  s = s.replace(/^\s*\[插图\]\s*:\s*.*$/gm, '');
  s = s.replace(/^\s*>\s*配图.*$/gm, '');
  s = s.trim();

  // 列表预览不按固定字数提前截断：交给 CSS 做“按容器边界裁剪 + 省略号”
  // 这里仅做轻量的长度保护，避免极端长文本影响渲染性能
  const softLimit = Math.max(800, maxChars);
  if (s.length <= softLimit) return s;
  return s.slice(0, softLimit);
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
    <div className="w-full max-w-[1440px] mx-auto grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
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
              'flex flex-col h-full',
            ].join(' ')}
            onClick={() => navigate(`/literary-agent/${ws.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(`/literary-agent/${ws.id}`);
              }
            }}
          >
            {/* 上栏：标题区 */}
            <div className="p-3 pb-1 flex-shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <FileText size={18} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                  <div className="font-semibold text-[15px] group-hover:truncate" style={{ color: 'var(--text-primary)' }}>
                    {ws.title}
                  </div>
                </div>
              </div>
            </div>

            {/* 中栏：摘要区 */}
            <div className="px-3 pb-1 flex-1 min-h-0 overflow-hidden">
              <div
                className="h-full overflow-hidden border rounded-[8px] text-[12px] leading-5 flex flex-col"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'rgba(255,255,255,0.02)',
                  color: 'var(--text-secondary)',
                }}
              >
                <div className="p-3 flex-1">
                  {getArticlePreviewText(ws) ? (
                    // 预览不渲染 Markdown：用纯文本 + CSS line-clamp，按容器边界裁剪并展示省略号
                    <div
                      style={{
                        display: '-webkit-box',
                        WebkitBoxOrient: 'vertical' as const,
                        WebkitLineClamp: 10,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {getArticlePreviewText(ws)}
                    </div>
                  ) : (
                    <div style={{ color: 'var(--text-muted)' }}>（暂无内容）</div>
                  )}
                </div>
                <div
                  className="px-3 py-2 text-[11px] border-t flex items-center gap-2"
                  style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
                >
                  {/* 操作按钮：放到“更新于 …”左侧；hover/focus-within 显示；不参与高度变化，避免撑开 */}
                  <div
                    className={[
                      'w-[104px] flex items-center gap-1.5',
                      'opacity-0 pointer-events-none',
                      'transition-opacity duration-150',
                      'group-hover:opacity-100 group-hover:pointer-events-auto',
                      'group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
                    ].join(' ')}
                  >
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-7 w-7 p-0 rounded-[10px] gap-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/literary-agent/${ws.id}`);
                      }}
                      title="编辑"
                    >
                      <SquarePen size={14} />
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-7 w-7 p-0 rounded-[10px] gap-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRename(ws);
                      }}
                      title="重命名"
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      size="xs"
                      variant="danger"
                      className="h-7 w-7 p-0 rounded-[10px] gap-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDelete(ws);
                      }}
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>

                  <div className="flex-1 text-right">
                    {formatDate(ws.updatedAt) ? `更新于 ${formatDate(ws.updatedAt)}` : ''}
                  </div>
                </div>
              </div>
            </div>

            {/* 下栏：图片区，仅在有图片时显示 */}
            {ws.coverAssets && ws.coverAssets.length > 0 && (
              <div className="px-3 pb-3 pt-1 flex-shrink-0">
                <div className="grid grid-cols-3 gap-2">
                  {ws.coverAssets.slice(0, 3).map((a, idx) => (
                    <div
                      key={a.id}
                      className="relative overflow-hidden rounded-[8px] border"
                      style={{ borderColor: 'var(--border-subtle)', background: 'rgba(255,255,255,0.04)' }}
                    >
                      <div className="aspect-[4/3]">
                        <img
                          src={a.url}
                          alt={ws.title ? `${ws.title}-cover-${idx + 1}` : `cover-${idx + 1}`}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          draggable={false}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
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

