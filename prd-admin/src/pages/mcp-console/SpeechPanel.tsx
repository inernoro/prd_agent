import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, AudioLines, Check, Clock3, FileAudio, Folder, History, Plus, RefreshCw, Save, Search, SlidersHorizontal, Volume2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Surface } from '@/components/design/Surface';
import { AudioAssetPlayer } from '@/components/assets/AudioAssetPlayer';
import { generateSpeech, getSpeechCapabilities, getSpeechRun, getSpeechSettings, listSpeechPresets, listSpeechRuns, saveSpeechPreset } from '@/services/real/mcpSpeech';
import type { SpeechCapabilities, SpeechPreset, SpeechRun, SpeechSettings } from '@/services/contracts/mcpSpeech';
import { toast } from '@/lib/toast';
import { EMPTY_SPEECH_DRAFT, applySpeechPreset, isSpeechRunActive, repeatSpeechRun, selectSpeechProfile, speechDraftIssue, speechRunRequest } from './speechForm';
import { SpeechSettingsPanel } from './SpeechSettingsPanel';
import './SpeechStudio.css';

const RUN_STATUS: Record<string, { label: string; icon: typeof Check; color: string }> = {
  queued: { label: '排队中', icon: Clock3, color: 'var(--text-secondary)' },
  preparing: { label: '准备生成', icon: Clock3, color: 'var(--text-secondary)' },
  generating: { label: '正在生成', icon: Volume2, color: 'var(--accent-primary)' },
  saving: { label: '正在保存', icon: Save, color: 'var(--accent-primary)' },
  completed: { label: '已完成', icon: Check, color: 'var(--semantic-success-text)' },
  failed: { label: '生成失败', icon: AlertTriangle, color: 'var(--semantic-danger-text)' },
  unknown: { label: '结果待核查', icon: AlertTriangle, color: 'var(--semantic-warning-text)' },
};

