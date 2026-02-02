import { useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

export interface ParticleWaveProps {
  particleColor: string;
  backgroundColor: string;
  particleCount: number;
  waveSpeed: number;
}

export const ParticleWave: React.FC<ParticleWaveProps> = ({
  particleColor,
  backgroundColor,
  particleCount,
  waveSpeed,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const particles = Array.from({ length: particleCount }, (_, i) => {
    const baseX = (i / particleCount) * width;
    const phase = (i / particleCount) * Math.PI * 4;

    // Wave animation
    const waveY = Math.sin((frame * waveSpeed * 0.05) + phase) * 80;
    const waveX = Math.cos((frame * waveSpeed * 0.03) + phase * 0.5) * 20;

    // Size pulsation
    const size = interpolate(
      Math.sin((frame * 0.1) + phase),
      [-1, 1],
      [4, 12]
    );

    // Opacity variation
    const opacity = interpolate(
      Math.sin((frame * 0.08) + phase * 1.5),
      [-1, 1],
      [0.3, 1]
    );

    return {
      x: baseX + waveX,
      y: height / 2 + waveY,
      size,
      opacity,
    };
  });

  // Background gradient animation
  const gradientAngle = interpolate(frame, [0, 90], [0, 360]);

  return (
    <div
      style={{
        width,
        height,
        background: `linear-gradient(${gradientAngle}deg, ${backgroundColor}, ${adjustColor(backgroundColor, 20)})`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Particle trail effect */}
      {particles.map((p, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            width: p.size,
            height: p.size,
            borderRadius: '50%',
            backgroundColor: particleColor,
            opacity: p.opacity,
            boxShadow: `0 0 ${p.size * 2}px ${particleColor}`,
            transform: 'translate(-50%, -50%)',
          }}
        />
      ))}

      {/* Central glow */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 200,
          height: 200,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${particleColor}33 0%, transparent 70%)`,
          transform: `translate(-50%, -50%) scale(${1 + Math.sin(frame * 0.05) * 0.2})`,
        }}
      />
    </div>
  );
};

// Helper function to lighten/darken color
function adjustColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export const particleWaveDefaults: ParticleWaveProps = {
  particleColor: '#22d3ee',
  backgroundColor: '#0c1222',
  particleCount: 50,
  waveSpeed: 1,
};
