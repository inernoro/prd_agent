/**
 * GlobalDefectSubmitDialog - 全局缺陷提交对话框
 * 支持全局快捷键 Command+B (Mac) / Control+B (Windows)
 * 支持截图自动 VLM 分析（异步后台完成，不阻塞用户输入）
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import type { AdminUser } from '@/types/admin';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';
import {
  analyzeDefectImage,
  listDefectTemplates,
  getDefectUsers,
  previewApiLogs,
} from '@/services';
import { toast } from '@/lib/toast';
import { resolveApiUrl } from '@/services/real/apiClient';
import { useAiPreviewStream } from '@/lib/useAiPreviewStream';
import { AiPreviewModal } from '@/components/streaming/AiPreviewModal';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useDefectSubmission } from '@/hooks/useDefectSubmission';
import { DefectSeverity } from '@/services/contracts/defectAgent';
import type { DefectTemplate, DefectUser, ApiLogPreviewItem } from '@/services/contracts/defectAgent';
import {
  X,
  Paperclip,
  FileText,
  Sparkles,
  Bug,
  Terminal,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Check,
  Eye,
  EyeOff,
} from 'lucide-react';
import { SuccessConfettiButton } from '@/components/ui/SuccessConfettiButton';

const STORAGE_KEY_TEMPLATE = 'defect-agent-last-template';
const STORAGE_KEY_ASSIGNEE = 'defect-agent-last-assignee';

type DefectSeverityValue = (typeof DefectSeverity)[keyof typeof DefectSeverity];

/** 带分析状态的附件 */
interface AnalyzedAttachment {
  file: File;
  previewUrl?: string;
  /** VLM 分析状态：idle=非图片无需分析, analyzing=分析中, done=完成, error=失败 */
  status: 'idle' | 'analyzing' | 'done' | 'error';
  /** VLM 提取的缺陷描述 */
  description?: string;
}

function revokeAttachmentPreview(item: AnalyzedAttachment | undefined) {
  if (item?.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

/**
 * 从内容中提取标题
 * 取第一行有内容（非空白、非回车）的文本
 */
function extractTitleFromContent(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      // 截取前 100 个字符作为标题
      return trimmed.length > 100 ? trimmed.slice(0, 100) + '...' : trimmed;
    }
  }
  return '';
}

