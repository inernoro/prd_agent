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
} from '@/services';
import { toast } from '@/lib/toast';
import { DefectSeverity } from '@/services/contracts/defectAgent';
import type { DefectTemplate, DefectUser } from '@/services/contracts/defectAgent';
import {
  X,
  Send,
  Paperclip,
  FileText,
  Sparkles,
  Loader2,
  Bug,
} from 'lucide-react';

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
  const [submitting, setSubmitting] = useState(false);
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

  // Submit defect
  const handleSubmit = async () => {
    if (!content.trim()) {
      toast.warning('请输入问题描述');
      return;
    }
    if (!assigneeUserId) {
      toast.warning('请选择提交给谁');
      return;
    }

    setSubmitting(true);
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
        setSubmitting(false);
        return;
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
        // 重置表单
        setContent('');
        setAttachments([]);
        setSeverity(DefectSeverity.Trivial);
        closeDialog();
      } else {
        toast.warning('缺陷已保存为草稿');
        closeDialog();
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

        {/* Content Area - 参考视觉创作的输入框样式 */}
        <div
          className="flex-1 min-h-0 px-5 pb-4 flex flex-col"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <div
            className="flex-1 min-h-[280px] flex flex-col rounded-xl overflow-hidden transition-all duration-200"
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

            {/* Input Actions */}
            <div
              className="px-4 py-3 border-t flex items-center gap-2"
              style={{ borderColor: 'rgba(255,255,255,0.08)' }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                title="添加附件"
              >
                <Paperclip size={16} style={{ color: 'var(--text-muted)' }} />
              </button>

              <div className="flex items-center gap-2">
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
                        className="px-2 py-1 rounded-md text-[11px] transition-colors"
                        style={{
                          background: active ? 'rgba(214, 178, 106, 0.2)' : 'rgba(255,255,255,0.06)',
                          border: active ? '1px solid rgba(214, 178, 106, 0.4)' : '1px solid rgba(255,255,255,0.08)',
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

              {/* AI Polish Button */}
              <button
                onClick={handlePolish}
                disabled={polishing || !content.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all disabled:opacity-50"
                style={{
                  background: polishing
                    ? 'rgba(168,85,247,0.2)'
                    : 'linear-gradient(135deg, rgba(168,85,247,0.2), rgba(236,72,153,0.2))',
                  border: '1px solid rgba(168,85,247,0.3)',
                  color: 'rgba(216,180,254,0.9)',
                }}
                title="AI 润色：优化描述内容，根据模板补充信息"
              >
                {polishing ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {polishing ? 'AI 润色中...' : 'AI 润色'}
              </button>

              <Button
                variant="primary"
                size="sm"
                onClick={handleSubmit}
                disabled={submitting || !content.trim() || !assigneeUserId}
              >
                {submitting ? (
                  <Loader2 size={14} className="animate-spin" />
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
