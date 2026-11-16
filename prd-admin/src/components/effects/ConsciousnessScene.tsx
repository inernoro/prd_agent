import { useEffect, useRef } from 'react';
import './consciousness-entry.css';
import { ConsciousnessPortrait } from './ConsciousnessPortrait';
import { beginEntryArrival } from './entryArrival';
import { prefersReducedMotion } from '@/lib/themeApplier';

export type IdentityPhase = 'idle' | 'verifying' | 'authorized' | 'entering';
export const COMPANION_ART = '/media/entry/companion.webp';
let arrivalUntil = 0;

/** Visual handoff only; authentication remains server-authoritative. */
export function markConsciousnessArrival() {
  if (prefersReducedMotion()) { arrivalUntil = 0; return; }
  arrivalUntil = Date.now() + 10000; beginEntryArrival();
}
export function clearConsciousnessArrival() { arrivalUntil = 0; }
export function isConsciousnessArrival() { return Date.now() < arrivalUntil; }

export function ConsciousnessScene({ fog = false, arriving = false, frameTime }: { fog?: boolean; arriving?: boolean; frameTime?: number }) {
  return (
    <div className={`consciousness-scene${fog ? ' has-fog' : ''}${arriving || frameTime !== undefined ? ' is-arriving' : ''}`} aria-hidden="true">
      <div className="consciousness-camera"><ConsciousnessPortrait fog={fog} arriving={arriving} frameTime={frameTime} /></div>
      <div className="consciousness-mist" />
      <div className="consciousness-ghost"><span data-word="MAP">MAP</span><i /><small>欢迎来到智能体工作空间</small></div>
      <div className="consciousness-grain" />
    </div>
  );
}

export function ConsciousnessHud({ login = false }: { login?: boolean }) {
  return <div className={`consciousness-hud${login ? ' is-paper' : ''}`} aria-hidden="true">
    <div className="consciousness-hud-brand"><strong>MAP</strong><span>// INTELLIGENCE WORKSPACE</span><i /></div>
    <div className="consciousness-hud-version">MAP OS<br /><span>IDEA INTO REALITY</span></div>
    <div className="consciousness-hud-left">ANALYSIS<br />BUILDING<br />CREATING<br />EVOLVING<i /></div>
    <div className="consciousness-hud-right">HUMAN<br />INTELLIGENCE<br />CONNECTED<i /></div>
    <div className="consciousness-hud-bottom">YOUR AI COMPANION<br />FOR WHAT COMES NEXT<span /></div>
    <div className="consciousness-hud-coordinate">/// MAP · WORKSPACE</div>
  </div>;
}

export function IdentityScanner({ phase }: { phase: IdentityPhase }) {
  const scanner = useRef<HTMLDivElement>(null);
  const rotations = useRef<Animation[]>([]);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rings = scanner.current?.querySelectorAll<SVGSVGElement>('[data-ring]');
    rotations.current = Array.from(rings ?? []).flatMap((ring, index) => {
      if (!ring.animate) return [];
      return [ring.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${index === 1 ? -360 : 360}deg)` }],
        { duration: [32000, 20000, 40000][index], iterations: Infinity })];
    });
    return () => { rotations.current.forEach(animation => animation.cancel()); rotations.current = []; };
  }, []);
  useEffect(() => {
    // Changing CSS animation-duration remaps the accumulated angle and visibly jumps.
    // Adjust playback speed on the existing clock, preserving its current angle.
    const target = phase === 'verifying' ? 10 : phase === 'idle' ? 1 : 2;
    const animations = rotations.current;
    const rates = animations.map(animation => animation.playbackRate);
    const start = performance.now();
    let frame = 0;
    const ramp = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const eased = t * t * (3 - 2 * t);
      animations.forEach((animation, index) => animation.updatePlaybackRate(rates[index] + (target - rates[index]) * eased));
      if (t < 1) frame = requestAnimationFrame(ramp);
    };
    if (animations.length) frame = requestAnimationFrame(ramp);
    return () => cancelAnimationFrame(frame);
  }, [phase]);
  return <div ref={scanner} className={`identity-scanner is-${phase}`} aria-hidden="true">
    <svg data-ring="outer" viewBox="0 0 560 560" fill="none"><circle cx="280" cy="280" r="252" stroke="currentColor" strokeWidth="5" strokeDasharray="970 615" strokeLinecap="round" /><circle cx="519" cy="360" r="7" fill="currentColor" /></svg>
    <svg data-ring="inner" viewBox="0 0 560 560" fill="none"><circle cx="280" cy="280" r="219" stroke="var(--cinema-light)" strokeWidth="1.5" strokeDasharray="720 656" /><circle cx="280" cy="61" r="4" fill="var(--cinema-light)" /></svg>
    <svg data-ring="dots" viewBox="0 0 560 560" fill="var(--cinema-amber)"><circle cx="163" cy="98" r="3" /><circle cx="450" cy="148" r="3" /><circle cx="164" cy="466" r="3" /></svg>
    <svg viewBox="0 0 560 560" fill="none"><circle cx="280" cy="280" r="184" stroke="currentColor" opacity="0.2" strokeWidth="0.6" strokeDasharray="1 7" /><path d="M25 280H43M517 280H535M280 25V43M280 517V535" stroke="currentColor" opacity="0.3" /></svg>
  </div>;
}
