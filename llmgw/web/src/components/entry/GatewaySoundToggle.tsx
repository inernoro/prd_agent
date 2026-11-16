import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { EntryAudio } from './entryAudio';
import { stopQuickstartArrivalSound } from './quickstartArrival';

export function GatewaySoundToggle() {
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('llmgw-entry-sound') !== 'off'; } catch { return true; } });
  const preview = useRef<EntryAudio | null>(null);
  useEffect(() => {
    const silence = () => { if (document.visibilityState !== 'visible') { stopQuickstartArrivalSound(); preview.current?.stop(); } };
    document.addEventListener('visibilitychange', silence);
    return () => { preview.current?.dispose(); preview.current = null; document.removeEventListener('visibilitychange', silence); };
  }, []);
  const toggle = () => {
    const enabled = !sound; setSound(enabled);
    try { localStorage.setItem('llmgw-entry-sound', enabled ? 'on' : 'off'); } catch { /* device preference only */ }
    if (!enabled) { stopQuickstartArrivalSound(); preview.current?.setEnabled(false); }
    else { preview.current ??= new EntryAudio(); preview.current.setEnabled(true); preview.current.unlock(); preview.current.play('verified'); }
  };
  const label = sound ? '关闭进入音效' : '开启进入音效';
  return <button className="gateway-chrome-sound" type="button" aria-pressed={sound} aria-label={label} title={label} onClick={toggle}>
    {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
  </button>;
}
