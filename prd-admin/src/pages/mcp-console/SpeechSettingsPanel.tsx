import { useState } from 'react';
import { Plus, Save, Settings2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { saveSpeechSettings } from '@/services/real/mcpSpeech';
import type { SpeechProfile, SpeechSettings } from '@/services/contracts/mcpSpeech';
import { toast } from '@/lib/toast';

export const speechInputClass = 'w-full min-w-0 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-inset';
export const speechInputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' };
export const speechCardStyle = { background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' };

const PROTOCOL_LABELS: Record<string, string> = { openai: 'OpenAI 语音接口', 'doubao-tts': '豆包语音合成' };

function newProfile(): SpeechProfile {
  return { id: crypto.randomUUID().replaceAll('-', ''), name: '', protocol: 'openai', model: '', modelPoolId: '', revision: 0, enabled: false, available: false, isDefault: false, maxTextChars: 2000, voices: [], formats: ['mp3'], supportsInstructions: false, supportsEmotion: false, emotions: [], minSpeed: 1, maxSpeed: 1, defaultVoiceId: '', defaultFormat: 'mp3', dailyCharacterQuota: 20000, maxConcurrentRuns: 2 };
}

export function SpeechSettingsPanel({ settings, onSaved }: { settings: SpeechSettings; onSaved: () => Promise<void> }) {
  const [profiles, setProfiles] = useState(settings.profiles);
  const [saving, setSaving] = useState(false);
  const patch = (id: string, values: Partial<SpeechProfile>) => setProfiles(items => items.map(profile => profile.id === id ? { ...profile, ...values } : profile));
  const save = async () => {
    setSaving(true);
    try {
      const res = await saveSpeechSettings({ revision: settings.revision, profiles });
      if (!res.success) { toast.error(res.error?.message || '配置未保存，请检查后重试。'); return; }
      toast.success('当前环境的语音配置已保存');
      await onSaved();
    } catch { toast.error('保存中断，请刷新确认配置后再试。'); }
    finally { setSaving(false); }
  };
  return <section className="rounded-xl border p-4" style={speechCardStyle}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-sm font-semibold"><Settings2 size={16} aria-hidden />当前环境配置</h2><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{settings.environment} · 配置版本 {settings.revision}</span></div>
    <p className="my-3 text-xs leading-6" style={{ color: 'var(--text-muted)' }}>服务地址和凭据由模型网关管理。这里将已授权的语音模型池与实际支持的音色、参数绑定；配置只作用于当前环境。请先配置可用音色，再启用能力。</p>
    <div className="flex flex-col gap-3">{profiles.map(profile => <details key={profile.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)' }} open={!profile.name}>
      <summary className="cursor-pointer text-sm font-medium">{profile.name || '新语音能力'}<span className="ml-3 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>{PROTOCOL_LABELS[profile.protocol] ?? profile.protocol} · {profile.enabled ? '已启用' : '未启用'}</span></summary>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SettingsField label="能力名称"><input className={speechInputClass} style={speechInputStyle} value={profile.name} onChange={event => patch(profile.id, { name: event.target.value })} placeholder="例如：中文解说" /></SettingsField>
        <SettingsField label="上游协议"><select className={speechInputClass} style={speechInputStyle} value={profile.protocol} onChange={event => patch(profile.id, { protocol: event.target.value })}>{Object.entries(PROTOCOL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></SettingsField>
        <SettingsField label="模型网关中的语音模型池"><select className={speechInputClass} style={speechInputStyle} value={profile.modelPoolId} onChange={event => patch(profile.id, { modelPoolId: event.target.value })}><option value="">请选择已配置的模型池</option>{!(settings.modelPools ?? []).some(pool => pool.id === profile.modelPoolId) && profile.modelPoolId && <option value={profile.modelPoolId}>{profile.modelPoolId}（当前目录不可用）</option>}{(settings.modelPools ?? []).map(pool => <option value={pool.id} key={pool.id}>{pool.name}</option>)}</select></SettingsField>
        <SettingsField label="输出格式（逗号分隔）"><ListInput value={profile.formats} onChange={formats => patch(profile.id, { formats })} /></SettingsField>
        <SettingsField label="默认音色"><select className={speechInputClass} style={speechInputStyle} value={profile.defaultVoiceId} onChange={event => patch(profile.id, { defaultVoiceId: event.target.value })}><option value="">请选择音色</option>{profile.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name || voice.id}</option>)}</select></SettingsField>
        <SettingsField label="默认输出格式"><select className={speechInputClass} style={speechInputStyle} value={profile.defaultFormat} onChange={event => patch(profile.id, { defaultFormat: event.target.value })}><option value="">请选择格式</option>{profile.formats.map(format => <option key={format}>{format}</option>)}</select></SettingsField>
        <SettingsField label="单次文字上限"><NumberInput value={profile.maxTextChars} min={1} onChange={maxTextChars => patch(profile.id, { maxTextChars })} /></SettingsField>
        <SettingsField label="每用户每日字符额度"><NumberInput value={profile.dailyCharacterQuota} min={1} onChange={dailyCharacterQuota => patch(profile.id, { dailyCharacterQuota })} /></SettingsField>
        <SettingsField label="最小语速"><NumberInput value={profile.minSpeed} min={0.01} step={0.1} onChange={minSpeed => patch(profile.id, { minSpeed })} /></SettingsField>
        <SettingsField label="最大语速"><NumberInput value={profile.maxSpeed} min={0.01} step={0.1} onChange={maxSpeed => patch(profile.id, { maxSpeed })} /></SettingsField>
        <SettingsField label="每用户同时生成数"><NumberInput value={profile.maxConcurrentRuns} min={1} onChange={maxConcurrentRuns => patch(profile.id, { maxConcurrentRuns })} /></SettingsField>
        <SettingsField label="支持的情绪（逗号分隔）"><ListInput value={profile.emotions} onChange={emotions => patch(profile.id, { emotions })} /></SettingsField>
      </div>
      <div className="mt-4 flex flex-wrap gap-4 text-xs">{([
        ['enabled', '启用能力'], ['isDefault', '作为默认能力'], ['supportsInstructions', '支持声音指令'], ['supportsEmotion', '支持情绪参数'],
      ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={profile[key]} onChange={event => patch(profile.id, { [key]: event.target.checked })} />{label}</label>)}</div>
      <div className="mt-4 flex items-center justify-between"><h3 className="text-xs font-semibold">可用音色</h3><Button size="sm" onClick={() => patch(profile.id, { voices: [...profile.voices, { id: '', name: '', languages: [] }] })}><Plus size={12} aria-hidden />添加音色</Button></div>
      {profile.voices.map((voice, index) => <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-3" key={index} style={{ borderColor: 'var(--border-subtle)' }}>
        <SettingsField label={`音色 ${index + 1} 标识`}><input className={speechInputClass} style={speechInputStyle} value={voice.id} onChange={event => patch(profile.id, { voices: profile.voices.map((item, n) => n === index ? { ...item, id: event.target.value } : item) })} /></SettingsField>
        <SettingsField label="显示名称"><input className={speechInputClass} style={speechInputStyle} value={voice.name} onChange={event => patch(profile.id, { voices: profile.voices.map((item, n) => n === index ? { ...item, name: event.target.value } : item) })} /></SettingsField>
        <SettingsField label="语言（逗号分隔）"><ListInput value={voice.languages} onChange={languages => patch(profile.id, { voices: profile.voices.map((item, n) => n === index ? { ...item, languages } : item) })} /></SettingsField>
        <Button size="sm" onClick={() => patch(profile.id, { voices: profile.voices.filter((_, n) => n !== index) })}>移除此音色</Button>
      </div>)}
      {!profile.voices.length && <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>请按此上游账号实际开通的资源添加音色，音色名称不会自动跨上游转换。</p>}
    </details>)}</div>
    <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" onClick={() => setProfiles(items => [...items, newProfile()])}><Plus size={14} aria-hidden />添加语音能力</Button><Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>{saving ? <MapSpinner size={14} /> : <Save size={14} aria-hidden />}{saving ? '正在保存' : '保存当前环境配置'}</Button></div>
  </section>;
}

function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs"><span style={{ color: 'var(--text-secondary)' }}>{label}</span>{children}</label>;
}
function NumberInput({ value, onChange, min, step = 1 }: { value: number; onChange: (value: number) => void; min: number; step?: number }) {
  return <input type="number" className={speechInputClass} style={speechInputStyle} value={Number.isFinite(value) ? value : ''} min={min} step={step} onChange={event => onChange(event.target.valueAsNumber)} />;
}
function ListInput({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  return <input className={speechInputClass} style={speechInputStyle} value={text} onChange={event => { setText(event.target.value); onChange([...new Set(event.target.value.split(/[,，]/).map(item => item.trim()).filter(Boolean))]); }} />;
}
