import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { ConsciousnessScene } from './ConsciousnessScene';
import { EntryAudio } from './entryAudio';
import { consumeQuickstartArrival, hasQuickstartArrival, stopQuickstartArrivalSound } from './quickstartArrival';
import '../../pages/GatewayEntry.css';

/** The real access form remains interactive while its decorative portrait arrives. */
export function GatewayQuickstartStage({ children }: { children: ReactNode }) {
  const [arriving] = useState(hasQuickstartArrival);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('llmgw-entry-sound') !== 'off'; } catch { return true; } });
  const preview = useRef<EntryAudio | null>(null);
  useEffect(() => {
    if (arriving) consumeQuickstartArrival();
    const silence = () => { if (document.visibilityState !== 'visible') { stopQuickstartArrivalSound(); preview.current?.stop(); } };
    document.addEventListener('visibilitychange', silence);
    return () => { preview.current?.dispose(); preview.current = null; document.removeEventListener('visibilitychange', silence); };
  }, [arriving]);
  const toggleSound = () => {
    const enabled = !sound; setSound(enabled);
    try { localStorage.setItem('llmgw-entry-sound', enabled ? 'on' : 'off'); } catch { /* device preference only */ }
    if (!enabled) { stopQuickstartArrivalSound(); preview.current?.setEnabled(false); }
    else {
      preview.current ??= new EntryAudio(); preview.current.setEnabled(true); preview.current.unlock(); preview.current.play('verified');
    }
  };
  return <section className={`gateway-entry gateway-quickstart-stage consciousness-home${arriving ? ' is-arriving' : ''}`} aria-label="第一步 说清要做什么">
    <ConsciousnessScene arriving={arriving} />
    <div className="gateway-quickstart-shade" aria-hidden="true" />
    {children}
    <button className="gateway-sound" type="button" aria-pressed={sound} onClick={toggleSound} aria-label={sound ? '关闭进入音效' : '开启进入音效'}>
      {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}<span>{sound ? '音效已开启' : '静音'}</span>
    </button>
  </section>;
}
