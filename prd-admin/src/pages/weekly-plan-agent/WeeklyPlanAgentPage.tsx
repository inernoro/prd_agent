import { useState, useEffect, useMemo, useCallback } from 'react';
import { CalendarCheck, Plus, Send, Eye, FileText, Users, ChevronLeft, ChevronRight, Trash2, Edit3, CheckCircle, Clock, RotateCcw } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { Dialog } from '@/components/ui/Dialog';
import { useAuthStore } from '@/stores/authStore';
import {
  listWeeklyPlanTemplates,
  createWeeklyPlanTemplate,
  updateWeeklyPlanTemplate,
  deleteWeeklyPlanTemplate,
  initWeeklyPlanTemplates,
  listWeeklyPlans,
  listTeamPlans,
  createWeeklyPlan,
  updateWeeklyPlan,
  submitWeeklyPlan,
  withdrawWeeklyPlan,
  reviewWeeklyPlan,
  deleteWeeklyPlan,
  getWeeklyPlanStats,
} from '@/services';
import type { WeeklyPlanTemplate, WeeklyPlanSubmission, PlanSectionEntry, TemplateSectionDef, WeeklyPlanStats } from '@/services/contracts/weeklyPlan';

// ===== Helper functions =====
function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekLabel(periodStart: string): string {
  const start = new Date(periodStart);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${formatDate(periodStart)} ~ ${formatDate(end.toISOString())}`;
}

const statusLabels: Record<string, { text: string; color: string }> = {
  draft: { text: '草稿', color: 'var(--text-muted)' },
  submitted: { text: '已提交', color: '#3b82f6' },
  reviewed: { text: '已审阅', color: '#10b981' },
};

// ===== Main Page =====
export default function WeeklyPlanAgentPage() {
  const permissions = useAuthStore((s) => s.permissions);
  const hasManage = permissions.includes('weekly-plan-agent.manage');

  const tabs = useMemo(() => {
    const items = [
      { key: 'my-plans', label: '我的计划' },
      { key: 'team-plans', label: '团队计划' },
    ];
    if (hasManage) items.push({ key: 'templates', label: '模板管理' });
    return items;
  }, [hasManage]);

  const [activeTab, setActiveTab] = useState('my-plans');

  return (
    <div className="h-full flex flex-col gap-5 p-6 overflow-y-auto">
      <div className="flex items-center gap-3">
        <CalendarCheck size={24} style={{ color: 'var(--accent-gold)' }} />
        <h1 className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          周计划
        </h1>
      </div>

      <TabBar items={tabs} activeKey={activeTab} onChange={setActiveTab} />

      {activeTab === 'my-plans' && <MyPlansTab />}
      {activeTab === 'team-plans' && <TeamPlansTab />}
      {activeTab === 'templates' && hasManage && <TemplatesTab />}
    </div>
  );
}

// ===== My Plans Tab =====
function MyPlansTab() {
  const [plans, setPlans] = useState<WeeklyPlanSubmission[]>([]);
  const [templates, setTemplates] = useState<WeeklyPlanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<WeeklyPlanStats | null>(null);

  // Dialog states
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [editingPlan, setEditingPlan] = useState<WeeklyPlanSubmission | null>(null);
  const [viewingPlan, setViewingPlan] = useState<WeeklyPlanSubmission | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, templatesRes, statsRes] = await Promise.all([
        listWeeklyPlans({}),
        listWeeklyPlanTemplates({ activeOnly: true }),
        getWeeklyPlanStats(),
      ]);
      if (plansRes.success) setPlans(plansRes.data.items);
      if (templatesRes.success) setTemplates(templatesRes.data.items);
      if (statsRes.success) setStats(statsRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!selectedTemplateId) return;
    const res = await createWeeklyPlan({ templateId: selectedTemplateId });
    if (res.success) {
      setCreateOpen(false);
      setSelectedTemplateId('');
      setEditingPlan(res.data.plan);
      await load();
    }
  };

  const handleDelete = async (id: string) => {
    const res = await deleteWeeklyPlan({ id });
    if (res.success) await load();
  };

  const handleWithdraw = async (id: string) => {
    const res = await withdrawWeeklyPlan({ id });
    if (res.success) await load();
  };

  return (
    <>
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="本周计划" value={stats.thisWeek.total} />
          <StatCard label="草稿" value={stats.thisWeek.draft} color="var(--text-muted)" />
          <StatCard label="已提交" value={stats.thisWeek.submitted} color="#3b82f6" />
          <StatCard label="已审阅" value={stats.thisWeek.reviewed} color="#10b981" />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {plans.length > 0 ? `共 ${plans.length} 份计划` : '暂无计划'}
        </span>
        <Button variant="primary" size="xs" onClick={() => setCreateOpen(true)}>
          <Plus size={14} className="mr-1" /> 新建计划
        </Button>
      </div>

      {/* Plan list */}
      {loading ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : (
        <div className="flex flex-col gap-3">
          {plans.map((plan) => (
            <GlassCard key={plan.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {plan.templateName}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{
                        color: statusLabels[plan.status]?.color,
                        background: `${statusLabels[plan.status]?.color}20`,
                      }}
                    >
                      {statusLabels[plan.status]?.text}
                    </span>
                  </div>
                  <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {getWeekLabel(plan.periodStart)}
                  </div>
                  {plan.reviewComment && (
                    <div className="text-xs mt-1" style={{ color: '#10b981' }}>
                      审阅评语: {plan.reviewComment}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {plan.status === 'draft' && (
                    <>
                      <Button size="xs" variant="primary" onClick={() => setEditingPlan(plan)}>
                        <Edit3 size={12} className="mr-1" /> 编辑
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => handleDelete(plan.id)}>
                        <Trash2 size={12} />
                      </Button>
                    </>
                  )}
                  {plan.status === 'submitted' && (
                    <Button size="xs" variant="ghost" onClick={() => handleWithdraw(plan.id)}>
                      <RotateCcw size={12} className="mr-1" /> 撤回
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" onClick={() => setViewingPlan(plan)}>
                    <Eye size={12} className="mr-1" /> 查看
                  </Button>
                </div>
              </div>
            </GlassCard>
          ))}
          {plans.length === 0 && !loading && (
            <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
              <CalendarCheck size={48} className="mx-auto mb-3 opacity-30" />
              <div>还没有周计划</div>
              <div className="text-xs mt-1">点击「新建计划」开始填写本周计划</div>
            </div>
          )}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="新建周计划"
        content={
          <div className="flex flex-col gap-4">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              选择一个模板开始填写本周计划:
            </div>
            {templates.length === 0 ? (
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                暂无可用模板，请联系管理员初始化内置模板
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto">
                {templates.map((t) => (
                  <div
                    key={t.id}
                    className="p-3 rounded-xl cursor-pointer transition-all"
                    style={{
                      background: selectedTemplateId === t.id ? 'rgba(214, 178, 106, 0.15)' : 'rgba(255,255,255,0.03)',
                      border: selectedTemplateId === t.id ? '1px solid var(--accent-gold)' : '1px solid var(--border-faint)',
                    }}
                    onClick={() => setSelectedTemplateId(t.id)}
                  >
                    <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                      {t.name}
                      {t.isBuiltIn && <span className="ml-2 text-xs opacity-60">(内置)</span>}
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      {t.description || `${t.sections.length} 个填写区域`}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button size="xs" variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button>
              <Button size="xs" variant="primary" onClick={handleCreate} disabled={!selectedTemplateId}>
                创建
              </Button>
            </div>
          </div>
        }
      />

      {/* Edit Dialog */}
      {editingPlan && (
        <PlanEditorDialog
          plan={editingPlan}
          templates={templates}
          onClose={() => { setEditingPlan(null); load(); }}
        />
      )}

      {/* View Dialog */}
      {viewingPlan && (
        <PlanViewDialog plan={viewingPlan} onClose={() => setViewingPlan(null)} />
      )}
    </>
  );
}

// ===== Team Plans Tab =====
function TeamPlansTab() {
  const [plans, setPlans] = useState<WeeklyPlanSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [reviewingPlan, setReviewingPlan] = useState<WeeklyPlanSubmission | null>(null);
  const [viewingPlan, setViewingPlan] = useState<WeeklyPlanSubmission | null>(null);
  const permissions = useAuthStore((s) => s.permissions);
  const hasManage = permissions.includes('weekly-plan-agent.manage');

  const periodStart = useMemo(() => {
    const monday = getMonday(new Date());
    monday.setDate(monday.getDate() + weekOffset * 7);
    return monday.toISOString().split('T')[0];
  }, [weekOffset]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listTeamPlans({ periodStart, pageSize: 100 });
      if (res.success) setPlans(res.data.items);
    } finally {
      setLoading(false);
    }
  }, [periodStart]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      {/* Week navigation */}
      <div className="flex items-center justify-between">
        <Button size="xs" variant="ghost" onClick={() => setWeekOffset((v) => v - 1)}>
          <ChevronLeft size={14} /> 上周
        </Button>
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {getWeekLabel(periodStart)}
          {weekOffset === 0 && <span className="ml-2 text-xs" style={{ color: 'var(--accent-gold)' }}>(本周)</span>}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setWeekOffset((v) => v + 1)} disabled={weekOffset >= 0}>
          下周 <ChevronRight size={14} />
        </Button>
      </div>

      {/* Team plans */}
      {loading ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : (
        <div className="flex flex-col gap-3">
          {plans.map((plan) => (
            <GlassCard key={plan.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {plan.userDisplayName}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {plan.templateName}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{
                        color: statusLabels[plan.status]?.color,
                        background: `${statusLabels[plan.status]?.color}20`,
                      }}
                    >
                      {statusLabels[plan.status]?.text}
                    </span>
                  </div>
                  {plan.submittedAt && (
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      提交于 {formatDate(plan.submittedAt)}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="xs" variant="ghost" onClick={() => setViewingPlan(plan)}>
                    <Eye size={12} className="mr-1" /> 查看
                  </Button>
                  {hasManage && plan.status === 'submitted' && (
                    <Button size="xs" variant="primary" onClick={() => setReviewingPlan(plan)}>
                      <CheckCircle size={12} className="mr-1" /> 审阅
                    </Button>
                  )}
                </div>
              </div>
            </GlassCard>
          ))}
          {plans.length === 0 && !loading && (
            <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
              <Users size={48} className="mx-auto mb-3 opacity-30" />
              <div>该周暂无团队计划提交</div>
            </div>
          )}
        </div>
      )}

      {/* Review dialog */}
      {reviewingPlan && (
        <ReviewDialog plan={reviewingPlan} onClose={() => { setReviewingPlan(null); load(); }} />
      )}
      {viewingPlan && (
        <PlanViewDialog plan={viewingPlan} onClose={() => setViewingPlan(null)} />
      )}
    </>
  );
}

// ===== Templates Tab =====
function TemplatesTab() {
  const [templates, setTemplates] = useState<WeeklyPlanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [initLoading, setInitLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listWeeklyPlanTemplates({});
      if (res.success) setTemplates(res.data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleInit = async () => {
    setInitLoading(true);
    try {
      await initWeeklyPlanTemplates();
      await load();
    } finally {
      setInitLoading(false);
    }
  };

  const handleToggleActive = async (t: WeeklyPlanTemplate) => {
    await updateWeeklyPlanTemplate({ id: t.id, isActive: !t.isActive });
    await load();
  };

  const handleDelete = async (id: string) => {
    await deleteWeeklyPlanTemplate({ id });
    await load();
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {templates.length} 个模板
        </span>
        <Button variant="secondary" size="xs" onClick={handleInit} disabled={initLoading}>
          <RotateCcw size={14} className="mr-1" />
          {initLoading ? '初始化中...' : '初始化内置模板'}
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : (
        <div className="flex flex-col gap-3">
          {templates.map((t) => (
            <GlassCard key={t.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <FileText size={14} style={{ color: 'var(--accent-gold)' }} />
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {t.name}
                    </span>
                    {t.isBuiltIn && (
                      <span className="text-xs px-2 py-0.5 rounded-full"
                        style={{ color: 'var(--accent-gold)', background: 'rgba(214,178,106,0.15)' }}>
                        内置
                      </span>
                    )}
                    {!t.isActive && (
                      <span className="text-xs px-2 py-0.5 rounded-full"
                        style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)' }}>
                        已停用
                      </span>
                    )}
                  </div>
                  <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {t.description} | {t.sections.length} 个段落
                    {t.submitDeadline && ` | 截止: ${t.submitDeadline}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="xs" variant="ghost" onClick={() => handleToggleActive(t)}>
                    {t.isActive ? '停用' : '启用'}
                  </Button>
                  {!t.isBuiltIn && (
                    <Button size="xs" variant="ghost" onClick={() => handleDelete(t.id)}>
                      <Trash2 size={12} />
                    </Button>
                  )}
                </div>
              </div>
              {/* Section preview */}
              <div className="flex flex-wrap gap-1 mt-2">
                {t.sections.map((s) => (
                  <span key={s.id} className="text-xs px-2 py-0.5 rounded"
                    style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>
                    {s.title}
                    {s.required && <span style={{ color: '#ef4444' }}>*</span>}
                  </span>
                ))}
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </>
  );
}

