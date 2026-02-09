import { useCallback, useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import {
  Sparkles, Send, Save, Eye, Loader2, RefreshCw,
  Trash2, FileText, Users, Clock, CheckCircle, XCircle,
  ChevronDown, ChevronUp, Mail,
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
              background: viewMode === t.key ? 'var(--bg-elevated)' : 'transparent',
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
    <div className="space-y-3">
      {viewMode === 'compose' && <ComposeView />}
      {viewMode === 'templates' && <TemplatesView />}
      {viewMode === 'records' && <RecordsView />}
    </div>
  );
}

// ========== AI Compose View (Main) ==========

const stylePresets = [
  { value: '', label: '默认风格' },
  { value: '极简科技风，深色背景，霓虹渐变', label: '科技暗黑' },
  { value: '温暖友好，圆角卡片，柔和配色', label: '温暖亲和' },
  { value: '商务专业，蓝灰色调，简洁排版', label: '商务正式' },
  { value: '活力创意，大胆配色，动感布局', label: '活力创意' },
];

function ComposeView() {
  const [topic, setTopic] = useState('');
  const [style, setStyle] = useState('');
  const [extra, setExtra] = useState('');
  const [language, setLanguage] = useState('中文');
  const [generating, setGenerating] = useState(false);

  const [htmlContent, setHtmlContent] = useState('');
  const [showCode, setShowCode] = useState(false);

  const [sendEmail, setSendEmail] = useState('');
  const [sendSubject, setSendSubject] = useState('');
  const [sending, setSending] = useState(false);
  const [saveAsTemplate, setSaveAsTemplate] = useState(true);
  const [templateName, setTemplateName] = useState('');

  const handleGenerate = async () => {
    if (!topic.trim()) {
      toast.error('请输入邮件主题');
      return;
    }
    setGenerating(true);
    const res = await generateTutorialEmailTemplate({
      topic: topic.trim(),
      style: style || undefined,
      language,
      extraRequirements: extra || undefined,
    });
    setGenerating(false);

    if (res.success && res.data.htmlContent) {
      setHtmlContent(res.data.htmlContent);
      toast.success(`AI 已生成邮件模板${res.data.model ? ` (${res.data.model})` : ''}`);
    } else {
      toast.error('生成失败，请重试');
    }
  };

  const handleSend = async () => {
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
      subject: sendSubject.trim() || topic.trim() || '产品教程',
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
      toast.error('邮件发送失败，请检查 SMTP 配置');
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
    <div className="space-y-4">
      {/* Step 1: 输入主题 */}
      <GlassCard className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles size={16} style={{ color: 'var(--color-warning)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            描述你想发的邮件
          </span>
        </div>

        <textarea
          placeholder="例如：Day 1 新手引导教程 - 介绍如何创建第一个 PRD 文档，包含快速入门步骤和截图说明"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 text-sm rounded-md resize-none"
          style={inputStyle}
        />

        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-md"
            style={inputStyle}
          >
            {stylePresets.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>

          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-md"
            style={inputStyle}
          >
            <option value="中文">中文</option>
            <option value="English">English</option>
            <option value="中英混合">中英混合</option>
          </select>

          <input
            placeholder="额外要求（可选）"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            className="flex-1 min-w-[200px] px-2.5 py-1.5 text-xs rounded-md"
            style={inputStyle}
          />

          <Button onClick={handleGenerate} disabled={generating} size="sm">
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generating ? 'AI 生成中...' : 'AI 生成'}
          </Button>
        </div>
      </GlassCard>

      {/* Step 2: 实时预览 */}
      {htmlContent && (
        <GlassCard className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Eye size={16} style={{ color: 'var(--text-secondary)' }} />
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                邮件预览
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowCode(!showCode)}
                className="text-xs px-2 py-1 rounded-md"
                style={{
                  background: showCode ? 'var(--bg-elevated)' : 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border-default)',
                }}
              >
                {showCode ? '预览' : '源码'}
              </button>
              <button
                onClick={handleGenerate}
                className="text-xs px-2 py-1 rounded-md flex items-center gap-1"
                style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
                disabled={generating}
              >
                <RefreshCw size={10} /> 重新生成
              </button>
            </div>
          </div>

          {showCode ? (
            <textarea
              value={htmlContent}
              onChange={(e) => setHtmlContent(e.target.value)}
              rows={20}
              className="w-full px-3 py-2 text-xs font-mono rounded-md"
              style={inputStyle}
            />
          ) : (
            <div className="rounded-lg overflow-hidden" style={{ background: '#f5f5f5' }}>
              <iframe
                srcDoc={htmlContent}
                sandbox=""
                className="w-full border-0"
                style={{ height: '500px' }}
                title="邮件预览"
              />
            </div>
          )}
        </GlassCard>
      )}

      {/* Step 3: 发送 */}
      {htmlContent && (
        <GlassCard className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Send size={16} style={{ color: 'var(--text-secondary)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              发送邮件
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="收件邮箱"
              value={sendEmail}
              onChange={(e) => setSendEmail(e.target.value)}
              className="px-3 py-2 text-sm rounded-md"
              style={inputStyle}
            />
            <input
              placeholder="邮件标题（默认使用主题描述）"
              value={sendSubject}
              onChange={(e) => setSendSubject(e.target.value)}
              className="px-3 py-2 text-sm rounded-md"
              style={inputStyle}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={saveAsTemplate}
                  onChange={(e) => setSaveAsTemplate(e.target.checked)}
                  className="rounded"
                />
                <Save size={12} /> 同时保存为模板
              </label>
              {saveAsTemplate && (
                <input
                  placeholder="模板名称（可选，自动生成）"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  className="px-2 py-1 text-xs rounded-md w-48"
                  style={inputStyle}
                />
              )}
            </div>

            <Button onClick={handleSend} disabled={sending} size="sm">
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {sending ? '发送中...' : '发送邮件'}
            </Button>
          </div>
        </GlassCard>
      )}
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
    <div className="space-y-3">
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
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : templates.length === 0 ? (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          <Mail size={32} className="mx-auto mb-2 opacity-30" />
          <div className="text-sm">暂无模板</div>
          <div className="text-xs mt-1">在「AI 编写」中生成邮件时勾选"保存为模板"即可自动保存</div>
        </div>
      ) : (
        templates.map((tpl) => (
          <GlassCard key={tpl.id} className="p-4">
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
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1 text-xs rounded-md"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
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
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : enrollments.length === 0 ? (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          <Users size={32} className="mx-auto mb-2 opacity-30" />
          <div className="text-sm">暂无发送记录</div>
        </div>
      ) : (
        <div className="space-y-2">
          {enrollments.map((enr) => (
            <GlassCard key={enr.id} className="p-3">
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
                      style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
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
