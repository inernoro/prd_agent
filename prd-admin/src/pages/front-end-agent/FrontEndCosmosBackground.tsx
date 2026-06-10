import { NightSkyBackground } from '@/components/effects/NightSkyBackground';
import { ParticleVortex } from '@/components/effects/ParticleVortex';

/**
 * 对齐视觉创作智能体：夜景 Canvas + 靛紫粒子漩涡。
 */
export function FrontEndCosmosBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <NightSkyBackground mode="container" />
      <div
        className="absolute inset-0"
        style={{
          maskImage: 'radial-gradient(ellipse 75% 55% at 50% 28%, black 10%, transparent 82%)',
          WebkitMaskImage: 'radial-gradient(ellipse 75% 55% at 50% 28%, black 10%, transparent 82%)',
        }}
      >
        <ParticleVortex
          particleCount={180}
          mouseFollow
          trailColor="rgba(10,10,12,0.9)"
          sizeRange={[1, 3]}
          hueRange={[230, 280]}
          className="absolute inset-0"
        />
      </div>
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(99,102,241,0.08) 0%, transparent 70%)',
        }}
      />
    </div>
  );
}