// ===== Plan Editor Dialog =====
function PlanEditorDialog({
  plan,
  templates,
  onClose,
}: {
  plan: WeeklyPlanSubmission;
  templates: WeeklyPlanTemplate[];
  onClose: () => void;
}) {
  const template = templates.find((t) => t.id === plan.templateId);
  const [entries, setEntries] = useState<Record<string, unknown>>(() => {
    const map: Record<string, unknown> = {};
    plan.entries.forEach((e) => { map[e.sectionId] = e.value; });
    return map;
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const entryList: PlanSectionEntry[] = Object.entries(entries).map(([sectionId, value]) => ({
        sectionId,
        value,
      }));
      await updateWeeklyPlan({ id: plan.id, entries: entryList });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const entryList: PlanSectionEntry[] = Object.entries(entries).map(([sectionId, value]) => ({
        sectionId,
        value,
      }));
      await submitWeeklyPlan({ id: plan.id, entries: entryList });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const updateEntry = (sectionId: string, value: unknown) => {
    setEntries((prev) => ({ ...prev, [sectionId]: value }));
  };

  return (
    <Dialog
      open={true}
      onOpenChange={() => onClose()}
      title={`${plan.templateName} - ${getWeekLabel(plan.periodStart)}`}
      maxWidth={720}
      content={
        <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">
          {template?.sections.map((section) => (
            <SectionEditor
              key={section.id}
              section={section}
              value={entries[section.id]}
              onChange={(val) => updateEntry(section.id, val)}
            />
          ))}
          <div className="flex justify-end gap-2 pt-3 border-t" style={{ borderColor: 'var(--border-faint)' }}>
            <Button size="xs" variant="ghost" onClick={onClose}>取消</Button>
            <Button size="xs" variant="secondary" onClick={handleSave} disabled={saving}>
              <Clock size={12} className="mr-1" /> 保存草稿
            </Button>
            <Button size="xs" variant="primary" onClick={handleSubmit} disabled={saving}>
              <Send size={12} className="mr-1" /> 提交
            </Button>
          </div>
        </div>
      }
    />
  );
}

// ===== Section Editor =====
function SectionEditor({
  section,
  value,
  onChange,
}: {
  section: TemplateSectionDef;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  const inputStyle = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border-faint)',
    color: 'var(--text-primary)',
    borderRadius: '10px',
    padding: '8px 12px',
    width: '100%',
    fontSize: '13px',
    outline: 'none',
  };

  return (
    <div>
      <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
        {section.title}
        {section.required && <span style={{ color: '#ef4444' }} className="ml-1">*</span>}
      </div>
      {section.placeholder && (
        <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>{section.placeholder}</div>
      )}

      {section.type === 'text' && (
        <textarea
          style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }}
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={section.placeholder}
        />
      )}

      {section.type === 'list' && (
        <ListEditor
          value={(value as string[]) || []}
          onChange={onChange}
          maxItems={section.maxItems}
          placeholder={section.placeholder}
        />
      )}

      {section.type === 'table' && section.columns && (
        <TableEditor
          columns={section.columns}
          value={(value as Record<string, unknown>[]) || []}
          onChange={onChange}
        />
      )}

      {section.type === 'progress' && (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min="0"
            max="100"
            value={(value as number) || 0}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1"
          />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {(value as number) || 0}%
          </span>
        </div>
      )}

      {section.type === 'checklist' && (
        <ChecklistEditor
          value={(value as Array<{ text: string; checked: boolean }>) || []}
          onChange={onChange}
        />
      )}
    </div>
  );
}

