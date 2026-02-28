import { Canvas, useFrame } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useVisibility } from '@/hooks/useVisibility';

type AttentionLandscapeMetrics = {
  ttfbP50Ms?: number | null;
  ttfbP95Ms?: number | null;
  cacheHitRate?: number | null; // 0-1
  tokenTotal?: number | null;
};

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function isWebglSupported(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl') ||
      canvas.getContext('webgl2');
    return Boolean(gl);
  } catch {
    return false;
  }
}

function Landscape({
  metrics,
}: {
  metrics: AttentionLandscapeMetrics;
}) {
  const matRef = useRef<THREE.ShaderMaterial | null>(null);

  const uniforms = useMemo(() => {
    const m = metrics;
    const cache = clamp01(Number.isFinite(m.cacheHitRate as number) ? (m.cacheHitRate as number) : 0);
    const p50 = Number.isFinite(m.ttfbP50Ms as number) ? (m.ttfbP50Ms as number) : 650;
    const p95 = Number.isFinite(m.ttfbP95Ms as number) ? (m.ttfbP95Ms as number) : 1800;
    const tok = Number.isFinite(m.tokenTotal as number) ? (m.tokenTotal as number) : 0;

    // normalize to 0..1 ranges for shader params
    const speedN = clamp01(1 - p50 / 2000); // faster -> higher
    const turbulenceN = clamp01(p95 / 5000); // larger tail -> more turbulence
    const tokenN = clamp01(Math.log10(Math.max(1, tok)) / 6); // ~ up to 1e6

    return {
      uTime: { value: 0 },
      uSpeed: { value: 0.35 + 0.85 * speedN },
      uTurbulence: { value: 0.12 + 0.65 * turbulenceN },
      uCache: { value: cache },
      uToken: { value: tokenN },
    };
  }, [metrics]);

  const material = useMemo(() => {
    const vertexShader = `
      precision highp float;
      varying vec2 vUv;
      varying float vH;
      uniform float uTime;
      uniform float uSpeed;
      uniform float uTurbulence;
      uniform float uCache;
      uniform float uToken;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
          v += a * noise(p);
          p *= 2.0;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vUv = uv;
        vec3 pos = position;

        // layered ridges to mimic "attention layers"
        float t = uTime * uSpeed;
        vec2 p = uv * vec2(7.0, 6.0);
        float n = fbm(p + vec2(t * 0.20, -t * 0.12));
        float n2 = fbm(p * 1.8 + vec2(-t * 0.28, t * 0.22));

        float ridges = smoothstep(0.46, 0.72, abs(sin((uv.y + n * 0.08) * 18.0)));
        float layers = mix(0.12, 0.28, uToken);
        float amp = layers + uTurbulence * 0.38;

        float h = (n * 0.55 + n2 * 0.45) * amp + ridges * (0.08 + 0.10 * uCache);
        h -= (1.0 - uCache) * 0.04; // worse cache -> slightly deeper valleys
        vH = h;

        pos.z += h;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `;

    const fragmentShader = `
      precision highp float;
      varying vec2 vUv;
      varying float vH;
      uniform float uCache;
      uniform float uToken;

      void main() {
        // palette: cyan -> green -> gold, driven by height + cache
        vec3 c0 = vec3(0.08, 0.62, 0.70); // cyan
        vec3 c1 = vec3(0.48, 0.86, 0.30); // green
        vec3 c2 = vec3(0.95, 0.84, 0.60); // gold

        float h = clamp(vH * 3.8 + 0.35, 0.0, 1.0);
        float k = clamp(0.25 + 0.65 * uCache + 0.25 * uToken, 0.0, 1.0);

        vec3 col = mix(c0, c1, smoothstep(0.15, 0.72, h));
        col = mix(col, c2, smoothstep(0.55, 1.0, h) * k);

        // subtle layer banding
        float band = smoothstep(0.92, 0.98, abs(sin((vUv.y + vUv.x * 0.25) * 28.0)));
        col += c2 * band * 0.08;

        // vignette
        float v = smoothstep(1.15, 0.55, length(vUv * 2.0 - 1.0));
        col *= v;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    const m = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: false,
      side: THREE.DoubleSide,
    });
    return m;
  }, [uniforms]);

  useEffect(() => {
    matRef.current = material;
    return () => material.dispose();
  }, [material]);

  useFrame((_state, dt) => {
    if (!matRef.current) return;
    matRef.current.uniforms.uTime.value += dt;
  });

  return (
    <group rotation={[-0.62, 0.0, 0.0]} position={[0, -0.35, 0]}>
      <mesh>
        <planeGeometry args={[3.2, 2.2, 180, 140]} />
        <primitive object={material} attach="material" />
      </mesh>
      {/* subtle fog feel via translucent overlay plane */}
      <mesh position={[0, 0, 0.14]}>
        <planeGeometry args={[3.35, 2.35, 1, 1]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.18} />
      </mesh>
    </group>
  );
}

export default function AttentionLandscape({
  className,
  metrics,
}: {
  className?: string;
  metrics: AttentionLandscapeMetrics;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const visible = useVisibility();
  const [webglOk, setWebglOk] = useState(true);

  useEffect(() => {
    setWebglOk(isWebglSupported());
  }, []);

  if (prefersReducedMotion || !webglOk) {
    return (
      <div
        className={className}
        aria-hidden
        style={{
          width: '100%',
          height: '100%',
          background:
            'radial-gradient(560px 340px at 50% 46%, rgba(34, 211, 238, 0.12) 0%, rgba(34, 197, 94, 0.06) 34%, transparent 72%), radial-gradient(900px 680px at 50% 60%, rgba(242, 213, 155, 0.10) 0%, transparent 68%), rgba(255,255,255,0.02)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 14,
        }}
      />
    );
  }

  return (
    <div className={className} style={{ width: '100%', height: '100%', position: 'relative' }} aria-hidden>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          borderRadius: 14,
          background:
            'radial-gradient(700px 520px at 55% 45%, rgba(255,255,255,0.035) 0%, transparent 68%), radial-gradient(900px 680px at 50% 55%, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.35) 72%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      <Suspense fallback={null}>
        <Canvas
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          camera={{ position: [0, 0.15, 2.2], fov: 48, near: 0.1, far: 50 }}
          frameloop={visible ? 'always' : 'never'}
        >
          <ambientLight intensity={0.55} />
          <directionalLight position={[3, 2, 1]} intensity={0.55} color="#a5b4fc" />
          <pointLight position={[-1.6, 0.6, 1.8]} intensity={0.45} color="#22d3ee" />
          <Landscape metrics={metrics} />
        </Canvas>
      </Suspense>
    </div>
  );
}


