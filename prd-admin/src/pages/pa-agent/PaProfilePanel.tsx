/**
 * 我的画像 (My Profile) — 跨会话记忆面板
 *
 * 用户可见 / 可编辑：
 *   - rhythm（工作节奏）
 *   - preferences（称呼 / 毒舌强度）
 *   - memories 列表（按 manual / auto / suggest 三档徽章区分）
 *
 * 操作：
 *   - 手动添加 memory（source=manual）
 *   - 确认 suggest 条目（转为 manual，开始注入）
 *   - 删除任意条目（软删除）
 *
 * 布局走 frontend-modal 三硬约束：inline style 高度 / createPortal / min-h:0。
 */
import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Plus, Trash2, Check, Loader2, Sparkles, ShieldCheck, Eye,
  Brain, Briefcase, FileText, Heart,
} from 'lucide-react';
import {
  getPaProfile, updatePaProfile, addPaMemory, confirmPaMemory, deletePaMemory,
  type PaUserProfile, type PaMemoryEntry, type PaMemoryKind, type PaMemorySource,
  type PaWorkRhythm, type PaUserPreferences,
} from '@/services/real/paAgentService';

interface Props {
  open: boolean;
  onClose: () => void;
}

const KIND_META: Record<PaMemoryKind, { label: string; icon: React.ReactNode; color: string }> = {
  role:       { label: '角色',  icon: <Briefcase size={11} />, color: '#22d3ee' },
  project:    { label: '项目',  icon: <FileText size={11} />,  color: '#f59e0b' },
  fact:       { label: '事实',  icon: <Brain size={11} />,     color: '#a78bfa' },
  preference: { label: '偏好',  icon: <Heart size={11} />,     color: '#ec4899' },
};

const SOURCE_META: Record<PaMemorySource, { label: string; bg: string; fg: string; tooltip: string }> = {
  manual:  { label: '我自己', bg: 'rgba(16,185,129,0.12)',  fg: '#34d399', tooltip: '手动添加 — 最高优先级，立即注入 prompt' },
  auto:    { label: '秘书记的', bg: 'rgba(99,102,241,0.12)',  fg: '#a5b4fc', tooltip: '秘书高置信抽取，已记入并参与下次对话' },
  suggest: { label: '待确认', bg: 'rgba(245,158,11,0.14)',  fg: '#fcd34d', tooltip: '秘书觉得可能但不确定，点确认后才参与对话' },
};

