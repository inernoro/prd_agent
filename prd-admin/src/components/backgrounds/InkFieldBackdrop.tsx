import { useEffect, useRef } from 'react';
import { Renderer, Program, Mesh, Triangle } from 'ogl';

/**
 * InkFieldBackdrop —— 墨在水里散开的全屏流场（WebGL 片元着色器）。
 *
 * 为什么做：首页原来的背景是纯 CSS、零动画、零 canvas 的静态层，整页因此"平"——
 * 十幕内容压在一块死黑板上。用户原话「太单调了，丑陋」。
 *
 * 为什么是「墨」不是粒子/极光：本站的色板本来就叫**八色墨带**，墨在水里化开是这套
 * 颜色自己的物理隐喻。粒子场和极光哪个站都能用，这个只有这里成立。
 *
 * 技术选型：用 `ogl` 而不是 `three`。这是未登录的公开页，ogl 约 10KB、three 约 150KB，
 * 而这里只需要一个全屏三角形 + 一段 shader，three 的场景图完全用不上。
 *
 * 性能纪律照抄同目录的 `AuroraBackground`（那份是 ReactBits 改的，已经驯化过）：
 *   - 标签页隐藏时暂停 rAF，回来再续
 *   - `prefers-reduced-motion` 只渲染一帧（静态墨迹，不是空白）
 *   - DPR 封顶 1.5
 *   - WebGL 拿不到就静默什么都不画 —— 调用方底下垫着 StaticBackdrop，降级即回到原样
 *
 * 强度默认压得很低（0.22）：它是背景，不是主角。压过正文就是失败。
 */

const VERT = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform vec2  uPointer;    // 0..1，已按宽高比校正前的原始比例
uniform vec3  uColorA;     // 陶土
uniform vec3  uColorB;     // 松绿
uniform vec3  uColorC;     // 钢青
uniform float uIntensity;

out vec4 fragColor;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

