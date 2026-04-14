import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSseStream } from '@/lib/useSseStream';
import { GlassCard } from '@/components/design/GlassCard';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { api } from '@/services/api';
import {
  createSkillAgentSession,
  getSkillAgentSession,
  saveSkillFromAgent,
  exportSkillMd,
  getExportZipUrl,
  deleteSkillAgentSession,
  listPersonalSkills,
  deletePersonalSkill,
  getSkillMd,
  getSkillZipUrl,
  updateSkillFromMd,
  listPlazaSkills,
  publishSkill,
  unpublishSkill,
  type SkillAgentStage,
  type PersonalSkillItem,
  type PlazaSkillItem,
} from '@/services/real/skillAgent';
import { useAuthStore } from '@/stores/authStore';
import { resolveAvatarUrl } from '@/lib/avatar';
import { glassBar } from '@/lib/glassStyles';
import {
  Send, Save, FileText, Archive, RotateCcw, Wand2, ArrowLeft, Check,
  Loader2, Bot, User, CheckCircle2, Plus, Trash2, Zap, Play, Copy, ClipboardCheck, ChevronLeft,
  Globe, Search, Share2, EyeOff,
} from 'lucide-react';

/** Strip ```json:stage_result ... ``` blocks from display text */
function stripJsonBlocks(text: string): string {
  return text.replace(/```json:stage_result[\s\S]*?```/g, '').trim();
}

// ━━━ Types ━━━━━━━━

type TabKey = 'create' | 'my-skills' | 'plaza';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ━━━ Page Component ━━━━━━━━

export default function SkillAgentPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabKey>('create');

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* ━━━ Top Header ━━━ */}
      <Header activeTab={activeTab} onTabChange={setActiveTab} onBack={() => navigate(-1)} />

      {/* ━━━ Tab Content ━━━ */}
      {activeTab === 'create' && <CreateTab />}
      {activeTab === 'my-skills' && <MySkillsTab onSwitchToCreate={() => setActiveTab('create')} />}
      {activeTab === 'plaza' && <PlazaTab />}
    </div>
  );
}

// ━━━ Header ━━━━━━━━

