import { useId } from 'react';
import './consciousness-entry.css';

export type IdentityPhase = 'idle' | 'verifying' | 'authorized' | 'entering';
export const COMPANION_ART = '/media/entry/companion.webp';
const COMPANION_SLEEP = '/media/entry/companion-sleep.webp';
let arrivalUntil = 0;

/** Visual handoff only; authentication remains server-authoritative. */
export function markConsciousnessArrival() { arrivalUntil = Date.now() + 10000; }
export function clearConsciousnessArrival() { arrivalUntil = 0; }
export function isConsciousnessArrival() { return Date.now() < arrivalUntil; }

export function ConsciousnessScene({ fog = false, arriving = false }: { fog?: boolean; arriving?: boolean }) {
  const filterId = `companion-contour-${useId().replace(/:/g, '')}`;
  return (
    <div className={`consciousness-scene${fog ? ' has-fog' : ''}${arriving ? ' is-arriving' : ''}`} aria-hidden="true">
      <svg className="consciousness-filter" width="0" height="0"><defs>
        <filter id={filterId} colorInterpolationFilters="sRGB">
          <feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 4 -1 0 -1 0" divisor="1" bias="0" preserveAlpha="true" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.22  0 0 0 0 0.64  0 0 0 0 1  5 9 3 0 0" />
        </filter>
      </defs></svg>
      <img className="consciousness-art" src={fog ? COMPANION_SLEEP : COMPANION_ART} alt="" loading="eager" decoding="async" />
      {arriving && <img className="consciousness-sleeping" src={COMPANION_SLEEP} alt="" decoding="async" />}
      {arriving && <img className="consciousness-contour" src={COMPANION_ART} alt="" style={{ filter: `url(#${filterId})` }} />}
      <div className="consciousness-mist" />
      <div className="consciousness-ghost"><span>MAP</span><i /><small>欢迎来到智能体工作空间</small></div>
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
  return <div className={`identity-scanner is-${phase}`} aria-hidden="true">
    <svg viewBox="0 0 560 560" fill="none">
      <g className="identity-ring-outer"><circle cx="280" cy="280" r="252" stroke="currentColor" strokeWidth="5" strokeDasharray="970 615" strokeLinecap="round" /><circle cx="519" cy="360" r="7" fill="currentColor" /></g>
      <g className="identity-ring-inner"><circle cx="280" cy="280" r="219" stroke="var(--cinema-light)" strokeWidth="1.5" strokeDasharray="720 656" /><circle cx="280" cy="61" r="4" fill="var(--cinema-light)" /></g>
      <circle cx="280" cy="280" r="184" stroke="currentColor" opacity="0.2" strokeWidth="0.6" strokeDasharray="1 7" />
      <g className="identity-ring-dots" fill="var(--cinema-amber)"><circle cx="163" cy="98" r="3" /><circle cx="450" cy="148" r="3" /><circle cx="164" cy="466" r="3" /></g>
      <path d="M25 280H43M517 280H535M280 25V43M280 517V535" stroke="currentColor" opacity="0.3" />
    </svg>
  </div>;
}
