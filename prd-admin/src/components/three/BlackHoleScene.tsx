import { Canvas, useFrame } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useVisibility } from '@/hooks/useVisibility';

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function BlackHoleDisk({
  targetPointer,
  intensity = 1,
}: {
  targetPointer: THREE.Vector2;
  intensity?: number;
}) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const matRef = useRef<THREE.ShaderMaterial | null>(null);

  const uniforms = useMemo(() => {
    return {
      uTime: { value: 0 },
      uPointer: { value: new THREE.Vector2(0, 0) },
      uIntensity: { value: intensity },
      uResolution: { value: new THREE.Vector2(1, 1) },
    };
  }, [intensity]);

  const material = useMemo(() => {
    const vertexShader = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const fragmentShader = `
      precision highp float;
      varying vec2 vUv;
      uniform float uTime;
      uniform vec2 uPointer;
      uniform float uIntensity;
      uniform vec2 uResolution;

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
        float a = 0.55;
        // fixed loop for WebGL1
        for (int i = 0; i < 5; i++) {
          v += a * noise(p);
          p = p * 2.02 + vec2(17.7, 9.2);
          a *= 0.52;
        }
        return v;
      }

      void main() {
        vec2 uv = vUv;
        vec2 p = uv * 2.0 - 1.0;
        // keep circular metrics under non-square aspect
        float aspect = max(uResolution.x / max(uResolution.y, 1.0), 0.001);
        p.x *= aspect;

        // subtle pointer parallax (screen-space)
        vec2 ptr = (uPointer * 2.0 - 1.0) * 0.18;
        p += ptr;

        float r = length(p);
        float a = atan(p.y, p.x);

        // swirl (stronger near center)
        float swirl = 0.65 + 0.25 * sin(uTime * 0.22);
        a += swirl * (1.0 / (r + 0.26));

        // black core (harder silhouette, like Grok eclipse)
        float core = smoothstep(0.215, 0.10, r);
        float lensRing = exp(-pow((r - 0.235) / 0.020, 2.0));

        // accretion disk (tight bright band)
        float disk = exp(-pow((r - 0.43) / 0.050, 2.0));
        float diskThin = exp(-pow((r - 0.43) / 0.020, 2.0));

        // cloudy nebula
        float side = smoothstep(-0.9, 1.1, p.x * 0.9); // bias brightness to the right
        float flow = uTime * 0.06;
        float gas1 = fbm(vec2(a * 1.1 + flow * 1.4, r * 3.2 - flow * 2.0));
        float gas2 = fbm(vec2(a * 2.2 - flow * 1.0, r * 5.4 + flow * 1.2));
        float gas = mix(gas1, gas2, 0.45);
        gas = smoothstep(0.20, 0.88, gas);

        // streaky turbulence in the disk
        float streak = fbm(vec2(a * 6.0 + uTime * 0.55, r * 9.0));
        streak = smoothstep(0.35, 0.92, streak);

        // palette (warm gold + smoky cream + hint of cool)
        vec3 gold = vec3(0.86, 0.72, 0.44);
        vec3 cream = vec3(0.95, 0.88, 0.72);
        vec3 smoke = vec3(0.14, 0.16, 0.18);
        vec3 cool = vec3(0.20, 0.38, 0.58);

        // base background haze (mostly dark)
        vec3 col = smoke * 0.14;

        // outer nebula: broad, soft cloud volumes
        float outerMask = smoothstep(1.25, 0.35, r);
        float neb = gas * outerMask * (0.35 + 0.85 * side);
        col += mix(smoke, gold, 0.85) * neb * 0.55;
        col += cream * neb * 0.18;
        col += cool * neb * (0.06 + 0.08 * (1.0 - side));

        // disk contribution
        col += (gold * (0.70 + 0.55 * streak) + cream * 0.22) * disk * (0.55 + 0.65 * side);
        col += cream * diskThin * (0.22 + 0.35 * streak);

        // lensing ring glow hugging the core
        col += cream * lensRing * 0.25;
        col += gold * lensRing * (0.10 + 0.12 * side);

        // central "black hole" absorbs light
        col *= (1.0 - core);

        // vignette
        col *= smoothstep(1.30, 0.62, r);

        // alpha: keep additive soft
        float alphaBase = (neb * 0.55 + disk * 0.65 + lensRing * 0.35);
        float alpha = clamp(alphaBase * uIntensity, 0.0, 0.92);
        gl_FragColor = vec4(col, alpha);
      }
    `;

    const m = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return m;
  }, [uniforms]);

  useEffect(() => {
    matRef.current = material;
    return () => {
      material.dispose();
    };
  }, [material]);

  useFrame((state, dt) => {
    if (!matRef.current) return;
    matRef.current.uniforms.uTime.value += dt;
    // smooth pointer
    const cur = matRef.current.uniforms.uPointer.value as THREE.Vector2;
    cur.lerp(targetPointer, 0.08);
    matRef.current.uniforms.uIntensity.value = intensity;
    matRef.current.uniforms.uResolution.value.set(state.size.width, state.size.height);

    // keep disk facing camera
    if (meshRef.current) {
      meshRef.current.rotation.z = state.clock.elapsedTime * 0.06;
    }
  });

  return (
    <mesh ref={meshRef} position={[0.2, 0.0, 0]} rotation={[0, 0, 0]} scale={[1.55, 1.55, 1]}>
      <planeGeometry args={[3.2, 3.2, 1, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

function BlackHoleCore() {
  const coreRef = useRef<THREE.Mesh | null>(null);
  useFrame((state) => {
    if (!coreRef.current) return;
    const t = state.clock.elapsedTime;
    coreRef.current.scale.setScalar(1 + 0.02 * Math.sin(t * 0.8));
  });
  return (
    <group position={[0.2, 0, 0.2]}>
      <mesh ref={coreRef}>
        <sphereGeometry args={[0.22, 48, 48]} />
        <meshBasicMaterial color="#050507" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.36, 48, 48]} />
        <meshBasicMaterial color="#f2d59b" transparent opacity={0.06} />
      </mesh>
    </group>
  );
}

function Scene({
  pointer01,
  intensity,
}: {
  pointer01: THREE.Vector2;
  intensity: number;
}) {
  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[3, 2, 2]} intensity={0.55} color="#f2d59b" />
      <pointLight position={[0.2, 0, 1.5]} intensity={0.8} color="#d6b26a" distance={6} />

      <Stars radius={80} depth={40} count={3200} factor={3} saturation={0} fade speed={0.45} />
      <BlackHoleDisk targetPointer={pointer01} intensity={intensity} />
      <BlackHoleCore />
    </>
  );
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

