import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Link2, Send, Trash2, AlertCircle, Eye } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { useSmartBack } from '@/hooks/useSmartBack';
import { useAuthStore } from '@/stores/authStore';
import { deleteMonthlyReport, getMonthlyReport, submitMonthlyReport, updateMonthlyReport } from '@/services';
import type { MonthlyLinkedWeekly, MonthlyReportDetail } from '@/services/contracts/reportAgentMonthly';
import { MONTHLY_CHAPTER_UI, formatYearMonth, getMonthlyStatusMeta } from './monthlyMeta';
import { MonthlyChapterShell } from './MonthlyChapterShell';
import { MarkdownField } from './MarkdownField';
import { WeeklyLinkChips } from './WeeklyLinkChips';
import { WeeklyLinkPicker } from './WeeklyLinkPicker';
import { PartnerSlots, type PartnerDraft } from './PartnerSlots';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 1500;

interface FormState {
  links: MonthlyLinkedWeekly[];
  achievementsText: string;
  problemsText: string;
  partners: PartnerDraft[];
  suggestionsText: string;
}

function toForm(detail: MonthlyReportDetail): FormState {
  const r = detail.report;
  return {
    links: detail.linkedWeeklies,
    achievementsText: r.achievementsText ?? '',
    problemsText: r.problemsText ?? '',
    partners: r.partners.map((p) => ({ userId: p.userId, userName: p.userName, reason: p.reason })),
    suggestionsText: r.suggestionsText ?? '',
  };
}

