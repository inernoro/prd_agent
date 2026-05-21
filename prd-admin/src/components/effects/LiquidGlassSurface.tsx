import { memo, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { MeshTransmissionMaterial } from '@react-three/drei';
import type { Group } from 'three';

/**
 * 真液态大玻璃 —— 基于 @react-three/drei 的 MeshTransmissionMaterial,做 WebGL 真折射。
 *
 * 设计取舍(对比 CSS backdrop-filter 的"假玻璃"):
 *   1. WebGL 渲染只能采样 R3F 场景内的内容,无法直接折射 DOM。
 *      所以我们在 canvas 内部摆几颗漂移的彩色 blob 当"液体",
 *      前景一块 plane 做玻璃,refract 这几颗 blob —— 视觉上是
 *      "一小块液体被封在玻璃里",和 macOS 26 / iOS 18 的液态玻璃同源。
 *   2. canvas 绝对定位铺满父容器,父容器自带 overflow-hidden + rounded
 *      会自然把 canvas 裁成圆角玻璃面。
 *   3. 性能:单实例 + orthographic camera + dpr [1, 1.5] 上限,小尺寸面板
 *      可稳定 60fps;若需禁用 Reduce Motion 默认关掉动画。
 *
 * 用法:
 *   <div className="relative overflow-hidden rounded-2xl">
 *     <LiquidGlassSurface />
 *     <div className="relative z-[1]">{children}</div>
 *   </div>
 */

export type LiquidGlassTone = 'cool' | 'warm' | 'aurora' | 'mono';

interface BlobSpec {
  color: string;
  radius: number;
  seed: number;
  z: number;
}

const TONE_PRESETS: Record<LiquidGlassTone, BlobSpec[]> = {
  // 冷色:科技感蓝紫(默认,匹配 ShareDock 的 sky/violet/indigo 槽位调色)
  cool: [
    { color: '#38bdf8', radius: 0.95, seed: 0.0, z: -1.0 },
    { color: '#a855f7', radius: 0.75, seed: 1.7, z: -1.3 },
    { color: '#6366f1', radius: 0.85, seed: 3.1, z: -0.9 },
  ],
  warm: [
    { color: '#fb923c', radius: 0.95, seed: 0.0, z: -1.0 },
    { color: '#f43f5e', radius: 0.75, seed: 1.7, z: -1.3 },
    { color: '#fbbf24', radius: 0.85, seed: 3.1, z: -0.9 },
  ],
  aurora: [
    { color: '#22d3ee', radius: 0.9, seed: 0.0, z: -1.0 },
    { color: '#a855f7', radius: 0.7, seed: 1.7, z: -1.3 },
    { color: '#34d399', radius: 0.8, seed: 3.1, z: -0.9 },
  ],
  mono: [
    { color: '#94a3b8', radius: 0.9, seed: 0.0, z: -1.0 },
    { color: '#cbd5e1', radius: 0.7, seed: 1.7, z: -1.3 },
    { color: '#64748b', radius: 0.8, seed: 3.1, z: -0.9 },
  ],
};

function FloatingBlobs({ specs, animated }: { specs: BlobSpec[]; animated: boolean }) {
  const groupRef = useRef<Group>(null);

  useFrame((state) => {
    if (!animated || !groupRef.current) return;
    const t = state.clock.elapsedTime;
    groupRef.current.children.forEach((child, i) => {
      const spec = specs[i];
      if (!spec) return;
      // 三角函数错相位飘动,让几颗 blob 不会同步
      child.position.x = Math.sin(t * 0.32 + spec.seed) * 1.4;
      child.position.y = Math.cos(t * 0.41 + spec.seed * 1.3) * 0.95;
    });
  });

  return (
    <group ref={groupRef}>
      {specs.map((s, i) => (
        <mesh key={i} position={[0, 0, s.z]}>
          <sphereGeometry args={[s.radius, 24, 24]} />
          <meshBasicMaterial color={s.color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function GlassPlane() {
  return (
    <mesh position={[0, 0, 0]}>
      <planeGeometry args={[10, 10, 1, 1]} />
      {/* MeshTransmissionMaterial 参数:
       * - thickness 0.6:中等厚度,有可见的折射强度但不会过分扭曲
       * - roughness 0.08:接近镜面,略带磨砂感
       * - chromaticAberration 0.04:轻微色散,像真玻璃边缘的彩虹
       * - ior 1.4:玻璃常用折射率(水 1.33,玻璃 1.5,这里取中间值更柔和)
       * - distortion 0.25 + temporalDistortion 0.08:轻微随时间扰动,让液体感更强
       * - transmission 1:完全透过(否则会变成磨砂)
       */}
      <MeshTransmissionMaterial
        thickness={0.6}
        roughness={0.08}
        chromaticAberration={0.04}
        anisotropy={0.1}
        distortion={0.25}
        distortionScale={0.5}
        temporalDistortion={0.08}
        ior={1.4}
        transmission={1}
        backside={false}
        samples={6}
        resolution={256}
      />
    </mesh>
  );
}

interface LiquidGlassSurfaceProps {
  tone?: LiquidGlassTone;
  /** 关闭动画(配合 prefers-reduced-motion 或低端机检测) */
  animated?: boolean;
  className?: string;
}

function LiquidGlassSurfaceImpl({
  tone = 'cool',
  animated = true,
  className,
}: LiquidGlassSurfaceProps) {
  const specs = useMemo(() => TONE_PRESETS[tone], [tone]);

  return (
    <div
      aria-hidden
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        // 父容器的 border-radius 会通过 overflow-hidden 自动裁剪 canvas
        zIndex: 0,
      }}
    >
      <Canvas
        orthographic
        camera={{ position: [0, 0, 5], zoom: 80 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <ambientLight intensity={1.2} />
        <FloatingBlobs specs={specs} animated={animated} />
        <GlassPlane />
      </Canvas>
    </div>
  );
}

/** memo 包装:ShareDock 父组件因拖动/折叠频繁 setState,避免触发 R3F canvas 重挂载 */
export const LiquidGlassSurface = memo(LiquidGlassSurfaceImpl);