// ===== List Editor =====
function ListEditor({
  value,
  onChange,
  maxItems,
  placeholder,
}: {
  value: string[];
  onChange: (val: string[]) => void;
  maxItems?: number;
  placeholder?: string;
}) {
  const inputStyle = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border-faint)',
    color: 'var(--text-primary)',
    borderRadius: '8px',
    padding: '6px 10px',
    width: '100%',
    fontSize: '13px',
    outline: 'none',
  };

  return (
    <div className="flex flex-col gap-1">
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{i + 1}.</span>
          <input
            style={inputStyle}
            value={item}
            onChange={(e) => {
              const newVal = [...value];
              newVal[i] = e.target.value;
              onChange(newVal);
            }}
          />
          <button
            className="text-xs opacity-50 hover:opacity-100"
            style={{ color: '#ef4444' }}
            onClick={() => onChange(value.filter((_, idx) => idx !== i))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {(!maxItems || value.length < maxItems) && (
        <Button size="xs" variant="ghost" onClick={() => onChange([...value, ''])}>
          <Plus size={12} className="mr-1" /> 添加一项
        </Button>
      )}
    </div>
  );
}

// ===== Table Editor =====
function TableEditor({
  columns,
  value,
  onChange,
}: {
  columns: TemplateSectionDef['columns'] & object;
  value: Record<string, unknown>[];
  onChange: (val: Record<string, unknown>[]) => void;
}) {
  const cellStyle = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border-faint)',
    color: 'var(--text-primary)',
    borderRadius: '6px',
    padding: '4px 8px',
    fontSize: '12px',
    outline: 'none',
    width: '100%',
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" style={{ borderCollapse: 'separate', borderSpacing: '0 2px' }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.name} className="text-left px-1 py-1 font-medium" style={{ color: 'var(--text-secondary)' }}>
                {col.name}
              </th>
            ))}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {value.map((row, ri) => (
            <tr key={ri}>
              {columns.map((col) => (
                <td key={col.name} className="px-1 py-0.5">
                  {col.type === 'select' && col.options ? (
                    <select
                      style={cellStyle}
                      value={(row[col.name] as string) || ''}
                      onChange={(e) => {
                        const newVal = [...value];
                        newVal[ri] = { ...row, [col.name]: e.target.value };
                        onChange(newVal);
                      }}
                    >
                      <option value="">--</option>
                      {col.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  ) : (
                    <input
                      type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text'}
                      style={cellStyle}
                      value={(row[col.name] as string) || ''}
                      onChange={(e) => {
                        const newVal = [...value];
                        newVal[ri] = { ...row, [col.name]: e.target.value };
                        onChange(newVal);
                      }}
                    />
                  )}
                </td>
              ))}
              <td className="px-1">
                <button
                  className="opacity-50 hover:opacity-100"
                  style={{ color: '#ef4444' }}
                  onClick={() => onChange(value.filter((_, i) => i !== ri))}
                >
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button size="xs" variant="ghost" onClick={() => onChange([...value, {}])} className="mt-1">
        <Plus size={12} className="mr-1" /> 添加行
      </Button>
    </div>
  );
}

// ===== Checklist Editor =====
function ChecklistEditor({
  value,
  onChange,
}: {
  value: Array<{ text: string; checked: boolean }>;
  onChange: (val: Array<{ text: string; checked: boolean }>) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={item.checked}
            onChange={(e) => {
              const newVal = [...value];
              newVal[i] = { ...item, checked: e.target.checked };
              onChange(newVal);
            }}
          />
          <input
            className="flex-1 text-sm outline-none"
            style={{
              background: 'transparent',
              color: item.checked ? 'var(--text-muted)' : 'var(--text-primary)',
              textDecoration: item.checked ? 'line-through' : 'none',
              border: 'none',
              borderBottom: '1px solid var(--border-faint)',
              padding: '2px 4px',
            }}
            value={item.text}
            onChange={(e) => {
              const newVal = [...value];
              newVal[i] = { ...item, text: e.target.value };
              onChange(newVal);
            }}
          />
          <button
            className="opacity-50 hover:opacity-100"
            style={{ color: '#ef4444' }}
            onClick={() => onChange(value.filter((_, idx) => idx !== i))}
          >
            <Trash2 size={10} />
          </button>
        </div>
      ))}
      <Button size="xs" variant="ghost" onClick={() => onChange([...value, { text: '', checked: false }])}>
        <Plus size={12} className="mr-1" /> 添加项
      </Button>
    </div>
  );
}

