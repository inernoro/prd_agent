import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, RefreshCw, X } from 'lucide-react';
import { AudioAssetPlayer } from '@/components/assets/AudioAssetPlayer';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { generateSpeech, getSpeechCapabilities, listSpeechRuns } from '@/services/real/mcpSpeech';
import { adoptVideoNarrationReal, getVideoNarrationReal, type VideoNarrationItem } from '@/services/real/videoAgent';
import type { SpeechProfile, SpeechRun } from '@/services/contracts/mcpSpeech';

/** 重试响应不明的提交时复用标识；恢复页面只读已有语音，不自动提交。 */
export function narrationRequestId(key: string, fingerprint: string, fresh = false): string {
  try {
    const previous = JSON.parse(sessionStorage.getItem(key) || 'null') as { fingerprint: string; id: string } | null;
    if (!fresh && previous?.fingerprint === fingerprint) return previous.id;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, id }));
    return id;
  } catch { return crypto.randomUUID(); }
}

export function VideoNarrationPanel({ runId, sceneIndex, editable, onClose, onAdopt }: {
  runId: string;
  sceneIndex: number;
  editable: boolean;
  onClose: () => void;
  onAdopt: () => Promise<void>;
}) {
  const [items, setItems] = useState<SpeechRun[]>([]);
  const [profiles, setProfiles] = useState<SpeechProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [text, setText] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [adopted, setAdopted] = useState<VideoNarrationItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const requestActive = useRef(false);
  const selected = items.find(item => item.id === selectedId);
  const profile = profiles.find(item => item.id === profileId);

  const refreshCapabilities = useCallback(async () => {
    try {
      const response = await getSpeechCapabilities();
      if (!alive.current || !response.success) return;
      const available = response.data.profiles.filter(item => item.available);
      setProfiles(available);
      setProfileId(current => {
        if (available.some(item => item.id === current)) return current;
        const initial = available.find(item => item.isDefault) ?? available[0];
        setVoiceId(initial?.defaultVoiceId ?? '');
        return initial?.id ?? '';
      });
    } catch { /* 配置目录暂不可用时仍保留已有语音入口。 */ }
  }, []);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([listSpeechRuns(), getVideoNarrationReal(runId)]);
    if (!alive.current) return;
    const [speech, narration] = results;
    const messages: string[] = [];
    if (speech.status === 'fulfilled' && speech.value.success) setItems(speech.value.data.items);
    else messages.push(speech.status === 'fulfilled' ? speech.value.error?.message || '读取语音失败，请刷新重试。' : '网络断开，请刷新重试。');
    if (narration.status === 'fulfilled' && narration.value.success) {
      setAdopted(narration.value.data.items.find(item => item.sceneIndex === sceneIndex) ?? null);
    } else messages.push(narration.status === 'fulfilled' ? narration.value.error?.message || '读取已采用配音失败。' : '读取已采用配音时网络断开。');
    setError(messages.join(' ') || null);
    setLoading(false);
  }, [runId, sceneIndex]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    void refreshCapabilities();
    return () => { alive.current = false; };
  }, [refresh, refreshCapabilities]);

  const hasActiveSpeech = items.some(item => ['queued', 'preparing', 'generating', 'saving'].includes(item.status));
  useEffect(() => {
    if (!hasActiveSpeech) return;
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [hasActiveSpeech, refresh]);

  const create = async () => {
    if (requestActive.current || !profile || !text.trim()) return;
    requestActive.current = true;
    setBusy('generate'); setError(null);
    const payload = { text: text.trim(), profileId, profileRevision: profile.revision, voiceId, format: profile.defaultFormat, speed: 1 };
    try {
      const response = await generateSpeech({ ...payload, title: `镜头 ${sceneIndex + 1} 配音`,
        clientRequestId: narrationRequestId(`video-narration:${runId}:${sceneIndex}`,
          JSON.stringify({ ...payload, retryOf: selected?.status === 'failed' ? selected.id : undefined })) });
      if (!alive.current) return;
      if (!response.success) { setError(response.error?.message || '提交失败，请重试同一请求。'); return; }
      setSelectedId(response.data.id);
      setItems(current => [response.data, ...current.filter(item => item.id !== response.data.id)]);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '网络异常，请重试同一请求。');
    } finally { requestActive.current = false; if (alive.current) setBusy(null); }
  };

  const adopt = async () => {
    if (requestActive.current || selected?.status !== 'completed') return;
    requestActive.current = true;
    setBusy('adopt'); setError(null);
    try {
      const response = await adoptVideoNarrationReal(runId, sceneIndex, selected.id);
      if (!response.success) {
        if (alive.current) setError(response.error?.message || '采用失败，请重试。');
        return;
      }
      // 服务端已保存时，父编辑器必须同步结果，不依赖当前镜头面板仍然挂载。
      await onAdopt();
      if (alive.current) await refresh();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '采用失败，请刷新确认后重试。');
    } finally { requestActive.current = false; if (alive.current) setBusy(null); }
  };

  return <aside className="video-console__inspector" aria-label="配音与字幕">
    <div className="video-console__panel-title">
      <div><AudioLines size={15} /> 配音与字幕</div>
      <button onClick={onClose} aria-label="关闭配音与字幕"><X size={15} /></button>
    </div>
    <div className="video-console__inspector-scroll flex flex-col gap-3 text-sm">
      <p>镜头 {sceneIndex + 1}：采用语音后，自动按该段完整语音时长生成同步字幕。合成后可在“完整成片”预览，下载同一文件。</p>
      {adopted?.speechRunId && <div role="status" className="rounded-lg border p-2" style={{ borderColor: 'var(--border-default)' }}>
        <strong>已采用配音 · {adopted.durationSeconds?.toFixed(2)} 秒</strong>
        <p>{adopted.text}</p>
        {adopted.errorMessage && <p>{adopted.errorMessage}</p>}
      </div>}
      {error && <div role="alert">{error}</div>}
      <label className="flex flex-col gap-1">已有语音（不新增生成费用）
        <select aria-label="已有语音" value={selectedId} onChange={event => setSelectedId(event.target.value)}>
          <option value="">选择已生成的语音</option>
          {items.map(item => <option key={item.id} value={item.id}>{item.title || item.text.slice(0, 22)} · {item.stage || item.status}</option>)}
        </select>
      </label>
      <Button size="sm" variant="secondary" onClick={() => { void refresh(); void refreshCapabilities(); }} disabled={loading}><RefreshCw size={14} /> 刷新语音与状态</Button>
      {loading && <MapSpinner size={16} />}
      {selected && <>
        <p>{selected.text}</p>
        {selected.status !== 'completed' && <div role="status">{selected.stage} {hasActiveSpeech && <MapSpinner size={14} />}</div>}
        {selected.errorMessage && <div role="alert">{selected.errorMessage} 可修改文字后重新生成，或采用其他已有语音。</div>}
        {selected.audioUrl && <AudioAssetPlayer url={selected.format === 'pcm'
          ? `${selected.audioUrl}${selected.audioUrl.includes('?') ? '&' : '?'}playable=true` : selected.audioUrl}
          title={selected.title || '镜头配音'} />}
        <Button size="sm" onClick={() => void adopt()} disabled={!editable || Boolean(busy) || selected.status !== 'completed'}>
          {busy === 'adopt' && <MapSpinner size={14} />}采用到此镜头并同步字幕
        </Button>
      </>}
      <hr style={{ borderColor: 'var(--border-default)' }} />
      <strong>生成新的配音</strong>
      {profiles.length === 0 ? <p>当前未发现可用语音能力或没有语音权限。可刷新配置，或使用已有语音；管理员可在智能体接入台配置 TTS。</p> : <>
        <label className="flex flex-col gap-1">语音能力
          <select aria-label="配音能力" value={profileId} onChange={event => {
            const next = profiles.find(item => item.id === event.target.value);
            setProfileId(event.target.value); setVoiceId(next?.defaultVoiceId ?? '');
          }}>{profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1">声音
          <select aria-label="配音声音" value={voiceId} onChange={event => setVoiceId(event.target.value)}>
            {profile?.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
          </select>
        </label>
        <textarea aria-label="此镜头配音脚本" value={text} onChange={event => setText(event.target.value)} maxLength={profile?.maxTextChars} placeholder="输入这一个镜头的旁白；采用时将同时保存字幕。" rows={4} />
        <p>生成使用当前语音能力额度，可能产生费用。页面恢复和导出只读取已采用的语音。</p>
        <Button size="sm" onClick={() => void create()} disabled={!editable || Boolean(busy) || !text.trim() || !voiceId || hasActiveSpeech}>
          {busy === 'generate' && <MapSpinner size={14} />}{selected?.status === 'failed' ? '重新生成配音' : '生成配音'}
        </Button>
      </>}
    </div>
  </aside>;
}
