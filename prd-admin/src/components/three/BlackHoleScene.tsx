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

      void main() {
        vec2 uv = vUv;
        vec2 p = uv * 2.0 - 1.0;

        // subtle pointer parallax (screen-space)
        vec2 ptr = (uPointer * 2.0 - 1.0) * 0.18;
        p += ptr;

        float r = length(p);
        float a = atan(p.y, p.x);

        // swirl
        float swirl = 0.55 * sin(uTime * 0.55) + 0.35;
        a += swirl * (1.0 / (r + 0.35));

        // accretion band around radius ~0.45
        float band = smoothstep(0.62, 0.40, abs(r - 0.45));
        float core = smoothstep(0.22, 0.06, r);
        float falloff = smoothstep(1.2, 0.2, r);

        float n = noise(vec2(a * 3.0, r * 6.5 + uTime * 0.8));
        float streak = smoothstep(0.35, 1.0, n);

        vec3 gold = vec3(0.84, 0.70, 0.42);
        vec3 gold2 = vec3(0.95, 0.84, 0.60);
        vec3 teal = vec3(0.12, 0.42, 0.60);

        vec3 col = vec3(0.0);
        col += (gold * 0.85 + gold2 * 0.35 * streak) * band * falloff;
        col += teal * (0.18 * band) * (0.4 + 0.6 * streak);

        // central "black hole" absorbs light
        col *= (1.0 - core);

        // outer vignette
        col *= smoothstep(1.2, 0.55, r);

        float glow = pow(smoothstep(0.78, 0.25, abs(r - 0.55)), 1.35);
        col += gold2 * glow * 0.22;

        float alpha = clamp((band * 0.72 + glow * 0.32) * uIntensity, 0.0, 0.96);
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
        <meshStandardMaterial color="#050507" roughness={0.9} metalness={0.1} />
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

      <Stars radius={80} depth={40} count={7000} factor={3} saturation={0} fade speed={0.6} />
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
    const onMove = (e: PointerEvent) => {
      const x = clamp(e.clientX / window.innerWidth, 0, 1);
      const y = clamp(e.clientY / window.innerHeight, 0, 1);
      targetPointer.current.set(x, 1 - y);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

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
          dpr={[1, 2]}
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