// ===== Plan View Dialog =====
function PlanViewDialog({ plan, onClose }: { plan: WeeklyPlanSubmission; onClose: () => void }) {
  return (
    <Dialog
      open={true}
      onOpenChange={() => onClose()}
      title={`${plan.userDisplayName} - ${plan.templateName}`}
      maxWidth={680}
      content={
        <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">
          <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            <span>{getWeekLabel(plan.periodStart)}</span>
            <span
              className="px-2 py-0.5 rounded-full"
              style={{ color: statusLabels[plan.status]?.color, background: `${statusLabels[plan.status]?.color}20` }}
            >
              {statusLabels[plan.status]?.text}
            </span>
            {plan.submittedAt && <span>提交: {formatDate(plan.submittedAt)}</span>}
          </div>
          {plan.entries.map((entry, i) => (
            <div key={i}>
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                {entry.sectionId}
              </div>
              <div className="text-sm pl-2" style={{ color: 'var(--text-secondary)' }}>
                <EntryValueDisplay value={entry.value} />
              </div>
            </div>
          ))}
          {plan.reviewComment && (
            <div className="p-3 rounded-xl" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
              <div className="text-xs font-medium" style={{ color: '#10b981' }}>审阅评语</div>
              <div className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>{plan.reviewComment}</div>
            </div>
          )}
          <div className="flex justify-end pt-2">
            <Button size="xs" variant="ghost" onClick={onClose}>关闭</Button>
          </div>
        </div>
      }
    />
  );
}

