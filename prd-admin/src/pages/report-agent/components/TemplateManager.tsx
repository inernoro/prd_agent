import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, FileBarChart, CheckSquare, ListChecks, Star, Users as UsersIcon, Shield, X } from 'lucide-react';
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
import { ReportInputType, ReportTeamRole, type ReportTemplate, type IssueOption } from '@/services/contracts/reportAgent';
import { useDataTheme } from '../hooks/useDataTheme';

const inputTypeLabels: Record<string, string> = {
  [ReportInputType.BulletList]: '列表',
  [ReportInputType.RichText]: '富文本',
  [ReportInputType.KeyValue]: '键值对',
  [ReportInputType.ProgressTable]: '进度表',
  [ReportInputType.IssueList]: '问题',
};

interface SectionInput {
  title: string;
  description: string;
  inputType: string;
  isRequired: boolean;
  sortOrder: number;
  issueCategories?: IssueOption[];
  issueStatuses?: IssueOption[];
}

/** 默认问题分类（新建"问题"章节时初始填入） */
const DEFAULT_ISSUE_CATEGORIES: IssueOption[] = [
  { key: 'tech', label: '技术' },
  { key: 'product', label: '产品' },
  { key: 'process', label: '流程' },
  { key: 'resource', label: '资源' },
];
/** 默认问题状态 */
const DEFAULT_ISSUE_STATUSES: IssueOption[] = [
  { key: 'new', label: '新增' },
  { key: 'ongoing', label: '跟进中' },
  { key: 'resolved', label: '已解决' },
  { key: 'blocked', label: '阻塞' },
];

type Scope = 'system' | 'mine' | 'team' | 'other';

function resolveScope(tpl: ReportTemplate, currentUserId: string | undefined): Scope {
  if (tpl.isSystem) return 'system';
  if (currentUserId && tpl.createdBy === currentUserId) return 'mine';
  const anyTeam = (tpl.teamIds && tpl.teamIds.length > 0) || !!tpl.teamId;
  if (anyTeam) return 'team';
  return 'other';
}

const scopeMeta: Record<Scope, { label: string; color: string; bg: string; Icon: typeof Shield }> = {
  system: { label: '系统', color: 'rgba(148, 163, 184, 0.95)', bg: 'rgba(148, 163, 184, 0.1)', Icon: Shield },
  mine: { label: '我创建', color: 'rgba(34, 197, 94, 0.95)', bg: 'rgba(34, 197, 94, 0.1)', Icon: Pencil },
  team: { label: '团队', color: 'rgba(168, 85, 247, 0.95)', bg: 'rgba(168, 85, 247, 0.1)', Icon: UsersIcon },
  other: { label: '其他成员', color: 'rgba(148, 163, 184, 0.8)', bg: 'rgba(148, 163, 184, 0.08)', Icon: UsersIcon },
};

