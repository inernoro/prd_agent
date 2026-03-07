import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Save, Send, Plus, Trash2, Sparkles, RefreshCw } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import {
  createWeeklyReport,
  updateWeeklyReport,
  submitWeeklyReport,
  getWeeklyReport,
  generateReport,
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
  const [generating, setGenerating] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.id || '');
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id || '');
  const [isNew, setIsNew] = useState(!reportId);

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

  const handleGenerate = useCallback(async () => {
    if (!report) return;
    if (!window.confirm('AI 将基于采集数据自动填充周报内容，当前编辑内容会被覆盖，确定继续？')) return;
    setGenerating(true);
    const res = await generateReport({ id: report.id });
    setGenerating(false);
    if (res.success && res.data) {
      const updated = res.data;
      setReport(updated);
      setSections(
        updated.sections.map((s) => ({
          items: s.items.length > 0
            ? s.items.map((i) => ({ content: i.content, source: i.source, sourceRef: i.sourceRef }))
            : [{ content: '', source: 'manual' }],
        }))
      );
      updateReportInList(updated);
      toast.success('AI 已生成周报内容');
    } else {
      toast.error(res.error?.message || 'AI 生成失败');
    }
  }, [report, updateReportInList]);

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

  // Section colors for numbered indicators
  const sectionColors = [
    'rgba(59, 130, 246, 0.9)',
    'rgba(34, 197, 94, 0.9)',
    'rgba(168, 85, 247, 0.9)',
    'rgba(249, 115, 22, 0.9)',
    'rgba(236, 72, 153, 0.9)',
    'rgba(20, 184, 166, 0.9)',
  ];

  // Create flow
  if (isNew && !report) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft size={14} />
          </Button>
          <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            创建周报 — {weekYear} 年第 {weekNumber} 周
          </span>
        </div>

        <GlassCard className="p-5 max-w-lg">
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-[12px] font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>选择团队</label>
              <select
                className="w-full px-3 py-2.5 rounded-xl text-[13px]"
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
              <label className="text-[12px] font-medium mb-1.5 block" style={{ color: 'var(--text-secondary)' }}>选择模板</label>
              <select
                className="w-full px-3 py-2.5 rounded-xl text-[13px]"
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
    <div className="flex flex-col gap-5 h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft size={14} />
          </Button>
          <div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {report.teamName}
            </span>
            <span className="text-[13px] ml-2" style={{ color: 'var(--text-muted)' }}>
              {report.weekYear} 年第 {report.weekNumber} 周
            </span>
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleGenerate} disabled={generating || saving}>
              {generating ? (
                <><RefreshCw size={12} className="animate-spin" /> 生成中...</>
              ) : (
                <><Sparkles size={12} /> AI 填充</>
              )}
            </Button>
            <Button variant="secondary" size="sm" onClick={handleSave} disabled={saving}>
              <Save size={12} /> 保存
            </Button>
            <Button variant="primary" size="sm" onClick={handleSubmit} disabled={saving}>
              <Send size={12} /> 提交
            </Button>
          </div>
        )}
      </div>

      {/* AI banner */}
      {report.autoGeneratedAt && (
        <div
          className="flex items-center gap-2 text-[12px] px-4 py-2.5 rounded-xl"
          style={{ color: 'rgba(168, 85, 247, 0.9)', background: 'rgba(168, 85, 247, 0.06)', border: '1px solid rgba(168, 85, 247, 0.12)' }}
        >
          <Sparkles size={13} />
          AI 于 {new Date(report.autoGeneratedAt).toLocaleString('zh-CN')} 自动生成，请审阅后提交
        </div>
      )}

      {/* Return reason */}
      {report.returnReason && (
        <div
          className="flex items-center gap-2 text-[12px] px-4 py-2.5 rounded-xl"
          style={{ color: 'rgba(239, 68, 68, 0.9)', background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.12)' }}
        >
          退回原因: {report.returnReason}
        </div>
      )}

      {/* Sections */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex flex-col gap-5">
          {report.sections.map((section, sIdx) => {
            const accentColor = sectionColors[sIdx % sectionColors.length];
            return (
              <div
                key={sIdx}
                className="rounded-xl overflow-hidden"
                style={{
                  background: 'var(--surface-glass)',
                  backdropFilter: 'blur(12px)',
                  border: '1px solid var(--border-primary)',
                }}
              >
                {/* Section header with numbered indicator */}
                <div className="px-5 py-3 flex items-center gap-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
                  <div
                    className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                    style={{ background: accentColor }}
                  >
                    {sIdx + 1}
                  </div>
                  <div className="flex-1">
                    <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {section.templateSection.title}
                    </span>
                    {section.templateSection.isRequired && (
                      <span className="text-[11px] ml-1" style={{ color: 'rgba(239, 68, 68, 0.8)' }}>*</span>
                    )}
                    {section.templateSection.description && (
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {section.templateSection.description}
                      </div>
                    )}
                  </div>
                </div>

                {/* Items */}
                <div className="px-5 py-4 flex flex-col gap-2.5">
                  {(sections[sIdx]?.items || []).map((item, iIdx) => (
                    <div key={iIdx} className="flex items-start gap-2.5">
                      {section.templateSection.inputType === ReportInputType.BulletList && (
                        <span className="text-[13px] mt-2 font-medium" style={{ color: accentColor }}>•</span>
                      )}
                      {section.templateSection.inputType === ReportInputType.RichText ? (
                        <textarea
                          className="flex-1 px-3 py-2.5 rounded-xl text-[13px] resize-none transition-all duration-150 focus:ring-1"
                          style={{
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                            minHeight: 80,
                            outlineColor: accentColor,
                          }}
                          value={item.content}
                          onChange={(e) => updateItem(sIdx, iIdx, e.target.value)}
                          placeholder="请输入内容..."
                          disabled={!canEdit}
                        />
                      ) : (
                        <input
                          className="flex-1 px-3 py-2.5 rounded-xl text-[13px] transition-all duration-150 focus:ring-1"
                          style={{
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                            outlineColor: accentColor,
                          }}
                          value={item.content}
                          onChange={(e) => updateItem(sIdx, iIdx, e.target.value)}
                          placeholder="请输入内容..."
                          disabled={!canEdit}
                        />
                      )}
                      {item.source && item.source !== 'manual' && (
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded-full self-center flex-shrink-0"
                          style={{
                            color: item.source === 'ai' ? 'rgba(168, 85, 247, 0.9)' : 'rgba(59, 130, 246, 0.9)',
                            background: item.source === 'ai' ? 'rgba(168, 85, 247, 0.08)' : 'rgba(59, 130, 246, 0.08)',
                          }}
                        >
                          {item.source === 'ai' ? 'AI' : item.source}
                        </span>
                      )}
                      {canEdit && sections[sIdx]?.items.length > 1 && (
                        <button
                          className="p-1.5 rounded-lg hover:bg-[rgba(239,68,68,0.08)] transition-colors self-center"
                          onClick={() => removeItem(sIdx, iIdx)}
                        >
                          <Trash2 size={12} style={{ color: 'var(--text-muted)' }} />
                        </button>
                      )}
                    </div>
                  ))}
                  {canEdit && (
                    <button
                      className="self-start flex items-center gap-1 text-[12px] px-2 py-1 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                      style={{ color: accentColor }}
                      onClick={() => addItem(sIdx)}
                    >
                      <Plus size={12} /> 添加一条
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