function Header({ activeTab, onTabChange, onBack }: {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  onBack: () => void;
}) {
  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'create', label: '创建技能', icon: <Plus size={13} /> },
    { key: 'my-skills', label: '我的技能', icon: <Zap size={13} /> },
    { key: 'plaza', label: '技能广场', icon: <Globe size={13} /> },
  ];

  return (
    <div
      className="shrink-0 px-4 py-2.5 flex items-center gap-3 rounded-2xl mx-3 mt-3"
      style={{ ...glassBar, borderRadius: '16px' }}
    >
      <button
        onClick={onBack}
        className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/5"
        style={{ color: 'var(--text-secondary)' }}
      >
        <ArrowLeft size={18} />
      </button>

      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, #8B5CF6, #6366F1)' }}>
          <Wand2 size={14} color="white" />
        </div>
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          技能创建助手
        </span>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 ml-4 p-0.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all"
              style={{
                background: active ? 'rgba(139, 92, 246, 0.15)' : 'transparent',
                color: active ? '#C4B5FD' : 'rgba(255,255,255,0.4)',
                border: active ? '1px solid rgba(139, 92, 246, 0.2)' : '1px solid transparent',
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />
    </div>
  );
}

// ━━━ Create Tab ━━━━━━━━

function CreateTab() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stages, setStages] = useState<SkillAgentStage[]>([]);
  const [currentStageIndex, setCurrentStageIndex] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [skillPreview, setSkillPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState(false);
  /** 会话中是否至少保存成功过一次（用于区分首次 vs 再次保存文案）。handleAdjust 不重置 */
  const [hasSavedOnce, setHasSavedOnce] = useState(false);
  // Auto-test state
  const [autoTestInput, setAutoTestInput] = useState<string | null>(null);
  const [autoTestResult, setAutoTestResult] = useState('');
  const [autoTestPhase, setAutoTestPhase] = useState<string | null>(null);
  const [descOptimized, setDescOptimized] = useState<{ oldDescription: string; newDescription: string; score: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    typing, isStreaming,
    start: startStream, reset: resetStream,
  } = useSseStream({
    url: '',
    method: 'POST',
    onEvent: {
      stage_advance: (raw: unknown) => {
        const d = raw as { stageIndex?: number };
        if (typeof d.stageIndex === 'number') setCurrentStageIndex(d.stageIndex);
      },
      stage_complete: (raw: unknown) => {
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

  // Auto-test SSE stream (separate from chat)
  const { typing: testTyping, isStreaming: testStreaming, start: startAutoTest } = useSseStream({
    url: '',
    method: 'POST',
    onEvent: {
      phase: (raw: unknown) => {
        const d = raw as { message?: string };
        if (d.message) setAutoTestPhase(d.message);
      },
      test_input: (raw: unknown) => {
        const d = raw as { input?: string };
        if (d.input) setAutoTestInput(d.input);
      },
      desc_optimized: (raw: unknown) => {
        const d = raw as { oldDescription?: string; newDescription?: string; score?: number };
        if (d.newDescription) setDescOptimized({ oldDescription: d.oldDescription ?? '', newDescription: d.newDescription, score: d.score ?? 0 });
      },
    },
  });

  // Accumulate auto-test typing
  useEffect(() => { if (testTyping) setAutoTestResult(testTyping); }, [testTyping]);

  // Accumulate typing into the last assistant message, filtering out JSON blocks
  useEffect(() => {
    if (!typing) return;
    const clean = stripJsonBlocks(typing);
    if (!clean) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, content: clean }];
      }
      return [...prev, { role: 'assistant', content: clean }];
    });
  }, [typing]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  useEffect(() => {
    initSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** sessionStorage key：按 `.claude/rules/no-localstorage.md`，不用 localStorage */
  const SESSION_STORAGE_KEY = 'skill-agent:sessionId';

  /**
   * 会话初始化：先尝试从 sessionStorage 恢复上次会话（刷新 / 重启 / 2h 后回来都能续上）；
   * 失败（会话过期或被清理）则回退到新建。
   */
  const initSession = async () => {
    const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      try {
        const res = await getSkillAgentSession(stored);
        if (res.success && res.data) {
          setSessionId(res.data.sessionId);
          if (res.data.stages) setStages(res.data.stages);
          setCurrentStageIndex(res.data.stageIndex);
          setMessages(res.data.messages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })));
          if (res.data.skillPreview) setSkillPreview(res.data.skillPreview);
          if (res.data.hasSavedOnce) setHasSavedOnce(true);
          setTimeout(() => inputRef.current?.focus(), 200);
          return;
        }
      } catch {
        // 任何异常 → 丢弃旧 sessionId 新建
      }
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }

    const res = await createSkillAgentSession();
    if (res.success && res.data) {
      setSessionId(res.data.sessionId);
      setStages(res.data.stages);
      setCurrentStageIndex(res.data.stageIndex);
      setMessages([{ role: 'assistant', content: res.data.welcome.message }]);
      sessionStorage.setItem(SESSION_STORAGE_KEY, res.data.sessionId);
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  };

  const handleSend = useCallback(async () => {
    if (!sessionId || !input.trim() || isStreaming) return;
    const userMsg = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    resetStream();
    await startStream({
      url: api.skillAgent.sendMessage(sessionId),
      body: { message: userMsg },
    });
  }, [sessionId, input, isStreaming, startStream, resetStream]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleSave = async () => {
    if (!sessionId || saving) return;
    setSaving(true);
    try {
      const res = await saveSkillFromAgent(sessionId);
      if (res.success && res.data) {
        setSaved(true);
        setHasSavedOnce(true);
        setMessages((prev) => [...prev, { role: 'system', content: res.data.message + '\n\n正在自动试跑效果…' }]);
        // Reset auto-test state (both first-save and re-save share this path)
        setAutoTestInput(null);
        setAutoTestResult('');
        setAutoTestPhase('准备试跑…');
        setDescOptimized(null);
        await startAutoTest({ url: api.skillAgent.autoTest(sessionId) });
      } else {
        // 失败兜底：不再静默，明确告诉用户原因
        const errMsg = res.error?.message ?? '未知错误';
        setMessages((prev) => [...prev, {
          role: 'system',
          content: `保存失败：${errMsg}。请稍后重试或点击"重置"开新会话。`,
        }]);
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: 'system',
        content: `保存异常：${err instanceof Error ? err.message : String(err)}`,
      }]);
    } finally {
      setSaving(false);
    }
  };

  const handleAdjust = () => {
    setSaved(false);
    setAutoTestInput(null);
    setAutoTestResult('');
    setAutoTestPhase(null);
    setDescOptimized(null);
    setMessages((prev) => [...prev, { role: 'system', content: '请告诉我哪里需要调整，我会重新生成。' }]);
    setTimeout(() => inputRef.current?.focus(), 200);
  };

  const handleExportMd = async () => {
    if (!sessionId) return;
    setExporting(true);
    try {
      const res = await exportSkillMd(sessionId);
      if (res.success && res.data) {
        const blob = new Blob([res.data.skillMd], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = res.data.fileName; a.click();
        URL.revokeObjectURL(url);
      }
    } finally { setExporting(false); }
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
        const a = document.createElement('a'); a.href = url; a.download = 'skill.zip'; a.click();
        URL.revokeObjectURL(url);
      }
    } finally { setExporting(false); }
  };

  const handleReset = async () => {
    if (sessionId) deleteSkillAgentSession(sessionId);
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    setSessionId(null); setMessages([]); setStages([]); setCurrentStageIndex(0);
    setSkillPreview(null); setInput(''); setSaved(false); setHasSavedOnce(false);
    setAutoTestInput(null); setAutoTestResult(''); setAutoTestPhase(null); setDescOptimized(null);
    resetStream();
    initSession();
  };

  const hasSkillDraft = !!skillPreview;

  return (
    <div className="flex-1 min-h-0 flex gap-3 px-3 pb-3 pt-2">
      {/* Chat Column — flex:6 (与"测试技能"页面同构) */}
      <div
        className="flex flex-col"
        style={hasSkillDraft ? { flex: '6 6 0%', minWidth: 0 } : { flex: '1 1 0%', minWidth: 0 }}
      >
        <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden' }}>
          {/* Stage progress (compact) */}
          {stages.length > 0 && (
            <div className="shrink-0 flex items-center gap-0.5 px-4 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              {stages.map((s, i) => {
                const done = i < currentStageIndex;
                const current = i === currentStageIndex;
                return (
                  <div key={s.key} className="flex items-center">
                    <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md" style={{
                      background: current ? 'rgba(139,92,246,0.12)' : 'transparent',
                    }}>
                      <div className="w-4.5 h-4.5 rounded-full flex items-center justify-center text-[9px] font-bold"
                        style={{
                          width: 18, height: 18,
                          background: done ? '#22C55E' : current ? '#8B5CF6' : 'rgba(255,255,255,0.06)',
                          color: done || current ? 'white' : 'rgba(255,255,255,0.25)',
                        }}>
                        {done ? <Check size={9} strokeWidth={3} /> : i + 1}
                      </div>
                      <span className="text-[11px] font-medium hidden sm:inline" style={{
                        color: current ? '#C4B5FD' : done ? 'var(--text-secondary)' : 'rgba(255,255,255,0.2)',
                      }}>{s.label}</span>
                    </div>
                    {i < stages.length - 1 && (
                      <div className="w-3 h-px mx-0.5" style={{ background: done ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.06)' }} />
                    )}
                  </div>
                );
              })}
              <div className="flex-1" />
              <button onClick={handleReset}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors hover:bg-white/5"
                style={{ color: 'var(--text-muted)' }}>
                <RotateCcw size={11} /> 重置
              </button>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" style={{ minHeight: 0 }}>
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                {msg.role !== 'system' && (
                  <div className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center mt-0.5"
                    style={{ background: msg.role === 'user' ? 'linear-gradient(135deg,#3B82F6,#2563EB)' : 'linear-gradient(135deg,#8B5CF6,#6366F1)' }}>
                    {msg.role === 'user' ? <User size={11} color="white" /> : <Bot size={11} color="white" />}
                  </div>
                )}
                <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${msg.role === 'system' ? 'mx-auto text-center' : ''}`}
                  style={msg.role === 'user'
                    ? { background: 'rgba(59,130,246,0.12)', color: 'var(--text-primary)', border: '1px solid rgba(59,130,246,0.15)', borderBottomRightRadius: 6 }
                    : msg.role === 'system'
                      ? { background: 'rgba(34,197,94,0.08)', color: 'rgba(34,197,94,0.9)', border: '1px solid rgba(34,197,94,0.12)' }
                      : { background: 'rgba(255,255,255,0.03)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.06)', borderBottomLeftRadius: 6 }
                  }>
                  {msg.role === 'assistant' ? (
                    <MarkdownContent content={msg.content} className="text-[13px] leading-relaxed" />
                  ) : (
                    <span className="text-[13px] leading-relaxed whitespace-pre-wrap">{msg.content}</span>
                  )}
                </div>
              </div>
            ))}

            {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="flex gap-2.5">
                <div className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center"
                  style={{ background: 'linear-gradient(135deg,#8B5CF6,#6366F1)' }}>
                  <Bot size={11} color="white" />
                </div>
                <div className="rounded-2xl px-3.5 py-2.5 flex items-center gap-1.5"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <Loader2 size={13} className="animate-spin" style={{ color: '#8B5CF6' }} />
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>思考中…</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 px-4 pb-3 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-end gap-2">
              <textarea ref={inputRef} value={input}
                onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder={isStreaming ? 'AI 正在生成…' : '描述你想创建的技能…'}
                disabled={isStreaming} rows={1}
                className="flex-1 resize-none rounded-xl px-4 py-2.5 text-[13px] outline-none transition-all"
                style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.08)', maxHeight: 120 }}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(139,92,246,0.4)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                onInput={(e) => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 120)}px`; }}
              />
              <button onClick={handleSend} disabled={!input.trim() || isStreaming}
                className="flex items-center justify-center w-10 h-10 rounded-xl transition-all"
                style={{
                  background: input.trim() && !isStreaming ? 'linear-gradient(135deg,#8B5CF6,#6366F1)' : 'rgba(255,255,255,0.04)',
                  color: input.trim() && !isStreaming ? 'white' : 'rgba(255,255,255,0.2)',
                  border: '1px solid ' + (input.trim() && !isStreaming ? 'rgba(139,92,246,0.3)' : 'rgba(255,255,255,0.06)'),
                }}>
                <Send size={16} />
              </button>
            </div>
          </div>
        </GlassCard>
      </div>

      {/* Right Panel: Preview / Auto-test results — flex:4 (与"测试技能"右栏同宽) */}
      {hasSkillDraft && (
        <div
          className="hidden lg:flex flex-col gap-3"
          style={{ flex: '4 4 0%', minWidth: 0 }}
        >
          {/* Auto-test results (shown after save) */}
          {saved && (autoTestPhase || autoTestInput || autoTestResult || testStreaming) ? (
            <>
              {/* Test Input */}
              <GlassCard className="flex flex-col shrink-0" padding="none" style={{ overflow: 'hidden' }}>
                <div className="px-4 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <Play size={12} style={{ color: '#F59E0B' }} />
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>自动测试输入</span>
                  {!autoTestInput && autoTestPhase && (
                    <span className="flex items-center gap-1 text-[10px]" style={{ color: '#8B5CF6' }}>
                      <Loader2 size={10} className="animate-spin" /> {autoTestPhase}
                    </span>
                  )}
                </div>
                {autoTestInput && (
                  <div className="px-4 py-2.5 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)', maxHeight: 120, overflowY: 'auto' }}>
                    {autoTestInput}
                  </div>
                )}
              </GlassCard>

              {/* Test Output */}
              <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden', minHeight: 0 }}>
                <div className="px-4 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <Bot size={12} style={{ color: '#22C55E' }} />
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>效果预览</span>
                  {testStreaming && (
                    <span className="flex items-center gap-1 text-[10px]" style={{ color: '#8B5CF6' }}>
                      <Loader2 size={10} className="animate-spin" /> 生成中
                    </span>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto px-4 py-2.5" style={{ minHeight: 0 }}>
                  {autoTestResult ? (
                    <div>
                      <MarkdownContent content={autoTestResult} className="text-[12px] leading-relaxed" />
                      {testStreaming && <span className="inline-block w-[2px] h-[13px] ml-0.5 animate-pulse" style={{ background: '#8B5CF6', verticalAlign: 'text-bottom' }} />}
                    </div>
                  ) : autoTestInput ? (
                    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 size={12} className="animate-spin" style={{ color: '#8B5CF6' }} /> 正在试跑技能…
                    </div>
                  ) : null}
                </div>
              </GlassCard>

              {/* Description optimization result */}
              {descOptimized && (
                <GlassCard padding="sm" className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 size={12} style={{ color: '#22C55E' }} />
                    <span className="text-[11px] font-semibold" style={{ color: '#22C55E' }}>描述已自动优化</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md ml-auto" style={{ background: 'rgba(34,197,94,0.1)', color: '#22C55E' }}>
                      匹配率 {descOptimized.score}%
                    </span>
                  </div>
                  {descOptimized.oldDescription !== descOptimized.newDescription && (
                    <div className="text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      <span style={{ textDecoration: 'line-through', opacity: 0.5 }}>{descOptimized.oldDescription}</span>
                      <br />→ {descOptimized.newDescription}
                    </div>
                  )}
                </GlassCard>
              )}

              {/* Feedback buttons */}
              {!testStreaming && autoTestResult && (
                <GlassCard padding="sm" className="flex flex-col gap-2">
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>效果满意吗？</div>
                  <button onClick={() => setMessages((prev) => [...prev, { role: 'system', content: '技能创建完成！你可以在「我的技能」中管理和使用。' }])}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium"
                    style={{ background: 'rgba(34,197,94,0.1)', color: '#22C55E', border: '1px solid rgba(34,197,94,0.15)' }}>
                    <CheckCircle2 size={13} /> 满意，完成
                  </button>
                  <button onClick={handleAdjust}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium"
                    style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.15)' }}>
                    <RotateCcw size={13} /> 需要调整
                  </button>
                </GlassCard>
              )}
            </>
          ) : (
            /* Pre-save: SKILL.md preview + save/export buttons */
            <>
              <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden' }}>
                <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <FileText size={13} style={{ color: '#8B5CF6' }} />
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>SKILL.md 预览</span>
                </div>
                <div className="flex-1 overflow-auto px-4 py-3" style={{ minHeight: 0 }}>
                  <pre className="text-[11px] leading-relaxed whitespace-pre-wrap font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {skillPreview}
                  </pre>
                </div>
              </GlassCard>

              <GlassCard padding="sm" className="flex flex-col gap-2">
                <button onClick={handleSave} disabled={saving}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all"
                  style={{ background: 'linear-gradient(135deg,#8B5CF6,#6366F1)', color: 'white', border: '1px solid rgba(139,92,246,0.3)' }}>
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {saving
                    ? (hasSavedOnce ? '更新并试跑…' : '保存并试跑…')
                    : (hasSavedOnce ? '更新并重新试跑' : '保存并试跑效果')}
                </button>
                <div className="flex gap-2">
                  <button onClick={handleExportMd} disabled={exporting}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium transition-colors hover:bg-white/5"
                    style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <FileText size={13} /> 导出 .md
                  </button>
                  <button onClick={handleExportZip} disabled={exporting}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium transition-colors hover:bg-white/5"
                    style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <Archive size={13} /> 导出 .zip
                  </button>
                </div>
              </GlassCard>
            </>
          )}
        </div>
      )}

      {/* Mobile export bar */}
      {hasSkillDraft && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 flex items-center gap-2 px-4 py-3"
          style={{ background: 'rgba(10,10,14,0.9)', borderTop: '1px solid rgba(255,255,255,0.06)', backdropFilter: 'blur(20px)' }}>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium"
            style={{ background: 'linear-gradient(135deg,#8B5CF6,#6366F1)', color: 'white' }}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? '保存中…' : (hasSavedOnce ? '重新保存' : '保存')}
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

// ━━━ My Skills Tab ━━━━━━━━

function MySkillsTab({ onSwitchToCreate }: { onSwitchToCreate: () => void }) {
  const [skills, setSkills] = useState<PersonalSkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<PersonalSkillItem | null>(null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listPersonalSkills();
      if (res.success && res.data) {
        // API returns { skills: [...] }, extract the array and filter personal only
        const raw = res.data as unknown as { skills?: PersonalSkillItem[] };
        const all = Array.isArray(raw.skills) ? raw.skills : Array.isArray(res.data) ? res.data : [];
        const personal = all.filter((s) => s.visibility === 'personal');
        setSkills(personal);
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const handleDelete = async (skillKey: string) => {
    setDeleting(skillKey);
    try {
      const res = await deletePersonalSkill(skillKey);
      if (res.success) {
        setSkills((prev) => prev.filter((s) => s.skillKey !== skillKey));
      }
    } finally { setDeleting(null); }
  };

  const CATEGORY_COLORS: Record<string, string> = {
    analysis: '#3B82F6', generation: '#8B5CF6', extraction: '#F59E0B',
    translation: '#06B6D4', summary: '#10B981', check: '#F97316',
    optimization: '#EC4899', general: '#6366F1', other: '#64748B',
  };

  // Detail view: selected skill
  if (selectedSkill) {
    return (
      <SkillDetailView
        skill={selectedSkill}
        onBack={() => { setSelectedSkill(null); loadSkills(); }}
        onDelete={() => { handleDelete(selectedSkill.skillKey); setSelectedSkill(null); }}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin" style={{ color: '#8B5CF6' }} />
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.15)' }}>
          <Zap size={28} style={{ color: '#8B5CF6' }} />
        </div>
        <div className="text-center">
          <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>还没有个人技能</div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>用 AI 助手创建你的第一个技能吧</div>
        </div>
        <button onClick={onSwitchToCreate}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium"
          style={{ background: 'linear-gradient(135deg,#8B5CF6,#6366F1)', color: 'white' }}>
          <Plus size={14} /> 创建技能
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 pt-2">
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {skills.map((skill) => {
          const accent = CATEGORY_COLORS[skill.category] ?? '#6366F1';
          return (
            <GlassCard key={skill.skillKey} padding="none" interactive className="group cursor-pointer"
              onClick={() => setSelectedSkill(skill)}>
              <div className="px-4 py-3.5">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-lg"
                    style={{ background: `${accent}15`, border: `1px solid ${accent}25` }}>
                    {skill.icon || '⚡'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{skill.title}</div>
                    <div className="text-[11px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{skill.description || '暂无描述'}</div>
                  </div>
                  <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(skill.skillKey); }}
                      disabled={deleting === skill.skillKey}
                      className="p-1.5 rounded-lg transition-colors hover:bg-red-500/10"
                      style={{ color: 'rgba(239,68,68,0.7)' }} title="删除">
                      {deleting === skill.skillKey ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium"
                    style={{ background: `${accent}15`, color: accent, border: `1px solid ${accent}20` }}>{skill.category}</span>
                  {skill.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-md"
                      style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.06)' }}>{tag}</span>
                  ))}
                  {skill.usageCount > 0 && (
                    <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{skill.usageCount} 次使用</span>
                  )}
                </div>
              </div>
            </GlassCard>
          );
        })}
      </div>
    </div>
  );
}

