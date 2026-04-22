import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, FileBarChart, CheckSquare, ListChecks, Star, Users as UsersIcon, Shield } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import {
  createReportTemplate,
  updateReportTemplate,
  deleteReportTemplate,
  getMyDefaultTemplate,
  setMyDefaultTemplate,
  clearMyDefaultTemplate,
} from '@/services';
import { ReportInputType, type ReportTemplate } from '@/services/contracts/reportAgent';

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

type Scope = 'system' | 'mine' | 'team' | 'other';

function resolveScope(tpl: ReportTemplate, currentUserId: string | undefined): Scope {
  if (tpl.isSystem) return 'system';
  if (currentUserId && tpl.createdBy === currentUserId) return 'mine';
  if (tpl.teamId) return 'team';
  return 'other';
}

const scopeMeta: Record<Scope, { label: string; color: string; bg: string; Icon: typeof Shield }> = {
  system: { label: '系统', color: 'rgba(148, 163, 184, 0.95)', bg: 'rgba(148, 163, 184, 0.1)', Icon: Shield },
  mine: { label: '我创建', color: 'rgba(34, 197, 94, 0.95)', bg: 'rgba(34, 197, 94, 0.1)', Icon: Pencil },
  team: { label: '团队', color: 'rgba(168, 85, 247, 0.95)', bg: 'rgba(168, 85, 247, 0.1)', Icon: UsersIcon },
  other: { label: '其他成员', color: 'rgba(148, 163, 184, 0.8)', bg: 'rgba(148, 163, 184, 0.08)', Icon: UsersIcon },
};

