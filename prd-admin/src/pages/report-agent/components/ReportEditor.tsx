import { useState, useEffect, useCallback, type ClipboardEvent } from 'react';
import { ArrowLeft, Save, Send, Plus, Trash2, Sparkles, RefreshCw, FileText } from 'lucide-react';
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
  deleteWeeklyReport,
  uploadReportRichTextImage,
} from '@/services';
import type { WeeklyReport } from '@/services/contracts/reportAgent';
import { WeeklyReportStatus, ReportInputType } from '@/services/contracts/reportAgent';
import { RichTextMarkdownContent } from './RichTextMarkdownContent';

interface Props {
  reportId: string | null;
  weekYear: number;
  weekNumber: number;
  onClose: () => void;
}

const MAX_RICH_TEXT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_COMPRESS_DIMENSION = 4096;
const MIN_COMPRESS_SCALE = 0.4;
const SCALE_REDUCE_FACTOR = 0.86;
const MIN_COMPRESS_QUALITY = 0.4;
const QUALITY_REDUCE_STEP = 0.08;
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*]\(([^)]+)\)/;

function inferExtFromMime(mime: string): string {
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('png')) return 'png';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

async function toBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片解码失败，请重试'));
    };
    img.src = objectUrl;
  });
}

function buildOutputFile(blob: Blob, originFile: File): File {
  const mimeType = blob.type || 'image/jpeg';
  const ext = inferExtFromMime(mimeType);
  const rawName = (originFile.name || '').trim();
  const baseName = rawName ? rawName.replace(/\.[^/.]+$/, '') : `pasted-image-${Date.now()}`;
  return new File([blob], `${baseName}.${ext}`, { type: mimeType, lastModified: Date.now() });
}

function hasMarkdownImage(content: string): boolean {
  return MARKDOWN_IMAGE_REGEX.test(content);
}