export function SpeechPanel({ refreshToken }: { refreshToken: number }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const focusedRunId = searchParams.get('run') || '';
  const historyView = searchParams.get('view') === 'history' || !!focusedRunId;
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showPresetEditor, setShowPresetEditor] = useState(false);
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
      toast.success('语音任务已提交，可在历史记录查看进度');
      await refresh();
      setSearchParams(current => { const next = new URLSearchParams(current); next.set('view', 'history'); next.set('run', result.data.id); return next; }, { replace: true });
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

  const navigateWorkspace = (history: boolean, runId?: string) => {
    setShowSettings(false);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('tab', 'speech');
      if (history) next.set('view', 'history'); else next.delete('view');
      if (runId) next.set('run', runId); else next.delete('run');
      return next;
    }, { replace: true });
  };
  const selectedRun = focusedRunId ? visibleRuns.find(run => run.id === focusedRunId) : visibleRuns[0];
  const selectedVoice = profile?.voices.find(voice => voice.id === draft.voiceId);
  const matchingRuns = visibleRuns.filter(run => (!statusFilter || run.status === statusFilter) &&
    (!query.trim() || `${run.title} ${run.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const characterCount = Array.from(draft.text).length;
  const repeat = (run: SpeechRun) => { setDraft(repeatSpeechRun(run)); setPresetId(''); navigateWorkspace(false); };

  if (loading) return <div className="speech-studio-loading"><MapSectionLoader text="正在读取当前环境的语音能力" /></div>;
  return <Surface className="speech-studio" data-testid="speech-studio">
    <header className="speech-toolbar">
      <Link to="/mcp-console" className="speech-toolbar-back" aria-label="返回智能体接入台" title="返回智能体接入台"><ArrowLeft size={16} /></Link>
      <h1><AudioLines size={20} aria-hidden />文生语音</h1>
      <div className="speech-view-tabs" aria-label="语音工作区">
        <button type="button" aria-current={!historyView && !showSettings ? 'page' : undefined} onClick={() => navigateWorkspace(false)}>创作工作台</button>
        <button type="button" aria-current={historyView && !showSettings ? 'page' : undefined} onClick={() => navigateWorkspace(true)}>语音历史 <span>{visibleRuns.length}</span></button>
      </div>
      <span className="speech-toolbar-spacer" />
      <span className="speech-environment" title={`当前环境：${capabilities?.environment || '暂未读取'}`}><span className="sr-only">当前环境：</span>{capabilities?.environment || '暂未读取'}</span>
      <Button size="sm" className="speech-refresh" disabled={refreshing} aria-label="刷新语音记录" title="刷新语音记录" onClick={() => void refresh()}>{refreshing ? <MapSpinner size={14} /> : <RefreshCw size={14} />}</Button>
      {settings?.canManage && <Button size="sm" className="speech-config-button" aria-expanded={showSettings} onClick={() => setShowSettings(value => !value)}><SlidersHorizontal size={14} />环境配置</Button>}
    </header>
    <div className={`speech-workspace${showSettings ? ' speech-workspace--settings' : ''}`}>
      <nav className="speech-workspace-nav" aria-label="语音导航">
        <span className="speech-eyebrow">工作区</span>
        <button type="button" className="speech-nav-item" aria-current={!historyView && !showSettings ? 'page' : undefined} onClick={() => navigateWorkspace(false)}><Plus size={18} />新建语音</button>
        <button type="button" className="speech-nav-item" aria-current={historyView && !showSettings ? 'page' : undefined} onClick={() => navigateWorkspace(true)}><History size={18} />历史记录 <span>{visibleRuns.length}</span></button>
        <Link className="speech-nav-item" to="/my-assets?tab=audio"><Folder size={18} />我的音频资产</Link>
        <div className="speech-nav-presets">
          <span className="speech-eyebrow">声音预设</span>
          {!presets.length && <p className="speech-muted">保存常用声音，随时复用。</p>}
          {presets.map(preset => <button key={preset.id} type="button" className="speech-preset-card" aria-pressed={preset.id === presetId} onClick={() => { setPresetId(preset.id); setPresetName(preset.name); setDraft(current => applySpeechPreset(current, preset)); navigateWorkspace(false); }}><strong>{preset.name}</strong><span>{preset.speed}× · {preset.format.toUpperCase()}</span></button>)}
        </div>
        <p className="speech-nav-footnote"><Folder size={17} aria-hidden />每次生成，自动存入资产<br />可从历史随时找回</p>
      </nav>
      {showSettings ? <main className="speech-main speech-settings-main">
        <div className="speech-page-heading"><h2>环境配置</h2><p>管理当前环境的语音能力</p></div>
        {settingsError && <SpeechAlert>{settingsError}</SpeechAlert>}
        {settings?.canManage && <SpeechSettingsPanel key={settings.revision} settings={settings} onSaved={refresh} />}
      </main> : <>
        <main className="speech-main">
          {error && <SpeechAlert>{error}</SpeechAlert>}
          {historyError && <SpeechAlert>{historyError}</SpeechAlert>}
          {settingsError && <SpeechAlert>{settingsError}</SpeechAlert>}
          {focusedRunError && <SpeechAlert>{focusedRunError}</SpeechAlert>}
          {historyView ? <>
            <div className="speech-page-heading"><h2>每一次表达，都能找回。</h2><p>查看已有成品，继续播放、下载或打开我的资产。</p></div>
            <div className="speech-history-filters"><label className="speech-history-search"><Search size={17} /><input aria-label="搜索成品名称或朗读文字" placeholder="搜索成品名称或朗读文字" value={query} onChange={event => setQuery(event.target.value)} /></label><select className="speech-input" aria-label="任务状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="">全部状态</option>{Object.entries(RUN_STATUS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></div>
            <p className="speech-history-count">{query || statusFilter ? '筛选结果' : '最近任务'} · {matchingRuns.length} 条</p>
            <div className="speech-history-list">{matchingRuns.map(run => <SpeechHistoryItem key={run.id} run={run} selected={run.id === selectedRun?.id} onSelect={() => navigateWorkspace(true, run.id)} />)}</div>
            {!matchingRuns.length && !historyError && !focusedRunError && <div className="speech-empty"><FileAudio size={30} /><h3>{query || statusFilter ? '没有匹配的语音任务' : '还没有语音任务'}</h3><p>{query || statusFilter ? '试试其他名称、文字或状态。' : '在创作工作台生成，或让已授权的 MCP 客户端为你生成。'}</p></div>}
            {visibleRuns.some(run => run.status === 'completed' && run.assetId) && <p className="speech-history-footnote"><Check size={16} />成品已同步到我的资产，刷新后仍可查看。</p>}
          </> : <>
            <div className="speech-page-heading"><h2>让文字，自然开口。</h2><p>写下要说的话，选好声音，即可生成专属音频。</p></div>
            {!capabilities?.profiles.length ? <div className="speech-empty"><Volume2 size={30} /><h3>当前环境尚未配置语音能力</h3><p>{settings?.canManage ? '在环境配置中添加语音能力，绑定可用的模型池与音色。' : '请联系管理员配置语音模型与音色。已有历史和音频资产仍可查阅。'}</p><Button size="sm" className="speech-control" onClick={() => navigateWorkspace(true)}>查看语音历史</Button></div> : <>
              <Field label="成品名称（选填）"><input className="speech-input" value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} placeholder="为这次表达起个名字" /></Field>
              <div className="speech-script-label"><span>朗读文本</span><span>{characterCount}{profile ? ` / ${profile.maxTextChars}` : ' 字'}</span></div>
              <div className="speech-script-editor"><textarea aria-label="需要朗读的文字" value={draft.text} onChange={event => setDraft(current => ({ ...current, text: event.target.value }))} placeholder="粘贴讲稿、产品介绍或希望朗读的文字。" /><p>按原文朗读，保留你的表达。</p></div>
              <div className="speech-generate-row"><span><FileAudio size={16} />{characterCount} 字</span><Button variant="primary" className="speech-generate-button" disabled={submitting || !!issue} onClick={() => void generate()}>{submitting ? <MapSpinner size={18} /> : <AudioLines size={18} />}{submitting ? '正在提交语音任务' : '生成语音'}</Button></div>
              {issue && <p className="speech-form-help" role="status">{issue}</p>}
            </>}
            {!!visibleRuns.length && <section className="speech-recent"><h3>最近生成</h3><SpeechResultCard run={visibleRuns[0]} onOpen={() => navigateWorkspace(true, visibleRuns[0].id)} /></section>}
          </>}
        </main>
        <aside className="speech-inspector" aria-label={historyView ? '音频详情' : '声音设置'}>
          {historyView ? selectedRun ? <SpeechRunDetails key={selectedRun.id} run={selectedRun} profiles={capabilities?.profiles || []} onRepeat={() => repeat(selectedRun)} /> : <><h2>音频详情</h2><p className="speech-muted">选择一条历史记录，查看音频与声音配置。</p></> : <>
            <h2>声音设置<SlidersHorizontal size={18} /></h2>
            {selectedVoice && <div className="speech-voice-identity"><div className="speech-voice-avatar">{Array.from(selectedVoice.name)[0]}</div><div><strong>{selectedVoice.name}</strong><p>{profile?.name}</p></div>{!!selectedVoice.languages.length && <div className="speech-language-tags">{selectedVoice.languages.map(language => <span key={language}>{language}</span>)}</div>}</div>}
            <Field label="语音能力"><select aria-label="语音能力" className="speech-input" value={draft.profileId} onChange={event => { const next = capabilities?.profiles.find(item => item.id === event.target.value); setPresetId(''); setDraft(current => next ? selectSpeechProfile(current, next) : { ...current, profileId: '', profileRevision: undefined, voiceId: '', format: '', instructions: '', emotion: '' }); }}><option value="">选择语音能力</option>{!profile && draft.profileId && <option value={draft.profileId}>原语音能力已不可用</option>}{capabilities?.profiles.map(item => <option key={item.id} value={item.id}>{item.name}{!item.available ? '（暂不可用）' : ''}</option>)}</select></Field>
            {profile && <>
              {!profile.available && <SpeechAlert>{profile.unavailableReason || '此能力暂不可用，请联系管理员检查配置。'}</SpeechAlert>}
              {draft.profileRevision !== undefined && draft.profileRevision !== profile.revision && <div className="speech-version-warning"><p>原声音配置已更新，需重新确认音色。</p><Button size="sm" className="speech-control" onClick={() => { setDraft(current => selectSpeechProfile(current, profile)); setPresetId(''); }}>载入最新声音配置</Button></div>}
              <Field label="音色"><select aria-label="音色" className="speech-input" value={draft.voiceId} onChange={event => setDraft(current => ({ ...current, voiceId: event.target.value }))}>{!profile.voices.some(voice => voice.id === draft.voiceId) && <option value={draft.voiceId}>请选择可用音色</option>}{profile.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></Field>
              {selectedVoice?.previewUrl && <audio controls preload="none" className="w-full" src={selectedVoice.previewUrl} aria-label="音色试听" />}
              <Field label={<>语速 <span className="speech-speed-value">{Number.isFinite(draft.speed) ? `${draft.speed.toFixed(1)}×` : '请选择语速'}</span></>}><input aria-label="语速" className="speech-range" style={{ '--speech-progress': `${profile.maxSpeed > profile.minSpeed ? Math.min(100, Math.max(0, (draft.speed - profile.minSpeed) / (profile.maxSpeed - profile.minSpeed) * 100)) : 0}%` } as CSSProperties} type="range" min={profile.minSpeed} max={profile.maxSpeed} step={0.1} value={draft.speed} onChange={event => setDraft(current => ({ ...current, speed: event.target.valueAsNumber }))} /><span className="speech-range-labels"><span>{profile.minSpeed}×</span><span>{profile.maxSpeed}×</span></span></Field>
              <Field label="输出格式">{profile.formats.length === 1 && profile.formats.includes(draft.format) ? <div className="speech-format-value">{draft.format.toUpperCase()}</div> : <select aria-label="输出格式" className="speech-input" value={draft.format} onChange={event => setDraft(current => ({ ...current, format: event.target.value }))}>{!profile.formats.includes(draft.format) && <option value={draft.format}>请选择输出格式</option>}{profile.formats.map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select>}</Field>
              {profile.supportsInstructions && <Field label="声音指令（可选）"><textarea aria-label="声音指令（可选）" rows={2} className="speech-input" value={draft.instructions} onChange={event => setDraft(current => ({ ...current, instructions: event.target.value }))} placeholder="描述此能力支持的朗读方式" /></Field>}
              {profile.supportsEmotion && <Field label="情绪（可选）"><select aria-label="情绪（可选）" className="speech-input" value={draft.emotion} onChange={event => setDraft(current => ({ ...current, emotion: event.target.value }))}><option value="">上游默认</option>{profile.emotions.map(emotion => <option key={emotion}>{emotion}</option>)}</select></Field>}
            </>}
            <div className="speech-preset-settings"><h3>声音预设</h3><p className="speech-muted">喜欢这组声音？保存后可直接复用。</p>
              {!!presets.length && <div className="speech-preset-selector"><Field label="我的声音预设"><select className="speech-input" value={presetId} onChange={event => { const preset = presets.find(item => item.id === event.target.value); setPresetId(preset?.id || ''); setPresetName(preset?.name || ''); if (preset) setDraft(current => applySpeechPreset(current, preset)); }}><option value="">自定义声音配置</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></Field></div>}
              {!showPresetEditor ? <Button className="speech-control" size="sm" disabled={!profile} onClick={() => setShowPresetEditor(true)}>保存为预设</Button> : <div className="speech-preset-editor"><input aria-label="声音预设名称" className="speech-input" value={presetName} onChange={event => setPresetName(event.target.value)} placeholder="为这组声音配置命名" /><Button className="speech-control" size="sm" disabled={savingPreset || !profile} onClick={() => void savePreset()}>{savingPreset ? <MapSpinner size={14} /> : <Save size={14} />}{selectedPreset ? '更新预设' : '保存预设'}</Button>{selectedPreset && <Button className="speech-control" size="sm" onClick={() => { setPresetId(''); setPresetName(''); }}>另存为</Button>}</div>}
              {presetError && <SpeechAlert>{presetError}</SpeechAlert>}
            </div>
            <div className="speech-scope-note"><p>当前支持原文朗读</p><p>语音可用范围与参数由环境配置管理。</p>{profile && <p>单次 {profile.maxTextChars} 字 · 每日 {profile.dailyCharacterQuota} 字 · 并发 {profile.maxConcurrentRuns}</p>}</div>
          </>}
        </aside>
      </>}
    </div>
  </Surface>;
}

function SpeechRunStatus({ run }: { run: SpeechRun }) {
  const status = RUN_STATUS[run.status] ?? { label: run.stage || run.status, icon: Clock3, color: 'var(--text-muted)' };
  const active = isSpeechRunActive(run);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(run.createdAt)) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active, run.createdAt]);
  const Icon = status.icon;
  return <span className={`speech-run-status${run.status === 'completed' ? ' speech-run-status--complete' : ''}`} style={{ color: status.color }}>{active ? <MapSpinner size={13} /> : <Icon size={13} aria-hidden />}{status.label}{active ? ` · 已等待 ${elapsed} 秒` : ''}</span>;
}

function SpeechHistoryItem({ run, selected, onSelect }: { run: SpeechRun; selected: boolean; onSelect: () => void }) {
  return <button type="button" id={`speech-run-${run.id}`} className="speech-history-item" aria-pressed={selected} onClick={onSelect}>
    <span className="speech-history-item-title"><FileAudio size={21} /><strong>{run.title || '语音生成'}</strong><SpeechRunStatus run={run} /></span>
    <span className="speech-history-item-text">{run.text}</span>
    <span className="speech-history-item-meta">{run.profileName} · {run.format.toUpperCase()} · {run.speed}× · <RelativeTime value={run.createdAt} /></span>
  </button>;
}

function SpeechResultCard({ run, onOpen }: { run: SpeechRun; onOpen: () => void }) {
  return <Surface variant="inset" className="speech-result-card">
    <div className="speech-result-title"><SpeechRunStatus run={run} /><div><h4><button type="button" aria-label={`查看任务详情：${run.title || '语音生成'}`} onClick={onOpen}>{run.title || '语音生成'}</button></h4><p>{RUN_STATUS[run.status]?.label || run.status} · <RelativeTime value={run.createdAt} />{run.assetId ? ' · 已保存到我的资产' : ''}</p></div></div>
    <SpeechRunMessage run={run} />
    {run.status === 'completed' && run.audioUrl && <AudioAssetPlayer url={run.audioUrl} title={run.title || '生成的语音'} variant="studio" actions={<Link className="speech-asset-link" to="/my-assets?tab=audio">查看资产</Link>} />}
  </Surface>;
}

function SpeechRunMessage({ run }: { run: SpeechRun }) {
  return <>
    {isSpeechRunActive(run) && run.stage && <p className="speech-run-message" role="status">{run.stage}</p>}
    {run.errorMessage && <p className="speech-run-message" role="status">{run.errorMessage}</p>}
    {run.status === 'unknown' && <p className="speech-run-message">上游是否完成尚未确认，请联系管理员核查此任务，避免重复生成和计费。</p>}
  </>;
}

function SpeechRunDetails({ run, profiles, onRepeat }: { run: SpeechRun; profiles: SpeechCapabilities['profiles']; onRepeat: () => void }) {
  const [metadata, setMetadata] = useState<{ sizeBytes?: number; duration?: number } | null>(null);
  const voice = profiles.find(profile => profile.id === run.profileId)?.voices.find(item => item.id === run.voiceId);
  const active = isSpeechRunActive(run);
  return <>
    <h2>音频详情</h2><SpeechRunStatus run={run} /><h3 className="speech-detail-title">{run.title || '语音生成'}</h3>
    <SpeechRunMessage run={run} />
    {run.status === 'completed' && run.audioUrl && <div className="speech-detail-player"><AudioAssetPlayer url={run.audioUrl} title={run.title || '生成的语音'} variant="studio" onMetadata={setMetadata} /></div>}
    <section className="speech-detail-text"><h3>朗读原文</h3><p>{run.text}</p></section>
    <dl className="speech-detail-metadata">
      <div><dt>音色</dt><dd>{voice?.name || run.voiceId}</dd></div>
      {!!voice?.languages.length && <div><dt>语言</dt><dd>{voice.languages.join(' / ')}</dd></div>}
      <div><dt>声音配置</dt><dd>{run.speed}× · {run.format.toUpperCase()}</dd></div>
      {metadata && <div><dt>文件</dt><dd>{metadata.sizeBytes !== undefined ? `${(metadata.sizeBytes / 1024).toFixed(1)} KB` : ''}{metadata.duration ? ` · ${metadata.duration.toFixed(3)} 秒` : ''}</dd></div>}
      {run.instructions && <div><dt>声音指令</dt><dd>{run.instructions}</dd></div>}{run.emotion && <div><dt>情绪</dt><dd>{run.emotion}</dd></div>}
      {run.actualModel && <div><dt>实际模型</dt><dd>{run.actualModel}{run.actualPlatformName ? ` · ${run.actualPlatformName}` : ''}</dd></div>}
      {run.profileRevision !== undefined && <div><dt>配置版本</dt><dd>{run.profileRevision}{run.environment ? ` · ${run.environment}` : ''}</dd></div>}
    </dl>
    <div className="speech-detail-actions"><Button size="sm" className="speech-control" disabled={active || run.status === 'unknown'} onClick={onRepeat}>按此配置再次生成</Button>{run.assetId && <Link className="speech-asset-link" to="/my-assets?tab=audio">在我的资产中查看</Link>}</div>
  </>;
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <label className="speech-field"><span className="speech-field-label">{label}</span>{children}</label>;
}
function SpeechAlert({ children }: { children: React.ReactNode }) {
  return <div className="speech-alert" role="status"><AlertTriangle size={15} aria-hidden />{children}</div>;
}