export default function BlackHoleScene({
  className,
}: {
  className?: string;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const visible = useVisibility();
  const [webglOk, setWebglOk] = useState(true);
  const dpr = useMemo(() => clamp(window.devicePixelRatio || 1, 1, 1.5), []);

  const pointer01 = useMemo(() => new THREE.Vector2(0.5, 0.5), []);
  const targetPointer = useRef(new THREE.Vector2(0.5, 0.5));
  const [intensity, setIntensity] = useState(0);

  useEffect(() => {
    setWebglOk(isWebglSupported());
  }, []);

  useEffect(() => {
    // slow fade in
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / 4200;
      setIntensity(clamp(t, 0, 1));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion || !webglOk) return;
    const onMove = (e: PointerEvent) => {
      const x = clamp(e.clientX / window.innerWidth, 0, 1);
      const y = clamp(e.clientY / window.innerHeight, 0, 1);
      targetPointer.current.set(x, 1 - y);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [prefersReducedMotion, webglOk]);

  useRaf(() => pointer01.lerp(targetPointer.current, 0.12), prefersReducedMotion || !visible);

  // fallback: static, no WebGL or reduced motion
  if (prefersReducedMotion || !webglOk) {
    return (
      <div
        className={className}
        aria-hidden
        style={{
          width: '100%',
          height: '100%',
          background:
            'radial-gradient(520px 520px at 55% 48%, rgba(242, 213, 155, 0.14) 0%, rgba(214, 178, 106, 0.06) 26%, transparent 62%), radial-gradient(1200px 900px at 70% 50%, rgba(255,255,255,0.05) 0%, transparent 62%), radial-gradient(900px 680px at 50% 55%, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.45) 72%, rgba(0,0,0,0.65) 100%)',
        }}
      />
    );
  }

  return (
    <div className={className} style={{ width: '100%', height: '100%', position: 'relative' }} aria-hidden>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(900px 700px at 58% 52%, rgba(242, 213, 155, 0.10) 0%, transparent 64%), radial-gradient(1200px 900px at 70% 55%, rgba(255,255,255,0.05) 0%, transparent 68%), radial-gradient(900px 680px at 55% 50%, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.45) 72%, rgba(0,0,0,0.70) 100%)',
          opacity: 0.9,
        }}
      />
      <Suspense fallback={null}>
        <Canvas
          dpr={dpr}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          camera={{ position: [0, 0, 2.6], fov: 50, near: 0.1, far: 200 }}
          frameloop={visible ? 'always' : 'never'}
        >
          <Scene pointer01={pointer01} intensity={intensity} />
        </Canvas>
      </Suspense>
    </div>
  );
}

function useRaf(fn: () => void, paused: boolean) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (paused) return;
    let raf = 0;
    const tick = () => {
      fnRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused]);
}


