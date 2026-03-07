import { useState } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, FileBarChart, CheckSquare, ListChecks } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { createReportTemplate, updateReportTemplate, deleteReportTemplate } from '@/services';
import { ReportInputType } from '@/services/contracts/reportAgent';

const inputTypeLabels: Record<string, string> = {
  [ReportInputType.BulletList]: '列表',
  [ReportInputType.RichText]: '富文本',
  [ReportInputType.KeyValue]: '键值对',
  [ReportInputType.ProgressTable]: '进度表',
};

interface SectionInput {
  title: string;
  description: string;
  inputType: string;
  isRequired: boolean;
  sortOrder: number;
}

export function TemplateManager() {
  const { templates, teams, loadTemplates } = useReportAgentStore();
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [teamId, setTeamId] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [sections, setSections] = useState<SectionInput[]>([]);
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setName('');
    setDescription('');
    setTeamId('');
    setIsDefault(false);
    setSections([{ title: '', description: '', inputType: ReportInputType.BulletList, isRequired: true, sortOrder: 0 }]);
    setEditingId(null);
  };

  const handleEdit = (id: string) => {
    const t = templates.find((tpl) => tpl.id === id);
    if (!t) return;
    setEditingId(id);
    setName(t.name);
    setDescription(t.description || '');
    setTeamId(t.teamId || '');
    setIsDefault(t.isDefault);
    setSections(t.sections.map((s) => ({
      title: s.title,
      description: s.description || '',
      inputType: s.inputType,
      isRequired: s.isRequired,
      sortOrder: s.sortOrder,
    })));
    setShowDialog(true);
  };

  const handleCreate = () => {
    resetForm();
    setShowDialog(true);
  };

  const handleSave = async () => {
    if (!name.trim()) { toast.error('请输入模板名称'); return; }
    if (sections.length === 0) { toast.error('至少需要一个章节'); return; }
    if (sections.some((s) => !s.title.trim())) { toast.error('章节标题不能为空'); return; }

    setSaving(true);
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      sections: sections.map((s, i) => ({ ...s, sortOrder: i })),
      teamId: teamId || undefined,
      isDefault,
    };

    const res = editingId
      ? await updateReportTemplate({ id: editingId, ...payload })
      : await createReportTemplate(payload);

    setSaving(false);
    if (res.success) {
      toast.success(editingId ? '模板已更新' : '模板已创建');
      setShowDialog(false);
      void loadTemplates();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('确认删除该模板？')) return;
    const res = await deleteReportTemplate({ id });
    if (res.success) {
      toast.success('模板已删除');
      void loadTemplates();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const addSection = () => {
    setSections((prev) => [...prev, {
      title: '',
      description: '',
      inputType: ReportInputType.BulletList,
      isRequired: true,
      sortOrder: prev.length,
    }]);
  };

  const removeSection = (idx: number) => {
    setSections((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveSection = (idx: number, dir: -1 | 1) => {
    setSections((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const updateSection = (idx: number, field: keyof SectionInput, value: string | boolean) => {
    setSections((prev) => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileBarChart size={16} style={{ color: 'var(--text-secondary)' }} />
          <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            模板管理
          </span>
          <span
            className="text-[11px] px-2 py-0.5 rounded-full"
            style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
          >
            {templates.length}
          </span>
        </div>
        <Button variant="primary" size="sm" onClick={handleCreate}>
          <Plus size={14} /> 新建模板
        </Button>
      </div>

      {/* Template grid */}
      {templates.length === 0 ? (
        <div className="flex items-center justify-center" style={{ minHeight: 300 }}>
          <div className="text-center">
            <ListChecks size={32} style={{ color: 'var(--text-muted)', opacity: 0.4, margin: '0 auto' }} />
            <div className="text-[13px] mt-3" style={{ color: 'var(--text-muted)' }}>暂无模板</div>
            <Button variant="primary" size="sm" className="mt-3" onClick={handleCreate}>
              <Plus size={12} /> 创建模板
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="group rounded-xl transition-all duration-200 hover:translate-y-[-1px]"
              style={{
                background: 'var(--surface-glass)',
                backdropFilter: 'blur(12px)',
                border: '1px solid var(--border-primary)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
              }}
            >
              <div className="p-4">
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {tpl.name}
                      </span>
                      {tpl.isDefault && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ color: 'rgba(59, 130, 246, 0.9)', background: 'rgba(59, 130, 246, 0.1)' }}
                        >
                          默认
                        </span>
                      )}
                    </div>
                    {tpl.description && (
                      <div className="text-[12px] mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                        {tpl.description}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                    <button
                      className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                      onClick={() => handleEdit(tpl.id)}
                    >
                      <Pencil size={12} style={{ color: 'var(--text-muted)' }} />
                    </button>
                    <button
                      className="p-1.5 rounded-lg hover:bg-[rgba(239,68,68,0.08)] transition-colors"
                      onClick={() => handleDelete(tpl.id)}
                    >
                      <Trash2 size={12} style={{ color: 'var(--text-muted)' }} />
                    </button>
                  </div>
                </div>

                {/* Section tags */}
                <div className="flex flex-wrap gap-1.5">
                  {tpl.sections.map((s, i) => (
                    <span
                      key={i}
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
                      style={{
                        color: 'var(--text-secondary)',
                        background: 'var(--bg-tertiary)',
                      }}
                    >
                      {s.isRequired && <CheckSquare size={8} />}
                      {s.title}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
          <GlassCard className="p-0 w-[600px] max-h-[80vh] flex flex-col">
            <div className="px-5 py-4 font-semibold text-[15px]" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-primary)' }}>
              {editingId ? '编辑模板' : '新建模板'}
            </div>
            <div className="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-4">
              <input
                className="w-full px-3 py-2.5 rounded-xl text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                placeholder="模板名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="w-full px-3 py-2.5 rounded-xl text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                placeholder="模板描述（可选）"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <div className="flex items-center gap-3">
                <select
                  className="flex-1 px-3 py-2.5 rounded-xl text-[13px]"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="">不绑定团队</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <label className="flex items-center gap-1.5 text-[12px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                  默认模板
                </label>
              </div>

              <div className="text-[13px] font-medium mt-1" style={{ color: 'var(--text-secondary)' }}>章节配置</div>
              {sections.map((sec, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl flex flex-col gap-2.5"
                  style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-secondary)',
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono w-5 text-center" style={{ color: 'var(--text-muted)' }}>
                      {idx + 1}
                    </span>
                    <input
                      className="flex-1 px-2.5 py-1.5 rounded-lg text-[12px]"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                      placeholder="章节标题"
                      value={sec.title}
                      onChange={(e) => updateSection(idx, 'title', e.target.value)}
                    />
                    <select
                      className="px-2.5 py-1.5 rounded-lg text-[12px]"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                      value={sec.inputType}
                      onChange={(e) => updateSection(idx, 'inputType', e.target.value)}
                    >
                      {Object.entries(inputTypeLabels).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <input type="checkbox" checked={sec.isRequired} onChange={(e) => updateSection(idx, 'isRequired', e.target.checked)} />
                      必填
                    </label>
                    <Button variant="ghost" size="sm" onClick={() => moveSection(idx, -1)} disabled={idx === 0}><ChevronUp size={12} /></Button>
                    <Button variant="ghost" size="sm" onClick={() => moveSection(idx, 1)} disabled={idx === sections.length - 1}><ChevronDown size={12} /></Button>
                    <Button variant="ghost" size="sm" onClick={() => removeSection(idx)}><Trash2 size={12} /></Button>
                  </div>
                  <input
                    className="w-full px-2.5 py-1.5 rounded-lg text-[11px] ml-7"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', maxWidth: 'calc(100% - 1.75rem)' }}
                    placeholder="填写提示（可选）"
                    value={sec.description}
                    onChange={(e) => updateSection(idx, 'description', e.target.value)}
                  />
                </div>
              ))}
              <Button variant="ghost" size="sm" className="self-start" onClick={addSection}>
                <Plus size={12} /> 添加章节
              </Button>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
              <Button variant="secondary" size="sm" onClick={() => setShowDialog(false)}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}