/** 将 File 转为 base64 字符串（不含 data: 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // 去掉 "data:image/png;base64," 前缀
      const base64 = result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function GlobalDefectSubmitDialog() {
  const { showDialog, closeDialog, prefill, onCreated } = useGlobalDefectStore();
  const isMobile = useIsMobile();

  // 数据状态
  const [templates, setTemplates] = useState<DefectTemplate[]>([]);
  const [users, setUsers] = useState<DefectUser[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);

  // 日志预览状态
  const [logPreview, setLogPreview] = useState<{
    totalCount: number;
    errorCount: number;
    items: ApiLogPreviewItem[];
  } | null>(null);
  const [logPreviewExpanded, setLogPreviewExpanded] = useState(false);
  const [logPreviewLoading, setLogPreviewLoading] = useState(false);

  // 表单状态
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(() => {
    return sessionStorage.getItem(STORAGE_KEY_TEMPLATE) || '';
  });
  const [assigneeUserId, setAssigneeUserId] = useState<string>(() => {
    return sessionStorage.getItem(STORAGE_KEY_ASSIGNEE) || '';
  });
  const [content, setContent] = useState('');
  const [severity, setSeverity] = useState<DefectSeverityValue>(DefectSeverity.Trivial);
  const [attachments, setAttachments] = useState<AnalyzedAttachment[]>([]);
  const [focused, setFocused] = useState(false);
  // 当前悬浮预览的附件索引
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [showExample, setShowExample] = useState(false);
  // 「提交给」字段闪烁提示的触发计数：每次自增都会重挂载覆盖层，重启 CSS 动画。
  const [assigneeFlashTick, setAssigneeFlashTick] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef<AnalyzedAttachment[]>([]);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; cancelScheduledClose(); };
  }, [cancelScheduledClose]);
  const submission = useDefectSubmission({
    onCreated: (defect) => onCreated?.({ id: defect.id, title: defect.title || extractTitleFromContent(content) || '未命名缺陷' }),
    onSubmitted: () => {
      if (!mountedRef.current) return;
      cancelScheduledClose();
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        if (!mountedRef.current) return;
        setContent('');
        clearAttachments();
        setSeverity(DefectSeverity.Trivial);
        closeDialog();
      }, 1500);
    },
    onRecovered: cancelScheduledClose,
  });
  const { submitting, reset: resetSubmissionState } = submission;
  const resetSubmission = useCallback(() => {
    if (!resetSubmissionState()) return false;
    cancelScheduledClose();
    return true;
  }, [resetSubmissionState, cancelScheduledClose]);
  const closeIfIdle = useCallback(() => {
    if (resetSubmission()) closeDialog();
  }, [resetSubmission, closeDialog]);
  useEffect(() => {
    if (!showDialog) resetSubmission();
  }, [showDialog, resetSubmission]);

  const polishStream = useAiPreviewStream({
    url: resolveApiUrl('/api/defect-agent/defects/polish/stream'),
    onApply: (final) => {
      setContent(final);
      toast.success('AI 润色已应用');
    },
  });
  const { open: polishOpen, cancel: cancelPolish } = polishStream;

  useEffect(() => {
    if (!showDialog && polishOpen) cancelPolish();
  }, [showDialog, polishOpen, cancelPolish]);

  useEffect(() => {
    if (!showDialog || polishStream.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeIfIdle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showDialog, polishStream.open, closeIfIdle]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
      attachmentsRef.current = [];
    };
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach(revokeAttachmentPreview);
      return [];
    });
    setPreviewIndex(null);
  }, []);

  // 加载模板和用户数据
  useEffect(() => {
    if (!showDialog || dataLoaded) return;

    const loadData = async () => {
      try {
        const [templatesRes, usersRes] = await Promise.all([
          listDefectTemplates(),
          getDefectUsers(),
        ]);
        if (templatesRes.success && templatesRes.data) {
          setTemplates(templatesRes.data.items);
        }
        if (usersRes.success && usersRes.data) {
          setUsers(usersRes.data.items);
        }
        setDataLoaded(true);
      } catch {
        // Silent fail
      }
    };

    void loadData();
  }, [showDialog, dataLoaded]);

  // 加载日志预览
  useEffect(() => {
    if (!showDialog) {
      // 关闭时重置
      setLogPreview(null);
      setLogPreviewExpanded(false);
      clearAttachments();
      return;
    }

    const loadLogPreview = async () => {
      setLogPreviewLoading(true);
      try {
        const res = await previewApiLogs();
        if (res.success && res.data) {
          setLogPreview(res.data);
        }
      } catch {
        // Silent fail
      } finally {
        setLogPreviewLoading(false);
      }
    };

    void loadLogPreview();
  }, [showDialog, clearAttachments]);

  // 保存选择到 sessionStorage
  useEffect(() => {
    if (assigneeUserId) {
      sessionStorage.setItem(STORAGE_KEY_ASSIGNEE, assigneeUserId);
    }
  }, [assigneeUserId]);

  useEffect(() => {
    if (selectedTemplateId) {
      sessionStorage.setItem(STORAGE_KEY_TEMPLATE, selectedTemplateId);
    }
  }, [selectedTemplateId]);

  // 注册全局快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Command+B (Mac) 或 Control+B (Windows)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        if (polishStream.open || submitting) return;
        // 检查是否在输入框中（排除某些场景）
        const active = document.activeElement;
        const isInInput = active instanceof HTMLInputElement ||
                          active instanceof HTMLTextAreaElement ||
                          (active instanceof HTMLElement && active.isContentEditable);

        // 如果在输入框中且对话框未打开，不阻止默认行为（允许加粗等操作）
        if (isInInput && !showDialog) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (showDialog) closeIfIdle();
        else useGlobalDefectStore.getState().openDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showDialog, polishStream.open, submitting, closeIfIdle]);

  // 应用预填草稿（行为洞察「转为缺陷」复用本面板时携带）：打开瞬间把标题/正文/严重度/指派人灌进表单。
  // title 作为正文首行（本面板用首行提取标题），避免再开一个标题输入框，复用既有「首行即标题」交互。
  // 无预填时清空正文/严重度，避免上一次 VOC 草稿在「侧边栏快捷无预填」重开时残留（关闭未提交时未重置）。
  useEffect(() => {
    if (!showDialog) return;
    if (!prefill) {
      setContent('');
      setSeverity(DefectSeverity.Trivial);
      clearAttachments();
      setPreviewIndex(null);
      return;
    }
    const titleLine = prefill.title?.trim();
    const body = prefill.content ?? '';
    setContent(titleLine ? `${titleLine}\n\n${body}`.trim() : body);
    if (prefill.severity) {
      setSeverity(prefill.severity as DefectSeverityValue);
    }
    if (prefill.assigneeUserId) {
      setAssigneeUserId(prefill.assigneeUserId);
    }
    // 仅在打开携带预填的瞬间灌一次；prefill 引用变化即重灌
  }, [clearAttachments, showDialog, prefill]);

  // 自动聚焦
  useEffect(() => {
    if (showDialog && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [showDialog]);

  /**
   * 添加文件并对图片自动触发 VLM 分析
   * 异步后台完成，不阻塞用户
   */
  const addFiles = useCallback((files: File[]) => {
    const newItems: AnalyzedAttachment[] = files.map((file) => ({
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      status: file.type.startsWith('image/') ? 'analyzing' as const : 'idle' as const,
    }));

    setAttachments((prev) => {
      const updated = [...prev, ...newItems];
      return updated;
    });

    // 对每张图片异步调用 VLM 分析
    for (const item of newItems) {
      if (item.status !== 'analyzing') continue;

      (async () => {
        try {
          const base64 = await fileToBase64(item.file);
          const res = await analyzeDefectImage({
            base64,
            mimeType: item.file.type || 'image/png',
          });

          if (res.success && res.data?.description) {
            setAttachments((prev) =>
              prev.map((a) =>
                a.file === item.file
                  ? { ...a, status: 'done', description: res.data!.description }
                  : a
              )
            );
          } else {
            const errCode = res.error?.code || '';
            const errMsg = res.error?.message || '图片分析失败';
            const isNotConfigured = errCode === 'MODEL_NOT_CONFIGURED';
            console.warn('[defect-image-analyze] failed:', errCode, errMsg);
            setAttachments((prev) =>
              prev.map((a) =>
                a.file === item.file
                  ? {
                      ...a,
                      status: isNotConfigured ? 'idle' as const : 'error',
                      description: isNotConfigured ? undefined : errMsg,
                    }
                  : a
              )
            );
            // 模型未配置时只提示一次，不反复弹错
            if (isNotConfigured) {
              console.info('[defect-image-analyze] VLM 模型池未配置，跳过图片分析');
            }
          }
        } catch (e) {
          console.warn('[defect-image-analyze] error:', e);
          setAttachments((prev) =>
            prev.map((a) =>
              a.file === item.file
                ? { ...a, status: 'error', description: String(e) }
                : a
            )
          );
        }
      })();
    }
  }, []);

  // Handle paste for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const pastedFiles: File[] = [];
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      // 阻止浏览器默认粘贴行为，否则会把截图占位文字插入 textarea
      e.preventDefault();
      addFiles(pastedFiles);
    }
  }, [addFiles]);

  // Handle drag and drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) addFiles(files);
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // Handle file input
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) addFiles(files);
      e.target.value = '';
    },
    [addFiles]
  );

  // Remove attachment
  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      revokeAttachmentPreview(prev[index]);
      return prev.filter((_, i) => i !== index);
    });
    setPreviewIndex(null);
  }, []);

  // 与缺陷页共用流式预览，只有确认应用才替换用户原文。
  const handlePolish = () => {
    if (polishStream.open) return;
    if (!content.trim()) {
      toast.warning('请先输入问题描述');
      return;
    }
    const imageDescriptions = attachments
      .filter((a) => a.status === 'done' && a.description)
      .map((a) => a.description!);
    polishStream.start({
      content: content.trim(),
      templateId: selectedTemplateId || undefined,
      imageDescriptions: imageDescriptions.length > 0 ? imageDescriptions : undefined,
    });
  };

  // Submit defect - 返回 boolean 供 SuccessConfettiButton 使用
  const handleSubmit = async (): Promise<boolean> => {
    // 新动作接管会话，上一轮成功的延迟关闭不能影响本次确认。
    cancelScheduledClose();
    if (!content.trim() && !submission.confirmationPending) {
      toast.warning('请输入问题描述');
      return false;
    }
    if (!assigneeUserId && !submission.confirmationPending) {
      // 字段级闪烁聚焦控件，toast 兜底保证用户明确看到原因
      setAssigneeFlashTick((t) => t + 1);
      toast.warning('请选择提交用户');
      return false;
    }

    const title = extractTitleFromContent(content);
    return submission.submit({
      templateId: selectedTemplateId || undefined,
      title: title || undefined,
      content: content.trim(),
      assigneeUserId,
      severity,
    }, attachments);

  };

  const defaultTemplate = templates.find((t) => t.isDefault);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const severityOptions: Array<{ value: DefectSeverityValue; label: string }> = [
    { value: DefectSeverity.Critical, label: '致命' },
    { value: DefectSeverity.Major, label: '严重' },
    { value: DefectSeverity.Minor, label: '一般' },
    { value: DefectSeverity.Trivial, label: '轻微' },
  ];

  // 当前预览的附件
  const previewItem = previewIndex !== null ? attachments[previewIndex] : null;

  if (!showDialog) return null;

  return createPortal((
    <>
    <div
      className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="global-defect-submit-title"
      onClick={closeIfIdle}
    >
      <GlassCard
        glow
        variant="default"
        className="w-full max-w-[760px] flex flex-col"
        style={{ height: 'min(820px, calc(100dvh - 24px))', maxHeight: 'calc(100dvh - 24px)' }}
        overflow="hidden"
        padding="none"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="surface-panel-header shrink-0 flex items-center justify-between px-3 py-3 sm:px-5 sm:py-4">
          <div className="flex items-center gap-3">
            <div className="surface-action-accent w-8 h-8 rounded-lg flex items-center justify-center">
              <Bug size={16} />
            </div>
            <span id="global-defect-submit-title" className="text-[15px] font-medium text-token-primary">
              提交缺陷
            </span>
            <span className="surface-inset hidden sm:inline text-[11px] px-2 py-0.5 rounded-full text-token-muted">
              {navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+B
            </span>
          </div>
          <button
            onClick={closeIfIdle}
            aria-label="关闭提交缺陷"
            disabled={submitting || submission.confirmationPending}
            className="p-2 rounded-lg text-token-muted hover-bg-soft transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <fieldset disabled={submitting} className="flex flex-1 flex-col min-w-0 border-0 p-0 m-0" style={{ minHeight: 0, pointerEvents: submitting ? 'none' : undefined }}>
        {submission.error && (
          <div role="alert" className="shrink-0 px-3 py-2 text-[12px] text-token-error">
            {submission.error}
            {submission.savedDefect && !submission.unappliedChanges && (
              <div>{submission.confirmationPending
                ? `缺陷 ${submission.savedDefect.defectNo} 已保存，提交结果待确认；请重试确认，确认后即可关闭。`
                : `草稿 ${submission.savedDefect.defectNo} 已保存，尚未提交；重试会继续此草稿。`}</div>
            )}
            {submission.unappliedChanges && <Button variant="ghost" size="sm" onClick={submission.reset}>保留当前内容并开始新提交</Button>}
          </div>
        )}
        {/* Selectors */}
        <div className="shrink-0 px-3 py-3 sm:px-5 sm:py-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            {/* Assignee —— 统一 UserSearchSelect；后端按已解决缺陷数倒序返回 */}
            <div className="flex min-w-0 items-center gap-2">
              <label className="text-[12px] flex-shrink-0 text-token-muted">
                提交给
              </label>
              <div className="min-w-0 flex-1 relative">
                <UserSearchSelect
                  value={assigneeUserId}
                  onChange={setAssigneeUserId}
                  users={users as unknown as AdminUser[]}
                  placeholder="选择提交给谁（按解决缺陷数排序）"
                  uiSize="sm"
                />
                {assigneeFlashTick > 0 && (
                  <div
                    key={assigneeFlashTick}
                    aria-hidden
                    className="defect-field-flash absolute inset-0"
                  />
                )}
                {assigneeFlashTick > 0 && !assigneeUserId && (
                  <div className="mt-1 text-[11px] text-token-error">
                    请选择提交用户
                  </div>
                )}
              </div>
            </div>

            {/* Template */}
            <div className="flex min-w-0 items-center gap-2">
              <label htmlFor="global-defect-template" className="text-[12px] flex-shrink-0 text-token-muted">
                模板
              </label>
              <select
                id="global-defect-template"
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="prd-field min-w-0 w-0 flex-1 px-3 py-2 rounded-lg text-[13px] outline-none transition-colors"
              >
                <option value="">
                  {defaultTemplate ? `${defaultTemplate.name} (默认)` : '无模板'}
                </option>
                {templates
                  .filter((t) => !t.isDefault)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {/* Template Hint + Example */}
          {selectedTemplate && (selectedTemplate.description || selectedTemplate.exampleContent) && (
            <div className="space-y-2">
              {selectedTemplate.description && (
                <div
                  className="surface-inset px-3 py-2 rounded-lg text-[11px] text-token-secondary"
                >
                  <span className="text-token-accent">模板提示：</span>
                  {selectedTemplate.description}
                </div>
              )}
              {selectedTemplate.exampleContent && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowExample(!showExample)}
                    className="flex items-center gap-1.5 text-[11px] text-token-accent transition-colors hover:opacity-80"
                  >
                    {showExample ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showExample ? '收起示范' : '查看示范 — 看看理想的缺陷报告长什么样'}
                  </button>
                  {showExample && (
                    <div
                      className="surface-inset mt-1.5 px-3 py-2.5 rounded-lg text-[12px] whitespace-pre-wrap leading-relaxed text-token-secondary max-h-[200px] overflow-y-auto"
                      style={{
                        borderColor: 'var(--border-focus)',
                      }}
                    >
                      {selectedTemplate.exampleContent}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Content Area */}
        <div
          className="flex-1 min-h-0 min-w-0 px-3 pb-3 sm:px-5 sm:pb-4 flex flex-col"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <div
            className="surface-inset flex-1 flex flex-col rounded-xl overflow-hidden transition-all duration-200"
            style={{
              minHeight: 0,
              borderColor: focused
                ? 'var(--border-focus)'
                : 'var(--border-subtle)',
              boxShadow: focused
                ? '0 0 0 2px rgba(214, 178, 106, 0.15)'
                : 'none',
            }}
          >
            <div className="flex-1 flex flex-col" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {/* Textarea - 无内部边框，直接使用外层容器的边框 */}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={'描述您发现的问题...\n\n第一行将作为标题\n\n支持粘贴截图或拖拽文件\n\n提示：点击右下角 AI 按钮可自动润色内容'}
              aria-label="问题描述"
              className="flex-1 shrink-0 p-3 sm:p-4 text-[16px] sm:text-[13px] resize-none outline-none no-focus-ring bg-transparent text-token-primary"
              style={{
                minHeight: isMobile ? '120px' : '200px',
              }}
            />

            {/* Attachments Preview */}
            {attachments.length > 0 && (
              <div
                className="px-4 py-3 border-t border-token-subtle"
              >
                <div className="flex flex-wrap gap-2">
                  {attachments.map((item, index) => (
                    <div
                      key={index}
                      className="group relative"
                    >
                      {item.file.type.startsWith('image/') ? (
                        <div
                          className="w-16 h-16 rounded-lg overflow-hidden relative cursor-pointer bg-token-nested"
                          style={{ border: item.status === 'done'
                              ? '1px solid rgba(100, 255, 150, 0.3)'
                              : item.status === 'error'
                                ? '1px solid rgba(255, 120, 120, 0.3)'
                                : '1px solid var(--border-subtle)' }}
                          onClick={() => setPreviewIndex(previewIndex === index ? null : index)}
                        >
                          <img
                            src={item.previewUrl}
                            alt={item.file.name}
                            className="w-full h-full object-cover"
                          />
                          {/* 分析状态角标 */}
                          {item.status === 'analyzing' && (
                            <div
                              className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-1 py-0.5"
                              style={{ background: 'rgba(0,0,0,0.7)' }}
                            >
                              <MapSpinner size={8} color="rgba(100, 200, 255, 0.9)" />
                              <span className="text-[8px]" style={{ color: 'rgba(100, 200, 255, 0.9)' }}>解析中</span>
                            </div>
                          )}
                          {item.status === 'done' && (
                            <div
                              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full flex items-center justify-center"
                              style={{ background: 'rgba(34, 197, 94, 0.9)' }}
                            >
                              <Check size={8} style={{ color: '#fff' }} />
                            </div>
                          )}
                          {item.status === 'error' && (
                            <div
                              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full flex items-center justify-center"
                              style={{ background: 'rgba(255, 120, 120, 0.9)' }}
                            >
                              <AlertTriangle size={8} style={{ color: '#fff' }} />
                            </div>
                          )}
                          {/* 预览按钮 - done 状态 hover 时显示 */}
                          {item.status === 'done' && (
                            <div
                              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ background: 'rgba(0,0,0,0.4)' }}
                            >
                              <Eye size={14} style={{ color: '#fff' }} />
                            </div>
                          )}
                        </div>
                      ) : (
                        <div
                          className="surface-inset flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] text-token-secondary"
                        >
                          <FileText size={12} />
                          <span className="max-w-[80px] truncate">{item.file.name}</span>
                        </div>
                      )}
                      <button
                        onClick={() => removeAttachment(index)}
                        className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{
                          background: 'rgba(255,80,80,0.9)',
                        }}
                      >
                        <X size={10} style={{ color: '#fff' }} />
                      </button>
                    </div>
                  ))}
                </div>

                {/* 图片分析预览面板 */}
                {previewItem && previewItem.status === 'done' && previewItem.description && (
                  <div
                    className="surface-state-success mt-2 px-3 py-2 rounded-lg text-[11px] leading-relaxed"
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <Eye size={10} style={{ color: 'rgba(34, 197, 94, 0.8)' }} />
                      <span style={{ color: 'rgba(34, 197, 94, 0.9)', fontWeight: 500 }}>AI 识别结果</span>
                    </div>
                    {previewItem.description}
                  </div>
                )}
                {previewItem && previewItem.status === 'analyzing' && (
                  <div
                    className="surface-inset mt-2 px-3 py-2 rounded-lg text-[11px] flex items-center gap-1.5 text-token-muted"
                  >
                    <MapSpinner size={10} color="rgba(100, 200, 255, 0.8)" />
                    正在分析截图内容...
                  </div>
                )}
                {previewItem && previewItem.status === 'error' && (
                  <div
                    className="surface-state-danger mt-2 px-3 py-2 rounded-lg text-[11px]"
                  >
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle size={10} style={{ color: 'rgba(255, 120, 120, 0.8)', flexShrink: 0 }} />
                      图片分析失败，不影响缺陷提交
                    </div>
                    {previewItem.description && (
                      <div className="mt-1 pl-4 text-[10px]" style={{ color: 'rgba(255, 120, 120, 0.7)' }}>
                        {previewItem.description}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 日志预览提示 - 始终显示 */}
            <div className="px-4 py-3 border-t border-token-subtle">
              <div className="surface-inset rounded-lg overflow-hidden">
                {/* 日志摘要头部 */}
                <button
                  type="button"
                  onClick={() => logPreview && logPreview.totalCount > 0 && setLogPreviewExpanded(!logPreviewExpanded)}
                  className="w-full px-3 py-2 flex items-center gap-2 hover-bg-soft transition-colors"
                  style={{ cursor: logPreview && logPreview.totalCount > 0 ? 'pointer' : 'default' }}
                >
                  {logPreviewLoading ? (
                    <MapSpinner size={14} color="rgba(100, 200, 255, 0.8)" />
                  ) : (
                    <Terminal size={14} className="text-token-accent" />
                  )}
                  <span className="text-[11px] text-token-muted">
                    {logPreviewLoading ? (
                      '正在加载 API 日志...'
                    ) : logPreview && logPreview.totalCount > 0 ? (
                      <>
                        提交时将自动采集 <span className="text-token-accent">{logPreview.totalCount}</span> 条请求日志
                        {logPreview.errorCount > 0 && (
                          <>
                            {' '}(含 <span style={{ color: 'rgba(255, 120, 120, 0.9)' }}>{logPreview.errorCount}</span> 条错误)
                          </>
                        )}
                      </>
                    ) : (
                      '提交时将自动采集 API 日志（当前无日志记录）'
                    )}
                  </span>
                  <div className="flex-1" />
                  {logPreview && logPreview.totalCount > 0 && (
                    logPreviewExpanded ? (
                      <ChevronUp size={14} className="text-token-muted" />
                    ) : (
                      <ChevronDown size={14} className="text-token-muted" />
                    )
                  )}
                </button>

                {/* 日志详情列表 */}
                {logPreviewExpanded && logPreview && logPreview.items.length > 0 && (
                  <div
                    className="max-h-[200px] overflow-y-auto border-t border-token-subtle"
                    style={{
                      scrollbarWidth: 'thin',
                      scrollbarColor: 'rgba(255,255,255,0.2) transparent',
                    }}
                  >
                    {logPreview.items.map((item, index) => (
                      <div
                        key={index}
                        className="px-3 py-1.5 flex items-center gap-2 text-[10px] font-mono hover-bg-soft"
                        style={{
                          borderBottom: index < logPreview.items.length - 1 ? '1px solid var(--border-subtle)' : undefined,
                        }}
                      >
                        {item.hasError && (
                          <AlertTriangle size={10} style={{ color: 'rgba(255, 120, 120, 0.8)', flexShrink: 0 }} />
                        )}
                        <span className="w-[105px] shrink-0 text-token-muted">
                          {item.time}
                        </span>
                        <span
                          style={{
                            color: item.method === 'GET' ? 'rgba(100, 200, 255, 0.8)' :
                                   item.method === 'POST' ? 'rgba(100, 255, 150, 0.8)' :
                                   item.method === 'PUT' ? 'rgba(255, 200, 100, 0.8)' :
                                   item.method === 'DELETE' ? 'rgba(255, 120, 120, 0.8)' : 'var(--text-muted)',
                            width: '45px',
                            flexShrink: 0,
                          }}
                        >
                          {item.method}
                        </span>
                        <span
                          className="truncate flex-1 text-token-secondary"
                          title={item.path}
                        >
                          {item.path}
                        </span>
                        <span
                          style={{
                            color: item.statusCode >= 400 ? 'rgba(255, 120, 120, 0.9)' :
                                   item.statusCode >= 300 ? 'rgba(255, 200, 100, 0.9)' : 'rgba(100, 255, 150, 0.9)',
                            width: '30px',
                            textAlign: 'right',
                            flexShrink: 0,
                          }}
                        >
                          {item.statusCode}
                        </span>
                        <span style={{
                          color: item.durationMs >= 1000 ? 'rgba(255, 120, 120, 0.9)' :
                                 item.durationMs >= 200 ? 'rgba(255, 200, 100, 0.9)' : 'var(--text-muted)',
                          width: '50px',
                          textAlign: 'right',
                          flexShrink: 0,
                        }}>
                          {item.durationMs}ms
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            </div>
            {/* Input Actions */}
            <div
              className="shrink-0 px-2 sm:px-4 py-2.5 border-t border-token-subtle flex items-center gap-2 flex-wrap"
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <Button
                variant="ghost"
                size="xs"
                onClick={() => fileInputRef.current?.click()}
                title="添加附件"
              >
                <Paperclip size={14} />
              </Button>

              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-token-muted">
                  严重性
                </span>
                <div className="flex items-center gap-1">
                  {severityOptions.map((opt) => {
                    const active = severity === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setSeverity(opt.value)}
                        className={`px-2 py-1 rounded-[7px] text-[11px] font-medium transition-opacity hover:opacity-90 ${
                          active ? 'surface-action-accent' : 'surface-action'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 basis-full sm:basis-auto" />

              <Button
                variant="secondary"
                size="sm"
                onClick={handlePolish}
                disabled={polishStream.open || !content.trim()}
                title="AI 润色：优化描述内容，根据模板补充信息"
              >
                {polishStream.open ? (
                  <MapSpinner size={14} />
                ) : (
                  <Sparkles size={14} />
                )}
                {polishStream.open ? 'AI 润色中...' : 'AI 润色'}
              </Button>

              <SuccessConfettiButton
                size="sm"
                readyText="提交缺陷"
                loadingText={submission.progress || '提交中'}
                successText="已提交"
                showLoadingText
                disabled={!content.trim() && !submission.confirmationPending}
                onAction={handleSubmit}
                successHoldMs={1200}
              />
            </div>
          </div>
        </div>
        </fieldset>
      </GlassCard>
    </div>
    <AiPreviewModal
      open={polishStream.open}
      text={polishStream.text}
      thinking={polishStream.thinking}
      streaming={polishStream.streaming}
      phaseMessage={polishStream.phaseMessage}
      error={polishStream.error}
      model={polishStream.model}
      title="AI 润色预览"
      subtitle="确认后应用；失败或取消会保留原文，可继续提交缺陷。"
      onApply={polishStream.apply}
      onRegenerate={() => polishStream.regenerate()}
      onCancel={polishStream.cancel}
      applyLabel="应用为原文"
    />
    </>
  ), document.body);
}

/**
 * DefectSubmitButton - 侧边栏提交缺陷按钮
 * 带呼吸动画效果
 */
export function DefectSubmitButton({ collapsed }: { collapsed: boolean }) {
  const openDialog = useGlobalDefectStore((s) => s.openDialog);

  return (
    <button
      type="button"
      onClick={() => openDialog()}
      className="h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors duration-200 hover-bg-soft shrink-0"
      style={{ color: 'var(--text-muted)' }}
      aria-label="提交缺陷"
      title={collapsed ? '提交缺陷 (Cmd/Ctrl+B)' : '提交缺陷'}
    >
      <Bug size={14} className="defect-submit-breath" />
    </button>
  );
}
