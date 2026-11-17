import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { EntryAudio, type EntryCue } from './entryAudio';
import { GATEWAY_SOUND_EVENT } from './gatewaySound';
import { hasQuickstartArrival, hasQuickstartArrivalAudio, waitForQuickstartArrivalSound, stopQuickstartArrivalSound } from './quickstartArrival';

function prefersSound() { try { return localStorage.getItem('llmgw-entry-sound') !== 'off'; } catch { return true; } }

export function GatewaySoundToggle() {
  const enabled = useRef(prefersSound());
  const [status, setStatus] = useState<'pending' | 'ready' | 'muted'>(enabled.current ? 'pending' : 'muted');
  const [arrival] = useState(() => ({ active: hasQuickstartArrival(), transferred: hasQuickstartArrivalAudio() }));
  const preview = useRef<EntryAudio | null>(null);
  const mounted = useRef(false);
  const playbackSeq = useRef(0);
  const play = useCallback(async (cue: EntryCue) => {
    if (!enabled.current) return;
    const sequence = ++playbackSeq.current;
    stopQuickstartArrivalSound();
    preview.current ??= new EntryAudio();
    preview.current.stop();
    preview.current.setEnabled(true);
    preview.current.unlock();
    const started = await preview.current.play(cue);
    if (mounted.current && enabled.current && playbackSeq.current === sequence) setStatus(started ? 'ready' : 'pending');
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (enabled.current && arrival.active) {
      if (!arrival.transferred) void play('reveal');
      else {
        const sequence = ++playbackSeq.current;
        void waitForQuickstartArrivalSound().then(started => {
          if (mounted.current && enabled.current && playbackSeq.current === sequence) setStatus(started ? 'ready' : 'pending');
        });
      }
    }
    const cue = (event: Event) => {
      const value = (event as CustomEvent<EntryCue>).detail;
      if (value === 'scan' || value === 'verified' || value === 'reveal') void play(value);
    };
    const silence = () => { if (document.visibilityState !== 'visible') { stopQuickstartArrivalSound(); preview.current?.stop(); } };
    window.addEventListener(GATEWAY_SOUND_EVENT, cue);
    document.addEventListener('visibilitychange', silence);
    return () => {
      mounted.current = false; playbackSeq.current++; preview.current?.dispose(); preview.current = null;
      window.removeEventListener(GATEWAY_SOUND_EVENT, cue);
      document.removeEventListener('visibilitychange', silence);
    };
  }, [arrival, play]);
  const toggle = () => {
    const next = status !== 'ready'; enabled.current = next;
    try { localStorage.setItem('llmgw-entry-sound', next ? 'on' : 'off'); } catch { /* device preference only */ }
    if (next) void play('reveal');
    else { stopQuickstartArrivalSound(); preview.current?.setEnabled(false); setStatus('muted'); }
  };
  const label = status === 'pending' ? '播放进入音效' : status === 'ready' ? '关闭进入音效' : '开启进入音效';
  return <button className={`gateway-chrome-sound${status === 'pending' ? ' is-pending' : ''}`} type="button" data-audio-status={status} aria-pressed={status === 'ready'} aria-label={label} title={status === 'pending' ? '浏览器需要点击后播放声音' : label} onClick={toggle}>
    {status === 'muted' ? <VolumeX size={17} /> : <Volume2 size={17} />}
    {status === 'pending' && <><span className="gateway-sound-label-long">试听音效</span><span className="gateway-sound-label-short">试听</span></>}
  </button>;
}