async function compressImageToLimit(file: File, maxBytes: number): Promise<{ file: File; compressed: boolean }> {
  if (file.size <= maxBytes) return { file, compressed: false };

  const image = await loadImage(file);
  const ratio = image.width > 0 && image.height > 0
    ? Math.min(1, MAX_COMPRESS_DIMENSION / Math.max(image.width, image.height))
    : 1;

  let bestBlob: Blob | null = null;
  const outputMimeTypes = file.type === 'image/jpeg' || file.type === 'image/webp'
    ? [file.type, 'image/jpeg']
    : ['image/webp', 'image/jpeg'];

  for (let scale = ratio; scale >= MIN_COMPRESS_SCALE; scale *= SCALE_REDUCE_FACTOR) {
    const width = Math.max(1, Math.floor(image.width * scale));
    const height = Math.max(1, Math.floor(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持图片压缩，请更换浏览器重试');

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    for (const mimeType of outputMimeTypes) {
      for (let quality = 0.92; quality >= MIN_COMPRESS_QUALITY; quality -= QUALITY_REDUCE_STEP) {
        const blob = await toBlob(canvas, mimeType, quality);
        if (!blob) continue;
        if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
        if (blob.size <= maxBytes) {
          return { file: buildOutputFile(blob, file), compressed: true };
        }
      }
    }
  }

  if (bestBlob && bestBlob.size <= maxBytes) {
    return { file: buildOutputFile(bestBlob, file), compressed: true };
  }

  throw new Error('图片压缩后仍超过 5MB，请裁剪后重试');
}

export function ReportEditor({ reportId, weekYear, weekNumber, onClose }: Props) {
  const { teams, templates, updateReportInList, addReportToList, removeReportFromList } = useReportAgentStore();
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [sections, setSections] = useState<{ items: { content: string; source: string; sourceRef?: string }[] }[]>([]);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pastingImageKey, setPastingImageKey] = useState<string | null>(null);
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
    try {
      const res = await generateReport({ id: report.id });
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
    } catch {
      toast.error('AI 生成失败，请稍后重试');
    } finally {
      setGenerating(false);
    }
  }, [report, updateReportInList]);

  const handleDelete = useCallback(async () => {
    if (!report) return;
    if (!window.confirm('删除后不可恢复，确定删除这份周报吗？')) return;

    setDeleting(true);
    const res = await deleteWeeklyReport({ id: report.id });
    setDeleting(false);
    if (res.success) {
      removeReportFromList(report.id);
      toast.success('周报已删除');
      onClose();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  }, [report, removeReportFromList, onClose]);

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

  const canEdit = !report
    || report.status === WeeklyReportStatus.Draft
    || report.status === WeeklyReportStatus.Submitted
    || report.status === WeeklyReportStatus.Returned
    || report.status === WeeklyReportStatus.Overdue;
  const canSubmit = !!report
    && (report.status === WeeklyReportStatus.Draft
      || report.status === WeeklyReportStatus.Returned
      || report.status === WeeklyReportStatus.Overdue);
  const canGenerate = !!report
    && (report.status === WeeklyReportStatus.Draft
      || report.status === WeeklyReportStatus.Returned
      || report.status === WeeklyReportStatus.Overdue);
  const canDelete = !!report
    && (report.status === WeeklyReportStatus.Draft
      || report.status === WeeklyReportStatus.Submitted
      || report.status === WeeklyReportStatus.Returned
      || report.status === WeeklyReportStatus.Overdue);

  const handleRichTextPaste = async (
    e: ClipboardEvent<HTMLTextAreaElement>,
    sectionIdx: number,
    itemIdx: number
  ) => {
    if (!report || !canEdit) return;
    const textarea = e.currentTarget;
    const imageItem = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith('image/'));
    if (!imageItem) return;

    const file = imageItem.getAsFile();
    if (!file) return;

    e.preventDefault();
    const uploadKey = `${sectionIdx}-${itemIdx}`;
    setPastingImageKey(uploadKey);

    try {
      const { file: uploadFile, compressed } = await compressImageToLimit(file, MAX_RICH_TEXT_IMAGE_BYTES);
      const res = await uploadReportRichTextImage({ id: report.id, file: uploadFile });
      if (!res.success || !res.data?.url) {
        toast.error(res.error?.message || '图片上传失败');
        return;
      }

      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      const current = textarea.value;
      const markdown = `\n![粘贴图片](${res.data.url})\n`;
      const next = `${current.slice(0, start)}${markdown}${current.slice(end)}`;
      updateItem(sectionIdx, itemIdx, next);

      const cursor = start + markdown.length;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(cursor, cursor);
      });

      toast.success(compressed ? '图片已自动压缩并插入' : '图片已插入');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '图片处理失败');
    } finally {
      setPastingImageKey((prev) => (prev === uploadKey ? null : prev));
    }
  };

  // Section colors — gradient pairs for headers
  const sectionThemes = [
    { color: 'rgba(59, 130, 246, 0.9)',  bg: 'rgba(59, 130, 246, 0.06)',  border: 'rgba(59, 130, 246, 0.15)' },
    { color: 'rgba(34, 197, 94, 0.9)',   bg: 'rgba(34, 197, 94, 0.06)',   border: 'rgba(34, 197, 94, 0.15)' },
    { color: 'rgba(168, 85, 247, 0.9)',  bg: 'rgba(168, 85, 247, 0.06)',  border: 'rgba(168, 85, 247, 0.15)' },
    { color: 'rgba(249, 115, 22, 0.9)',  bg: 'rgba(249, 115, 22, 0.06)',  border: 'rgba(249, 115, 22, 0.15)' },
    { color: 'rgba(236, 72, 153, 0.9)',  bg: 'rgba(236, 72, 153, 0.06)',  border: 'rgba(236, 72, 153, 0.15)' },
    { color: 'rgba(20, 184, 166, 0.9)',  bg: 'rgba(20, 184, 166, 0.06)',  border: 'rgba(20, 184, 166, 0.15)' },
  ];

  // Create flow
  if (isNew && !report) {
    return (
      <div className="flex flex-col gap-6">
        {/* Back + title */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft size={16} />
          </Button>
          <div>
            <div className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              创建周报
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {weekYear} 年第 {weekNumber} 周
            </div>
          </div>
        </div>

        {/* Create card */}
        <div className="max-w-lg">
          <GlassCard className="p-6">
            <div className="flex items-center gap-3 mb-5">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(59, 130, 246, 0.08)' }}
              >
                <FileText size={18} style={{ color: 'rgba(59, 130, 246, 0.9)' }} />
              </div>
              <div>
                <div className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>选择团队和模板</div>
                <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>创建后可随时编辑和保存</div>
              </div>
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <label className="text-[12px] font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>所属团队</label>
                <select
                  className="w-full px-3.5 py-2.5 rounded-xl text-[13px]"
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
                <label className="text-[12px] font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>周报模板</label>
                <select
                  className="w-full px-3.5 py-2.5 rounded-xl text-[13px]"
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
              <Button
                variant="primary"
                onClick={handleCreate}
                disabled={saving || !selectedTeamId || !selectedTemplateId}
                className="mt-1"
              >
                {saving ? '创建中...' : '开始编写周报'}
              </Button>
            </div>
          </GlassCard>
        </div>
      </div>
    );
  }

  if (!report) return null;

  // Calculate progress
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
  const filledItems = sections.reduce(
    (sum, s) => sum + s.items.filter((i) => i.content.trim()).length, 0
  );
  const progress = totalItems > 0 ? Math.round((filledItems / totalItems) * 100) : 0;

  return (
    <div className="flex flex-col gap-5 h-full min-h-0">
      {/* Header toolbar — now in a card */}
      <GlassCard variant="subtle" className="px-5 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              <ArrowLeft size={16} />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {report.teamName}
                </span>
                <span
                  className="text-[11px] px-2 py-0.5 rounded-full"
                  style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
                >
                  {report.weekYear} 年第 {report.weekNumber} 周
                </span>
              </div>
              {/* Mini progress bar */}
              {canEdit && totalItems > 0 && (
                <div className="flex items-center gap-2 mt-1.5">
                  <div className="w-24 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${progress}%`,
                        background: progress === 100
                          ? 'rgba(34, 197, 94, 0.7)'
                          : 'rgba(59, 130, 246, 0.6)',
                      }}
                    />
                  </div>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {filledItems}/{totalItems} 已填写
                  </span>
                </div>
              )}
            </div>
          </div>
          {(canEdit || canSubmit || canGenerate || canDelete) && (
            <div className="flex items-center gap-2">
              {canGenerate && (
                <Button variant="secondary" size="sm" onClick={handleGenerate} disabled={generating || saving || deleting}>
                  {generating ? (
                    <><RefreshCw size={13} className="animate-spin" /> 生成中...</>
                  ) : (
                    <><Sparkles size={13} /> AI 填充</>
                  )}
                </Button>
              )}
              {canEdit && (
                <Button variant="secondary" size="sm" onClick={handleSave} disabled={saving || generating || deleting}>
                  <Save size={13} /> 保存
                </Button>
              )}
              {canSubmit && (
                <Button variant="primary" size="sm" onClick={handleSubmit} disabled={saving || generating || deleting}>
                  <Send size={13} /> 提交
                </Button>
              )}
              {canDelete && (
                <Button variant="ghost" size="sm" onClick={handleDelete} disabled={saving || generating || deleting}>
                  <Trash2 size={13} /> {deleting ? '删除中...' : '删除'}
                </Button>
              )}
            </div>
          )}
        </div>
      </GlassCard>

      {/* AI banner */}
      {report.autoGeneratedAt && (
        <div
          className="flex items-center gap-2.5 text-[12px] px-5 py-3 rounded-xl"
          style={{ color: 'rgba(168, 85, 247, 0.9)', background: 'rgba(168, 85, 247, 0.06)', border: '1px solid rgba(168, 85, 247, 0.12)' }}
        >
          <Sparkles size={14} />
          <span>AI 于 {new Date(report.autoGeneratedAt).toLocaleString('zh-CN')} 自动生成，请审阅后提交</span>
        </div>
      )}

      {/* Return reason */}
      {report.returnReason && (
        <div
          className="flex items-center gap-2.5 text-[12px] px-5 py-3 rounded-xl"
          style={{ color: 'rgba(239, 68, 68, 0.9)', background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.12)' }}
        >
          退回原因: {report.returnReason}
        </div>
      )}

      {report.status === WeeklyReportStatus.Submitted && (
        <div
          className="flex items-center gap-2.5 text-[12px] px-5 py-3 rounded-xl"
          style={{ color: 'rgba(59, 130, 246, 0.9)', background: 'rgba(59, 130, 246, 0.06)', border: '1px solid rgba(59, 130, 246, 0.12)' }}
        >
          已提交周报在“已审阅”前仍可编辑或删除，变更会即时生效。
        </div>
      )}

      {/* Sections */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex flex-col gap-5">
          {report.sections.map((section, sIdx) => {
            const theme = sectionThemes[sIdx % sectionThemes.length];
            return (
              <div
                key={sIdx}
                className="rounded-xl overflow-hidden"
                style={{
                  background: 'var(--surface-glass)',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  border: '1px solid var(--border-primary)',
                }}
              >
                {/* Section header — colored background band */}
                <div
                  className="px-5 py-4 flex items-center gap-3.5"
                  style={{
                    background: theme.bg,
                    borderBottom: `1px solid ${theme.border}`,
                  }}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] font-bold text-white flex-shrink-0"
                    style={{ background: theme.color, boxShadow: `0 2px 8px ${theme.color.replace('0.9', '0.3')}` }}
                  >
                    {sIdx + 1}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {section.templateSection.title}
                      </span>
                      {section.templateSection.isRequired && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ color: 'rgba(239, 68, 68, 0.8)', background: 'rgba(239, 68, 68, 0.06)' }}>
                          必填
                        </span>
                      )}
                    </div>
                    {section.templateSection.description && (
                      <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {section.templateSection.description}
                      </div>
                    )}
                  </div>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {(sections[sIdx]?.items || []).filter(i => i.content.trim()).length} 条
                  </span>
                </div>

                {/* Items */}
                <div className="px-5 py-4 flex flex-col gap-3">
                  {(sections[sIdx]?.items || []).map((item, iIdx) => (
                    <div key={iIdx} className="flex items-start gap-3 group">
                      {section.templateSection.inputType === ReportInputType.BulletList && (
                        <div
                          className="w-2 h-2 rounded-full mt-3 flex-shrink-0"
                          style={{ background: theme.color }}
                        />
                      )}
                      {section.templateSection.inputType === ReportInputType.RichText ? (
                        <div className="flex-1">
                          <textarea
                            className="w-full px-4 py-3 rounded-xl text-[13px] resize-none transition-all duration-200"
                            style={{
                              background: 'var(--bg-secondary)',
                              color: 'var(--text-primary)',
                              border: '1px solid var(--border-primary)',
                              minHeight: 100,
                              outline: 'none',
                            }}
                            onFocus={(e) => { e.currentTarget.style.borderColor = theme.color.replace('0.9', '0.4'); e.currentTarget.style.boxShadow = `0 0 0 2px ${theme.color.replace('0.9', '0.08')}`; }}
                            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.boxShadow = 'none'; }}
                            value={item.content}
                            onChange={(e) => updateItem(sIdx, iIdx, e.target.value)}
                            onPaste={(e) => { void handleRichTextPaste(e, sIdx, iIdx); }}
                            placeholder={pastingImageKey === `${sIdx}-${iIdx}` ? '图片上传中...' : '请输入内容（支持直接粘贴图片，超 5MB 自动压缩）...'}
                            disabled={!canEdit}
                          />
                          {hasMarkdownImage(item.content) && (
                            <RichTextMarkdownContent
                              content={item.content}
                              showRealtimeLabel
                              imageMaxHeight={220}
                              className="mt-2"
                            />
                          )}
                        </div>
                      ) : (
                        <input
                          className="flex-1 px-4 py-3 rounded-xl text-[13px] transition-all duration-200"
                          style={{
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                            outline: 'none',
                          }}
                          onFocus={(e) => { e.currentTarget.style.borderColor = theme.color.replace('0.9', '0.4'); e.currentTarget.style.boxShadow = `0 0 0 2px ${theme.color.replace('0.9', '0.08')}`; }}
                          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.boxShadow = 'none'; }}
                          value={item.content}
                          onChange={(e) => updateItem(sIdx, iIdx, e.target.value)}
                          placeholder="请输入内容..."
                          disabled={!canEdit}
                        />
                      )}
                      {item.source && item.source !== 'manual' && (
                        <span
                          className="text-[10px] px-2 py-1 rounded-full self-center flex-shrink-0 font-medium"
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
                          className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,0.08)] transition-all self-center"
                          onClick={() => removeItem(sIdx, iIdx)}
                        >
                          <Trash2 size={13} style={{ color: 'var(--text-muted)' }} />
                        </button>
                      )}
                    </div>
                  ))}
                  {canEdit && (
                    <button
                      className="self-start flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-lg transition-all duration-150"
                      style={{
                        color: theme.color,
                        background: theme.bg,
                        border: `1px dashed ${theme.border}`,
                      }}
                      onClick={() => addItem(sIdx)}
                    >
                      <Plus size={13} /> 添加一条
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
