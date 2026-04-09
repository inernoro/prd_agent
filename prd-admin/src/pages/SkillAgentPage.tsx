import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { GlassCard } from '@/components/design/GlassCard';
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
import { glassBar } from '@/lib/glassStyles';
import {
  Send,
  Save,
  FileText,
  Archive,
  RotateCcw,
  Wand2,
  ArrowLeft,
  Check,
  Loader2,
  Bot,
  User,
  CheckCircle2,
} from 'lucide-react';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export default function SkillAgentPage() {
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stages, setStages] = useState<SkillAgentStage[]>([]);
  const [currentStageIndex, setCurrentStageIndex] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [skillPreview, setSkillPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    phase,
    phaseMessage,
    typing,
    isStreaming,
    start: startStream,
    reset: resetStream,
  } = useSseStream({
    url: '',
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  useEffect(() => {
    initSession();
    return () => {
      // Cleanup on unmount - don't await
    };
  }, []);

  const initSession = async () => {
    const res = await createSkillAgentSession();
    if (res.success && res.data) {
      setSessionId(res.data.sessionId);
      setStages(res.data.stages);
      setCurrentStageIndex(res.data.stageIndex);
      setMessages([{ role: 'assistant', content: res.data.welcome.message }]);
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  };

  const handleSend = useCallback(async () => {
    if (!sessionId || !input.trim() || isStreaming) return;
    const userMsg = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);
    // Reset textarea height
    if (inputRef.current) inputRef.current.style.height = 'auto';
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
        setSaved(true);
        setMessages((prev) => [...prev, { role: 'system', content: res.data.message }]);
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
        a.download = 'skill.zip';
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setExporting(false);
    }
  };

  const handleReset = async () => {
    if (sessionId) deleteSkillAgentSession(sessionId);
    setSessionId(null);
    setMessages([]);
    setStages([]);
    setCurrentStageIndex(0);
    setSkillPreview(null);
    setInput('');
    setSaved(false);
    resetStream();
    initSession();
  };

  const hasSkillDraft = !!skillPreview;

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* ━━━ Top Header ━━━ */}
      <div
        className="shrink-0 px-5 py-3 flex items-center gap-4 rounded-2xl mx-3 mt-3"
        style={{ ...glassBar, borderRadius: '16px' }}
      >
        <button
          onClick={() => navigate(-1)}
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: 'var(--text-secondary)' }}
        >
          <ArrowLeft size={18} />
        </button>

        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, #8B5CF6 0%, #6366F1 100%)',
            }}
          >
            <Wand2 size={16} color="white" />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              技能创建助手
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              AI 引导你逐步创建可复用的技能
            </div>
          </div>
        </div>

        <div className="flex-1" />

        {/* Step Navigation */}
        {stages.length > 0 && (
          <div className="hidden md:flex items-center gap-1">
            {stages.map((s, i) => {
              const isCompleted = i < currentStageIndex;
              const isCurrent = i === currentStageIndex;
              return (
                <div key={s.key} className="flex items-center">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{
                    background: isCurrent ? 'rgba(139, 92, 246, 0.15)' : 'transparent',
                  }}>
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{
                        background: isCompleted
                          ? 'linear-gradient(135deg, #22C55E, #16A34A)'
                          : isCurrent
                            ? 'linear-gradient(135deg, #8B5CF6, #6366F1)'
                            : 'rgba(255,255,255,0.06)',
                        color: isCompleted || isCurrent ? 'white' : 'rgba(255,255,255,0.3)',
                        border: !isCompleted && !isCurrent ? '1px solid rgba(255,255,255,0.1)' : 'none',
                      }}
                    >
                      {isCompleted ? <Check size={10} strokeWidth={3} /> : i + 1}
                    </div>
                    <span
                      className="text-[11px] font-medium whitespace-nowrap"
                      style={{
                        color: isCurrent
                          ? 'rgba(139, 92, 246, 1)'
                          : isCompleted
                            ? 'var(--text-secondary)'
                            : 'rgba(255,255,255,0.25)',
                      }}
                    >
                      {s.label}
                    </span>
                  </div>
                  {i < stages.length - 1 && (
                    <div
                      className="w-4 h-px mx-0.5"
                      style={{
                        background: isCompleted
                          ? 'rgba(34, 197, 94, 0.4)'
                          : 'rgba(255,255,255,0.08)',
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={handleReset}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors hover:bg-white/5"
          style={{ color: 'var(--text-muted)' }}
          title="重新开始"
        >
          <RotateCcw size={13} />
          重置
        </button>
      </div>

      {/* ━━━ Mobile Step Bar (shown only on small screens) ━━━ */}
      {stages.length > 0 && (
        <div className="md:hidden flex items-center gap-1 px-4 py-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {stages.map((s, i) => {
            const isCompleted = i < currentStageIndex;
            const isCurrent = i === currentStageIndex;
            return (
              <div key={s.key} className="flex items-center shrink-0">
                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md" style={{
                  background: isCurrent ? 'rgba(139, 92, 246, 0.12)' : 'transparent',
                }}>
                  <div
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold"
                    style={{
                      background: isCompleted ? '#22C55E' : isCurrent ? '#8B5CF6' : 'rgba(255,255,255,0.06)',
                      color: isCompleted || isCurrent ? 'white' : 'rgba(255,255,255,0.3)',
                    }}
                  >
                    {isCompleted ? <Check size={8} strokeWidth={3} /> : i + 1}
                  </div>
                  <span className="text-[10px]" style={{
                    color: isCurrent ? '#8B5CF6' : isCompleted ? 'var(--text-secondary)' : 'rgba(255,255,255,0.2)',
                  }}>
                    {s.label}
                  </span>
                </div>
                {i < stages.length - 1 && <div className="w-3 h-px" style={{ background: 'rgba(255,255,255,0.08)' }} />}
              </div>
            );
          })}
        </div>
      )}

      {/* ━━━ Main Content: Chat + Preview side panel ━━━ */}
      <div className="flex-1 min-h-0 flex gap-3 px-3 pb-3 pt-2">
        {/* Chat Column */}
        <div className="flex-1 min-w-0 flex flex-col">
          <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden' }}>
            {/* Streaming indicator */}
            {(phase === 'connecting' || phase === 'streaming') && (
              <div className="shrink-0 px-4 pt-3">
                <SsePhaseBar phase={phase} message={phaseMessage} />
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" style={{ minHeight: 0 }}>
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  {/* Avatar */}
                  {msg.role !== 'system' && (
                    <div
                      className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5"
                      style={{
                        background: msg.role === 'user'
                          ? 'linear-gradient(135deg, #3B82F6, #2563EB)'
                          : 'linear-gradient(135deg, #8B5CF6, #6366F1)',
                      }}
                    >
                      {msg.role === 'user' ? <User size={13} color="white" /> : <Bot size={13} color="white" />}
                    </div>
                  )}

                  {/* Bubble */}
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'system' ? 'mx-auto text-center' : ''
                    }`}
                    style={
                      msg.role === 'user'
                        ? {
                            background: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(37,99,235,0.1))',
                            color: 'var(--text-primary)',
                            border: '1px solid rgba(59,130,246,0.2)',
                            borderBottomRightRadius: '6px',
                          }
                        : msg.role === 'system'
                          ? {
                              background: 'rgba(34, 197, 94, 0.08)',
                              color: 'rgba(34, 197, 94, 0.9)',
                              border: '1px solid rgba(34, 197, 94, 0.15)',
                            }
                          : {
                              background: 'rgba(255,255,255,0.03)',
                              color: 'var(--text-primary)',
                              border: '1px solid rgba(255,255,255,0.06)',
                              borderBottomLeftRadius: '6px',
                            }
                    }
                  >
                    {msg.content}
                  </div>
                </div>
              ))}

              {/* Streaming indicator dot */}
              {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex gap-3">
                  <div className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
                    style={{ background: 'linear-gradient(135deg, #8B5CF6, #6366F1)' }}>
                    <Bot size={13} color="white" />
                  </div>
                  <div className="rounded-2xl px-4 py-3 flex items-center gap-1.5"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <Loader2 size={14} className="animate-spin" style={{ color: '#8B5CF6' }} />
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>思考中…</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="shrink-0 px-4 pb-4 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={isStreaming ? 'AI 正在思考…' : '描述你想创建的技能，或回答 AI 的问题…'}
                  disabled={isStreaming}
                  rows={1}
                  className="flex-1 resize-none rounded-xl px-4 py-2.5 text-[13px] outline-none transition-all"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    color: 'var(--text-primary)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    maxHeight: '120px',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(139,92,246,0.4)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = 'auto';
                    target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                  className="flex items-center justify-center w-10 h-10 rounded-xl transition-all"
                  style={{
                    background: input.trim() && !isStreaming
                      ? 'linear-gradient(135deg, #8B5CF6, #6366F1)'
                      : 'rgba(255,255,255,0.04)',
                    color: input.trim() && !isStreaming ? 'white' : 'rgba(255,255,255,0.2)',
                    border: '1px solid ' + (input.trim() && !isStreaming ? 'rgba(139,92,246,0.3)' : 'rgba(255,255,255,0.06)'),
                  }}
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </GlassCard>
        </div>

        {/* Right Panel: Skill Preview + Actions (shown when draft exists) */}
        {hasSkillDraft && (
          <div className="hidden lg:flex flex-col gap-3 w-[320px] shrink-0">
            {/* Skill Preview */}
            <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden' }}>
              <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <FileText size={14} style={{ color: '#8B5CF6' }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>SKILL.md 预览</span>
              </div>
              <div className="flex-1 overflow-auto px-4 py-3" style={{ minHeight: 0 }}>
                <pre className="text-[11px] leading-relaxed whitespace-pre-wrap font-mono" style={{ color: 'var(--text-secondary)' }}>
                  {skillPreview}
                </pre>
              </div>
            </GlassCard>

            {/* Export Actions */}
            <GlassCard padding="sm" className="flex flex-col gap-2">
              <button
                onClick={handleSave}
                disabled={saving || saved}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all"
                style={{
                  background: saved
                    ? 'rgba(34, 197, 94, 0.12)'
                    : 'linear-gradient(135deg, #8B5CF6, #6366F1)',
                  color: saved ? 'rgba(34, 197, 94, 0.9)' : 'white',
                  border: saved ? '1px solid rgba(34, 197, 94, 0.2)' : '1px solid rgba(139,92,246,0.3)',
                }}
              >
                {saved ? <CheckCircle2 size={15} /> : <Save size={15} />}
                {saving ? '保存中…' : saved ? '已保存到个人技能' : '保存为个人技能'}
              </button>

              <div className="flex gap-2">
                <button
                  onClick={handleExportMd}
                  disabled={exporting}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium transition-colors hover:bg-white/5"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    color: 'var(--text-secondary)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <FileText size={13} />
                  导出 .md
                </button>
                <button
                  onClick={handleExportZip}
                  disabled={exporting}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium transition-colors hover:bg-white/5"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    color: 'var(--text-secondary)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <Archive size={13} />
                  导出 .zip
                </button>
              </div>
            </GlassCard>
          </div>
        )}
      </div>

      {/* Mobile Export Bar (when draft ready, no side panel) */}
      {hasSkillDraft && (
        <div className="lg:hidden shrink-0 flex items-center gap-2 px-4 pb-3">
          <button
            onClick={handleSave}
            disabled={saving || saved}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium"
            style={{
              background: saved ? 'rgba(34,197,94,0.12)' : 'linear-gradient(135deg, #8B5CF6, #6366F1)',
              color: saved ? 'rgba(34,197,94,0.9)' : 'white',
            }}
          >
            {saved ? <CheckCircle2 size={13} /> : <Save size={13} />}
            {saved ? '已保存' : '保存'}
          </button>
          <button onClick={handleExportMd} disabled={exporting}
            className="flex items-center gap-1 px-3 py-2 rounded-xl text-[12px]"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <FileText size={12} /> .md
          </button>
          <button onClick={handleExportZip} disabled={exporting}
            className="flex items-center gap-1 px-3 py-2 rounded-xl text-[12px]"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <Archive size={12} /> .zip
          </button>
        </div>
      )}
    </div>
  );
}
