import { useState, useRef, useCallback, useEffect } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDefectStore } from '@/stores/defectStore';
import {
  createDefect,
  submitDefect,
  addDefectAttachment,
} from '@/services';
import { toast } from '@/lib/toast';
import {
  X,
  Send,
  Paperclip,
  Image as ImageIcon,
  FileText,
  Trash2,
  Upload,
} from 'lucide-react';

const STORAGE_KEY_TEMPLATE = 'defect-agent-last-template';
const STORAGE_KEY_ASSIGNEE = 'defect-agent-last-assignee';

export function DefectSubmitPanel() {
  const {
    templates,
    users,
    setShowSubmitPanel,
    addDefectToList,
    loadStats,
  } = useDefectStore();

  // 从 localStorage 读取上次选择
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY_TEMPLATE) || '';
  });
  const [assigneeUserId, setAssigneeUserId] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY_ASSIGNEE) || '';
  });
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 当用户/模板选择变化时保存到 localStorage
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      // Create defect
      const createRes = await createDefect({
        templateId: selectedTemplateId || undefined,
        content: content.trim(),
        assigneeUserId,
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-end"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={() => setShowSubmitPanel(false)}
    >
      <div
        className="h-full w-[480px] flex flex-col"
        style={{ background: 'var(--bg-base)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          <div
            className="text-[14px] font-medium"
            style={{ color: 'var(--text-primary)' }}
          >
            提交缺陷
          </div>
          <button
            onClick={() => setShowSubmitPanel(false)}
            className="p-1 rounded hover:bg-white/10 transition-colors"
          >
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Selectors */}
        <div className="px-4 py-3 space-y-3">
          {/* Assignee */}
          <div className="flex items-center gap-3">
            <label
              className="text-[12px] w-16 flex-shrink-0"
              style={{ color: 'var(--text-muted)' }}
            >
              提交给
            </label>
            <select
              value={assigneeUserId}
              onChange={(e) => setAssigneeUserId(e.target.value)}
              className="flex-1 px-3 py-1.5 rounded-md text-[12px] outline-none"
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
          <div className="flex items-center gap-3">
            <label
              className="text-[12px] w-16 flex-shrink-0"
              style={{ color: 'var(--text-muted)' }}
            >
              模板
            </label>
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              className="flex-1 px-3 py-1.5 rounded-md text-[12px] outline-none"
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

        {/* Content Area */}
        <div
          className="flex-1 min-h-0 px-4 pb-3 flex flex-col"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <GlassCard glow className="flex-1 min-h-0 flex flex-col p-0 overflow-hidden">
            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onPaste={handlePaste}
              placeholder="描述您发现的问题...&#10;&#10;支持粘贴截图或拖拽文件"
              className="flex-1 min-h-0 p-3 text-[13px] resize-none outline-none"
              style={{
                background: 'transparent',
                color: 'var(--text-primary)',
              }}
            />

            {/* Attachments Preview */}
            {attachments.length > 0 && (
              <div
                className="px-3 py-2 border-t flex flex-wrap gap-2"
                style={{ borderColor: 'rgba(255,255,255,0.08)' }}
              >
                {attachments.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px]"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {file.type.startsWith('image/') ? (
                      <ImageIcon size={12} />
                    ) : (
                      <FileText size={12} />
                    )}
                    <span className="max-w-[100px] truncate">{file.name}</span>
                    <button
                      onClick={() => removeAttachment(index)}
                      className="p-0.5 rounded hover:bg-white/10"
                    >
                      <Trash2 size={10} style={{ color: 'rgba(255,100,100,0.8)' }} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Input Actions */}
            <div
              className="px-3 py-2 border-t flex items-center gap-2"
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
                className="p-1.5 rounded hover:bg-white/10 transition-colors"
                title="添加附件"
              >
                <Paperclip size={14} style={{ color: 'var(--text-muted)' }} />
              </button>
              <div className="flex-1" />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSubmit}
                disabled={submitting || !content.trim() || !assigneeUserId}
              >
                {submitting ? (
                  <Upload size={14} className="animate-spin" />
                ) : (
                  <Send size={14} />
                )}
                {submitting ? '提交中...' : '提交缺陷'}
              </Button>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