/** 问题分类 / 状态预设内嵌编辑器:追加/删除 option 项 */
function IssueOptionEditor({
  title, placeholder, options, onChange,
}: {
  title: string;
  placeholder: string;
  options: IssueOption[];
  onChange: (next: IssueOption[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const handleAdd = () => {
    const label = draft.trim();
    if (!label) return;
    // 自动生成 key（slug + 序号兜底）
    const baseKey = label.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') || `opt-${options.length + 1}`;
    let key = baseKey;
    let n = 2;
    while (options.some((o) => o.key === key)) key = `${baseKey}-${n++}`;
    onChange([...options, { key, label }]);
    setDraft('');
  };
  const handleRemove = (key: string) => {
    onChange(options.filter((o) => o.key !== key));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <span
            key={opt.key}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
          >
            {opt.label}
            <button
              type="button"
              onClick={() => handleRemove(opt.key)}
              className="ml-0.5 opacity-60 hover:opacity-100"
              aria-label={`删除 ${opt.label}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          className="flex-1 px-2.5 py-1 rounded-lg text-[11px]"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
        />
        <Button variant="ghost" size="sm" onClick={handleAdd}>
          <Plus size={11} /> 添加
        </Button>
      </div>
    </div>
  );
}

/** 归一化：把 teamId 单字段和 teamIds 多字段合并为一个数组 */
function getTemplateTeamIds(tpl: ReportTemplate): string[] {
  const set = new Set<string>();
  if (tpl.teamIds) tpl.teamIds.forEach((tid) => tid && set.add(tid));
  if (tpl.teamId) set.add(tpl.teamId);
  return Array.from(set);
}

export function TemplateManager() {
  const isLight = useDataTheme() === 'light';
  const { templates, teams, users, loadTemplates, loadUsers } = useReportAgentStore();
  const currentUserId = useAuthStore((s) => s.user?.userId);

  // 当前用户可管的团队（Leader / Deputy）
  const manageableTeams = useMemo(
    () => teams.filter((t) => {
      const role = t.myRole ?? (t.leaderUserId === currentUserId ? ReportTeamRole.Leader : undefined);
      return role === ReportTeamRole.Leader || role === ReportTeamRole.Deputy;
    }),
    [teams, currentUserId]
  );
  const manageableTeamIdSet = useMemo(() => new Set(manageableTeams.map((t) => t.id)), [manageableTeams]);

  const [myDefaultId, setMyDefaultId] = useState<string | null>(null);
  const [myDefaultLoading, setMyDefaultLoading] = useState(false);

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [defaultForTeamIds, setDefaultForTeamIds] = useState<string[]>([]);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  const [sections, setSections] = useState<SectionInput[]>([]);
  const [saving, setSaving] = useState(false);

  const userLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) {
      map.set(u.id, u.displayName || u.username || u.id);
    }
    return map;
  }, [users]);

  const teamLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of teams) map.set(t.id, t.name);
    return map;
  }, [teams]);

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
    setSelectedTeamIds([]);
    setDefaultForTeamIds([]);
    setTeamPickerOpen(false);
    setSections([{ title: '', description: '', inputType: ReportInputType.BulletList, isRequired: true, sortOrder: 0 }]);
    setEditingId(null);
  };

  const canEditTemplate = (tpl: ReportTemplate): boolean => {
    if (tpl.isSystem) return false;
    if (currentUserId && tpl.createdBy === currentUserId) return true;
    // 任一关联团队的 Leader/Deputy 也能编辑/删除
    const tplTeamIds = getTemplateTeamIds(tpl);
    return tplTeamIds.some((tid) => manageableTeamIdSet.has(tid));
  };

  const handleEdit = (id: string) => {
    const t = templates.find((tpl) => tpl.id === id);
    if (!t) return;
    if (!canEditTemplate(t)) {
      toast.error('仅作者或关联团队的管理员/副管理员可编辑');
      return;
    }
    setEditingId(id);
    setName(t.name);
    setDescription(t.description || '');
    setSelectedTeamIds(getTemplateTeamIds(t));
    setDefaultForTeamIds(t.defaultForTeamIds || []);
    setTeamPickerOpen(false);
    setSections(t.sections.map((s) => ({
      title: s.title,
      description: s.description || '',
      inputType: s.inputType,
      isRequired: s.isRequired,
      sortOrder: s.sortOrder,
      issueCategories: s.issueCategories ? [...s.issueCategories] : undefined,
      issueStatuses: s.issueStatuses ? [...s.issueStatuses] : undefined,
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

    // 默认团队必须是已关联团队的子集
    const invalidDefaults = defaultForTeamIds.filter((tid) => !selectedTeamIds.includes(tid));
    if (invalidDefaults.length > 0) {
      toast.error('默认团队必须先被关联');
      return;
    }

    // 新建必须自己管得着；编辑时只要新增的团队是自己管的即可（后端同样会校验）
    if (!editingId) {
      const outsideMyScope = selectedTeamIds.filter((tid) => !manageableTeamIdSet.has(tid));
      if (outsideMyScope.length > 0) {
        toast.error('只能关联自己管理的团队');
        return;
      }
    }

    setSaving(true);
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      sections: sections.map((s, i) => ({ ...s, sortOrder: i })),
      teamIds: selectedTeamIds,
      defaultForTeamIds,
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
      toast.error('仅作者或关联团队的管理员/副管理员可删除');
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

  const toggleSelectedTeam = (tid: string) => {
    setSelectedTeamIds((prev) => {
      if (prev.includes(tid)) {
        // 移除关联时同时从默认列表剔除
        setDefaultForTeamIds((d) => d.filter((x) => x !== tid));
        return prev.filter((x) => x !== tid);
      }
      return [...prev, tid];
    });
  };

  const toggleDefaultForTeam = (tid: string) => {
    if (!selectedTeamIds.includes(tid)) return;
    setDefaultForTeamIds((prev) =>
      prev.includes(tid) ? prev.filter((x) => x !== tid) : [...prev, tid]
    );
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
    setSections((prev) => prev.map((s, i) => {
      if (i !== idx) return s;
      const next = { ...s, [field]: value };
      // 首次切到"问题"类型,自动填入默认分类/状态
      if (field === 'inputType' && value === ReportInputType.IssueList) {
        if (!next.issueCategories || next.issueCategories.length === 0) next.issueCategories = [...DEFAULT_ISSUE_CATEGORIES];
        if (!next.issueStatuses || next.issueStatuses.length === 0) next.issueStatuses = [...DEFAULT_ISSUE_STATUSES];
      }
      return next;
    }));
  };

  /** 更新章节的分类/状态预设项列表 */
  const updateSectionIssueOptions = (idx: number, field: 'issueCategories' | 'issueStatuses', options: IssueOption[]) => {
    setSections((prev) => prev.map((s, i) => i === idx ? { ...s, [field]: options } : s));
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
                · 仅团队管理员/副管理员可见与操作
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {myDefaultId && (
              <Button variant="secondary" size="sm" onClick={handleClearMyDefault} disabled={myDefaultLoading}>
                清除我的默认
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreate}
              disabled={manageableTeams.length === 0}
              title={manageableTeams.length === 0 ? '需至少是一个团队的管理员/副管理员' : undefined}
            >
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
            <Button variant="primary" size="sm" className="mt-3" onClick={handleCreate} disabled={manageableTeams.length === 0}>
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
            const templateTeamIds = getTemplateTeamIds(tpl);
            const defaultTeamNames = (tpl.defaultForTeamIds || []).map((tid) => teamLookup.get(tid)).filter(Boolean) as string[];
            const creatorLabel = userLookup.get(tpl.createdBy) || (tpl.createdBy === 'system' ? '系统' : tpl.createdBy);
            return (
              <div
                key={tpl.id}
                className="group rounded-xl transition-all duration-200 hover:translate-y-[-1px]"
                style={{
                  background: isLight ? '#FFFFFF' : 'var(--surface-glass)',
                  backdropFilter: isLight ? undefined : 'blur(12px)',
                  WebkitBackdropFilter: isLight ? undefined : 'blur(12px)',
                  border: isMyDefault
                    ? `1px solid ${isLight ? 'var(--accent-claude-border)' : 'rgba(59,130,246,0.5)'}`
                    : (isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)'),
                  boxShadow: 'var(--shadow-card-sm)',
                }}
              >
                <div className="p-5">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="text-[15px] font-semibold truncate"
                          style={{
                            color: 'var(--text-primary)',
                            fontFamily: isLight ? 'var(--font-serif)' : undefined,
                            letterSpacing: isLight ? '-0.01em' : undefined,
                          }}
                        >
                          {tpl.name}
                        </span>
                        <span
                          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ color: meta.color, background: meta.bg }}
                        >
                          <meta.Icon size={9} />
                          {meta.label}
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
                      {templateTeamIds.length > 0 && (
                        <div className="text-[11px] mt-1 flex items-start gap-1 flex-wrap">
                          <span style={{ color: 'var(--text-muted)' }}>关联团队：</span>
                          {templateTeamIds.map((tid) => {
                            const isTeamDefault = (tpl.defaultForTeamIds || []).includes(tid);
                            return (
                              <span
                                key={tid}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px]"
                                style={
                                  isTeamDefault
                                    ? { color: 'rgba(59, 130, 246, 0.95)', background: 'rgba(59, 130, 246, 0.12)' }
                                    : { color: 'rgba(168, 85, 247, 0.9)', background: 'rgba(168, 85, 247, 0.08)' }
                                }
                              >
                                {isTeamDefault && <Star size={8} />}
                                {teamLookup.get(tid) || tid}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {defaultTeamNames.length > 0 && templateTeamIds.length === 0 && (
                        <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          团队默认：{defaultTeamNames.join('、')}
                        </div>
                      )}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--modal-overlay)' }}>
          <GlassCard className="p-0 w-[600px] max-h-[80vh] flex flex-col">
            <div
              className="px-5 py-4 font-semibold text-[15px]"
              style={{
                color: 'var(--text-primary)',
                borderBottom: '1px solid var(--border-primary)',
                fontFamily: isLight ? 'var(--font-serif)' : undefined,
                letterSpacing: isLight ? '-0.01em' : undefined,
              }}
            >
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

              {/* 多团队关联 */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                    关联团队（可多选；关联后即为该团队的默认模板候选）
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTeamPickerOpen((v) => !v)}
                    disabled={manageableTeams.length === 0}
                  >
                    {teamPickerOpen ? '收起' : '选择团队'}
                  </Button>
                </div>

                {/* 已选 chips */}
                <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                  {selectedTeamIds.length === 0 && (
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {manageableTeams.length === 0 ? '你尚未管理任何团队，无法关联' : '未关联任何团队'}
                    </span>
                  )}
                  {selectedTeamIds.map((tid) => {
                    const isDefault = defaultForTeamIds.includes(tid);
                    return (
                      <span
                        key={tid}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px]"
                        style={
                          isDefault
                            ? { color: 'rgba(59, 130, 246, 0.95)', background: 'rgba(59, 130, 246, 0.12)', border: '1px solid rgba(59,130,246,0.25)' }
                            : { color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' }
                        }
                      >
                        {teamLookup.get(tid) || tid}
                        <button
                          type="button"
                          className="p-0.5 hover:opacity-80"
                          onClick={() => toggleDefaultForTeam(tid)}
                          title={isDefault ? '取消团队默认' : '设为该团队默认'}
                        >
                          <Star size={10} style={{ fill: isDefault ? 'rgba(59,130,246,0.9)' : 'none' }} />
                        </button>
                        <button
                          type="button"
                          className="p-0.5 hover:opacity-80"
                          onClick={() => toggleSelectedTeam(tid)}
                          title="移除关联"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    );
                  })}
                </div>

                {/* 可选团队列表（只列自己管得着的） */}
                {teamPickerOpen && (
                  <div
                    className="flex flex-wrap gap-1.5 p-2 rounded-xl"
                    style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-secondary)' }}
                  >
                    {manageableTeams.length === 0 ? (
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>无可选团队</span>
                    ) : (
                      manageableTeams.map((t) => {
                        const selected = selectedTeamIds.includes(t.id);
                        return (
                          <button
                            key={t.id}
                            type="button"
                            className="px-2 py-1 rounded-full text-[11px] transition-colors"
                            style={
                              selected
                                ? { color: 'rgba(34, 197, 94, 0.95)', background: 'rgba(34, 197, 94, 0.12)' }
                                : { color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }
                            }
                            onClick={() => toggleSelectedTeam(t.id)}
                          >
                            {selected && <CheckSquare size={10} className="inline mr-1" />}
                            {t.name}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}

                {selectedTeamIds.length > 0 && (
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    提示：给某团队切换模板时，该团队在旧模板上的关联会被自动移除。
                  </div>
                )}
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
                  {sec.inputType === ReportInputType.IssueList && (
                    <div className="ml-7 flex flex-col gap-2 pt-2">
                      <IssueOptionEditor
                        title="问题分类"
                        placeholder="新增分类（如：技术 / 产品 / 流程）"
                        options={sec.issueCategories || []}
                        onChange={(options) => updateSectionIssueOptions(idx, 'issueCategories', options)}
                      />
                      <IssueOptionEditor
                        title="问题状态"
                        placeholder="新增状态（如：新增 / 跟进中 / 已解决）"
                        options={sec.issueStatuses || []}
                        onChange={(options) => updateSectionIssueOptions(idx, 'issueStatuses', options)}
                      />
                    </div>
                  )}
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
