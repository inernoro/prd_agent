import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Loader2, Zap, PenLine, Workflow as WorkflowIcon,
  Trash2, Clock, Hash,
} from 'lucide-react';
import { listWorkflows, createWorkflow, deleteWorkflow } from '@/services';
import type { Workflow } from '@/services/contracts/workflowAgent';
import { GlassCard } from '@/components/design/GlassCard';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';

// ═══════════════════════════════════════════════════════════════
// 工作流列表页 — 首页
// ═══════════════════════════════════════════════════════════════

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function WorkflowRow({ workflow, onEdit, onCanvas, onDelete }: {
  workflow: Workflow;
  onEdit: () => void;
  onCanvas: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-4 px-4 py-3 rounded-[12px] transition-all duration-200 cursor-pointer"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
      }}
      onClick={onEdit}
    >
      {/* 图标 */}
      <div
        className="w-10 h-10 rounded-[10px] flex items-center justify-center flex-shrink-0"
        style={{
          background: 'rgba(214,178,106,0.1)',
          border: '1px solid rgba(214,178,106,0.15)',
        }}
      >
        <span className="text-lg">{workflow.icon || '⚡'}</span>
      </div>

      {/* 名称 + 描述 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {workflow.name || '未命名工作流'}
          </h3>
          {workflow.tags.map((tag) => (
            <Badge key={tag} variant="subtle" size="sm">{tag}</Badge>
          ))}
        </div>
        {workflow.description && (
          <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
            {workflow.description}
          </p>
        )}
      </div>

      {/* 统计 */}
      <div className="flex items-center gap-4 flex-shrink-0">
        <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <Hash className="w-3 h-3" />
          <span>{workflow.executionCount}</span>
        </div>
        {workflow.lastExecutedAt && (
          <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <Clock className="w-3 h-3" />
            <span>{formatDate(workflow.lastExecutedAt)}</span>
          </div>
        )}
      </div>

      {/* 悬浮操作按钮 */}
      <div className="flex items-center gap-1.5 opacity-0 pointer-events-none transition-all duration-150 group-hover:opacity-100 group-hover:pointer-events-auto flex-shrink-0">
        <Button
          size="xs"
          variant="primary"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          title="直接编辑"
        >
          <PenLine className="w-3 h-3" />
          直接编辑
        </Button>
        <Button
          size="xs"
          variant="secondary"
          onClick={(e) => { e.stopPropagation(); onCanvas(); }}
          title="画布编辑"
        >
          <WorkflowIcon className="w-3 h-3" />
          画布编辑
        </Button>
        <Button
          size="xs"
          variant="danger"
          className="h-6 w-6 p-0"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除"
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
}

export function WorkflowListPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    reload();
  }, []);

  async function reload() {
    setLoading(true);
    try {
      const res = await listWorkflows({ pageSize: 100 });
      if (res.success && res.data) {
        setWorkflows(res.data.items);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await createWorkflow({
        name: '新建工作流',
        description: '',
        icon: '⚡',
        tags: [],
      });
      if (res.success && res.data) {
        navigate(`/workflow-agent/${res.data.workflow.id}`);
      }
    } catch { /* ignore */ }
    setCreating(false);
  }

  async function handleDelete(wf: Workflow) {
    if (!confirm(`确定删除「${wf.name || '未命名'}」？`)) return;
    try {
      const res = await deleteWorkflow(wf.id);
      if (res.success) {
        setWorkflows((prev) => prev.filter((w) => w.id !== wf.id));
      }
    } catch { /* ignore */ }
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5">
      <TabBar
        title="TAPD 数据自动化"
        icon={<Zap size={16} />}
        actions={
          <Button
            variant="primary"
            size="xs"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Plus className="w-3.5 h-3.5" />
            }
            新建工作流
          </Button>
        }
      />

      <div className="px-5 pb-6 space-y-3 w-full max-w-4xl mx-auto">
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          管理你的自动化工作流。选择工作流可直接编辑节点配置，或使用画布编排更复杂的流程。
        </p>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-muted)' }} />
            <span className="ml-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</span>
          </div>
        )}

        {!loading && workflows.length === 0 && (
          <GlassCard>
            <div className="flex flex-col items-center py-10 gap-4">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(214,178,106,0.08)', border: '1px solid rgba(214,178,106,0.15)' }}
              >
                <Zap className="w-7 h-7" style={{ color: 'var(--accent-gold)' }} />
              </div>
              <div className="text-center">
                <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  尚无工作流
                </h3>
                <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  创建你的第一个自动化工作流
                </p>
              </div>
              <Button variant="primary" size="sm" onClick={handleCreate} disabled={creating}>
                <Plus className="w-4 h-4" />
                新建工作流
              </Button>
            </div>
          </GlassCard>
        )}

        {!loading && workflows.length > 0 && (
          <div className="space-y-1.5">
            {workflows.map((wf) => (
              <WorkflowRow
                key={wf.id}
                workflow={wf}
                onEdit={() => navigate(`/workflow-agent/${wf.id}`)}
                onCanvas={() => navigate(`/workflow-agent/${wf.id}/canvas`)}
                onDelete={() => handleDelete(wf)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