// ━━━ Skill Detail View (left: md editor 6, right: test 4) ━━━━━━━━

function SkillDetailView({ skill, onBack, onDelete }: {
  skill: PersonalSkillItem; onBack: () => void; onDelete: () => void;
}) {
  const [mdContent, setMdContent] = useState('');
  const [loadingMd, setLoadingMd] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [isPublic, setIsPublic] = useState(skill.isPublic ?? false);
  const [publishing, setPublishing] = useState(false);
  /** 发布/取消发布操作的提示（成功 or 失败），2.5s 后自动消失 */
  const [publishMsg, setPublishMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  /** 复制 MD / 下载 zip 状态（与 PlazaSkillDetailView 同构，1.8s 自动复位） */
  const [mdCopyState, setMdCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
  const [zipState, setZipState] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle');

  const handleTogglePublish = async () => {
    if (publishing) return;
    setPublishing(true);
    setPublishMsg(null);
    try {
      if (isPublic) {
        const res = await unpublishSkill(skill.skillKey);
        if (res.success) {
          setIsPublic(false);
          setPublishMsg({ type: 'ok', text: '已从广场取消发布' });
        } else {
          setPublishMsg({ type: 'err', text: `取消发布失败：${res.error?.message ?? '未知错误'}` });
        }
      } else {
        const res = await publishSkill(skill.skillKey);
        if (res.success) {
          setIsPublic(true);
          setPublishMsg({ type: 'ok', text: '已发布到技能广场' });
        } else {
          setPublishMsg({ type: 'err', text: `发布失败：${res.error?.message ?? '未知错误'}` });
        }
      }
    } catch (err) {
      setPublishMsg({ type: 'err', text: `操作异常：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setPublishing(false);
      setTimeout(() => setPublishMsg(null), 2500);
    }
  };

  // Test state
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState('');
  const [copied, setCopied] = useState<'text' | 'md' | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const { typing: testTyping, isStreaming: testStreaming, start: startTest, reset: resetTest } = useSseStream({
    url: '',
    method: 'POST',
  });

  useEffect(() => { if (testTyping) setTestResult(testTyping); }, [testTyping]);
  useEffect(() => { resultRef.current?.scrollTo({ top: resultRef.current.scrollHeight, behavior: 'smooth' }); }, [testResult]);

  // Load SKILL.md
  useEffect(() => {
    (async () => {
      setLoadingMd(true);
      const res = await getSkillMd(skill.skillKey);
      if (res.success && res.data) setMdContent(res.data.skillMd);
      setLoadingMd(false);
    })();
  }, [skill.skillKey]);

  /** 复制当前 SKILL.md 文本到剪贴板。优先用内存里已加载的 mdContent，保证用户若在编辑器里做过修改也能拷到未保存版本 */
  const handleCopySkillMd = async () => {
    if (mdCopyState === 'ok') return;
    try {
      let text = mdContent;
      if (!text) {
        const res = await getSkillMd(skill.skillKey);
        if (res.success && res.data) text = res.data.skillMd;
      }
      if (!text) { setMdCopyState('err'); return; }
      await navigator.clipboard.writeText(text);
      setMdCopyState('ok');
    } catch {
      setMdCopyState('err');
    } finally {
      setTimeout(() => setMdCopyState('idle'), 1800);
    }
  };

  /** 下载技能 zip（SKILL.md + README.md + examples/），带 Authorization */
  const handleDownloadZip = async () => {
    if (zipState === 'loading') return;
    setZipState('loading');
    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(getSkillZipUrl(skill.skillKey), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { setZipState('err'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${skill.skillKey}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setZipState('ok');
    } catch {
      setZipState('err');
    } finally {
      setTimeout(() => setZipState('idle'), 1800);
    }
  };

  const handleSave = async () => {
    setSaving(true); setSaveMsg(null);
    const res = await updateSkillFromMd(skill.skillKey, mdContent);
    if (res.success) { setSaveMsg('已保存'); setDirty(false); setTimeout(() => setSaveMsg(null), 2000); }
    else { setSaveMsg('保存失败'); }
    setSaving(false);
  };

  const handleTest = async () => {
    if (testStreaming) return;
    setTestResult(''); resetTest();
    await startTest({ url: api.skillAgent.testSkill(skill.skillKey), body: { userInput: testInput } });
  };

  const handleCopyText = async () => {
    await navigator.clipboard.writeText(testResult);
    setCopied('text'); setTimeout(() => setCopied(null), 1500);
  };

  const handleCopyMd = async () => {
    const htmlContent = `<pre>${testResult.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([testResult], { type: 'text/plain' }),
        'text/html': new Blob([htmlContent], { type: 'text/html' }),
      }),
    ]);
    setCopied('md'); setTimeout(() => setCopied(null), 1500);
  };

  const showResult = testResult || testStreaming;

  return (
    <div className="flex-1 min-h-0 flex flex-col px-3 pb-3 pt-2">
      {/* Breadcrumb */}
      <div className="shrink-0 flex items-center gap-2 mb-2">
        <button onClick={onBack}
          className="flex items-center gap-1 text-[12px] font-medium px-2 py-1 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: 'var(--text-muted)' }}>
          <ChevronLeft size={14} /> 返回列表
        </button>
        <span className="text-lg">{skill.icon || '⚡'}</span>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{skill.title}</span>
        <span className="text-[11px] px-1.5 py-0.5 rounded-md" style={{ background: 'rgba(139,92,246,0.1)', color: '#8B5CF6' }}>{skill.category}</span>
        {isPublic && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{ background: 'rgba(34,197,94,0.1)', color: '#22C55E' }}>已发布到广场</span>
        )}
        <div className="flex-1" />
        {publishMsg && (
          <span
            className="text-[11px] px-2 py-0.5 rounded-md transition-opacity"
            style={{
              background: publishMsg.type === 'ok' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
              color: publishMsg.type === 'ok' ? '#22C55E' : '#EF4444',
              border: `1px solid ${publishMsg.type === 'ok' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
            }}
          >
            {publishMsg.type === 'ok' ? <CheckCircle2 size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-2px' }} /> : null}
            {publishMsg.text}
          </span>
        )}
        {/* 复制 MD / 下载 zip：与 PlazaSkillDetailView breadcrumb 同构，操作破坏性由低到高 */}
        <button onClick={handleCopySkillMd} disabled={mdCopyState === 'ok'}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: mdCopyState === 'ok' ? '#22C55E' : mdCopyState === 'err' ? '#EF4444' : '#8B5CF6' }}>
          {mdCopyState === 'ok' ? <ClipboardCheck size={12} /> : <Copy size={12} />}
          {mdCopyState === 'ok' ? '已复制' : mdCopyState === 'err' ? '复制失败' : '复制 MD'}
        </button>
        <button onClick={handleDownloadZip} disabled={zipState === 'loading'}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: zipState === 'ok' ? '#22C55E' : zipState === 'err' ? '#EF4444' : 'var(--text-secondary)' }}>
          {zipState === 'loading' ? <Loader2 size={12} className="animate-spin" />
            : zipState === 'ok' ? <CheckCircle2 size={12} />
            : <Archive size={12} />}
          {zipState === 'loading' ? '下载中…' : zipState === 'ok' ? '已下载' : zipState === 'err' ? '下载失败' : '下载 .zip'}
        </button>
        <button onClick={handleTogglePublish} disabled={publishing}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: isPublic ? '#F59E0B' : '#8B5CF6' }}>
          {publishing ? <Loader2 size={12} className="animate-spin" /> : isPublic ? <EyeOff size={12} /> : <Share2 size={12} />}
          {isPublic ? '取消发布' : '发布到广场'}
        </button>
        <button onClick={onDelete}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors hover:bg-red-500/10"
          style={{ color: 'rgba(239,68,68,0.7)' }}>
          <Trash2 size={12} /> 删除
        </button>
      </div>

      {/* Main: left editor (flex:6) + right test (flex:4) */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* Left: SKILL.md Editor — flex:6 */}
        <GlassCard className="flex flex-col" padding="none" style={{ overflow: 'hidden', flex: '6 6 0%', minWidth: 0 }}>
          <div className="shrink-0 flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <FileText size={13} style={{ color: '#8B5CF6' }} />
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>SKILL.md</span>
            {dirty && <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B' }}>未保存</span>}
            <div className="flex-1" />
            {saveMsg && (
              <span className="text-[11px] flex items-center gap-1" style={{ color: saveMsg === '已保存' ? '#22C55E' : '#EF4444' }}>
                {saveMsg === '已保存' && <CheckCircle2 size={12} />} {saveMsg}
              </span>
            )}
            <button onClick={handleSave} disabled={saving || !dirty}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
              style={{
                background: dirty ? 'linear-gradient(135deg,#8B5CF6,#6366F1)' : 'rgba(255,255,255,0.04)',
                color: dirty ? 'white' : 'rgba(255,255,255,0.3)',
              }}>
              <Save size={11} /> {saving ? '保存中…' : '保存'}
            </button>
          </div>
          <div className="flex-1 min-h-0">
            {loadingMd ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="animate-spin" style={{ color: '#8B5CF6' }} />
              </div>
            ) : (
              <textarea
                value={mdContent}
                onChange={(e) => { setMdContent(e.target.value); setDirty(true); }}
                className="w-full h-full resize-none px-4 py-3 text-[12px] leading-relaxed font-mono outline-none"
                style={{ background: 'transparent', color: 'var(--text-primary)', border: 'none' }}
                spellCheck={false}
              />
            )}
          </div>
        </GlassCard>

        {/* Right: Test Panel — flex:4 */}
        <div className="flex flex-col gap-3" style={{ flex: '4 4 0%', minWidth: 0 }}>
          {/* Input area */}
          <GlassCard className="flex flex-col shrink-0" padding="none" style={{ overflow: 'hidden' }}>
            <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <Play size={13} style={{ color: '#8B5CF6' }} />
              <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>测试输入</span>
            </div>
            <div className="p-3">
              <textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="输入要处理的内容…"
                rows={4}
                className="w-full resize-none rounded-xl px-3 py-2.5 text-[13px] outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.08)' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(139,92,246,0.4)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
              />
              <button onClick={handleTest} disabled={testStreaming}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium transition-all"
                style={{
                  background: testStreaming ? 'rgba(139,92,246,0.15)' : 'linear-gradient(135deg,#8B5CF6,#6366F1)',
                  color: testStreaming ? '#C4B5FD' : 'white',
                }}>
                {testStreaming ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {testStreaming ? '正在生成…' : '运行测试'}
              </button>
            </div>
          </GlassCard>

          {/* Result area — fills remaining space */}
          <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden', minHeight: 0 }}>
            <div className="shrink-0 px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <Bot size={13} style={{ color: '#22C55E' }} />
              <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>输出结果</span>
              {testStreaming && (
                <span className="flex items-center gap-1 text-[10px]" style={{ color: '#8B5CF6' }}>
                  <Loader2 size={10} className="animate-spin" /> 生成中
                </span>
              )}
              <div className="flex-1" />
              {testResult && !testStreaming && (
                <div className="flex items-center gap-1">
                  <button onClick={handleCopyText}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors hover:bg-white/5"
                    style={{ color: copied === 'text' ? '#22C55E' : 'var(--text-muted)' }}>
                    {copied === 'text' ? <ClipboardCheck size={11} /> : <Copy size={11} />} 复制文本
                  </button>
                  <button onClick={handleCopyMd}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors hover:bg-white/5"
                    style={{ color: copied === 'md' ? '#22C55E' : 'var(--text-muted)' }}>
                    {copied === 'md' ? <ClipboardCheck size={11} /> : <Copy size={11} />} 复制 Markdown
                  </button>
                </div>
              )}
            </div>
            <div ref={resultRef} className="flex-1 overflow-y-auto px-4 py-3" style={{ minHeight: 0 }}>
              {showResult ? (
                <div>
                  <MarkdownContent content={testResult} className="text-[13px] leading-relaxed" />
                  {testStreaming && <span className="inline-block w-[2px] h-[14px] ml-0.5 animate-pulse" style={{ background: '#8B5CF6', verticalAlign: 'text-bottom' }} />}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-2">
                  <Bot size={24} style={{ color: 'rgba(255,255,255,0.08)' }} />
                  <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    输入内容后点击运行，结果将实时显示
                  </span>
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

// ━━━ Plaza Tab ━━━━━━━━

function PlazaTab() {
  const [skills, setSkills] = useState<PlazaSkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [testingSkill, setTestingSkill] = useState<PlazaSkillItem | null>(null);

  const load = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const res = await listPlazaSkills({ search: query });
      if (res.success && res.data) setSkills(res.data.items || []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    load(search);
  };

  const CATEGORY_COLORS: Record<string, string> = {
    analysis: '#3B82F6', generation: '#8B5CF6', extraction: '#F59E0B',
    translation: '#06B6D4', summary: '#10B981', check: '#F97316',
    optimization: '#EC4899', general: '#6366F1', other: '#64748B',
  };

  if (testingSkill) {
    return <PlazaSkillDetailView skill={testingSkill} onBack={() => setTestingSkill(null)} />;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col px-3 pb-3 pt-2">
      {/* Search bar */}
      <form onSubmit={handleSearch} className="shrink-0 flex items-center gap-2 mb-3">
        <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索技能名称、描述或标签…"
            className="flex-1 bg-transparent outline-none text-[13px]"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>
        <button type="submit"
          className="px-4 py-2 rounded-xl text-[12px] font-medium"
          style={{ background: 'linear-gradient(135deg,#8B5CF6,#6366F1)', color: 'white' }}>
          搜索
        </button>
      </form>

      {/* List */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin" style={{ color: '#8B5CF6' }} />
        </div>
      ) : skills.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Globe size={28} style={{ color: 'rgba(255,255,255,0.1)' }} />
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {search ? '没有找到匹配的技能' : '广场还没有任何技能'}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {skills.map((skill) => {
              const accent = CATEGORY_COLORS[skill.category] ?? '#6366F1';
              return (
                <GlassCard key={skill.skillKey} padding="none" interactive
                  className="group cursor-pointer" onClick={() => setTestingSkill(skill)}>
                  <div className="px-4 py-3.5">
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-lg"
                        style={{ background: `${accent}15`, border: `1px solid ${accent}25` }}>
                        {skill.icon || '⚡'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {skill.title}
                        </div>
                        <div className="text-[11px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                          {skill.description || '暂无描述'}
                        </div>
                      </div>
                    </div>

                    {/* Meta: author + tags + usage */}
                    <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium"
                        style={{ background: `${accent}15`, color: accent, border: `1px solid ${accent}20` }}>
                        {skill.category}
                      </span>
                      {skill.tags.slice(0, 2).map((tag) => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-md"
                          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center gap-2 mt-2.5 pt-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                      <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {skill.authorAvatar ? (
                          <img src={resolveAvatarUrl({ avatarFileName: skill.authorAvatar })} alt="" className="w-4 h-4 rounded-full" />
                        ) : (
                          <User size={10} />
                        )}
                        {skill.authorName || '匿名'}
                      </div>
                      <div className="flex-1" />
                      {skill.usageCount > 0 && (
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {skill.usageCount} 次使用
                        </span>
                      )}
                    </div>
                  </div>
                </GlassCard>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ━━━ Plaza Skill Detail (read-only test view) ━━━━━━━━

function PlazaSkillDetailView({ skill, onBack }: { skill: PlazaSkillItem; onBack: () => void }) {
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState('');
  const [copied, setCopied] = useState<'text' | 'md' | null>(null);
  /** 广场导出：MD 复制状态 + ZIP 下载状态，采用与 MySkillDetailView 一致的图标切换反馈 */
  const [mdCopyState, setMdCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
  const [zipState, setZipState] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle');

  const { typing: testTyping, isStreaming: testStreaming, start: startTest, reset: resetTest } = useSseStream({
    url: '', method: 'POST',
  });

  useEffect(() => { if (testTyping) setTestResult(testTyping); }, [testTyping]);

  const handleTest = async () => {
    if (testStreaming) return;
    setTestResult(''); resetTest();
    await startTest({ url: api.skillAgent.testSkill(skill.skillKey), body: { userInput: testInput } });
  };

  const handleCopyText = async () => {
    await navigator.clipboard.writeText(testResult);
    setCopied('text'); setTimeout(() => setCopied(null), 1500);
  };

  /** 复制 SKILL.md 到剪贴板。后端端点 GetSkillMd 已允许 IsPublic=true 的广场访问 */
  const handleCopyMd = async () => {
    if (mdCopyState === 'ok') return;
    try {
      const res = await getSkillMd(skill.skillKey);
      if (res.success && res.data) {
        await navigator.clipboard.writeText(res.data.skillMd);
        setMdCopyState('ok');
      } else {
        setMdCopyState('err');
      }
    } catch {
      setMdCopyState('err');
    } finally {
      setTimeout(() => setMdCopyState('idle'), 1800);
    }
  };

  /** 下载技能 zip。与 CreateTab.handleExportZip 同模式：手动 fetch 带 Authorization */
  const handleDownloadZip = async () => {
    if (zipState === 'loading') return;
    setZipState('loading');
    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(getSkillZipUrl(skill.skillKey), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { setZipState('err'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${skill.skillKey}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setZipState('ok');
    } catch {
      setZipState('err');
    } finally {
      setTimeout(() => setZipState('idle'), 1800);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col px-3 pb-3 pt-2">
      {/* Breadcrumb */}
      <div className="shrink-0 flex items-center gap-2 mb-2">
        <button onClick={onBack}
          className="flex items-center gap-1 text-[12px] font-medium px-2 py-1 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: 'var(--text-muted)' }}>
          <ChevronLeft size={14} /> 返回广场
        </button>
        <span className="text-lg">{skill.icon || '⚡'}</span>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{skill.title}</span>
        <span className="text-[11px] px-1.5 py-0.5 rounded-md" style={{ background: 'rgba(139,92,246,0.1)', color: '#8B5CF6' }}>{skill.category}</span>
        <div className="flex-1" />
        <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {skill.authorAvatar ? <img src={resolveAvatarUrl({ avatarFileName: skill.authorAvatar })} alt="" className="w-4 h-4 rounded-full" /> : <User size={11} />}
          {skill.authorName || '匿名'}
        </span>
        {/* 复制 MD / 下载 zip：与 MySkillDetailView breadcrumb 按钮风格一致（小图标 + 短文案） */}
        <button onClick={handleCopyMd} disabled={mdCopyState === 'ok'}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: mdCopyState === 'ok' ? '#22C55E' : mdCopyState === 'err' ? '#EF4444' : '#8B5CF6' }}>
          {mdCopyState === 'ok' ? <ClipboardCheck size={12} /> : <Copy size={12} />}
          {mdCopyState === 'ok' ? '已复制' : mdCopyState === 'err' ? '复制失败' : '复制 MD'}
        </button>
        <button onClick={handleDownloadZip} disabled={zipState === 'loading'}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: zipState === 'ok' ? '#22C55E' : zipState === 'err' ? '#EF4444' : 'var(--text-secondary)' }}>
          {zipState === 'loading' ? <Loader2 size={12} className="animate-spin" />
            : zipState === 'ok' ? <CheckCircle2 size={12} />
            : <Archive size={12} />}
          {zipState === 'loading' ? '下载中…' : zipState === 'ok' ? '已下载' : zipState === 'err' ? '下载失败' : '下载 .zip'}
        </button>
      </div>

      {/* Main */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* Left: skill info */}
        <GlassCard className="flex flex-col" padding="none" style={{ overflow: 'hidden', flex: '6 6 0%', minWidth: 0 }}>
          <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <FileText size={13} style={{ color: '#8B5CF6' }} />
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>技能详情</span>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div>
              <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>描述</div>
              <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                {skill.description || '暂无描述'}
              </div>
            </div>
            {skill.tags.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>标签</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {skill.tags.map((tag) => (
                    <span key={tag} className="text-[11px] px-2 py-0.5 rounded-md"
                      style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.06)' }}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>作者</div>
              <div className="flex items-center gap-2">
                {skill.authorAvatar ? <img src={resolveAvatarUrl({ avatarFileName: skill.authorAvatar })} alt="" className="w-6 h-6 rounded-full" /> : <User size={16} />}
                <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{skill.authorName || '匿名'}</span>
              </div>
            </div>
            {skill.usageCount > 0 && (
              <div>
                <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>使用次数</div>
                <div className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{skill.usageCount} 次</div>
              </div>
            )}
          </div>
        </GlassCard>

        {/* Right: test panel */}
        <div className="flex flex-col gap-3" style={{ flex: '4 4 0%', minWidth: 0 }}>
          <GlassCard className="flex flex-col shrink-0" padding="none" style={{ overflow: 'hidden' }}>
            <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <Play size={13} style={{ color: '#8B5CF6' }} />
              <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>试用</span>
            </div>
            <div className="p-3">
              <textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="输入要处理的内容…"
                rows={4}
                className="w-full resize-none rounded-xl px-3 py-2.5 text-[13px] outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.08)' }}
              />
              <button onClick={handleTest} disabled={testStreaming}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium transition-all"
                style={{
                  background: testStreaming ? 'rgba(139,92,246,0.15)' : 'linear-gradient(135deg,#8B5CF6,#6366F1)',
                  color: testStreaming ? '#C4B5FD' : 'white',
                }}>
                {testStreaming ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {testStreaming ? '正在生成…' : '运行试用'}
              </button>
            </div>
          </GlassCard>

          <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden', minHeight: 0 }}>
            <div className="shrink-0 px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <Bot size={13} style={{ color: '#22C55E' }} />
              <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>输出结果</span>
              <div className="flex-1" />
              {testResult && !testStreaming && (
                <button onClick={handleCopyText}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors hover:bg-white/5"
                  style={{ color: copied === 'text' ? '#22C55E' : 'var(--text-muted)' }}>
                  {copied === 'text' ? <ClipboardCheck size={11} /> : <Copy size={11} />} 复制
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3" style={{ minHeight: 0 }}>
              {(testResult || testStreaming) ? (
                <div>
                  <MarkdownContent content={testResult} className="text-[13px] leading-relaxed" />
                  {testStreaming && <span className="inline-block w-[2px] h-[14px] ml-0.5 animate-pulse" style={{ background: '#8B5CF6', verticalAlign: 'text-bottom' }} />}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-2">
                  <Bot size={24} style={{ color: 'rgba(255,255,255,0.08)' }} />
                  <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    输入内容后点击运行
                  </span>
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
