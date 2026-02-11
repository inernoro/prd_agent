import { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { glassPanel } from '@/lib/glassStyles';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import {
  createDefectTemplate,
  updateDefectTemplate,
  deleteDefectTemplate,
} from '@/services';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  X,
  Plus,
  Pencil,
  Trash2,
  Star,
  Share2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { DefectTemplate } from '@/services/contracts/defectAgent';

export function TemplateDialog() {
  const {
    templates,
    setShowTemplateDialog,
    addTemplateToList,
    updateTemplateInList,
    removeTemplateFromList,
  } = useDefectStore();

  const [editingTemplate, setEditingTemplate] = useState<DefectTemplate | null>(
    null
  );
  const [isCreating, setIsCreating] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  // Expand state for shared templates
  const [showShared, setShowShared] = useState(false);

  const myTemplates = templates.filter((t) => !t.sharedFrom);
  const sharedTemplates = templates.filter((t) => t.sharedFrom);

  const startCreate = () => {
    setEditingTemplate(null);
    setIsCreating(true);
    setName('');
    setDescription('');
    setIsDefault(false);
  };

  const startEdit = (template: DefectTemplate) => {
    setEditingTemplate(template);
    setIsCreating(true);
    setName(template.name);
    setDescription(template.description || '');
    setIsDefault(template.isDefault);
  };

  const cancelEdit = () => {
    setEditingTemplate(null);
    setIsCreating(false);
    setName('');
    setDescription('');
    setIsDefault(false);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.warning('请输入模板名称');
      return;
    }

    setSaving(true);
    try {
      if (editingTemplate) {
        // Update
        const res = await updateDefectTemplate({
          id: editingTemplate.id,
          name: name.trim(),
          description: description.trim() || undefined,
          isDefault,
        });
        if (res.success && res.data) {
          updateTemplateInList(res.data.template);
          toast.success('模板已更新');
          cancelEdit();
        } else {
          toast.error(res.error?.message || '更新失败');
        }
      } else {
        // Create
        const res = await createDefectTemplate({
          name: name.trim(),
          description: description.trim() || undefined,
          requiredFields: [],
          isDefault,
        });
        if (res.success && res.data) {
          addTemplateToList(res.data.template);
          toast.success('模板已创建');
          cancelEdit();
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

  const handleDelete = async (template: DefectTemplate) => {
    const confirmed = await systemDialog.confirm({
      title: '删除模板',
      message: `确定要删除模板「${template.name}」吗？`,
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!confirmed) return;

    const res = await deleteDefectTemplate({ id: template.id });
    if (res.success) {
      removeTemplateFromList(template.id);
      toast.success('模板已删除');
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0, 0, 0, 0.5)' }}
        onClick={() => setShowTemplateDialog(false)}
      />

      {/* 弹窗内容 - 使用液态玻璃样式 */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[480px] max-h-[80vh] overflow-hidden rounded-2xl flex flex-col"
        style={{
          ...glassPanel,
          boxShadow:
            '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          <div
            className="text-[15px] font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            我的模板
          </div>
          <div className="flex items-center gap-2">
            {!isCreating && (
              <Button variant="secondary" size="sm" onClick={startCreate}>
                <Plus size={12} />
                新建
              </Button>
            )}
            <button
              onClick={() => setShowTemplateDialog(false)}
              className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            >
              <X size={16} style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {/* Create/Edit Form */}
          {isCreating && (
            <GlassCard glow className="mb-4">
              <div className="space-y-3">
                <div
                  className="text-[12px] font-medium"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {editingTemplate ? '编辑模板' : '新建模板'}
                </div>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="模板名称"
                  className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'var(--text-primary)',
                  }}
                />
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="模板描述（可选）"
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'var(--text-primary)',
                  }}
                />
                <label className="flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={isDefault}
                    onChange={(e) => setIsDefault(e.target.checked)}
                    className="rounded"
                  />
                  <span style={{ color: 'var(--text-secondary)' }}>
                    设为默认模板
                  </span>
                </label>
                <div className="flex items-center gap-2 justify-end pt-2">
                  <Button variant="secondary" size="sm" onClick={cancelEdit}>
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
            </GlassCard>
          )}

          {/* My Templates */}
          {myTemplates.length === 0 && !isCreating ? (
            <div
              className="text-center py-10 text-[13px]"
              style={{ color: 'var(--text-muted)' }}
            >
              暂无模板，点击右上角新建
            </div>
          ) : (
            <div className="space-y-2">
              {myTemplates.map((template) => (
                <div
                  key={template.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl transition-colors hover:bg-white/5"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[13px] font-medium truncate"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {template.name}
                      </span>
                      {template.isDefault && (
                        <Star
                          size={12}
                          fill="rgba(214,178,106,0.9)"
                          style={{ color: 'rgba(214,178,106,0.9)' }}
                        />
                      )}
                    </div>
                    {template.description && (
                      <div
                        className="text-[11px] mt-1 truncate"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {template.description}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => startEdit(template)}
                      className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                      title="编辑"
                    >
                      <Pencil size={14} style={{ color: 'var(--text-muted)' }} />
                    </button>
                    <button
                      className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                      title="分享"
                    >
                      <Share2 size={14} style={{ color: 'var(--text-muted)' }} />
                    </button>
                    <button
                      onClick={() => handleDelete(template)}
                      className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                      title="删除"
                    >
                      <Trash2
                        size={14}
                        style={{ color: 'rgba(255,100,100,0.8)' }}
                      />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Shared Templates */}
          {sharedTemplates.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowShared(!showShared)}
                className="flex items-center gap-2 text-[12px] mb-2 hover:opacity-80 transition-opacity"
                style={{ color: 'var(--text-muted)' }}
              >
                {showShared ? (
                  <ChevronUp size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                收到的分享 ({sharedTemplates.length})
              </button>
              {showShared && (
                <div className="space-y-2">
                  {sharedTemplates.map((template) => (
                    <div
                      key={template.id}
                      className="flex items-center gap-3 px-4 py-3 rounded-xl"
                      style={{
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid rgba(255,255,255,0.04)',
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <div
                          className="text-[13px] truncate"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {template.name}
                        </div>
                        <div
                          className="text-[11px] mt-1"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          来自: {template.sharedFrom}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