export function TemplateManager() {
  const { templates, teams, users, loadTemplates, loadUsers } = useReportAgentStore();
  const currentUserId = useAuthStore((s) => s.user?.userId);
  const permissions = useAuthStore((s) => s.permissions);
  const canViewAll = permissions.includes('report-agent.view.all');

  const [myDefaultId, setMyDefaultId] = useState<string | null>(null);
  const [myDefaultLoading, setMyDefaultLoading] = useState(false);

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [teamId, setTeamId] = useState('');
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [sections, setSections] = useState<SectionInput[]>([]);
  const [saving, setSaving] = useState(false);

  const userLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) {
      map.set(u.id, u.displayName || u.username || u.id);
    }
    return map;
  }, [users]);

  useEffect(() => {
    if (users.length === 0) void loadUsers();
  }, [users.length, loadUsers]);

  useEffect(() => {
    void refreshMyDefault();
  }, []);

  const refreshMyDefault = async () => {
    setMyDefaultLoading(true);
    const res = await getMyDefaultTemplate();
    if (res.success && res.data) {
      setMyDefaultId(res.data.template?.id ?? null);
    }
    setMyDefaultLoading(false);
  };

  const resetForm = () => {
    setName('');
    setDescription('');
    setTeamId('');
    setSetAsDefault(false);
    setSections([{ title: '', description: '', inputType: ReportInputType.BulletList, isRequired: true, sortOrder: 0 }]);
    setEditingId(null);
  };

  const canEditTemplate = (tpl: ReportTemplate): boolean => {
    if (tpl.isSystem) return false;
    if (canViewAll) return true;
    return !!currentUserId && tpl.createdBy === currentUserId;
  };

  const handleEdit = (id: string) => {
    const t = templates.find((tpl) => tpl.id === id);
    if (!t) return;
    if (!canEditTemplate(t)) {
      toast.error('只能编辑自己创建的模板');
      return;
    }
    setEditingId(id);
    setName(t.name);
    setDescription(t.description || '');
    setTeamId(t.teamId || '');
    setSetAsDefault(myDefaultId === id);
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
      isDefault: setAsDefault,
    };

    const res = editingId
      ? await updateReportTemplate({ id: editingId, ...payload })
      : await createReportTemplate(payload);

    setSaving(false);
    if (res.success) {
      toast.success(editingId ? '模板已更新' : '模板已创建');
      setShowDialog(false);
      void loadTemplates();
      void refreshMyDefault();
    } else {
      toast.error(res.error?.message || '操作失败');
    }
  };

  const handleDelete = async (id: string) => {
    const t = templates.find((tpl) => tpl.id === id);
    if (t && !canEditTemplate(t)) {
      toast.error('只能删除自己创建的模板');
      return;
    }
    if (!window.confirm('确认删除该模板？')) return;
    const res = await deleteReportTemplate({ id });
    if (res.success) {
      toast.success('模板已删除');
      void loadTemplates();
      if (myDefaultId === id) void refreshMyDefault();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const handleSetMyDefault = async (id: string) => {
    const res = await setMyDefaultTemplate({ id });
    if (res.success) {
      setMyDefaultId(id);
      toast.success('已设为你的默认模板');
    } else {
      toast.error(res.error?.message || '设置失败');
    }
  };

  const handleClearMyDefault = async () => {
    const res = await clearMyDefaultTemplate();
    if (res.success) {
      void refreshMyDefault();
      toast.success('已清除默认模板偏好');
    } else {
      toast.error(res.error?.message || '操作失败');
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

  const sortedTemplates = useMemo(() => {
    const withScope = templates.map((tpl) => ({ tpl, scope: resolveScope(tpl, currentUserId) }));
    const priority: Record<Scope, number> = { mine: 0, team: 1, system: 2, other: 3 };
    return withScope.sort((a, b) => {
      if (myDefaultId && a.tpl.id === myDefaultId) return -1;
      if (myDefaultId && b.tpl.id === myDefaultId) return 1;
      const pa = priority[a.scope];
      const pb = priority[b.scope];
      if (pa !== pb) return pa - pb;
      return new Date(b.tpl.updatedAt).getTime() - new Date(a.tpl.updatedAt).getTime();
    });
  }, [templates, currentUserId, myDefaultId]);

  return (
    <div className="flex flex-col gap-5">
      {/* Header — card-wrapped */}
      <GlassCard variant="subtle" className="px-5 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'rgba(168, 85, 247, 0.06)' }}>
              <FileBarChart size={16} style={{ color: 'rgba(168, 85, 247, 0.8)' }} />
            </div>
            <div>
              <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                模板管理
              </span>
              <span
                className="text-[11px] px-2 py-0.5 rounded-full ml-2"
                style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
              >
                {templates.length} 个模板
              </span>
              <span className="text-[11px] ml-2" style={{ color: 'var(--text-muted)' }}>
                · 只看「系统 / 我创建 / 我所在团队」
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {myDefaultId && (
              <Button variant="secondary" size="sm" onClick={handleClearMyDefault} disabled={myDefaultLoading}>
                清除我的默认
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={handleCreate}>
              <Plus size={14} /> 新建模板
            </Button>
          </div>
        </div>
      </GlassCard>

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
          {sortedTemplates.map(({ tpl, scope }) => {
            const meta = scopeMeta[scope];
            const isMyDefault = myDefaultId === tpl.id;
            const editable = canEditTemplate(tpl);
            const teamLabel = tpl.teamId ? teams.find((t) => t.id === tpl.teamId)?.name : null;
            const creatorLabel = userLookup.get(tpl.createdBy) || (tpl.createdBy === 'system' ? '系统' : tpl.createdBy);
            return (
              <div
                key={tpl.id}
                className="group rounded-xl transition-all duration-200 hover:translate-y-[-1px]"
                style={{
                  background: 'var(--surface-glass)',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  border: isMyDefault ? '1px solid rgba(59,130,246,0.5)' : '1px solid var(--border-primary)',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <div className="p-5">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {tpl.name}
                        </span>
                        <span
                          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ color: meta.color, background: meta.bg }}
                          title={scope === 'team' && teamLabel ? `团队：${teamLabel}` : meta.label}
                        >
                          <meta.Icon size={9} />
                          {scope === 'team' && teamLabel ? teamLabel : meta.label}
                        </span>
                        {isMyDefault && (
                          <span
                            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                            style={{ color: 'rgba(59, 130, 246, 0.95)', background: 'rgba(59, 130, 246, 0.12)' }}
                          >
                            <Star size={9} />
                            我的默认
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        创建人：{creatorLabel}
                      </div>
                      {tpl.description && (
                        <div className="text-[12px] mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                          {tpl.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                      {!isMyDefault && (
                        <button
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                          onClick={() => handleSetMyDefault(tpl.id)}
                          title="设为我的默认"
                        >
                          <Star size={12} style={{ color: 'var(--text-muted)' }} />
                        </button>
                      )}
                      {editable && (
                        <>
                          <button
                            className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                            onClick={() => handleEdit(tpl.id)}
                            title="编辑"
                          >
                            <Pencil size={12} style={{ color: 'var(--text-muted)' }} />
                          </button>
                          <button
                            className="p-1.5 rounded-lg hover:bg-[rgba(239,68,68,0.08)] transition-colors"
                            onClick={() => handleDelete(tpl.id)}
                            title="删除"
                          >
                            <Trash2 size={12} style={{ color: 'var(--text-muted)' }} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Section tags with accent colors */}
                  <div className="flex flex-wrap gap-1.5">
                    {tpl.sections.map((s, i) => {
                      const tagColors = [
                        { color: 'rgba(59, 130, 246, 0.85)', bg: 'rgba(59, 130, 246, 0.08)' },
                        { color: 'rgba(34, 197, 94, 0.85)', bg: 'rgba(34, 197, 94, 0.08)' },
                        { color: 'rgba(168, 85, 247, 0.85)', bg: 'rgba(168, 85, 247, 0.08)' },
                        { color: 'rgba(249, 115, 22, 0.85)', bg: 'rgba(249, 115, 22, 0.08)' },
                        { color: 'rgba(236, 72, 153, 0.85)', bg: 'rgba(236, 72, 153, 0.08)' },
                      ];
                      const tc = tagColors[i % tagColors.length];
                      return (
                        <span
                          key={i}
                          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-full font-medium"
                          style={{ color: tc.color, background: tc.bg }}
                        >
                          {s.isRequired && <CheckSquare size={8} />}
                          {s.title}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
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
                  <input type="checkbox" checked={setAsDefault} onChange={(e) => setSetAsDefault(e.target.checked)} />
                  {canViewAll ? '设为全局默认' : '设为我的默认'}
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