/** 梯度噪声，值域约 [-0.7, 0.7] */
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(hash2(i)              * 2.0 - 1.0, f);
  float b = dot(hash2(i + vec2(1, 0)) * 2.0 - 1.0, f - vec2(1, 0));
  float c = dot(hash2(i + vec2(0, 1)) * 2.0 - 1.0, f - vec2(0, 1));
  float d = dot(hash2(i + vec2(1, 1)) * 2.0 - 1.0, f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** 四阶 fbm。再多一阶肉眼看不出，但整屏逐帧要多算一遍 —— 背景不值这个钱 */
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * gnoise(p); p *= 2.02; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  float t = uTime * 0.055;

  // 两次 domain warp：墨不是平移，是自己卷着走
  vec2 q = vec2(fbm(p * 1.5 + t),                      fbm(p * 1.5 + vec2(3.2, 1.7) - t));
  vec2 r = vec2(fbm(p * 1.5 + 2.0 * q + vec2(1.7, 9.2) + t * 0.7),
                fbm(p * 1.5 + 2.0 * q + vec2(8.3, 2.8) - t * 0.6));
  float f = fbm(p * 1.5 + 2.2 * r);

  // 指针处轻轻鼓起来一块 —— 页面对鼠标有反应，但不追着跑
  vec2 pp = vec2(uPointer.x * aspect, uPointer.y);
  float d = distance(p, pp);
  f += exp(-d * d * 3.0) * 0.30;

  // 主体只在 A↔B 之间走（陶土↔钢青，本站的暖石墨基调）；
  // C 是稀有点缀 —— 阈值抬到 0.62 起步，第一版写 0.42 时它几乎铺满整屏，
  // 整页被染成一片浑绿，比原来的死黑还糟。
  vec3 col = mix(uColorA, uColorB, smoothstep(0.10, 0.80, f + 0.30));
  col = mix(col, uColorC, smoothstep(0.62, 1.25, length(r)) * 0.55);

  // 起点从 0.05 抬到 0.20：墨要聚成一缕一缕，中间留出干净的暗部。
  // 均匀铺满时不像墨，像脏。
  float veil = smoothstep(0.20, 0.95, f + 0.35) * uIntensity;
  // 上浓下淡：首屏是主场，越往下越让位给内容
  veil *= mix(0.30, 1.0, uv.y);

  fragColor = vec4(col, veil);
}
`;

/** '#RRGGBB' → [0..1, 0..1, 0..1]。只认六位 hex，调用方传的都是 token 里的固定值。 */
function toRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export interface InkFieldBackdropProps {
  /** 三支墨色，从调用方传 —— 让色值留在受 no-purple 守卫扫描的那一侧 */
  colors: [string, string, string];
  /** 整体浓度，默认 0.22。往上调之前先看一眼正文还读不读得清 */
  intensity?: number;
  className?: string;
}

export function InkFieldBackdrop({ colors, intensity = 0.22, className }: InkFieldBackdropProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  /* 颜色/浓度走 ref：改这两个值不该重建 WebGL 上下文 */
  const propsRef = useRef({ colors, intensity });
  propsRef.current = { colors, intensity };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({ alpha: true, antialias: false, dpr: Math.min(window.devicePixelRatio || 1, 1.5) });
    } catch {
      return; // 完全没有 WebGL：什么都不画，底下的 StaticBackdrop 就是降级形态
    }
    // 只有 WebGL1 的设备也要走同一条降级路。ogl 拿不到 webgl2 会**静默退回** webgl1：
    // 构造函数照样成功、不抛异常，但下面两段 shader 是 GLSL ES 3（`#version 300 es`），
    // 在 webgl1 上编译失败——而 ogl 的 Program 只把编译错误打进 console，不抛。
    // 于是 canvas 挂上了、rAF 循环转起来了、一个像素都不画。这里挡住，回到静态底。
    if (!renderer.isWebgl2) return;
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    host.appendChild(gl.canvas);
    gl.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: [1, 1] },
        uPointer: { value: [0.5, 0.62] },
        uColorA: { value: toRgb(propsRef.current.colors[0]) },
        uColorB: { value: toRgb(propsRef.current.colors[1]) },
        uColorC: { value: toRgb(propsRef.current.colors[2]) },
        uIntensity: { value: propsRef.current.intensity },
      },
    });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    const resize = () => {
      renderer.setSize(host.clientWidth, host.clientHeight);
      program.uniforms.uResolution.value = [gl.canvas.width, gl.canvas.height];
    };
    resize();
    window.addEventListener('resize', resize);

    /* 指针目标值与当前值分开存，逐帧插值 —— 直接跟手会显得神经质 */
    const target = { x: 0.5, y: 0.62 };
    const onPointer = (e: PointerEvent) => {
      target.x = e.clientX / window.innerWidth;
      target.y = 1 - e.clientY / window.innerHeight; // gl 的 y 轴自下而上
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let running = false;

    const draw = (ms: number) => {
      raf = requestAnimationFrame(draw);
      const u = program.uniforms;
      u.uTime.value = ms * 0.001;
      u.uColorA.value = toRgb(propsRef.current.colors[0]);
      u.uColorB.value = toRgb(propsRef.current.colors[1]);
      u.uColorC.value = toRgb(propsRef.current.colors[2]);
      u.uIntensity.value = propsRef.current.intensity;
      const cur = u.uPointer.value as number[];
      cur[0] += (target.x - cur[0]) * 0.035;
      cur[1] += (target.y - cur[1]) * 0.035;
      renderer.render({ scene: mesh });
    };

    const start = () => { if (!running && !reduceMotion) { running = true; raf = requestAnimationFrame(draw); } };
    const stop = () => { if (running) { running = false; cancelAnimationFrame(raf); } };

    if (reduceMotion) {
      // 静止一帧：仍然是一片墨，不是空白。降级不该降成"什么都没有"
      program.uniforms.uTime.value = 12.0;
      renderer.render({ scene: mesh });
    } else {
      start();
    }

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointer);
      gl.canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <div ref={hostRef} aria-hidden className={className} />;
}
