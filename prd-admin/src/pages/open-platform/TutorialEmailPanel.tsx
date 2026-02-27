import { useCallback, useEffect, useRef, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import {
  Sparkles, Send, Save, Eye, Loader2, RefreshCw, Code2,
  Trash2, FileText, Users, Clock, CheckCircle, XCircle,
  ChevronDown, ChevronUp, Mail, Copy, Download,
} from 'lucide-react';
import {
  generateTutorialEmailTemplate,
  quickSendTutorialEmail,
  listTutorialEmailTemplates,
  deleteTutorialEmailTemplate,
  testSendTutorialEmail,
  listTutorialEmailEnrollments,
  unsubscribeTutorialEmailEnrollment,
  batchEnrollTutorialEmail,
  listTutorialEmailSequences,
} from '@/services';
import type {
  TutorialEmailTemplate,
  TutorialEmailEnrollment,
  TutorialEmailSequence,
} from '@/services';
import { toast } from '@/lib/toast';

interface TutorialEmailPanelProps {
  onActionsReady?: (actions: React.ReactNode) => void;
}

type ViewMode = 'compose' | 'templates' | 'records';

export default function TutorialEmailPanel({ onActionsReady }: TutorialEmailPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('compose');

  useEffect(() => {
    onActionsReady?.(
      <div className="flex items-center gap-1">
        {([
          { key: 'compose' as const, label: 'AI 编写', icon: <Sparkles size={12} /> },
          { key: 'templates' as const, label: '模板库', icon: <FileText size={12} /> },
          { key: 'records' as const, label: '发送记录', icon: <Users size={12} /> },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setViewMode(t.key)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors"
            style={{
              background: viewMode === t.key ? 'var(--bg-card, rgba(255, 255, 255, 0.03))' : 'transparent',
              color: viewMode === t.key ? 'var(--text-primary)' : 'var(--text-muted)',
              border: viewMode === t.key ? '1px solid var(--border-default)' : '1px solid transparent',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>
    );
  }, [viewMode, onActionsReady]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      {viewMode === 'compose' && <ComposeView />}
      {viewMode === 'templates' && <TemplatesView />}
      {viewMode === 'records' && <RecordsView />}
    </div>
  );
}

// ========== Chat Message Types ==========

type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  htmlContent?: string; // extracted HTML for assistant messages
  timestamp: Date;
};

// ========== AI Compose View (Split Layout) ==========

function ComposeView() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [htmlContent, setHtmlContent] = useState('');
  const [showCode, setShowCode] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Send section
  const [sendEmail, setSendEmail] = useState('');
  const [sendSubject, setSendSubject] = useState('');
  const [sending, setSending] = useState(false);
  const [saveAsTemplate, setSaveAsTemplate] = useState(true);
  const templateName = '';

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  const adjustTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || generating) return;

    const userMsg: ChatMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setGenerating(true);

    // Build conversation history for the API
    // Include existing HTML content as context for modifications
    const apiMessages: Array<{ role: string; content: string }> = [];

    for (const msg of updatedMessages) {
      if (msg.role === 'user') {
        apiMessages.push({ role: 'user', content: msg.content });
      } else if (msg.htmlContent) {
        // For assistant messages, send back the HTML they generated
        apiMessages.push({ role: 'assistant', content: msg.htmlContent });
      }
    }

    const isFirstMessage = updatedMessages.filter(m => m.role === 'user').length === 1;

    const res = await generateTutorialEmailTemplate(
      isFirstMessage
        ? { topic: text }
        : { messages: apiMessages },
    );

    setGenerating(false);

    if (res.success && res.data.htmlContent) {
      const assistantMsg: ChatMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: res.data.model
          ? `已生成邮件 (${res.data.model}, ${res.data.tokens ?? '?'} tokens)`
          : '已生成邮件',
        htmlContent: res.data.htmlContent,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMsg]);
      setHtmlContent(res.data.htmlContent);
    } else {
      const errorMsg: ChatMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '生成失败，请重试。',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMsg]);
      toast.error('生成失败');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setHtmlContent('');
    setShowCode(false);
    setInput('');
  };

  const handleCopyHtml = () => {
    navigator.clipboard.writeText(htmlContent);
    toast.success('HTML 已复制到剪贴板');
  };

  const handleDownloadHtml = () => {
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'email-template.html';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleQuickSend = async () => {
    if (!sendEmail.trim()) {
      toast.error('请输入收件邮箱');
      return;
    }
    if (!htmlContent) {
      toast.error('请先生成邮件内容');
      return;
    }
    setSending(true);
    const res = await quickSendTutorialEmail({
      email: sendEmail.trim(),
      subject: sendSubject.trim() || '产品教程',
      htmlContent,
      saveAsTemplate,
      templateName: templateName.trim() || undefined,
    });
    setSending(false);

    if (res.success && res.data.sent) {
      toast.success(
        res.data.templateId
          ? `邮件已发送，模板已保存为「${res.data.templateName}」`
          : '邮件已发送',
      );
    } else if (res.success && !res.data.sent) {
      toast.error('发送失败，请检查 SMTP 配置');
    } else {
      toast.error('操作失败');
    }
  };

  const inputStyle = {
    background: 'var(--bg-base)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
  };

  return (
    <div className="flex-1 min-h-0 flex gap-4">
      {/* Left: Email Preview */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {/* Preview header */}
        <div className="flex items-center justify-between flex-shrink-0 px-1">
          <div className="flex items-center gap-2">
            <Eye size={16} style={{ color: 'var(--text-secondary)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              邮件预览
            </span>
          </div>
          {htmlContent && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowCode(!showCode)}
                className="p-1.5 rounded-md transition-colors hover:opacity-80"
                style={{ color: showCode ? 'var(--accent-primary)' : 'var(--text-muted)' }}
                title={showCode ? '切换预览' : '查看源码'}
              >
                <Code2 size={14} />
              </button>
              <button
                onClick={handleCopyHtml}
                className="p-1.5 rounded-md transition-colors hover:opacity-80"
                style={{ color: 'var(--text-muted)' }}
                title="复制 HTML"
              >
                <Copy size={14} />
              </button>
              <button
                onClick={handleDownloadHtml}
                className="p-1.5 rounded-md transition-colors hover:opacity-80"
                style={{ color: 'var(--text-muted)' }}
                title="下载 HTML"
              >
                <Download size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Preview content */}
        <GlassCard animated className="flex-1 min-h-0 flex flex-col" padding="none" overflow="hidden">
          {htmlContent ? (
            showCode ? (
              <textarea
                value={htmlContent}
                onChange={(e) => setHtmlContent(e.target.value)}
                className="flex-1 w-full px-4 py-3 text-xs font-mono leading-relaxed resize-none"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: 'none', outline: 'none' }}
              />
            ) : (
              <iframe
                srcDoc={htmlContent}
                sandbox=""
                className="flex-1 w-full border-0"
                title="邮件预览"
                style={{ background: 'white' }}
              />
            )
          ) : (
            <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
              <div className="text-center space-y-3">
                <Mail size={48} className="mx-auto opacity-15" />
                <div className="text-sm">在右侧对话中描述你想要的邮件</div>
                <div className="text-xs opacity-60">AI 会自动生成精美的 HTML 邮件模板</div>
              </div>
            </div>
          )}
        </GlassCard>

        {/* Send bar (only when content exists) */}
        {htmlContent && (
          <GlassCard animated className="flex-shrink-0 p-3">
            <div className="flex items-center gap-3">
              <input
                placeholder="收件邮箱"
                value={sendEmail}
                onChange={(e) => setSendEmail(e.target.value)}
                className="flex-1 px-3 py-2 text-sm rounded-lg"
                style={inputStyle}
              />
              <input
                placeholder="邮件标题（可选）"
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                className="flex-1 px-3 py-2 text-sm rounded-lg"
                style={inputStyle}
              />
              <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={saveAsTemplate}
                  onChange={(e) => setSaveAsTemplate(e.target.checked)}
                  className="rounded"
                />
                <Save size={12} /> 存模板
              </label>
              <Button onClick={handleQuickSend} disabled={sending} size="sm">
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                发送
              </Button>
            </div>
          </GlassCard>
        )}
      </div>

      {/* Right: Chat Interface */}
      <GlassCard animated className="w-96 flex-shrink-0 flex flex-col" padding="none" overflow="hidden">
        {/* Chat header */}
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex items-center gap-2">
            <Sparkles size={16} style={{ color: 'var(--color-warning)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              AI 邮件助手
            </span>
          </div>
          {messages.length > 0 && (
            <button
              onClick={handleNewChat}
              className="p-1.5 rounded-md transition-colors hover:opacity-80"
              style={{ color: 'var(--text-muted)' }}
              title="新建对话"
            >
              <RefreshCw size={14} />
            </button>
          )}
        </div>

        {/* Messages area */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center space-y-4 px-4">
                <div className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center"
                  style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))' }}>
                  <Sparkles size={24} style={{ color: 'var(--color-warning)', opacity: 0.7 }} />
                </div>
                <div>
                  <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                    描述你想要的邮件
                  </div>
                  <div className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    告诉我邮件主题，我会生成精美的 HTML 邮件。
                    之后你可以继续对话来修改细节。
                  </div>
                </div>
                <div className="space-y-1.5">
                  {[
                    '写一个新手引导 Day 1 教程邮件',
                    '生成一封功能更新通知邮件',
                    '做一个带截图的操作指南邮件',
                  ].map((hint) => (
                    <button
                      key={hint}
                      onClick={() => { setInput(hint); textareaRef.current?.focus(); }}
                      className="block w-full text-left px-3 py-2 text-xs rounded-lg transition-colors"
                      style={{
                        background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-default)',
                      }}
                    >
                      {hint}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className="max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed"
                    style={
                      msg.role === 'user'
                        ? {
                            background: 'var(--accent-primary)',
                            color: 'white',
                            borderBottomRightRadius: 4,
                          }
                        : {
                            background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                            color: 'var(--text-primary)',
                            borderBottomLeftRadius: 4,
                          }
                    }
                  >
                    {msg.content}
                    {msg.htmlContent && (
                      <button
                        onClick={() => setHtmlContent(msg.htmlContent!)}
                        className="block mt-1.5 text-xs underline opacity-70 hover:opacity-100"
                      >
                        查看此版本
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {generating && (
                <div className="flex justify-start">
                  <div className="px-3 py-2 rounded-xl text-sm flex items-center gap-2"
                    style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', color: 'var(--text-muted)', borderBottomLeftRadius: 4 }}>
                    <Loader2 size={14} className="animate-spin" />
                    AI 正在生成邮件...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input area */}
        <div className="flex-shrink-0 px-4 py-3" style={{ borderTop: '1px solid var(--border-default)' }}>
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); adjustTextarea(); }}
              onKeyDown={handleKeyDown}
              placeholder={messages.length === 0 ? '描述邮件主题...' : '输入修改指令，如：把头部换成蓝色渐变...'}
              rows={1}
              className="flex-1 px-3 py-2 text-sm rounded-lg resize-none leading-relaxed"
              style={{ ...inputStyle, maxHeight: 120 }}
            />
            <Button
              onClick={handleSend}
              disabled={generating || !input.trim()}
              size="sm"
              style={{ flexShrink: 0 }}
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </Button>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}

// ========== Templates Library View ==========

function TemplatesView() {
  const [templates, setTemplates] = useState<TutorialEmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listTutorialEmailTemplates();
    if (res.success) setTemplates(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此模板？')) return;
    const res = await deleteTutorialEmailTemplate(id);
    if (res.success) {
      toast.success('已删除');
      void load();
    }
  };

  const handleTestSend = async (templateId: string) => {
    const email = prompt('输入测试邮箱地址：');
    if (!email) return;
    const res = await testSendTutorialEmail({ email, templateId });
    if (res.success && res.data.success) {
      toast.success('测试邮件已发送');
    } else {
      toast.error('发送失败，请检查 SMTP 配置');
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
      {previewHtml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setPreviewHtml(null)}>
          <div className="max-w-2xl w-full max-h-[80vh] rounded-lg overflow-hidden"
            style={{ background: 'white' }}
            onClick={(e) => e.stopPropagation()}>
            <iframe
              srcDoc={previewHtml}
              sandbox=""
              className="w-full border-0"
              style={{ height: '70vh' }}
              title="邮件预览"
            />
          </div>
        </div>
      )}

      <div className="flex justify-between items-center">
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          共 {templates.length} 个已保存模板
        </span>
      </div>

      {loading ? (
        <div className="text-center py-20" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : templates.length === 0 ? (
        <div className="text-center py-32" style={{ color: 'var(--text-muted)' }}>
          <Mail size={48} className="mx-auto mb-3 opacity-20" />
          <div className="text-base">暂无模板</div>
          <div className="text-sm mt-2 opacity-60">在「AI 编写」中生成邮件时勾选"保存为模板"即可自动保存到这里</div>
        </div>
      ) : (
        templates.map((tpl) => (
          <GlassCard animated key={tpl.id} className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  {tpl.name}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {new Date(tpl.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPreviewHtml(tpl.htmlContent)}
                  className="p-1.5 rounded-md transition-colors hover:opacity-80"
                  style={{ color: 'var(--text-secondary)' }}
                  title="预览"
                >
                  <Eye size={14} />
                </button>
                <button
                  onClick={() => handleTestSend(tpl.id)}
                  className="p-1.5 rounded-md transition-colors hover:opacity-80"
                  style={{ color: 'var(--color-info)' }}
                  title="发送测试"
                >
                  <Send size={14} />
                </button>
                <button
                  onClick={() => handleDelete(tpl.id)}
                  className="p-1.5 rounded-md transition-colors hover:opacity-80"
                  style={{ color: 'var(--color-danger)' }}
                  title="删除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </GlassCard>
        ))
      )}
    </div>
  );
}

// ========== Records View (Enrollments) ==========

function RecordsView() {
  const [enrollments, setEnrollments] = useState<TutorialEmailEnrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [sequences, setSequences] = useState<TutorialEmailSequence[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listTutorialEmailEnrollments(statusFilter ? { status: statusFilter } : undefined);
    if (res.success) setEnrollments(res.data.items);
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    listTutorialEmailSequences().then((res) => {
      if (res.success) setSequences(res.data.items);
    });
  }, []);

  const handleBatchEnroll = async () => {
    if (sequences.length === 0) {
      toast.error('请先创建邮件序列');
      return;
    }
    const seqKey = prompt(
      `请输入要批量注册的序列 Key：\n可选: ${sequences.map((s) => s.sequenceKey).join(', ')}`,
      sequences[0]?.sequenceKey,
    );
    if (!seqKey) return;
    if (!confirm(`将为所有有邮箱的活跃用户注册序列 "${seqKey}"，继续？`)) return;
    const res = await batchEnrollTutorialEmail({ sequenceKey: seqKey });
    if (res.success) {
      toast.success(`已注册 ${res.data.enrolled} 人，跳过 ${res.data.skipped} 人`);
      void load();
    } else {
      toast.error(res.error?.message || '批量注册失败');
    }
  };

  const handleUnsubscribe = async (id: string) => {
    const res = await unsubscribeTutorialEmailEnrollment(id);
    if (res.success) {
      toast.success('已退订');
      void load();
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'active': return <Clock size={12} style={{ color: 'var(--color-info)' }} />;
      case 'completed': return <CheckCircle size={12} style={{ color: 'var(--color-success)' }} />;
      case 'unsubscribed': return <XCircle size={12} style={{ color: 'var(--text-muted)' }} />;
      default: return null;
    }
  };

  const statusLabel: Record<string, string> = {
    active: '进行中',
    completed: '已完成',
    unsubscribed: '已退订',
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1 text-xs rounded-md"
            style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          >
            <option value="">全部状态</option>
            <option value="active">进行中</option>
            <option value="completed">已完成</option>
            <option value="unsubscribed">已退订</option>
          </select>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            共 {enrollments.length} 条
          </span>
        </div>
        <Button onClick={handleBatchEnroll} size="sm">
          <Users size={14} /> 批量注册
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-20" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : enrollments.length === 0 ? (
        <div className="text-center py-32" style={{ color: 'var(--text-muted)' }}>
          <Users size={48} className="mx-auto mb-3 opacity-20" />
          <div className="text-base">暂无发送记录</div>
          <div className="text-sm mt-2 opacity-60">发送邮件或批量注册用户后，记录会显示在这里</div>
        </div>
      ) : (
        <div className="space-y-2">
          {enrollments.map((enr) => (
            <GlassCard animated key={enr.id} className="p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {statusIcon(enr.status)}
                  <div>
                    <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                      {enr.email}
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        {enr.sequenceKey}
                      </span>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {statusLabel[enr.status] || enr.status}
                      · 步骤 {enr.currentStepIndex + 1}
                      · 已发送 {enr.sentHistory.filter((s) => s.success).length} 封
                      {enr.nextSendAt && ` · 下次: ${new Date(enr.nextSendAt).toLocaleString()}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {enr.sentHistory.length > 0 && (
                    <button
                      onClick={() => setExpandedId(expandedId === enr.id ? null : enr.id)}
                      className="p-1 rounded-md"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {expandedId === enr.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                  )}
                  {enr.status === 'active' && (
                    <button
                      onClick={() => handleUnsubscribe(enr.id)}
                      className="text-xs px-2 py-1 rounded-md"
                      style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
                    >
                      退订
                    </button>
                  )}
                </div>
              </div>
              {expandedId === enr.id && enr.sentHistory.length > 0 && (
                <div className="mt-2 pt-2 space-y-1" style={{ borderTop: '1px solid var(--border-default)' }}>
                  {enr.sentHistory.map((rec, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {rec.success
                        ? <CheckCircle size={10} style={{ color: 'var(--color-success)' }} />
                        : <XCircle size={10} style={{ color: 'var(--color-danger)' }} />}
                      <span>步骤 {rec.stepIndex + 1}</span>
                      <span>{new Date(rec.sentAt).toLocaleString()}</span>
                      {rec.errorMessage && <span style={{ color: 'var(--color-danger)' }}>{rec.errorMessage}</span>}
                    </div>
                  ))}
                </div>
              )}
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
