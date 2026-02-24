import { useState, useRef, useCallback, useEffect } from 'react';
import { invoke } from '../../lib/tauri';
import { useDefectStore } from '../../stores/defectStore';
import type { ApiResponse, DefectReport, DefectSeverity } from '../../types';

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

const STORAGE_KEY_TEMPLATE = 'defect-agent-last-template';
const STORAGE_KEY_ASSIGNEE = 'defect-agent-last-assignee';
const DEFAULT_ASSIGNEE_USERNAME = 'inernoro';

const severityOptions: { value: DefectSeverity; label: string }[] = [
  { value: 'critical', label: '致命' },
  { value: 'major', label: '严重' },
  { value: 'minor', label: '一般' },
  { value: 'trivial', label: '轻微' },
];

interface DefectUser {
  id: string;
  username: string;
  displayName?: string;
}

interface DefectTemplate {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

interface ApiLogPreviewItem {
  time: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  hasError: boolean;
  errorCode?: string;
  apiSummary?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTitle(text: string): string | undefined {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 100 ? trimmed.slice(0, 100) + '...' : trimmed;
  }
  return undefined;
}

/** Read a File as base64 string for Tauri IPC */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip data:...;base64, prefix
      resolve(result.split(',')[1] || result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DefectSubmitPanel() {
  const { setShowSubmitPanel, addDefectToList, loadStats } = useDefectStore();

  // Data
  const [users, setUsers] = useState<DefectUser[]>([]);
  const [templates, setTemplates] = useState<DefectTemplate[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);

  // Log preview
  const [logPreview, setLogPreview] = useState<{
    totalCount: number;
    errorCount: number;
    items: ApiLogPreviewItem[];
  } | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const [logLoading, setLogLoading] = useState(false);

  // Form
  const [assigneeUserId, setAssigneeUserId] = useState(
    () => localStorage.getItem(STORAGE_KEY_ASSIGNEE) || '',
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    () => localStorage.getItem(STORAGE_KEY_TEMPLATE) || '',
  );
  const [content, setContent] = useState('');
  const [severity, setSeverity] = useState<DefectSeverity>('trivial');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ─── Load data on mount ───────────────────────────────────────────
  useEffect(() => {
    if (dataLoaded) return;
    (async () => {
      try {
        const [usersRes, templatesRes] = await Promise.all([
          invoke<ApiResponse<{ items: DefectUser[] }>>('list_defect_users'),
          invoke<ApiResponse<{ items: DefectTemplate[] }>>('list_defect_templates'),
        ]);

        let userItems: DefectUser[] = [];
        if (usersRes.success && usersRes.data) {
          userItems = Array.isArray(usersRes.data) ? usersRes.data : (usersRes.data as any).items ?? [];
          setUsers(userItems);
        }

        if (templatesRes.success && templatesRes.data) {
          const tItems = Array.isArray(templatesRes.data) ? templatesRes.data : (templatesRes.data as any).items ?? [];
          setTemplates(tItems);
        }

        // Restore or default assignee
        const savedAssignee = localStorage.getItem(STORAGE_KEY_ASSIGNEE);
        if (savedAssignee && userItems.some((u) => u.id === savedAssignee)) {
          setAssigneeUserId(savedAssignee);
        } else {
          const defaultUser = userItems.find((u) => u.username === DEFAULT_ASSIGNEE_USERNAME);
          if (defaultUser) setAssigneeUserId(defaultUser.id);
          else if (userItems.length > 0) setAssigneeUserId(userItems[0].id);
        }

        setDataLoaded(true);
      } catch (err) {
        console.error('Failed to load defect data:', err);
        setDataLoaded(true);
      }
    })();
  }, [dataLoaded]);

  // ─── Load log preview ─────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setLogLoading(true);
      try {
        const res = await invoke<ApiResponse<{ totalCount: number; errorCount: number; items: ApiLogPreviewItem[] }>>('preview_defect_logs');
        if (res.success && res.data) {
          setLogPreview(res.data as any);
        }
      } catch {
        // silent
      } finally {
        setLogLoading(false);
      }
    })();
  }, []);

  // ─── Persist selections ───────────────────────────────────────────
  useEffect(() => {
    if (assigneeUserId) localStorage.setItem(STORAGE_KEY_ASSIGNEE, assigneeUserId);
  }, [assigneeUserId]);

  useEffect(() => {
    if (selectedTemplateId) localStorage.setItem(STORAGE_KEY_TEMPLATE, selectedTemplateId);
  }, [selectedTemplateId]);

  // ─── Auto focus textarea ──────────────────────────────────────────
  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, []);

  // ─── Paste screenshot ─────────────────────────────────────────────
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) setAttachments((prev) => [...prev, file]);
      }
    }
  }, []);

  // ─── Drag & drop ──────────────────────────────────────────────────
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    setAttachments((prev) => [...prev, ...files]);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // ─── File input ───────────────────────────────────────────────────
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setAttachments((prev) => [...prev, ...files]);
    e.target.value = '';
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ─── AI Polish ────────────────────────────────────────────────────
  const handlePolish = async () => {
    if (!content.trim()) return;
    setPolishing(true);
    setError('');
    try {
      const res = await invoke<ApiResponse<{ content: string }>>('polish_defect', {
        content: content.trim(),
        templateId: selectedTemplateId || null,
      });
      if (res.success && res.data) {
        const polished = (res.data as any).content ?? '';
        if (polished) setContent(polished);
        else setError('AI 润色未返回内容');
      } else {
        setError(res.error?.message || 'AI 润色失败');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPolishing(false);
    }
  };

  // ─── Submit ───────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!content.trim()) { setError('请输入问题描述'); return; }
    if (!assigneeUserId) { setError('请选择提交对象'); return; }

    setSubmitting(true);
    setError('');
    try {
      const title = extractTitle(content);

      // Step 1: Create defect
      const createResp = await invoke<ApiResponse<{ defect: DefectReport }>>('create_defect', {
        content: content.trim(),
        severity,
        title: title ?? null,
        assigneeUserId,
        templateId: selectedTemplateId || null,
      });

      if (!createResp.success || !createResp.data) {
        setError(createResp.error?.message || '创建失败');
        setSubmitting(false);
        return;
      }

      const defect = (createResp.data as any).defect ?? createResp.data;

      // Step 2: Upload attachments
      for (const file of attachments) {
        try {
          const base64 = await fileToBase64(file);
          await invoke('add_defect_attachment', {
            id: defect.id,
            fileBase64: base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
          });
        } catch (e) {
          console.error('Failed to upload attachment:', e);
        }
      }

      // Step 3: Submit defect
      const submitResp = await invoke<ApiResponse<{ defect: DefectReport }>>('submit_defect', {
        id: defect.id,
      });

      if (submitResp.success && submitResp.data) {
        const submitted = (submitResp.data as any).defect ?? submitResp.data;
        addDefectToList(submitted as DefectReport);
      } else {
        addDefectToList(defect as DefectReport);
      }

      loadStats();
      setShowSubmitPanel(false);
      setContent('');
      setAttachments([]);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const defaultTemplate = templates.find((t) => t.isDefault);

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowSubmitPanel(false)}>
      <div
        className="w-full max-w-[720px] mx-4 ui-glass-panel rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-blue-500/15">
              <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2l1.88 1.88M14.12 3.88 16 2" />
                <path d="M9 7.13v-1a3 3 0 1 1 6 0v1" />
                <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
                <path d="M12 20v-9" />
                <path d="M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4" />
                <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
              </svg>
            </div>
            <span className="text-[15px] font-medium">提交缺陷</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/5 text-text-secondary">
              {navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+B
            </span>
          </div>
          <button onClick={() => setShowSubmitPanel(false)} className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── Selectors: Assignee + Template ── */}
        <div className="px-5 py-3">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 flex-1">
              <label className="text-[12px] text-text-secondary shrink-0">提交给</label>
              <select
                value={assigneeUserId}
                onChange={(e) => setAssigneeUserId(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-[13px] bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 outline-none focus:ring-1 focus:ring-primary-500/30"
              >
                <option value="">选择用户</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.displayName || u.username}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 flex-1">
              <label className="text-[12px] text-text-secondary shrink-0">模板</label>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg text-[13px] bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 outline-none focus:ring-1 focus:ring-primary-500/30"
              >
                <option value="">{defaultTemplate ? `${defaultTemplate.name} (默认)` : '无模板'}</option>
                {templates.filter((t) => !t.isDefault).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Template hint */}
          {selectedTemplate?.description && (
            <div className="mt-2 px-3 py-2 rounded-lg text-[11px] bg-blue-500/8 border border-blue-500/15 text-text-secondary">
              <span className="text-blue-400">模板提示：</span>
              {selectedTemplate.description}
            </div>
          )}
        </div>

        {/* ── Content area ── */}
        <div className="flex-1 min-h-0 px-5 pb-4 flex flex-col" onDrop={handleDrop} onDragOver={handleDragOver}>
          <div
            className="flex-1 min-h-[240px] flex flex-col rounded-xl overflow-hidden transition-all duration-200"
            style={{
              background: 'rgba(0,0,0,0.06)',
              border: focused ? '1px solid rgba(59,130,246,0.5)' : '1px solid rgba(0,0,0,0.08)',
              boxShadow: focused ? '0 0 0 2px rgba(59,130,246,0.12)' : 'none',
            }}
          >
            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={'描述您发现的问题...\n\n第一行将作为标题\n\n支持粘贴截图或拖拽文件\n\n提示：点击右下角 AI 按钮可自动润色内容'}
              className="flex-1 min-h-0 p-4 text-[13px] resize-none outline-none bg-transparent"
            />

            {/* Attachment preview */}
            {attachments.length > 0 && (
              <div className="px-4 py-3 border-t border-black/5 dark:border-white/8 flex flex-wrap gap-2">
                {attachments.map((file, i) => (
                  <div key={i} className="group relative">
                    {file.type.startsWith('image/') ? (
                      <div className="w-16 h-16 rounded-lg overflow-hidden bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10">
                        <img src={URL.createObjectURL(file)} alt={file.name} className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] bg-black/5 dark:bg-white/5 text-text-secondary">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        <span className="max-w-[80px] truncate">{file.name}</span>
                      </div>
                    )}
                    <button
                      onClick={() => removeAttachment(i)}
                      className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Log preview */}
            <div className="px-4 py-3 border-t border-black/5 dark:border-white/8">
              <div className="rounded-lg overflow-hidden bg-blue-500/5 border border-blue-500/10">
                <button
                  type="button"
                  onClick={() => logPreview && logPreview.totalCount > 0 && setLogExpanded(!logExpanded)}
                  className="w-full px-3 py-2 flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  style={{ cursor: logPreview && logPreview.totalCount > 0 ? 'pointer' : 'default' }}
                >
                  {logLoading ? (
                    <svg className="w-3.5 h-3.5 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                  ) : (
                    <svg className="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  )}
                  <span className="text-[11px] text-text-secondary">
                    {logLoading ? '正在加载 API 日志...' :
                     logPreview && logPreview.totalCount > 0 ? (
                       <>提交时将自动采集 <span className="text-blue-400">{logPreview.totalCount}</span> 条请求日志{logPreview.errorCount > 0 && <>{' '}(含 <span className="text-red-400">{logPreview.errorCount}</span> 条错误)</>}</>
                     ) : '提交时将自动采集 API 日志（当前无日志记录）'}
                  </span>
                  <div className="flex-1" />
                  {logPreview && logPreview.totalCount > 0 && (
                    <svg className={`w-3.5 h-3.5 text-text-secondary transition-transform ${logExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  )}
                </button>

                {/* Expanded log details */}
                {logExpanded && logPreview && logPreview.items.length > 0 && (
                  <div className="max-h-[180px] overflow-y-auto border-t border-black/5 dark:border-white/5" style={{ scrollbarWidth: 'thin' }}>
                    {logPreview.items.map((item, i) => (
                      <div key={i} className="px-3 py-1.5 flex items-center gap-2 text-[10px] font-mono hover:bg-black/5 dark:hover:bg-white/5"
                        style={{ borderBottom: i < logPreview.items.length - 1 ? '1px solid rgba(0,0,0,0.04)' : undefined }}>
                        {item.hasError && (
                          <svg className="w-2.5 h-2.5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19H19a2.13 2.13 0 001.85-3.19L13.85 4.17a2.13 2.13 0 00-3.7 0L3.22 15.81A2.13 2.13 0 005.07 19z" /></svg>
                        )}
                        <span className="text-text-secondary w-[55px] shrink-0">{item.time}</span>
                        <span className={`w-[40px] shrink-0 ${
                          item.method === 'GET' ? 'text-blue-400' :
                          item.method === 'POST' ? 'text-green-400' :
                          item.method === 'PUT' ? 'text-orange-400' :
                          item.method === 'DELETE' ? 'text-red-400' : 'text-text-secondary'
                        }`}>{item.method}</span>
                        <span className="truncate flex-1 text-text-secondary" title={item.path}>{item.path}</span>
                        <span className={`w-[30px] text-right shrink-0 ${
                          item.statusCode >= 400 ? 'text-red-400' :
                          item.statusCode >= 300 ? 'text-orange-400' : 'text-green-400'
                        }`}>{item.statusCode}</span>
                        <span className={`w-[45px] text-right shrink-0 ${
                          item.durationMs >= 1000 ? 'text-red-400' :
                          item.durationMs >= 200 ? 'text-orange-400' : 'text-text-secondary'
                        }`}>{item.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ── Bottom action bar ── */}
            <div className="px-4 py-3 border-t border-black/5 dark:border-white/8 flex items-center gap-2">
              {/* File picker */}
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-text-secondary"
                title="添加附件"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              </button>

              {/* Severity */}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-text-secondary">严重性</span>
                <div className="flex items-center gap-1">
                  {severityOptions.map((opt) => {
                    const active = severity === opt.value;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => setSeverity(opt.value)}
                        className={`px-2 py-1 rounded-md text-[11px] transition-colors border ${
                          active
                            ? 'bg-primary-500/15 border-primary-500/30 text-primary-600 dark:text-primary-400'
                            : 'bg-black/5 dark:bg-white/5 border-transparent text-text-secondary hover:bg-black/10 dark:hover:bg-white/10'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1" />

              {/* AI Polish */}
              <button
                onClick={handlePolish}
                disabled={polishing || !content.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all disabled:opacity-50"
                style={{
                  background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(236,72,153,0.15))',
                  border: '1px solid rgba(168,85,247,0.25)',
                  color: 'rgba(168,85,247,0.9)',
                }}
                title="AI 润色：优化描述，根据模板补充信息"
              >
                {polishing ? (
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                )}
                {polishing ? 'AI 润色中...' : 'AI 润色'}
              </button>

              {/* Submit */}
              <button
                onClick={handleSubmit}
                disabled={submitting || !content.trim() || !assigneeUserId}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? (
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                )}
                {submitting ? '提交中...' : '提交缺陷'}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && <p className="mt-2 text-red-500 text-[12px]">{error}</p>}
        </div>
      </div>
    </div>
  );
}
