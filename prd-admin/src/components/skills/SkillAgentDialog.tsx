import { useState, useRef, useCallback, useEffect } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { api } from '@/services/api';
import {
  createSkillAgentSession,
  saveSkillFromAgent,
  exportSkillMd,
  getExportZipUrl,
  deleteSkillAgentSession,
  type SkillAgentStage,
} from '@/services/real/skillAgent';
import { useAuthStore } from '@/stores/authStore';
import { Send, Save, FileText, Archive, RotateCcw, Sparkles } from 'lucide-react';

interface SkillAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSkillCreated?: () => void;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function SkillAgentDialog({ open, onOpenChange, onSkillCreated }: SkillAgentDialogProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stages, setStages] = useState<SkillAgentStage[]>([]);
  const [currentStageIndex, setCurrentStageIndex] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [skillPreview, setSkillPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // SSE stream for message responses
  const {
    phase,
    phaseMessage,
    typing,
    isStreaming,
    start: startStream,
    reset: resetStream,
  } = useSseStream({
    url: '', // will be overridden per call
    method: 'POST',
    onEvent: {
      stage: (raw: unknown) => {
        const d = raw as { stageIndex?: number };
        if (typeof d.stageIndex === 'number') setCurrentStageIndex(d.stageIndex);
      },
      done: (raw: unknown) => {
        const d = raw as { stageIndex?: number; skillDraft?: string };
        if (typeof d.stageIndex === 'number') setCurrentStageIndex(d.stageIndex);
        if (d.skillDraft) setSkillPreview(d.skillDraft);
      },
    },
  });

  // When typing accumulates, update the assistant message in real-time
  useEffect(() => {
    if (!typing) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, content: typing }];
      }
      return [...prev, { role: 'assistant', content: typing }];
    });
  }, [typing]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  // Initialize session when dialog opens
  useEffect(() => {
    if (open && !sessionId) {
      initSession();
    }
  }, [open]);

  const initSession = async () => {
    const res = await createSkillAgentSession();
    if (res.success && res.data) {
      setSessionId(res.data.sessionId);
      setStages(res.data.stages);
      setCurrentStageIndex(res.data.stageIndex);
      // Add welcome message
      setMessages([{ role: 'assistant', content: res.data.welcome.message }]);
    }
  };

  const handleSend = useCallback(async () => {
    if (!sessionId || !input.trim() || isStreaming) return;

    const userMsg = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);

    resetStream();
    await startStream({
      url: api.skillAgent.sendMessage(sessionId),
      body: { message: userMsg },
    });
  }, [sessionId, input, isStreaming, startStream, resetStream]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSave = async () => {
    if (!sessionId) return;
    setSaving(true);
    try {
      const res = await saveSkillFromAgent(sessionId);
      if (res.success && res.data) {
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: `${res.data.message}` },
        ]);
        onSkillCreated?.();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleExportMd = async () => {
    if (!sessionId) return;
    setExporting(true);
    try {
      const res = await exportSkillMd(sessionId);
      if (res.success && res.data) {
        // Download as file
        const blob = new Blob([res.data.skillMd], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.data.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setExporting(false);
    }
  };

  const handleExportZip = async () => {
    if (!sessionId) return;
    setExporting(true);
    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(getExportZipUrl(sessionId), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `skill.zip`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setExporting(false);
    }
  };

  const handleReset = async () => {
    if (sessionId) {
      await deleteSkillAgentSession(sessionId);
    }
    setSessionId(null);
    setMessages([]);
    setStages([]);
    setCurrentStageIndex(0);
    setSkillPreview(null);
    setInput('');
    resetStream();
    // Re-init
    initSession();
  };

  const handleClose = (v: boolean) => {
    if (!v && sessionId) {
      deleteSkillAgentSession(sessionId);
      setSessionId(null);
      setMessages([]);
      setStages([]);
      setCurrentStageIndex(0);
      setSkillPreview(null);
      setInput('');
      resetStream();
    }
    onOpenChange(v);
  };

  const hasSkillDraft = !!skillPreview;

  return (
    <Dialog
      open={open}
      onOpenChange={handleClose}
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={18} />
          AI 技能创建助手
        </span>
      }
      maxWidth={720}
      titleAction={
        <button
          onClick={handleReset}
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--text-tertiary)' }}
          title="重新开始"
        >
          <RotateCcw size={16} />
        </button>
      }
      content={
        <div className="flex flex-col" style={{ height: 'min(70vh, 600px)' }}>
          {/* Stage Progress Bar */}
          {stages.length > 0 && (
            <div className="flex items-center gap-1 px-1 py-3 mb-3">
              {stages.map((s, i) => (
                <div key={s.key} className="flex items-center gap-1 flex-1">
                  <div
                    className="flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium transition-all"
                    style={{
                      background: i <= currentStageIndex ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                      color: i <= currentStageIndex ? 'white' : 'var(--text-tertiary)',
                    }}
                  >
                    {i + 1}
                  </div>
                  <span
                    className="text-xs hidden sm:inline"
                    style={{ color: i <= currentStageIndex ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
                  >
                    {s.label}
                  </span>
                  {i < stages.length - 1 && (
                    <div
                      className="flex-1 h-px mx-1"
                      style={{ background: i < currentStageIndex ? 'var(--accent-primary)' : 'var(--border-secondary)' }}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Streaming Phase Bar */}
          {(phase === 'connecting' || phase === 'streaming') && (
            <div className="mb-2">
              <SsePhaseBar phase={phase} message={phaseMessage} />
            </div>
          )}

          {/* Chat Messages */}
          <div
            className="flex-1 overflow-y-auto space-y-3 px-1"
            style={{ minHeight: 0 }}
          >
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
                  style={
                    msg.role === 'user'
                      ? {
                          background: 'var(--accent-primary)',
                          color: 'white',
                          borderBottomRightRadius: '6px',
                        }
                      : msg.role === 'system'
                        ? {
                            background: 'var(--bg-success)',
                            color: 'var(--text-success)',
                            borderBottomLeftRadius: '6px',
                          }
                        : {
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            borderBottomLeftRadius: '6px',
                          }
                  }
                >
                  {msg.content}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Skill Preview (shown when draft is ready) */}
          {skillPreview && (
            <div className="mt-3 p-3 rounded-xl text-xs font-mono overflow-auto" style={{
              background: 'var(--bg-tertiary)',
              maxHeight: '120px',
              border: '1px solid var(--border-secondary)',
            }}>
              <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)', fontFamily: 'inherit' }}>
                SKILL.md 预览
              </div>
              <pre className="whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                {skillPreview.slice(0, 500)}{skillPreview.length > 500 ? '...' : ''}
              </pre>
            </div>
          )}

          {/* Export Actions (shown when draft is ready) */}
          {hasSkillDraft && (
            <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-secondary)' }}>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--accent-primary)', color: 'white' }}
              >
                <Save size={14} />
                {saving ? '保存中…' : '保存为个人技能'}
              </button>
              <button
                onClick={handleExportMd}
                disabled={exporting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              >
                <FileText size={14} />
                导出 .md
              </button>
              <button
                onClick={handleExportZip}
                disabled={exporting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              >
                <Archive size={14} />
                导出 .zip
              </button>
            </div>
          )}

          {/* Input Area */}
          <div className="mt-3 flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? 'AI 正在回复…' : '输入你的想法…'}
              disabled={isStreaming}
              rows={1}
              className="flex-1 resize-none rounded-xl px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-secondary)',
                maxHeight: '120px',
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
              }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
              className="flex items-center justify-center w-10 h-10 rounded-xl transition-colors"
              style={{
                background: input.trim() && !isStreaming ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                color: input.trim() && !isStreaming ? 'white' : 'var(--text-tertiary)',
              }}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      }
    />
  );
}
