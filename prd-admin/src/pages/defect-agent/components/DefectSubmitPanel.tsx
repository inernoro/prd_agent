import { useState, useRef, useCallback, useEffect } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { cn } from '@/lib/cn';
import type { AdminUser } from '@/types/admin';
import { useDefectStore } from '@/stores/defectStore';
import {
  createDefect,
  submitDefect,
  addDefectAttachment,
  polishDefect,
  analyzeDefectImage,
} from '@/services';
import { toast } from '@/lib/toast';
import { DefectSeverity } from '@/services/contracts/defectAgent';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  X,
  Send,
  Paperclip,
  FileText,
  Sparkles,
  Check,
  Eye,
  EyeOff,
  AlertTriangle,
} from 'lucide-react';

const STORAGE_KEY_TEMPLATE = 'defect-agent-last-template';
const STORAGE_KEY_ASSIGNEE = 'defect-agent-last-assignee';

type DefectSeverityValue = (typeof DefectSeverity)[keyof typeof DefectSeverity];

/** 带分析状态的附件 */
interface AnalyzedAttachment {
  file: File;
  status: 'idle' | 'analyzing' | 'done' | 'error';
  description?: string;
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
      const base64 = result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function DefectSubmitPanel() {
  const {
    templates,
    users,
    projects,
    setShowSubmitPanel,
    addDefectToList,
    loadStats,
  } = useDefectStore();

  // 从 sessionStorage 读取上次选择
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(() => {
    return sessionStorage.getItem(STORAGE_KEY_TEMPLATE) || '';
  });
  const [assigneeUserId, setAssigneeUserId] = useState<string>(() => {
    return sessionStorage.getItem(STORAGE_KEY_ASSIGNEE) || '';
  });
  const [projectId, setProjectId] = useState<string>('');
  const [content, setContent] = useState('');
  const [focused, setFocused] = useState(false);
  const [severity, setSeverity] = useState<DefectSeverityValue>(DefectSeverity.Trivial);
  const [attachments, setAttachments] = useState<AnalyzedAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [showExample, setShowExample] = useState(false);
  // 「提交给」字段闪烁提示的触发计数：每次自增都会重挂载覆盖层，重启 CSS 动画。
  const [assigneeFlashTick, setAssigneeFlashTick] = useState(0);

  // 当用户/模板选择变化时保存到 sessionStorage
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 添加文件并对图片自动触发 VLM 分析
   */
  const addFiles = useCallback((files: File[]) => {
    const newItems: AnalyzedAttachment[] = files.map((file) => ({
      file,
      status: file.type.startsWith('image/') ? 'analyzing' as const : 'idle' as const,
    }));

    setAttachments((prev) => [...prev, ...newItems]);

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
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setPreviewIndex(null);
  }, []);

  // AI Polish - 收集已解析的图片描述
  const handlePolish = async () => {
    if (!content.trim()) {
      toast.warning('请先输入问题描述');
      return;
    }
    setPolishing(true);
    try {
      const imageDescriptions = attachments
        .filter((a) => a.status === 'done' && a.description)
        .map((a) => a.description!);

      const res = await polishDefect({
        content: content.trim(),
        templateId: selectedTemplateId || undefined,
        imageDescriptions: imageDescriptions.length > 0 ? imageDescriptions : undefined,
      });
      if (res.success && res.data?.content) {
        setContent(res.data.content);
        toast.success('AI 润色完成');
      } else {
        toast.error(res.error?.message || 'AI 润色失败');
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setPolishing(false);
    }
  };

  // Submit defect
  const handleSubmit = async () => {
    if (!content.trim()) {
      toast.warning('请输入问题描述');
      return;
    }
    if (!assigneeUserId) {
      // 用字段级闪烁代替右上角 toast：视觉聚焦到真正需要填写的那个控件
      setAssigneeFlashTick((t) => t + 1);
      return;
    }

    setSubmitting(true);
    try {
      // 从内容中提取标题（第一行有内容的文本）
      const title = extractTitleFromContent(content);

      // Create defect
      const createRes = await createDefect({
        templateId: selectedTemplateId || undefined,
        title: title || undefined,
        content: content.trim(),
        assigneeUserId,
        severity,
        projectId: projectId || undefined,
      });

      if (!createRes.success || !createRes.data) {
        toast.error(createRes.error?.message || '创建失败');
        setSubmitting(false);
        return;
      }

      const defect = createRes.data.defect;

      // Upload attachments (with AI image description if available)
      for (const item of attachments) {
        await addDefectAttachment({ id: defect.id, file: item.file, description: item.description });
      }

      // Submit defect
      const submitRes = await submitDefect({ id: defect.id });
      if (submitRes.success && submitRes.data) {
        addDefectToList(submitRes.data.defect);
        toast.success('缺陷已提交');
        setShowSubmitPanel(false);
        loadStats();
      } else {
        // Still add to list even if submit fails
        addDefectToList(defect);
        toast.warning('缺陷已保存为草稿');
        setShowSubmitPanel(false);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const defaultTemplate = templates.find((t) => t.isDefault);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const severityOptions: Array<{ value: DefectSeverityValue; label: string }> = [
    { value: DefectSeverity.Critical, label: '致命' },
    { value: DefectSeverity.Major, label: '严重' },
    { value: DefectSeverity.Minor, label: '一般' },
    { value: DefectSeverity.Trivial, label: '轻微' },
  ];

  const previewItem = previewIndex !== null ? attachments[previewIndex] : null;

  return (
    <div
      className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={() => setShowSubmitPanel(false)}
    >
      <GlassCard
        glow
        animated
        variant="default"
        className="w-full max-w-[760px] max-h-[90vh] flex flex-col"
        overflow="hidden"
        padding="none"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-token-subtle">
          <div className="flex items-center gap-3">
            <div className="surface-inset w-8 h-8 rounded-lg flex items-center justify-center">
              <Send size={16} className="text-token-accent" />
            </div>
            <span className="text-token-primary text-[15px] font-medium">
              提交缺陷
            </span>
          </div>
          <button
            onClick={() => setShowSubmitPanel(false)}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors text-token-muted"
          >
            <X size={18} />
          </button>
        </div>

        {/* Selectors - 一排显示 */}
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-4">
            {/* Assignee —— 统一使用 UserSearchSelect（与「发起数据分享」一致），
                用户列表后端已按「已解决缺陷数」倒序返回。 */}
            <div className="flex items-center gap-2 flex-1">
              <label className="text-token-muted text-[12px] flex-shrink-0">
                提交给
              </label>
              <div data-tour-id="defect-assignee-picker" className="flex-1 relative">
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
              </div>
            </div>

            {/* Template */}
            <div className="flex items-center gap-2 flex-1">
              <label className="text-token-muted text-[12px] flex-shrink-0">
                模板
              </label>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="prd-field flex-1 px-3 py-2 rounded-lg text-[13px] outline-none"
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

            {/* Project */}
            {projects.length > 0 && (
              <div className="flex items-center gap-2 flex-1">
                <label className="text-token-muted text-[12px] flex-shrink-0">
                  项目
                </label>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="prd-field flex-1 px-3 py-2 rounded-lg text-[13px] outline-none"
                >
                  <option value="">不关联项目</option>
                  {projects.filter(p => !p.isArchived).map((p) => (
                    <option key={p.id} value={p.id}>
                      [{p.key}] {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Template Hint + Example */}
          {selectedTemplate && (selectedTemplate.description || selectedTemplate.exampleContent) && (
            <div className="space-y-2">
              {selectedTemplate.description && (
                <div className="surface-inset text-token-secondary px-3 py-2 rounded-lg text-[11px]">
                  <span className="text-token-accent">模板提示：</span>
                  {selectedTemplate.description}
                </div>
              )}
              {selectedTemplate.exampleContent && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowExample(!showExample)}
                    className="text-token-warning flex items-center gap-1.5 text-[11px] transition-colors hover:opacity-80"
                  >
                    {showExample ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showExample ? '收起示范' : '查看示范 — 看看理想的缺陷报告长什么样'}
                  </button>
                  {showExample && (
                    <div className="surface-state-warning mt-1.5 max-h-[200px] overflow-y-auto px-3 py-2.5 rounded-lg text-[12px] whitespace-pre-wrap leading-relaxed">
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
          className="flex-1 min-h-0 px-5 pb-4 flex flex-col"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <div
            className={cn(
              'surface-inset flex-1 flex flex-col rounded-xl overflow-hidden transition-all duration-200',
              focused && 'border-[var(--accent-primary)]/50 ring-2 ring-[var(--accent-primary)]/15'
            )}
            style={{ minHeight: attachments.length > 0 ? '500px' : '380px' }}
          >
            {/* Textarea - 无内部边框，第一行即为标题 */}
            <textarea
              ref={textareaRef}
              data-tour-id="defect-description"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={'描述您发现的问题...\n\n第一行将作为标题\n\n支持粘贴截图或拖拽文件\n\n提示：点击右下角 AI 按钮可自动润色内容'}
              className="text-token-primary flex-1 p-4 text-[13px] resize-none outline-none no-focus-ring bg-transparent"
              style={{ minHeight: '200px' }}
            />

            {/* Attachments Preview */}
            {attachments.length > 0 && (
              <div className="px-4 py-3 border-t border-token-subtle">
                <div className="flex flex-wrap gap-2">
                  {attachments.map((item, index) => (
                    <div
                      key={index}
                      className="group relative"
                    >
                      {item.file.type.startsWith('image/') ? (
                        <div
                          className="w-16 h-16 rounded-lg overflow-hidden relative cursor-pointer"
                          style={{
                            background: 'var(--bg-input-hover)',
                            border: item.status === 'done'
                              ? '1px solid rgba(100, 255, 150, 0.3)'
                              : item.status === 'error'
                                ? '1px solid rgba(255, 120, 120, 0.3)'
                                : '1px solid var(--border-default)',
                          }}
                          onClick={() => setPreviewIndex(previewIndex === index ? null : index)}
                        >
                          <img
                            src={URL.createObjectURL(item.file)}
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
                        <div className="surface-row text-token-secondary flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px]">
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
                  <div className="surface-state-success mt-2 px-3 py-2 rounded-lg text-[11px] leading-relaxed">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Eye size={10} />
                      <span className="font-medium">AI 识别结果</span>
                    </div>
                    {previewItem.description}
                  </div>
                )}
                {previewItem && previewItem.status === 'analyzing' && (
                  <div className="surface-inset text-token-muted mt-2 px-3 py-2 rounded-lg text-[11px] flex items-center gap-1.5">
                    <MapSpinner size={10} color="rgba(100, 200, 255, 0.8)" />
                    正在分析截图内容...
                  </div>
                )}
                {previewItem && previewItem.status === 'error' && (
                  <div className="surface-state-danger mt-2 px-3 py-2 rounded-lg text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle size={10} className="flex-shrink-0" />
                      图片分析失败，不影响缺陷提交
                    </div>
                    {previewItem.description && (
                      <div className="mt-1 pl-4 text-[10px] opacity-80">
                        {previewItem.description}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Input Actions */}
            <div className="px-4 py-2.5 border-t border-token-subtle flex items-center gap-2 flex-wrap">
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
                <span className="text-token-muted text-[11px]">
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
                        className={cn(
                          'px-2 py-1 rounded-[7px] text-[11px] font-medium transition-colors border',
                          active
                            ? 'bg-token-nested border-[var(--accent-primary)]/35 text-token-primary'
                            : 'bg-token-nested border-token-subtle text-token-muted hover:text-token-secondary'
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1" />

              <Button
                variant="secondary"
                size="sm"
                onClick={handlePolish}
                disabled={polishing || !content.trim()}
                title="AI 润色：优化描述内容，根据模板补充信息"
              >
                {polishing ? (
                  <MapSpinner size={14} />
                ) : (
                  <Sparkles size={14} />
                )}
                {polishing ? 'AI 润色中...' : 'AI 润色'}
              </Button>

              <Button
                variant="primary"
                size="sm"
                data-tour-id="defect-submit"
                onClick={handleSubmit}
                disabled={submitting || !content.trim()}
              >
                {submitting ? (
                  <MapSpinner size={14} />
                ) : (
                  <Send size={14} />
                )}
                {submitting ? '提交中...' : '提交缺陷'}
              </Button>
            </div>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