export default function MonthlyReportEditorPage() {
  const { reportId = '' } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const goBack = useSmartBack('/report-agent');
  const currentUserId = useAuthStore((s) => s.user?.userId);

  const [detail, setDetail] = useState<MonthlyReportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /** 最新表单快照（自动保存定时器里读，避免闭包拿到旧值） */
  const formRef = useRef<FormState | null>(null);
  const timerRef = useRef<number | null>(null);
  const saveSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await getMonthlyReport({ id: reportId });
      if (!alive) return;
      if (!res.success || !res.data) {
        setLoadError(res.error?.message || '月报加载失败');
        return;
      }
      if (!res.data.canEdit) {
        navigate(`/report-agent/monthly/${reportId}`, { replace: true });
        return;
      }
      setDetail(res.data);
      const f = toForm(res.data);
      setForm(f);
      formRef.current = f;
    })();
    return () => {
      alive = false;
    };
  }, [reportId, navigate]);

  const save = useCallback(async (): Promise<boolean> => {
    const f = formRef.current;
    if (!f) return false;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const seq = ++saveSeqRef.current;
    setSaveState('saving');
    const res = await updateMonthlyReport({
      id: reportId,
      weeklyReportIds: f.links.map((l) => l.weeklyReportId),
      achievementsText: f.achievementsText,
      problemsText: f.problemsText,
      partners: f.partners.map((p) => ({ userId: p.userId, reason: p.reason })),
      suggestionsText: f.suggestionsText,
    });
    // 只认最后一次保存的结果，避免慢请求把新内容的状态覆盖掉
    if (seq !== saveSeqRef.current) return res.success;
    if (res.success && res.data) {
      setDetail(res.data);
      setSaveState(formRef.current === f ? 'saved' : 'dirty');
      setSaveError(null);
      return true;
    }
    setSaveState('error');
    setSaveError(res.error?.message || '保存失败');
    return false;
  }, [reportId]);

  const patch = useCallback(
    (p: Partial<FormState>) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...p };
        formRef.current = next;
        return next;
      });
      setSaveState('dirty');
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    },
    [save]
  );

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
  }, []);

  // 有未保存的修改时离开页面给出浏览器原生提示
  useEffect(() => {
    if (saveState !== 'dirty' && saveState !== 'saving') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState]);

  const issuesByChapter = useMemo(() => {
    const map: Record<number, string> = {};
    for (const it of detail?.submitIssues ?? []) {
      map[it.chapter] = map[it.chapter] ? `${map[it.chapter]}；${it.message}` : it.message;
    }
    return map;
  }, [detail]);

  const scrollToChapter = (chapter: number) => {
    document.getElementById(`monthly-chapter-${chapter}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleBack = async () => {
    if (saveState === 'dirty' || saveState === 'error') {
      const ok = await save();
      if (!ok && !window.confirm('最近的修改没有保存成功，仍然离开吗？')) return;
    }
    goBack();
  };

  const handleSubmit = async () => {
    if (!detail) return;
    setSubmitting(true);
    const saved = saveState === 'saved' || saveState === 'idle' ? true : await save();
    if (!saved) {
      setSubmitting(false);
      toast.error('保存没有成功，先处理保存问题再提交');
      return;
    }
    const res = await submitMonthlyReport({ id: reportId });
    setSubmitting(false);
    if (res.success) {
      toast.success('月报已提交');
      navigate(`/report-agent/monthly/${reportId}`, { replace: true });
      return;
    }
    toast.error(res.error?.message || '提交失败');
    const first = detail.submitIssues?.[0];
    if (first) scrollToChapter(first.chapter);
  };

  const handleDelete = async () => {
    if (!window.confirm('删除这份月报草稿？删除后不能恢复。')) return;
    setDeleting(true);
    const res = await deleteMonthlyReport({ id: reportId });
    setDeleting(false);
    if (res.success) {
      toast.success('草稿已删除');
      navigate('/report-agent', { replace: true });
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  if (loadError) {
    return (
      <GlassCard variant="subtle" className="p-8 flex flex-col items-center gap-3 text-center">
        <AlertCircle size={24} style={{ color: 'var(--accent-fg-error)' }} />
        <div className="text-[14px]" style={{ color: 'var(--text-primary)' }}>{loadError}</div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/report-agent')}>回到周报</Button>
      </GlassCard>
    );
  }
  if (!detail || !form) return <MapSectionLoader text="正在打开月报…" />;

  const report = detail.report;
  const titles = detail.chapterTitles;
  const statusMeta = getMonthlyStatusMeta(report.status);
  const isDraft = report.status === 'draft';
  const issues = detail.submitIssues ?? [];
  const saveLabel: Record<SaveState, string> = {
    idle: '已保存',
    dirty: '有修改，稍后自动保存',
    saving: '保存中…',
    saved: '已自动保存',
    error: saveError ? `保存失败：${saveError}` : '保存失败',
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4" data-testid="monthly-report-editor">
      <GlassCard variant="subtle" className="px-4 sm:px-5 py-3 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="sm" onClick={handleBack} aria-label="返回">
            <ArrowLeft size={16} />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {formatYearMonth(report.year, report.month)}月报
              </span>
              <span
                className="text-[11px] px-2 py-0.5 rounded-full"
                style={{ color: statusMeta.color, background: statusMeta.bg, border: `1px solid ${statusMeta.border}` }}
              >
                {statusMeta.label}
              </span>
            </div>
            <div className="text-[12px] mt-0.5 flex items-center gap-1.5" style={{ color: saveState === 'error' ? 'var(--accent-fg-error)' : 'var(--text-muted)' }}>
              {report.teamName} ·
              {saveState === 'saving' && <MapSpinner size={11} />}
              <span data-testid="monthly-save-state">{saveLabel[saveState]}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isDraft ? (
              <Button variant="ghost" size="sm" onClick={handleDelete} disabled={deleting}>
                <Trash2 size={13} /> 删除草稿
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => navigate(`/report-agent/monthly/${reportId}`)}>
                <Eye size={13} /> 查看
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => void save()} disabled={saveState === 'saving'}>
              保存
            </Button>
            {isDraft && (
              <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting || (issues.length > 0 && saveState !== 'dirty')} data-testid="monthly-submit">
                {submitting ? <MapSpinner size={13} /> : <Send size={13} />} 提交
              </Button>
            )}
          </div>
        </div>
      </GlassCard>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="max-w-[920px] mx-auto flex flex-col gap-4 pb-8">
          {isDraft && (
            <div
              className="rounded-xl px-4 py-3 text-[12px] flex items-start gap-2"
              style={{
                background: issues.length === 0 ? 'var(--status-done-soft)' : 'var(--bg-secondary)',
                border: `1px solid ${issues.length === 0 ? 'var(--status-done-border)' : 'var(--border-primary)'}`,
                color: 'var(--text-secondary)',
              }}
              data-testid="monthly-submit-issues"
            >
              {issues.length === 0 ? (
                <>
                  <CheckCircle2 size={14} style={{ color: 'var(--status-done)', marginTop: 1 }} />
                  <span>必填项都写好了，可以提交。提交后负责人就能看到；团队其他成员能否查看，取决于团队的月报可见性设置。</span>
                </>
              ) : (
                <>
                  <AlertCircle size={14} style={{ color: 'var(--accent-fg-warning)', marginTop: 1 }} />
                  <span>
                    提交前还差：
                    {issues.map((it, i) => (
                      <button
                        key={i}
                        type="button"
                        className="underline underline-offset-2 mx-1"
                        style={{ color: 'var(--text-primary)' }}
                        onClick={() => scrollToChapter(it.chapter)}
                      >
                        {it.message}
                      </button>
                    ))}
                  </span>
                </>
              )}
            </div>
          )}

          <MonthlyChapterShell
            index={0}
            title={titles[0]}
            requiredLabel={MONTHLY_CHAPTER_UI[0].requiredLabel}
            hint={MONTHLY_CHAPTER_UI[0].hint}
            issue={issuesByChapter[0]}
            actions={
              <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)} data-testid="open-weekly-picker">
                <Link2 size={13} /> 关联周报
              </Button>
            }
          >
            <WeeklyLinkChips
              links={form.links}
              onRemove={(id) => patch({ links: form.links.filter((l) => l.weeklyReportId !== id) })}
            />
            <MarkdownField
              value={form.achievementsText}
              onChange={(v) => patch({ achievementsText: v })}
              placeholder={MONTHLY_CHAPTER_UI[0].placeholder}
              testId="monthly-achievements"
            />
          </MonthlyChapterShell>

          <MonthlyChapterShell index={1} title={titles[1]} requiredLabel={MONTHLY_CHAPTER_UI[1].requiredLabel} hint={MONTHLY_CHAPTER_UI[1].hint} issue={issuesByChapter[1]}>
            <MarkdownField
              value={form.problemsText}
              onChange={(v) => patch({ problemsText: v })}
              placeholder={MONTHLY_CHAPTER_UI[1].placeholder}
              minRows={4}
              testId="monthly-problems"
            />
          </MonthlyChapterShell>

          <MonthlyChapterShell index={2} title={titles[2]} requiredLabel={MONTHLY_CHAPTER_UI[2].requiredLabel} hint={MONTHLY_CHAPTER_UI[2].hint} issue={issuesByChapter[2]}>
            <PartnerSlots
              value={form.partners}
              onChange={(partners) => patch({ partners })}
              selfUserId={currentUserId}
              placeholder={MONTHLY_CHAPTER_UI[2].placeholder}
            />
          </MonthlyChapterShell>

          <MonthlyChapterShell index={3} title={titles[3]} requiredLabel={MONTHLY_CHAPTER_UI[3].requiredLabel} hint={MONTHLY_CHAPTER_UI[3].hint} issue={issuesByChapter[3]}>
            <MarkdownField
              value={form.suggestionsText}
              onChange={(v) => patch({ suggestionsText: v })}
              placeholder={MONTHLY_CHAPTER_UI[3].placeholder}
              minRows={4}
              testId="monthly-suggestions"
            />
          </MonthlyChapterShell>
        </div>
      </div>

      {pickerOpen && (
        <WeeklyLinkPicker
          teamId={report.teamId}
          year={report.year}
          month={report.month}
          selectedIds={form.links.map((l) => l.weeklyReportId)}
          onClose={() => setPickerOpen(false)}
          onConfirm={(ids, picked) => {
            const known = new Map(form.links.map((l) => [l.weeklyReportId, l]));
            const links: MonthlyLinkedWeekly[] = ids.map((id) => {
              const fromPicker = picked.find((p) => p.weeklyReportId === id);
              if (fromPicker) {
                return {
                  weeklyReportId: id,
                  weekYear: fromPicker.weekYear,
                  weekNumber: fromPicker.weekNumber,
                  periodStart: fromPicker.periodStart,
                  periodEnd: fromPicker.periodEnd,
                  exists: true,
                  status: fromPicker.status,
                };
              }
              return known.get(id)!;
            }).filter(Boolean);
            links.sort((a, b) => a.periodStart.localeCompare(b.periodStart));
            patch({ links });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