// ===== Review Dialog =====
function ReviewDialog({ plan, onClose }: { plan: WeeklyPlanSubmission; onClose: () => void }) {
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleReview = async () => {
    setSubmitting(true);
    try {
      await reviewWeeklyPlan({ id: plan.id, comment: comment.trim() || undefined });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={true}
      onOpenChange={() => onClose()}
      title={`审阅 - ${plan.userDisplayName}`}
      maxWidth={680}
      content={
        <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {plan.templateName} | {getWeekLabel(plan.periodStart)}
          </div>
          {plan.entries.map((entry, i) => (
            <div key={i}>
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                {entry.sectionId}
              </div>
              <div className="text-sm pl-2" style={{ color: 'var(--text-secondary)' }}>
                <EntryValueDisplay value={entry.value} />
              </div>
            </div>
          ))}
          <div>
            <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>审阅评语 (可选)</div>
            <textarea
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border-faint)',
                color: 'var(--text-primary)',
                borderRadius: '10px',
                padding: '8px 12px',
                width: '100%',
                fontSize: '13px',
                outline: 'none',
                minHeight: '60px',
                resize: 'vertical',
              }}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="填写审阅评语..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button size="xs" variant="ghost" onClick={onClose}>取消</Button>
            <Button size="xs" variant="primary" onClick={handleReview} disabled={submitting}>
              <CheckCircle size={12} className="mr-1" /> 确认审阅
            </Button>
          </div>
        </div>
      }
    />
  );
}

