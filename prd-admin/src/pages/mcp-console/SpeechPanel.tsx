import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Check, Clock3, Headphones, Plus, RefreshCw, Save, Volume2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { AudioAssetPlayer } from '@/components/assets/AudioAssetPlayer';
import { generateSpeech, getSpeechCapabilities, getSpeechRun, getSpeechSettings, listSpeechPresets, listSpeechRuns, saveSpeechPreset } from '@/services/real/mcpSpeech';
import type { SpeechCapabilities, SpeechPreset, SpeechRun, SpeechSettings } from '@/services/contracts/mcpSpeech';
import { toast } from '@/lib/toast';
import { EMPTY_SPEECH_DRAFT, applySpeechPreset, isSpeechRunActive, repeatSpeechRun, selectSpeechProfile, speechDraftIssue, speechRunRequest } from './speechForm';
import { SpeechSettingsPanel, speechCardStyle, speechInputClass, speechInputStyle } from './SpeechSettingsPanel';

const RUN_STATUS: Record<string, { label: string; icon: typeof Check; color: string }> = {
  queued: { label: '排队中', icon: Clock3, color: 'var(--text-secondary)' },
  preparing: { label: '准备生成', icon: Clock3, color: 'var(--text-secondary)' },
  generating: { label: '正在生成', icon: Volume2, color: 'var(--accent-primary)' },
  saving: { label: '正在保存', icon: Save, color: 'var(--accent-primary)' },
  completed: { label: '已完成', icon: Check, color: 'var(--semantic-success-text)' },
  failed: { label: '生成失败', icon: AlertTriangle, color: 'var(--semantic-error-text)' },
  unknown: { label: '结果待核查', icon: AlertTriangle, color: 'var(--semantic-warning-text)' },
};

