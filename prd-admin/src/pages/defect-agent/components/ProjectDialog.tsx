import { useState } from 'react';
import { Surface } from '@/components/design';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import {
  createDefectProject,
  updateDefectProject,
  archiveDefectProject,
} from '@/services';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { Plus, Pencil, Archive, ArchiveRestore } from 'lucide-react';
import type { DefectProject } from '@/services/contracts/defectAgent';

interface ProjectDialogProps {
  onClose: () => void;
}

export function ProjectDialog({ onClose }: ProjectDialogProps) {
  const { projects, loadProjects } = useDefectStore();

  const [editingProject, setEditingProject] = useState<DefectProject | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const activeProjects = projects.filter((p) => !p.isArchived);
  const archivedProjects = projects.filter((p) => p.isArchived);

  const startCreate = () => {
    setEditingProject(null);
    setIsCreating(true);
    setName('');
    setKey('');
    setDescription('');
  };

  const startEdit = (project: DefectProject) => {
    setEditingProject(project);
    setIsCreating(true);
    setName(project.name);
    setKey(project.key);
    setDescription(project.description || '');
  };

  const cancelEdit = () => {
    setEditingProject(null);
    setIsCreating(false);
    setName('');
    setKey('');
    setDescription('');
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.warning('请输入项目名称');
      return;
    }
    if (!editingProject && !key.trim()) {
      toast.warning('请输入项目标识');
      return;
    }

    setSaving(true);
    try {
      if (editingProject) {
        const res = await updateDefectProject({
          id: editingProject.id,
          name: name.trim(),
          description: description.trim() || undefined,
        });
        if (res.success) {
          toast.success('项目已更新');
          cancelEdit();
          await loadProjects();
        } else {
          toast.error(res.error?.message || '更新失败');
        }
      } else {
        const res = await createDefectProject({
          name: name.trim(),
          key: key.trim().toUpperCase(),
          description: description.trim() || undefined,
        });
        if (res.success) {
          toast.success('项目已创建');
          cancelEdit();
          await loadProjects();
        } else {
          toast.error(res.error?.message || '创建失败');
        }
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (project: DefectProject) => {
    const confirmed = await systemDialog.confirm({
      title: '归档项目',
      message: `确定要归档项目「${project.name}」吗？归档后该项目下的缺陷仍然保留，但不再出现在项目筛选中。`,
      confirmText: '归档',
      cancelText: '取消',
    });
    if (!confirmed) return;

    const res = await archiveDefectProject({ id: project.id });
    if (res.success) {
      toast.success('项目已归档');
      await loadProjects();
    } else {
      toast.error(res.error?.message || '归档失败');
    }
  };

  const renderProjectRow = (project: DefectProject) => (
    <Surface
      variant="interactive"
      key={project.id}
      className="flex items-center gap-3 px-4 py-3 rounded-xl"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="bg-token-nested text-token-accent text-[11px] px-1.5 py-0.5 rounded font-mono">
            {project.key}
          </span>
          <span className="text-token-primary text-[13px] font-medium truncate">
            {project.name}
          </span>
        </div>
        {project.description && (
          <div className="text-token-muted text-[11px] mt-1 truncate">
            {project.description}
          </div>
        )}
      </div>
      {!project.isArchived && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => startEdit(project)}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors"
            title="编辑"
          >
            <Pencil size={14} className="text-token-muted" />
          </button>
          <button
            onClick={() => handleArchive(project)}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors"
            title="归档"
          >
            <Archive size={14} className="text-token-warning" />
          </button>
        </div>
      )}
    </Surface>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="项目管理"
      maxWidth={520}
      titleAction={
        !isCreating ? (
          <Button variant="secondary" size="sm" onClick={startCreate}>
            <Plus size={12} />
            新建项目
          </Button>
        ) : undefined
      }
      contentStyle={{ maxHeight: 'min(80vh, 640px)' }}
      content={
        <div className="h-full overflow-y-auto -mx-1 px-1">
          {/* Create/Edit Form */}
          {isCreating && (
            <Surface variant="raised" className="mb-4 rounded-xl p-4">
              <div className="space-y-3">
                <div className="text-token-primary text-[12px] font-medium">
                  {editingProject ? '编辑项目' : '新建项目'}
                </div>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="项目名称，如：智能体"
                  className="prd-field w-full px-3 py-2 rounded-lg text-[13px]"
                />
                {!editingProject && (
                  <div>
                    <input
                      type="text"
                      value={key}
                      onChange={(e) => setKey(e.target.value.replace(/[^a-zA-Z0-9-]/g, '').toUpperCase())}
                      placeholder="项目标识，如：AI-ASSIST（创建后不可修改）"
                      maxLength={20}
                      className="prd-field w-full px-3 py-2 rounded-lg text-[13px] font-mono"
                    />
                    <div className="text-token-muted text-[11px] mt-1">
                      用于缺陷编号前缀，如 AI-ASSIST-001，仅允许大写字母、数字和连字符
                    </div>
                  </div>
                )}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="项目描述（可选）"
                  rows={2}
                  className="prd-field w-full px-3 py-2 rounded-lg text-[13px] resize-none"
                />
                <div className="flex items-center gap-2 justify-end pt-1">
                  <Button variant="ghost" size="sm" onClick={cancelEdit}>
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? '保存中...' : '保存'}
                  </Button>
                </div>
              </div>
            </Surface>
          )}

          {/* Active Projects */}
          {activeProjects.length === 0 && !isCreating ? (
            <div className="text-token-muted text-center py-10 text-[13px]">
              暂无项目，点击右上角新建
            </div>
          ) : (
            <div className="space-y-2">
              {activeProjects.map(renderProjectRow)}
            </div>
          )}

          {/* Archived Projects */}
          {archivedProjects.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowArchived(!showArchived)}
                className="text-token-muted flex items-center gap-2 text-[12px] mb-2 hover:opacity-80 transition-opacity"
              >
                <ArchiveRestore size={14} />
                已归档 ({archivedProjects.length})
              </button>
              {showArchived && (
                <div className="space-y-2">
                  {archivedProjects.map(renderProjectRow)}
                </div>
              )}
            </div>
          )}
        </div>
      }
    />
  );
}
