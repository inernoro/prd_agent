/**
 * GlobalDefectSubmitDialog - 全局缺陷提交对话框
 * 支持全局快捷键 Command+B (Mac) / Control+B (Windows)
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';
import {
  createDefect,
  submitDefect,
  addDefectAttachment,
  polishDefect,
  listDefectTemplates,
  getDefectUsers,
  previewApiLogs,
} from '@/services';
import { toast } from '@/lib/toast';
import { DefectSeverity } from '@/services/contracts/defectAgent';
import type { DefectTemplate, DefectUser, ApiLogPreviewItem } from '@/services/contracts/defectAgent';
import {
  X,
  Paperclip,
  FileText,
  Sparkles,
  Loader2,
  Bug,
  Terminal,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { SuccessConfettiButton } from '@/components/ui/SuccessConfettiButton';

const STORAGE_KEY_TEMPLATE = 'defect-agent-last-template';
const STORAGE_KEY_ASSIGNEE = 'defect-agent-last-assignee';

type DefectSeverityValue = (typeof DefectSeverity)[keyof typeof DefectSeverity];

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

export function GlobalDefectSubmitDialog() {
  const { showDialog, closeDialog } = useGlobalDefectStore();

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
    return localStorage.getItem(STORAGE_KEY_TEMPLATE) || '';
  });
  const [assigneeUserId, setAssigneeUserId] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY_ASSIGNEE) || '';
  });
  const [content, setContent] = useState('');
  const [severity, setSeverity] = useState<DefectSeverityValue>(DefectSeverity.Trivial);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [polishing, setPolishing] = useState(false);
  const [focused, setFocused] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
  }, [showDialog]);

  // 保存选择到 localStorage
  useEffect(() => {
    if (assigneeUserId) {
      localStorage.setItem(STORAGE_KEY_ASSIGNEE, assigneeUserId);
    }
  }, [assigneeUserId]);

  useEffect(() => {
    if (selectedTemplateId) {
      localStorage.setItem(STORAGE_KEY_TEMPLATE, selectedTemplateId);
    }
  }, [selectedTemplateId]);

  // 注册全局快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Command+B (Mac) 或 Control+B (Windows)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
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
        useGlobalDefectStore.getState().toggleDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showDialog]);

  // 自动聚焦
  useEffect(() => {
    if (showDialog && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [showDialog]);

  // Handle paste for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          setAttachments((prev) => [...prev, file]);
        }
      }
    }
  }, []);

  // Handle drag and drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    setAttachments((prev) => [...prev, ...files]);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // Handle file input
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      setAttachments((prev) => [...prev, ...files]);
      e.target.value = '';
    },
    []
  );

  // Remove attachment
  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // AI Polish
  const handlePolish = async () => {
    if (!content.trim()) {
      toast.warning('请先输入问题描述');
      return;
    }
    setPolishing(true);
    try {
      const res = await polishDefect({
        content: content.trim(),
        templateId: selectedTemplateId || undefined,
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

  // Submit defect - 返回 boolean 供 SuccessConfettiButton 使用
  const handleSubmit = async (): Promise<boolean> => {
    if (!content.trim()) {
      toast.warning('请输入问题描述');
      return false;
    }
    if (!assigneeUserId) {
      toast.warning('请选择提交给谁');
      return false;
    }

    try {
      // 从内容中提取标题
      const title = extractTitleFromContent(content);

      // Create defect
      const createRes = await createDefect({
        templateId: selectedTemplateId || undefined,
        title: title || undefined,
        content: content.trim(),
        assigneeUserId,
        severity,
      });

      if (!createRes.success || !createRes.data) {
        toast.error(createRes.error?.message || '创建失败');
        return false;
      }

      const defect = createRes.data.defect;

      // Upload attachments
      for (const file of attachments) {
        await addDefectAttachment({ id: defect.id, file });
      }

      // Submit defect
      const submitRes = await submitDefect({ id: defect.id });
      if (submitRes.success && submitRes.data) {
        toast.success('缺陷已提交');
        // 重置表单（延迟执行，等撒花动画结束后关闭）
        setTimeout(() => {
          setContent('');
          setAttachments([]);
          setSeverity(DefectSeverity.Trivial);
          closeDialog();
        }, 1500);
        return true;
      } else {
        toast.warning('缺陷已保存为草稿');
        closeDialog();
        return false;
      }
    } catch (e) {
      toast.error(String(e));
      return false;
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

  if (!showDialog) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={closeDialog}
    >
      <GlassCard
        glow
        variant="default"
        className="w-full max-w-[760px] max-h-[90vh] flex flex-col"
        overflow="hidden"
        padding="none"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'rgba(100,200,255,0.15)' }}
            >
              <Bug size={16} style={{ color: 'rgba(100,200,255,0.9)' }} />
            </div>
            <span
              className="text-[15px] font-medium"
              style={{ color: 'var(--text-primary)' }}
            >
              提交缺陷
            </span>
            <span
              className="text-[11px] px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
            >
              {navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+B
            </span>
          </div>
          <button
            onClick={closeDialog}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={18} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Selectors */}
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-4">
            {/* Assignee */}
            <div className="flex items-center gap-2 flex-1">
              <label
                className="text-[12px] flex-shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                提交给
              </label>
              <select
                value={assigneeUserId}
                onChange={(e) => setAssigneeUserId(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-[13px] outline-none transition-colors"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="">选择用户</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName || u.username}
                  </option>
                ))}
              </select>
            </div>

            {/* Template */}
            <div className="flex items-center gap-2 flex-1">
              <label
                className="text-[12px] flex-shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                模板
              </label>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-[13px] outline-none transition-colors"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'var(--text-primary)',
                }}
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

          {/* Template Hint */}
          {selectedTemplate && selectedTemplate.description && (
            <div
              className="px-3 py-2 rounded-lg text-[11px]"
              style={{
                background: 'rgba(100,200,255,0.08)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(100,200,255,0.15)',
              }}
            >
              <span style={{ color: 'rgba(100,200,255,0.8)' }}>模板提示：</span>
              {selectedTemplate.description}
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
            className="flex-1 min-h-[180px] flex flex-col rounded-xl overflow-hidden transition-all duration-200"
            style={{
              background: 'rgba(0,0,0,0.14)',
              border: focused 
                ? '1px solid rgba(214, 178, 106, 0.55)' 
                : '1px solid rgba(255,255,255,0.08)',
              boxShadow: focused 
                ? '0 0 0 2px rgba(214, 178, 106, 0.15)' 
                : 'none',
            }}
          >
            {/* Textarea - 无内部边框，直接使用外层容器的边框 */}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={'描述您发现的问题...\n\n第一行将作为标题\n\n支持粘贴截图或拖拽文件\n\n提示：点击右下角 AI 按钮可自动润色内容'}
              className="flex-1 min-h-0 p-4 text-[13px] resize-none outline-none no-focus-ring"
              style={{
                background: 'transparent',
                color: 'var(--text-primary)',
              }}
            />

            {/* Attachments Preview */}
            {attachments.length > 0 && (
              <div
                className="px-4 py-3 border-t flex flex-wrap gap-2"
                style={{ borderColor: 'rgba(255,255,255,0.08)' }}
              >
                {attachments.map((file, index) => (
                  <div
                    key={index}
                    className="group relative"
                  >
                    {file.type.startsWith('image/') ? (
                      <div
                        className="w-16 h-16 rounded-lg overflow-hidden"
                        style={{
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(255,255,255,0.1)',
                        }}
                      >
                        <img
                          src={URL.createObjectURL(file)}
                          alt={file.name}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div
                        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px]"
                        style={{
                          background: 'rgba(255,255,255,0.06)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <FileText size={12} />
                        <span className="max-w-[80px] truncate">{file.name}</span>
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
            )}

            {/* 日志预览提示 - 始终显示 */}
            <div
              className="px-4 py-3 border-t"
              style={{ borderColor: 'rgba(255,255,255,0.08)' }}
            >
              <div
                className="rounded-lg overflow-hidden"
                style={{
                  background: 'rgba(100, 200, 255, 0.06)',
                  border: '1px solid rgba(100, 200, 255, 0.12)',
                }}
              >
                {/* 日志摘要头部 */}
                <button
                  type="button"
                  onClick={() => logPreview && logPreview.totalCount > 0 && setLogPreviewExpanded(!logPreviewExpanded)}
                  className="w-full px-3 py-2 flex items-center gap-2 hover:bg-white/5 transition-colors"
                  style={{ cursor: logPreview && logPreview.totalCount > 0 ? 'pointer' : 'default' }}
                >
                  {logPreviewLoading ? (
                    <Loader2 size={14} className="animate-spin" style={{ color: 'rgba(100, 200, 255, 0.8)' }} />
                  ) : (
                    <Terminal size={14} style={{ color: 'rgba(100, 200, 255, 0.8)' }} />
                  )}
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {logPreviewLoading ? (
                      '正在加载 API 日志...'
                    ) : logPreview && logPreview.totalCount > 0 ? (
                      <>
                        提交时将自动采集 <span style={{ color: 'rgba(100, 200, 255, 0.9)' }}>{logPreview.totalCount}</span> 条请求日志
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
                      <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} />
                    ) : (
                      <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
                    )
                  )}
                </button>

                {/* 日志详情列表 */}
                {logPreviewExpanded && logPreview && logPreview.items.length > 0 && (
                  <div
                    className="max-h-[200px] overflow-y-auto border-t"
                    style={{
                      borderColor: 'rgba(255,255,255,0.06)',
                      scrollbarWidth: 'thin',
                      scrollbarColor: 'rgba(255,255,255,0.2) transparent',
                    }}
                  >
                    {logPreview.items.map((item, index) => (
                      <div
                        key={index}
                        className="px-3 py-1.5 flex items-center gap-2 text-[10px] font-mono hover:bg-white/5"
                        style={{
                          borderBottom: index < logPreview.items.length - 1 ? '1px solid rgba(255,255,255,0.04)' : undefined,
                        }}
                      >
                        {item.hasError && (
                          <AlertTriangle size={10} style={{ color: 'rgba(255, 120, 120, 0.8)', flexShrink: 0 }} />
                        )}
                        <span style={{ color: 'var(--text-muted)', width: '105px', flexShrink: 0 }}>
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
                          className="truncate flex-1"
                          style={{ color: 'var(--text-secondary)' }}
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

            {/* Input Actions */}
            <div
              className="px-4 py-2.5 border-t flex items-center gap-2 flex-wrap"
              style={{ borderColor: 'rgba(255,255,255,0.08)' }}
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
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
                        className="px-2 py-1 rounded-[7px] text-[11px] font-medium transition-colors"
                        style={{
                          background: active ? 'rgba(214, 178, 106, 0.18)' : 'rgba(255,255,255,0.06)',
                          border: active ? '1px solid rgba(214, 178, 106, 0.35)' : '1px solid rgba(255,255,255,0.08)',
                          color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                        }}
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
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {polishing ? 'AI 润色中...' : 'AI 润色'}
              </Button>

              <SuccessConfettiButton
                size="sm"
                readyText="提交缺陷"
                loadingText="提交中"
                successText="已提交"
                showLoadingText
                disabled={!content.trim() || !assigneeUserId}
                onAction={handleSubmit}
                successHoldMs={1200}
              />
            </div>
          </div>
        </div>
      </GlassCard>
    </div>
  );
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
      onClick={openDialog}
      className="h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors duration-200 hover:bg-white/10 shrink-0"
      style={{ color: 'var(--text-muted)' }}
      aria-label="提交缺陷"
      title={collapsed ? '提交缺陷 (Cmd/Ctrl+B)' : '提交缺陷'}
    >
      <Bug size={14} className="defect-submit-breath" />
    </button>
  );
}