export function SpeechPanel({ refreshToken }: { refreshToken: number }) {
  const [searchParams] = useSearchParams();
  const focusedRunId = searchParams.get('run') || '';
  const [capabilities, setCapabilities] = useState<SpeechCapabilities | null>(null);
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  const [presets, setPresets] = useState<SpeechPreset[]>([]);
  const [runs, setRuns] = useState<SpeechRun[]>([]);
  const [focusedRun, setFocusedRun] = useState<SpeechRun | null>(null);
  const [focusedRunError, setFocusedRunError] = useState('');
  const [draft, setDraft] = useState(EMPTY_SPEECH_DRAFT);
  const [presetName, setPresetName] = useState('');
  const [presetId, setPresetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [presetError, setPresetError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const generation = useRef(0);
  const submitIdentity = useRef<{ payload: string; key: string } | null>(null);
  const invalidate = useCallback(() => { generation.current++; }, []);

  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    setRefreshing(true);
    try {
      const [capsRes, runsRes, presetsRes, settingsRes, focusedRes] = await Promise.all([getSpeechCapabilities(), listSpeechRuns(), listSpeechPresets(), getSpeechSettings(), focusedRunId ? getSpeechRun(focusedRunId) : Promise.resolve(null)]);
      if (gen !== generation.current) return;
      if (capsRes.success && capsRes.data) {
        setCapabilities(capsRes.data);
        setError('');
        setDraft(current => {
          if (current.profileId) return current;
          const initial = capsRes.data.profiles.find(profile => profile.isDefault);
          return initial ? selectSpeechProfile(current, initial) : current;
        });
      } else setError(capsRes.error?.message || '语音能力暂时无法加载，请刷新重试。');
      if (runsRes.success && runsRes.data) { setRuns(runsRes.data.items); setHistoryError(''); }
      else setHistoryError(runsRes.error?.message || '历史暂时无法刷新，当前保留上次结果。');
      if (focusedRes?.success) { setFocusedRun(focusedRes.data); setFocusedRunError(''); }
      else { setFocusedRun(null); setFocusedRunError(focusedRes?.error?.message || ''); }
      if (presetsRes.success && presetsRes.data) { setPresets(presetsRes.data.items); setPresetError(''); }
      else setPresetError(presetsRes.error?.message || '声音预设暂时无法加载。');
      if (settingsRes.success && settingsRes.data) { setSettings(settingsRes.data); setSettingsError(''); }
      else setSettingsError(settingsRes.error?.message || '环境配置暂时无法加载。');
    } catch {
      if (gen === generation.current) setError('连接中断，请检查网络后刷新。已有语音任务会继续执行。');
    } finally {
      if (gen === generation.current) { setLoading(false); setRefreshing(false); }
    }
  }, [focusedRunId]);
  useEffect(() => { void refresh(); return invalidate; }, [refresh, refreshToken, invalidate]);

  const visibleRuns = focusedRun && !runs.some(run => run.id === focusedRun.id) ? [focusedRun, ...runs] : runs;
  const hasActiveRuns = visibleRuns.some(isSpeechRunActive);
  useEffect(() => {
    if (!hasActiveRuns) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const gen = generation.current;
        const [result, focusedRes] = await Promise.all([listSpeechRuns(), focusedRunId ? getSpeechRun(focusedRunId) : Promise.resolve(null)]);
        if (disposed) return;
        if (gen !== generation.current) { timer = setTimeout(() => void poll(), 4000); return; }
        if (result.success && result.data) { setRuns(result.data.items); setHistoryError(''); }
        else setHistoryError(result.error?.message || '进度刷新失败，后台任务仍会继续。');
        if (focusedRes?.success) setFocusedRun(focusedRes.data);
      } catch { if (!disposed) setHistoryError('进度连接中断，后台任务仍会继续。'); }
      if (!disposed) timer = setTimeout(() => void poll(), 4000);
    };
    timer = setTimeout(() => void poll(), 4000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [hasActiveRuns, focusedRunId]);
  const loadedFocusId = focusedRun?.id;
  useEffect(() => {
    if (loadedFocusId) document.getElementById(`speech-run-${loadedFocusId}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [loadedFocusId]);

  const profile = capabilities?.profiles.find(item => item.id === draft.profileId);
  const selectedPreset = presets.find(item => item.id === presetId);
  const issue = speechDraftIssue(draft, profile);
  const generate = async () => {
    if (!profile || issue) { toast.error(issue || '请先选择可用的语音能力。'); return; }
    // An ambiguous submit can be retried with the same identity; editing the form starts a new request.
    const payload = JSON.stringify(speechRunRequest(draft, profile, ''));
    if (submitIdentity.current?.payload !== payload) submitIdentity.current = { payload, key: crypto.randomUUID() };
    setSubmitting(true);
    try {
      const result = await generateSpeech(speechRunRequest(draft, profile, submitIdentity.current.key));
      if (!result.success) { toast.error(result.error?.message || '任务未提交，请检查配置后重试。'); return; }
      submitIdentity.current = null;
      toast.success('语音任务已提交，可在下方历史查看进度');
      await refresh();
    } catch { toast.error('提交结果暂未确认，请先刷新历史；直接重试同一内容不会重复提交。'); }
    finally { setSubmitting(false); }
  };
  const savePreset = async () => {
    if (!profile || !presetName.trim()) { toast.error('请为声音预设填写名称，并选择语音能力。'); return; }
    const configIssue = speechDraftIssue({ ...draft, text: '声音预设' }, profile);
    if (configIssue) { toast.error(configIssue); return; }
    setSavingPreset(true);
    try {
      const result = await saveSpeechPreset({ id: selectedPreset?.id, revision: selectedPreset?.revision, name: presetName.trim(), profileId: profile.id, profileRevision: profile.revision, voiceId: draft.voiceId, format: draft.format, speed: draft.speed, instructions: draft.instructions.trim() || undefined, emotion: draft.emotion || undefined });
      if (!result.success) { toast.error(result.error?.message || '预设未保存，请重试。'); return; }
      toast.success('声音预设已保存');
      setPresetId(result.data.id);
      await refresh();
    } catch { toast.error('保存中断，请刷新确认预设后再试。'); }
    finally { setSavingPreset(false); }
  };

  if (loading) return <div className="flex min-h-0 flex-1 items-center justify-center"><MapSectionLoader text="正在读取当前环境的语音能力" /></div>;
  return <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-3" style={{ overscrollBehavior: 'contain' }}>
    <div className="flex flex-wrap items-center gap-3"><div className="flex-1"><h2 className="flex items-center gap-2 text-base font-semibold"><Headphones size={18} aria-hidden />文生语音</h2><p className="mt-1 text-xs leading-6" style={{ color: 'var(--text-muted)' }}>按原文朗读，成品自动保存到我的资产。当前环境：{capabilities?.environment || '暂未读取'}</p></div><Button size="sm" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? <MapSpinner size={14} /> : <RefreshCw size={14} aria-hidden />}刷新</Button><Link to="/my-assets?tab=audio" className="mcp-button">我的音频资产<ArrowRight size={13} aria-hidden /></Link></div>
    {error && <SpeechAlert>{error}</SpeechAlert>}
    {!capabilities?.profiles.length ? <div className="mcp-empty"><Volume2 size={30} aria-hidden /><h3>当前环境尚未配置语音能力</h3><p>{settings?.canManage ? '在下方添加语音能力，并绑定模型网关中的语音模型池和实际可用音色。' : '请联系管理员配置语音模型与音色。已有历史和音频资产仍可查阅。'}</p></div> : <section className="rounded-xl border p-4" style={speechCardStyle}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <Field label="需要朗读的文字"><textarea rows={9} className={`${speechInputClass} resize-y`} style={speechInputStyle} value={draft.text} onChange={event => setDraft(current => ({ ...current, text: event.target.value }))} placeholder="粘贴讲稿、产品介绍或希望朗读的文字。生成时保留原文。" /></Field>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><span>{Array.from(draft.text).length} 字{profile ? ` / 单次最多 ${profile.maxTextChars} 字` : ''}</span><span>单次生成，不自动改写</span></div>
          <Field label="成品名称（可选）"><input className={speechInputClass} style={speechInputStyle} value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} placeholder="例如：新品介绍旁白" /></Field>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {presetError && <SpeechAlert>{presetError}</SpeechAlert>}
          <Field label="我的声音预设"><select className={speechInputClass} style={speechInputStyle} value={presetId} onChange={event => { const selected = presets.find(item => item.id === event.target.value); setPresetId(event.target.value); setPresetName(selected?.name ?? ''); if (selected) setDraft(current => applySpeechPreset(current, selected)); }}><option value="">自定义声音配置</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></Field>
          <Field label="语音能力"><select className={speechInputClass} style={speechInputStyle} value={draft.profileId} onChange={event => { const selected = capabilities.profiles.find(item => item.id === event.target.value); setPresetId(''); setDraft(current => selected ? selectSpeechProfile(current, selected) : { ...current, profileId: '', profileRevision: undefined, voiceId: '', format: '', instructions: '', emotion: '' }); }}><option value="">请选择语音能力</option>{!profile && draft.profileId && <option value={draft.profileId}>原语音能力已不可用</option>}{capabilities.profiles.map(item => <option key={item.id} value={item.id}>{item.name}{!item.available ? '（暂不可用）' : ''}</option>)}</select></Field>
          {profile && <>
            {!profile.available && <SpeechAlert>{profile.unavailableReason || '此能力暂不可用，请联系管理员检查配置。'}</SpeechAlert>}
            {draft.profileRevision !== undefined && draft.profileRevision !== profile.revision && <div className="flex flex-wrap items-center gap-2"><span className="text-xs" style={{ color: 'var(--semantic-warning-text)' }}>原声音配置已更新，需重新确认音色。</span><Button size="sm" onClick={() => { setDraft(current => selectSpeechProfile(current, profile)); setPresetId(''); }}>载入最新声音配置</Button></div>}
            <div className="grid grid-cols-2 gap-3"><Field label="音色"><select className={speechInputClass} style={speechInputStyle} value={draft.voiceId} onChange={event => setDraft(current => ({ ...current, voiceId: event.target.value }))}>{!profile.voices.some(voice => voice.id === draft.voiceId) && <option value={draft.voiceId}>请选择可用音色</option>}{profile.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}{voice.languages?.length ? ` · ${voice.languages.join(' / ')}` : ''}</option>)}</select></Field><Field label="输出格式"><select className={speechInputClass} style={speechInputStyle} value={draft.format} onChange={event => setDraft(current => ({ ...current, format: event.target.value }))}>{!profile.formats.includes(draft.format) && <option value={draft.format}>请选择输出格式</option>}{profile.formats.map(format => <option key={format}>{format}</option>)}</select></Field></div>
            {profile.voices.find(voice => voice.id === draft.voiceId)?.previewUrl && <audio controls preload="none" className="w-full" src={profile.voices.find(voice => voice.id === draft.voiceId)?.previewUrl} aria-label="音色试听" />}
            <Field label={`语速（${profile.minSpeed}–${profile.maxSpeed}）`}><input type="number" min={profile.minSpeed} max={profile.maxSpeed} step={0.1} className={speechInputClass} style={speechInputStyle} value={Number.isFinite(draft.speed) ? draft.speed : ''} onChange={event => setDraft(current => ({ ...current, speed: event.target.valueAsNumber }))} /></Field>
            {profile.supportsInstructions && <Field label="声音指令（可选）"><textarea rows={2} className={speechInputClass} style={speechInputStyle} value={draft.instructions} onChange={event => setDraft(current => ({ ...current, instructions: event.target.value }))} placeholder="描述此能力支持的朗读方式" /></Field>}
            {profile.supportsEmotion && <Field label="情绪（可选）"><select className={speechInputClass} style={speechInputStyle} value={draft.emotion} onChange={event => setDraft(current => ({ ...current, emotion: event.target.value }))}><option value="">上游默认</option>{profile.emotions.map(emotion => <option key={emotion}>{emotion}</option>)}</select></Field>}
          </>}
          <div className="flex flex-wrap gap-2"><input aria-label="声音预设名称" className={`${speechInputClass} flex-1`} style={speechInputStyle} value={presetName} onChange={event => setPresetName(event.target.value)} placeholder="为这组声音配置命名" /><Button size="sm" disabled={savingPreset || !profile} onClick={() => void savePreset()}>{savingPreset ? <MapSpinner size={14} /> : <Save size={14} aria-hidden />}{selectedPreset ? '更新预设' : '保存预设'}</Button>{selectedPreset && <Button size="sm" onClick={() => { setPresetId(''); setPresetName(''); }}><Plus size={12} aria-hidden />另存为</Button>}</div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3"><Button variant="primary" size="sm" disabled={submitting || !!issue} onClick={() => void generate()}>{submitting ? <MapSpinner size={14} /> : <Volume2 size={14} aria-hidden />}{submitting ? '正在提交语音任务' : '生成并保存语音'}</Button><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{issue || '任务在后台执行，关闭客户端也会继续。'}</span></div>
    </section>}
    <section className="rounded-xl border p-4" style={speechCardStyle}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Clock3 size={16} aria-hidden />最近的语音任务</h2>
      {historyError && <SpeechAlert>{historyError}</SpeechAlert>}
      {focusedRunError && <SpeechAlert>{focusedRunError}</SpeechAlert>}
      {!visibleRuns.length && !historyError && !focusedRunError && <p className="py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>还没有语音任务。可在上方生成，也可以让已授权的 MCP 客户端为你生成。</p>}
      <div className="flex flex-col gap-3">{visibleRuns.map(run => <SpeechRunCard key={run.id} run={run} focused={run.id === focusedRunId} onRepeat={() => { setDraft(repeatSpeechRun(run)); setPresetId(''); }} />)}</div>
    </section>
    {settingsError && <SpeechAlert>{settingsError}</SpeechAlert>}
    {settings?.canManage && <><Button size="sm" className="self-start" onClick={() => setShowSettings(value => !value)}>{showSettings ? '收起环境配置' : '管理当前环境的语音能力'}</Button>{showSettings && <SpeechSettingsPanel key={settings.revision} settings={settings} onSaved={refresh} />}</>}
  </div>;
}

function SpeechRunCard({ run, focused, onRepeat }: { run: SpeechRun; focused: boolean; onRepeat: () => void }) {
  const status = RUN_STATUS[run.status] ?? { label: run.stage || run.status, icon: Clock3, color: 'var(--text-muted)' };
  const Icon = status.icon;
  const active = isSpeechRunActive(run);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(run.createdAt)) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active, run.createdAt]);
  return <article id={`speech-run-${run.id}`} className="rounded-lg border p-3" style={{ borderColor: focused ? 'var(--accent-primary)' : 'var(--border-subtle)' }}>
    <div className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 flex-1 break-words text-sm font-medium">{run.title || '语音生成'}</h3><span className="inline-flex items-center gap-1.5 text-xs" style={{ color: status.color }}>{active ? <MapSpinner size={12} /> : <Icon size={12} aria-hidden />}{status.label}{active ? ` · 已等待 ${elapsed} 秒` : ''}</span><RelativeTime value={run.createdAt} className="text-xs" /></div>
    <p className="mt-2 break-words text-xs" style={{ color: 'var(--text-muted)' }}>{run.profileName} · {run.voiceId} · {run.format} · 语速 {run.speed}</p>
    {active && run.stage && <p className="mt-2 text-xs" aria-live="polite" style={{ color: 'var(--text-secondary)' }}>{run.stage}</p>}
    {run.errorMessage && <p className="mt-2 text-xs leading-6" role="status" style={{ color: 'var(--semantic-warning-text)' }}>{run.errorMessage}</p>}
    {run.status === 'unknown' && <p className="mt-2 text-xs leading-6" style={{ color: 'var(--text-muted)' }}>上游是否完成尚未确认，请联系管理员核查此任务，避免重复生成和计费。</p>}
    <details className="mt-2 text-xs"><summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>查看朗读文字与声音配置</summary><p className="mt-2 whitespace-pre-wrap break-words leading-6">{run.text}</p>{run.instructions && <p className="mt-2 leading-6">声音指令：{run.instructions}</p>}{run.emotion && <p className="mt-2">情绪：{run.emotion}</p>}{run.actualModel && <p className="mt-2">实际模型：{run.actualModel}{run.actualPlatformName ? ` · ${run.actualPlatformName}` : ''}</p>}{run.profileRevision !== undefined && <p className="mt-2">声音配置版本：{run.profileRevision}{run.environment ? ` · 环境：${run.environment}` : ''}</p>}</details>
    {run.status === 'completed' && run.audioUrl && <div className="mt-3"><AudioAssetPlayer url={run.audioUrl} title={run.title || '生成的语音'} /></div>}
    <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={active || run.status === 'unknown'} onClick={onRepeat}>按此配置再次生成</Button>{run.assetId && <Link className="mcp-button" to="/my-assets?tab=audio">在我的资产中查看<ArrowRight size={12} aria-hidden /></Link>}</div>
  </article>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs"><span style={{ color: 'var(--text-secondary)' }}>{label}</span>{children}</label>;
}
function SpeechAlert({ children }: { children: React.ReactNode }) {
  return <div className="mcp-alert" role="status"><AlertTriangle size={15} className="shrink-0" aria-hidden /><span>{children}</span></div>;
}