// ===== Entry Value Display =====
function EntryValueDisplay({ value }: { value: unknown }) {
  if (value == null || value === '') return <span className="opacity-40">未填写</span>;

  if (typeof value === 'string') return <div className="whitespace-pre-wrap">{value}</div>;

  if (typeof value === 'number') return <span>{value}%</span>;

  if (Array.isArray(value)) {
    // Check if it's a checklist
    if (value.length > 0 && typeof value[0] === 'object' && 'text' in (value[0] as object)) {
      return (
        <ul className="list-none">
          {(value as Array<{ text: string; checked: boolean }>).map((item, i) => (
            <li key={i} className="flex items-center gap-1">
              <span>{item.checked ? '✓' : '○'}</span>
              <span style={{ textDecoration: item.checked ? 'line-through' : 'none' }}>{item.text}</span>
            </li>
          ))}
        </ul>
      );
    }
    // Check if it's a table (array of objects)
    if (value.length > 0 && typeof value[0] === 'object' && !('text' in (value[0] as object))) {
      const rows = value as Record<string, unknown>[];
      const cols = Object.keys(rows[0] || {});
      return (
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} className="text-left px-2 py-1 font-medium border-b" style={{ borderColor: 'var(--border-faint)' }}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {cols.map((c) => (
                  <td key={c} className="px-2 py-1 border-b" style={{ borderColor: 'var(--border-faint)' }}>
                    {String(row[c] || '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    // Simple list
    return (
      <ul className="list-disc list-inside">
        {(value as string[]).map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }

  return <pre className="text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

// ===== Stat Card =====
function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <GlassCard className="p-3 text-center">
      <div className="text-[20px] font-bold" style={{ color: color || 'var(--text-primary)' }}>
        {value}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </GlassCard>
  );
}
