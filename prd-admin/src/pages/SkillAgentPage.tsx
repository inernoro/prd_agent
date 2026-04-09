import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSseStream } from '@/lib/useSseStream';
import { GlassCard } from '@/components/design/GlassCard';
import { api } from '@/services/api';
import {
  createSkillAgentSession,
  saveSkillFromAgent,
  exportSkillMd,
  getExportZipUrl,
  deleteSkillAgentSession,
  listPersonalSkills,
  deletePersonalSkill,
  getSkillMd,
  updateSkillFromMd,
  type SkillAgentStage,
  type PersonalSkillItem,
} from '@/services/real/skillAgent';
import { useAuthStore } from '@/stores/authStore';
import { glassBar } from '@/lib/glassStyles';
import {
  Send, Save, FileText, Archive, RotateCcw, Wand2, ArrowLeft, Check,
  Loader2, Bot, User, CheckCircle2, Plus, Trash2, Zap, Play, Copy, ClipboardCheck, ChevronLeft,
} from 'lucide-react';

/** Strip ```json:stage_result ... ``` blocks from display text */
function stripJsonBlocks(text: string): string {
  return text.replace(/```json:stage_result[\s\S]*?```/g, '').trim();
}

// ━━━ Types ━━━━━━━━

type TabKey = 'create' | 'my-skills';

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
      {activeTab === 'create' ? <CreateTab /> : <MySkillsTab onSwitchToCreate={() => setActiveTab('create')} />}
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
    if (!sessionId) return;
    setSaving(true);
    try {
      const res = await saveSkillFromAgent(sessionId);
      if (res.success && res.data) {
        setSaved(true);
        setMessages((prev) => [...prev, { role: 'system', content: res.data.message }]);
      }
    } finally { setSaving(false); }
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
    setSessionId(null); setMessages([]); setStages([]); setCurrentStageIndex(0);
    setSkillPreview(null); setInput(''); setSaved(false);
    resetStream();
    initSession();
  };

  const hasSkillDraft = !!skillPreview;

  return (
    <div className="flex-1 min-h-0 flex gap-3 px-3 pb-3 pt-2">
      {/* Chat Column */}
      <div className="flex-1 min-w-0 flex flex-col">
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
                <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${msg.role === 'system' ? 'mx-auto text-center' : ''}`}
                  style={msg.role === 'user'
                    ? { background: 'rgba(59,130,246,0.12)', color: 'var(--text-primary)', border: '1px solid rgba(59,130,246,0.15)', borderBottomRightRadius: 6 }
                    : msg.role === 'system'
                      ? { background: 'rgba(34,197,94,0.08)', color: 'rgba(34,197,94,0.9)', border: '1px solid rgba(34,197,94,0.12)' }
                      : { background: 'rgba(255,255,255,0.03)', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.06)', borderBottomLeftRadius: 6 }
                  }>
                  {msg.content}
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

      {/* Right Panel: Preview + Actions */}
      {hasSkillDraft && (
        <div className="hidden lg:flex flex-col gap-3 w-[320px] shrink-0">
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
            <button onClick={handleSave} disabled={saving || saved}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all"
              style={{
                background: saved ? 'rgba(34,197,94,0.12)' : 'linear-gradient(135deg,#8B5CF6,#6366F1)',
                color: saved ? 'rgba(34,197,94,0.9)' : 'white',
                border: saved ? '1px solid rgba(34,197,94,0.2)' : '1px solid rgba(139,92,246,0.3)',
              }}>
              {saved ? <CheckCircle2 size={15} /> : <Save size={15} />}
              {saving ? '保存中…' : saved ? '已保存到个人技能' : '保存为个人技能'}
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
        </div>
      )}

      {/* Mobile export bar */}
      {hasSkillDraft && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 flex items-center gap-2 px-4 py-3"
          style={{ background: 'rgba(10,10,14,0.9)', borderTop: '1px solid rgba(255,255,255,0.06)', backdropFilter: 'blur(20px)' }}>
          <button onClick={handleSave} disabled={saving || saved}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium"
            style={{ background: saved ? 'rgba(34,197,94,0.12)' : 'linear-gradient(135deg,#8B5CF6,#6366F1)', color: saved ? 'rgba(34,197,94,0.9)' : 'white' }}>
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

// ━━━ Skill Detail View (left: md editor, right: test) ━━━━━━━━

function SkillDetailView({ skill, onBack, onDelete }: {
  skill: PersonalSkillItem; onBack: () => void; onDelete: () => void;
}) {
  const [mdContent, setMdContent] = useState('');
  const [loadingMd, setLoadingMd] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

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
    // Write both text/plain and text/html to clipboard for rich paste
    const htmlContent = `<pre>${testResult.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([testResult], { type: 'text/plain' }),
        'text/html': new Blob([htmlContent], { type: 'text/html' }),
      }),
    ]);
    setCopied('md'); setTimeout(() => setCopied(null), 1500);
  };

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
        <div className="flex-1" />
        <button onClick={onDelete}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors hover:bg-red-500/10"
          style={{ color: 'rgba(239,68,68,0.7)' }}>
          <Trash2 size={12} /> 删除
        </button>
      </div>

      {/* Main: left editor + right test */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* Left: SKILL.md Editor */}
        <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden' }}>
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

        {/* Right: Test Panel */}
        <div className="flex flex-col gap-3 w-[380px] shrink-0">
          {/* Input */}
          <GlassCard className="flex flex-col" padding="none" style={{ overflow: 'hidden' }}>
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
                {testStreaming ? '生成中…' : '运行测试'}
              </button>
            </div>
          </GlassCard>

          {/* Result */}
          <GlassCard className="flex-1 flex flex-col" padding="none" style={{ overflow: 'hidden', minHeight: 0 }}>
            <div className="shrink-0 px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <Bot size={13} style={{ color: '#22C55E' }} />
              <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>输出结果</span>
              <div className="flex-1" />
              {testResult && (
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
              {testResult ? (
                <pre className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                  {testResult}
                </pre>
              ) : (
                <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  运行测试后结果会显示在这里
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