export function PaProfilePanel({ open, onClose }: Props) {
  const [profile, setProfile] = useState<PaUserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingRhythm, setSavingRhythm] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newMemoryText, setNewMemoryText] = useState('');
  const [newMemoryKind, setNewMemoryKind] = useState<PaMemoryKind>('fact');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getPaProfile();
      if (res.success && res.data) setProfile(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const updateRhythm = async (patch: Partial<PaWorkRhythm>) => {
    if (!profile) return;
    setSavingRhythm(true);
    try {
      const next = { ...profile.rhythm, ...patch };
      const res = await updatePaProfile({ rhythm: next });
      if (res.success && res.data) setProfile(res.data);
    } finally {
      setSavingRhythm(false);
    }
  };

  const updatePrefs = async (patch: Partial<PaUserPreferences>) => {
    if (!profile) return;
    setSavingPrefs(true);
    try {
      const next = { ...profile.preferences, ...patch };
      const res = await updatePaProfile({ preferences: next });
      if (res.success && res.data) setProfile(res.data);
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleAdd = async () => {
    const text = newMemoryText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const res = await addPaMemory({ kind: newMemoryKind, text });
      if (res.success && res.data) {
        setNewMemoryText('');
        await load();
      }
    } finally {
      setAdding(false);
    }
  };

  const handleConfirm = async (id: string) => {
    const res = await confirmPaMemory(id);
    if (res.success) await load();
  };

  const handleDelete = async (id: string) => {
    const res = await deletePaMemory(id);
    if (res.success) await load();
  };

  if (!open) return null;

  const activeMemories = (profile?.memories ?? []).filter(m => m.status === 'active');
  const suggestCount = activeMemories.filter(m => m.source === 'suggest').length;

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl shadow-2xl flex flex-col w-full max-w-2xl overflow-hidden"
        style={{
          background: '#0f1014',
          border: '1px solid rgba(255,255,255,0.08)',
          height: '85vh',
          maxHeight: '85vh',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center justify-between px-5 py-3"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg,#f59e0b,#22d3ee)' }}
            >
              <Brain size={14} color="#0b1020" />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                我的画像
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                毒舌秘书会跨会话记得这些事。三档徽章告诉你来源。
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div
          className="flex-1 px-5 py-4"
          style={{
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          {loading || !profile ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={22} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : (
            <div className="space-y-6">
              {/* Rhythm */}
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    工作节奏
                  </h3>
                  {savingRhythm && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--text-muted)' }} />}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <NumberInput
                    label="通常上班 (h)"
                    value={profile.rhythm.typicalStartHour ?? undefined}
                    onChange={v => void updateRhythm({ typicalStartHour: v })}
                    min={0} max={23}
                  />
                  <NumberInput
                    label="通常下班 (h)"
                    value={profile.rhythm.typicalEndHour ?? undefined}
                    onChange={v => void updateRhythm({ typicalEndHour: v })}
                    min={0} max={23}
                  />
                  <ToggleRow
                    label="周末活跃"
                    hint="周末也会接活；周六/周日不要把任务自动下沉到周一"
                    value={profile.rhythm.weekendActive}
                    onChange={v => void updateRhythm({ weekendActive: v })}
                  />
                  <SelectRow
                    label="完美主义倾向"
                    value={profile.rhythm.perfectionismLevel ?? ''}
                    onChange={v => void updateRhythm({ perfectionismLevel: v ? (v as 'low' | 'mid' | 'high') : null })}
                    options={[
                      { value: '', label: '不指定' },
                      { value: 'low', label: '低（不容易拖延）' },
                      { value: 'mid', label: '中（偶尔规划替代行动）' },
                      { value: 'high', label: '高（秘书主动 callout 拖延）' },
                    ]}
                  />
                </div>
              </section>

              {/* Preferences */}
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    个人偏好
                  </h3>
                  {savingPrefs && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--text-muted)' }} />}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <TextInput
                    label="希望被叫"
                    placeholder="留空 = 直呼姓名"
                    value={profile.preferences.preferredAddress ?? ''}
                    onChange={v => void updatePrefs({ preferredAddress: v || null })}
                  />
                  <SelectRow
                    label="毒舌强度"
                    value={profile.preferences.savageLevel}
                    onChange={v => void updatePrefs({ savageLevel: v as 'gentle' | 'default' | 'sharp' })}
                    options={[
                      { value: 'gentle', label: '温和（少毒一点）' },
                      { value: 'default', label: '默认（推荐）' },
                      { value: 'sharp', label: '尖锐（再狠一点）' },
                    ]}
                  />
                </div>
              </section>

              {/* Memories */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    持久事实 · {activeMemories.length}
                    {suggestCount > 0 && (
                      <span className="ml-2 text-[10px] font-normal" style={{ color: '#fcd34d' }}>
                        {suggestCount} 条待确认
                      </span>
                    )}
                  </h3>
                </div>

                {/* Add new */}
                <div
                  className="flex gap-2 mb-3 p-2 rounded-xl"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <select
                    value={newMemoryKind}
                    onChange={e => setNewMemoryKind(e.target.value as PaMemoryKind)}
                    className="text-xs px-2 rounded-lg bg-transparent outline-none"
                    style={{ color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)' }}
                  >
                    {(Object.keys(KIND_META) as PaMemoryKind[]).map(k => (
                      <option key={k} value={k} style={{ background: '#0f1014' }}>
                        {KIND_META[k].label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="例：我负责 IMP 项目（≤ 60 字）"
                    value={newMemoryText}
                    onChange={e => setNewMemoryText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleAdd(); }}
                    maxLength={60}
                    className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-transparent outline-none"
                    style={{ color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                  <button
                    onClick={() => void handleAdd()}
                    disabled={!newMemoryText.trim() || adding}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-all disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg,#f59e0b,#22d3ee)', color: '#0b1020' }}
                  >
                    {adding ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                    添加
                  </button>
                </div>

                {/* List */}
                {activeMemories.length === 0 ? (
                  <div
                    className="text-xs text-center py-8 rounded-xl"
                    style={{
                      color: 'var(--text-muted)',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px dashed rgba(255,255,255,0.08)',
                    }}
                  >
                    还没有记忆。说说你的角色、负责的项目，秘书会自己记下来。
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {activeMemories.map(m => (
                      <MemoryRow
                        key={m.id}
                        entry={m}
                        onConfirm={() => void handleConfirm(m.id)}
                        onDelete={() => void handleDelete(m.id)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// ── 小组件 ──────────────────────────────────────────────────────────────

function MemoryRow({
  entry, onConfirm, onDelete,
}: {
  entry: PaMemoryEntry;
  onConfirm: () => void;
  onDelete: () => void;
}) {
  const kind = KIND_META[entry.kind] ?? KIND_META.fact;
  const src = SOURCE_META[entry.source] ?? SOURCE_META.manual;
  return (
    <li
      className="group flex items-start gap-2 px-3 py-2 rounded-lg"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <span
        className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium"
        style={{ background: `${kind.color}20`, color: kind.color, border: `1px solid ${kind.color}40` }}
      >
        {kind.icon}
        {kind.label}
      </span>
      <span
        className="flex-1 text-xs leading-relaxed"
        style={{ color: 'var(--text-primary)' }}
      >
        {entry.text}
      </span>
      <span
        className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
        style={{ background: src.bg, color: src.fg }}
        title={src.tooltip}
      >
        {entry.source === 'manual' ? <ShieldCheck size={9} />
          : entry.source === 'auto' ? <Sparkles size={9} />
            : <Eye size={9} />}
        {src.label}
      </span>
      {entry.source === 'suggest' && (
        <button
          onClick={onConfirm}
          title="确认 — 记入持久画像，立即生效"
          className="shrink-0 p-1 rounded-md transition-colors opacity-60 group-hover:opacity-100"
          style={{ color: '#34d399' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(16,185,129,0.12)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Check size={12} />
        </button>
      )}
      <button
        onClick={onDelete}
        title="删除"
        className="shrink-0 p-1 rounded-md transition-colors opacity-0 group-hover:opacity-100"
        style={{ color: '#f87171' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.12)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        <Trash2 size={11} />
      </button>
    </li>
  );
}

function NumberInput({
  label, value, onChange, min = 0, max = 23,
}: {
  label: string;
  value?: number;
  onChange: (v: number | null) => void;
  min?: number; max?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        value={value ?? ''}
        onChange={e => {
          const raw = e.target.value;
          if (raw === '') onChange(null);
          else {
            const n = parseInt(raw, 10);
            if (!Number.isNaN(n) && n >= min && n <= max) onChange(n);
          }
        }}
        placeholder="—"
        className="text-sm px-2 py-1.5 rounded-lg bg-transparent outline-none"
        style={{ color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)' }}
      />
    </label>
  );
}

function TextInput({
  label, value, placeholder, onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <input
        type="text"
        value={local}
        placeholder={placeholder}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => { if (local !== value) onChange(local.trim()); }}
        maxLength={20}
        className="text-sm px-2 py-1.5 rounded-lg bg-transparent outline-none"
        style={{ color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)' }}
      />
    </label>
  );
}

function SelectRow({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="text-sm px-2 py-1.5 rounded-lg bg-transparent outline-none"
        style={{ color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)' }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value} style={{ background: '#0f1014' }}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleRow({
  label, hint, value, onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-all"
        style={{
          color: 'var(--text-primary)',
          border: `1px solid ${value ? 'rgba(34,197,94,0.5)' : 'rgba(255,255,255,0.1)'}`,
          background: value ? 'rgba(34,197,94,0.08)' : 'transparent',
        }}
      >
        <span
          className="w-3 h-3 rounded-full transition-all"
          style={{ background: value ? '#22c55e' : 'rgba(255,255,255,0.2)' }}
        />
        <span className="text-xs">{value ? '是' : '否'}</span>
        {hint && <span className="text-[10px] ml-auto truncate" style={{ color: 'var(--text-muted)' }} title={hint}>{hint}</span>}
      </button>
    </div>
  );
}
