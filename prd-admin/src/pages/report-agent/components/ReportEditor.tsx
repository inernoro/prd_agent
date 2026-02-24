import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Save, Send, Plus, Trash2 } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import {
  createWeeklyReport,
  updateWeeklyReport,
  submitWeeklyReport,
  getWeeklyReport,
} from '@/services';
import type { WeeklyReport } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus, ReportInputType } from '@/services/contracts/reportAgent';

interface Props {
  reportId: string | null;
  weekYear: number;
  weekNumber: number;
  onClose: () => void;
}

export function ReportEditor({ reportId, weekYear, weekNumber, onClose }: Props) {
  const { teams, templates, updateReportInList, addReportToList } = useReportAgentStore();
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [sections, setSections] = useState<{ items: { content: string; source: string; sourceRef?: string }[] }[]>([]);
  const [saving, setSaving] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.id || '');
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id || '');
  const [isNew, setIsNew] = useState(!reportId);

  // Load existing report
  useEffect(() => {
    if (!reportId) return;
    (async () => {
      const res = await getWeeklyReport({ id: reportId });
      if (res.success && res.data) {
        setReport(res.data.report);
        setSections(
          res.data.report.sections.map((s) => ({
            items: s.items.length > 0
              ? s.items.map((i) => ({ content: i.content, source: i.source, sourceRef: i.sourceRef }))
              : [{ content: '', source: 'manual' }],
          }))
        );
        setIsNew(false);
      }
    })();
  }, [reportId]);

  const handleCreate = useCallback(async () => {
    if (!selectedTeamId || !selectedTemplateId) {
      toast.error('请选择团队和模板');
      return;
    }
    setSaving(true);
    const res = await createWeeklyReport({
      teamId: selectedTeamId,
      templateId: selectedTemplateId,
      weekYear,
      weekNumber,
    });
    setSaving(false);
    if (res.success && res.data) {
      setReport(res.data.report);
      setSections(
        res.data.report.sections.map(() => ({
          items: [{ content: '', source: 'manual' }],
        }))
      );
      setIsNew(false);
      addReportToList(res.data.report);
      toast.success('周报已创建');
    } else {
      toast.error(res.error?.message || '创建失败');
    }
  }, [selectedTeamId, selectedTemplateId, weekYear, weekNumber, addReportToList]);

  const handleSave = useCallback(async () => {
    if (!report) return;
    setSaving(true);
    const res = await updateWeeklyReport({ id: report.id, sections });
    setSaving(false);
    if (res.success && res.data) {
      setReport(res.data.report);
      updateReportInList(res.data.report);
      toast.success('已保存');
    } else {
      toast.error(res.error?.message || '保存失败');
    }
  }, [report, sections, updateReportInList]);

  const handleSubmit = useCallback(async () => {
    if (!report) return;
    // Save first
    setSaving(true);
    const saveRes = await updateWeeklyReport({ id: report.id, sections });
    if (!saveRes.success) {
      setSaving(false);
      toast.error(saveRes.error?.message || '保存失败');
      return;
    }
    const res = await submitWeeklyReport({ id: report.id });
    setSaving(false);
    if (res.success && res.data) {
      updateReportInList(res.data.report);
      toast.success('周报已提交');
      onClose();
    } else {
      toast.error(res.error?.message || '提交失败');
    }
  }, [report, sections, updateReportInList, onClose]);

  const updateItem = (sectionIdx: number, itemIdx: number, content: string) => {
    setSections((prev) => {
      const next = [...prev];
      next[sectionIdx] = {
        ...next[sectionIdx],
        items: next[sectionIdx].items.map((item, i) =>
          i === itemIdx ? { ...item, content } : item
        ),
      };
      return next;
    });
  };

  const addItem = (sectionIdx: number) => {
    setSections((prev) => {
      const next = [...prev];
      next[sectionIdx] = {
        ...next[sectionIdx],
        items: [...next[sectionIdx].items, { content: '', source: 'manual' }],
      };
      return next;
    });
  };

  const removeItem = (sectionIdx: number, itemIdx: number) => {
    setSections((prev) => {
      const next = [...prev];
      next[sectionIdx] = {
        ...next[sectionIdx],
        items: next[sectionIdx].items.filter((_, i) => i !== itemIdx),
      };
      return next;
    });
  };

  const canEdit = !report || report.status === WeeklyReportStatus.Draft || report.status === WeeklyReportStatus.Returned;

  // Create flow: select team and template
  if (isNew && !report) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft size={14} />
          </Button>
          <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
            创建周报 - {weekYear} 年第 {weekNumber} 周
          </span>
        </div>

        <GlassCard className="p-4">
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>选择团队</label>
              <select
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                value={selectedTeamId}
                onChange={(e) => setSelectedTeamId(e.target.value)}
              >
                <option value="">请选择团队</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>选择模板</label>
              <select
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
              >
                <option value="">请选择模板</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (默认)' : ''}</option>
                ))}
              </select>
            </div>
            <Button variant="primary" onClick={handleCreate} disabled={saving || !selectedTeamId || !selectedTemplateId}>
              {saving ? '创建中...' : '创建周报'}
            </Button>
          </div>
        </GlassCard>
      </div>
    );
  }

  if (!report) return null;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft size={14} />
          </Button>
          <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {report.teamName} - {report.weekYear} 年第 {report.weekNumber} 周
          </span>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleSave} disabled={saving}>
              <Save size={12} /> 保存草稿
            </Button>
            <Button variant="primary" size="sm" onClick={handleSubmit} disabled={saving}>
              <Send size={12} /> 提交
            </Button>
          </div>
        )}
      </div>

      {/* Return reason banner */}
      {report.returnReason && (
        <GlassCard className="px-4 py-2">
          <div className="text-[12px]" style={{ color: 'rgba(239, 68, 68, 0.9)' }}>
            退回原因: {report.returnReason}
          </div>
        </GlassCard>
      )}

      {/* Sections */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex flex-col gap-4">
          {report.sections.map((section, sIdx) => (
            <GlassCard key={sIdx} className="p-4">
              <div className="mb-3">
                <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {section.templateSection.title}
                  {section.templateSection.isRequired && (
                    <span style={{ color: 'rgba(239, 68, 68, 0.9)' }}> *</span>
                  )}
                </div>
                {section.templateSection.description && (
                  <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    {section.templateSection.description}
                  </div>
                )}
              </div>

              {/* Items */}
              <div className="flex flex-col gap-2">
                {(sections[sIdx]?.items || []).map((item, iIdx) => (
                  <div key={iIdx} className="flex items-start gap-2">
                    {section.templateSection.inputType === ReportInputType.BulletList && (
                      <span className="text-[12px] mt-2" style={{ color: 'var(--text-muted)' }}>•</span>
                    )}
                    {section.templateSection.inputType === ReportInputType.RichText ? (
                      <textarea
                        className="flex-1 px-3 py-2 rounded-lg text-[13px] resize-none"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', minHeight: 80 }}
                        value={item.content}
                        onChange={(e) => updateItem(sIdx, iIdx, e.target.value)}
                        placeholder="请输入内容..."
                        disabled={!canEdit}
                      />
                    ) : (
                      <input
                        className="flex-1 px-3 py-2 rounded-lg text-[13px]"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                        value={item.content}
                        onChange={(e) => updateItem(sIdx, iIdx, e.target.value)}
                        placeholder="请输入内容..."
                        disabled={!canEdit}
                      />
                    )}
                    {canEdit && sections[sIdx]?.items.length > 1 && (
                      <Button variant="ghost" size="sm" onClick={() => removeItem(sIdx, iIdx)}>
                        <Trash2 size={12} />
                      </Button>
                    )}
                  </div>
                ))}
                {canEdit && (
                  <Button variant="ghost" size="sm" className="self-start" onClick={() => addItem(sIdx)}>
                    <Plus size={12} /> 添加一条
                  </Button>
                )}
              </div>
            </GlassCard>
          ))}
        </div>
      </div>
    </div>
  );
}
