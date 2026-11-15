import { memo, useRef, type CSSProperties } from 'react';
import './orbital-entry.css';

// Reference: 19.3s consciousness-OS film. 1px contours, wide whitespace,
// concentric acquisition rings. Native vector geometry stays sharp in both skins.
const contours = Array.from({ length: 38 }, (_, index) => {
  const phase = (index / 38) * Math.PI * 2;
  const points = Array.from({ length: 181 }, (_, step) => {
    const t = (step / 180) * Math.PI * 2;
    const radius = 146 + 28 * Math.sin(3 * t + phase);
    const x = 300 + radius * Math.cos(t) * Math.cos(phase) - 36 * Math.sin(t) * Math.sin(phase);
    const y = 300 + radius * Math.sin(t);
    return `${step === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `${points.join(' ')} Z`;
});

export const OrbitalInstrument = memo(function OrbitalInstrument({ compact = false, active = false }: { compact?: boolean; active?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={root}
      className={`orbital-instrument${compact ? ' is-compact' : ''}${active ? ' is-active' : ''}`}
      aria-hidden="true"
      onPointerMove={compact ? undefined : (event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        root.current?.style.setProperty('--orbital-x', `${((event.clientX - bounds.left) / bounds.width - 0.5) * 12}deg`);
        root.current?.style.setProperty('--orbital-y', `${((event.clientY - bounds.top) / bounds.height - 0.5) * -12}deg`);
      }}
      onPointerLeave={() => {
        root.current?.style.setProperty('--orbital-x', '0deg');
        root.current?.style.setProperty('--orbital-y', '0deg');
      }}
    >
      <svg viewBox="0 0 600 600" fill="none" className="orbital-instrument-art">
        <g stroke="currentColor" strokeWidth="0.7">
          <circle cx="300" cy="300" r="236" opacity="0.2" />
          <circle cx="300" cy="300" r="219" strokeDasharray="1 6" opacity="0.5" />
          <circle cx="300" cy="300" r="201" opacity="0.2" />
          {Array.from({ length: 72 }, (_, i) => (
            <path key={i} d={`M300 ${i % 6 === 0 ? 53 : 59}V66`} transform={`rotate(${i * 5} 300 300)`} opacity={i % 6 === 0 ? 0.8 : 0.3} />
          ))}
          <path d="M300 35V78M300 522V565M35 300H78M522 300H565" opacity="0.5" />
          <path d="M60 110V90H80M520 90H540V110M60 490V510H80M520 510H540V490" opacity="0.5" />
        </g>
        <g className="orbital-core" stroke="currentColor" strokeWidth="0.65" opacity="0.64">
          {contours.map((d, i) => <path key={i} d={d} />)}
        </g>
        <g className="orbital-orbit" stroke="currentColor" strokeWidth="0.9">
          <ellipse cx="300" cy="300" rx="274" ry="64" transform="rotate(-24 300 300)" />
          <circle cx="550" cy="189" r="3" fill="currentColor" stroke="none" />
          <circle cx="50" cy="411" r="3" fill="currentColor" stroke="none" />
        </g>
        <g className="orbital-scan" stroke="currentColor" strokeWidth="2">
          <circle cx="300" cy="300" r="229" strokeDasharray="90 1350" />
        </g>
        <circle className="orbital-center" cx="300" cy="300" r="5" fill="currentColor" />
        <path d="M282 300H318M300 282V318" stroke="currentColor" strokeWidth="0.7" />
      </svg>
      {!compact && <div className="orbital-instrument-caption"><span>IDEA</span><span>INTELLIGENCE</span><span>REALITY</span></div>}
    </div>
  );
});

export function OrbitalWorkspaceSignature() {
  return <div className="orbital-workspace-signature" style={{ '--orbital-x': '0deg' } as CSSProperties}><OrbitalInstrument compact /></div>;
}
