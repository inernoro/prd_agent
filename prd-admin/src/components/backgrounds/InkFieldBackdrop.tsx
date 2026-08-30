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

/**
 * 整数位混合 hash（PCG 家族的两轮 LCG + 异或折叠）。
 *
 * 这里**不能**用那个到处抄的 fract(sin(dot(p, k)) * 43758.5453)：它的结果取决于
 * 驱动怎么实现大参数的 sin，各家差得很远。同一份代码在 Apple（ANGLE-Metal）上
 * 是一缕一缕的墨，在 NVIDIA 上整片糊成一层橙——首页背景变成一张暖色滤镜盖住正文。
 * 用户拿两台机器一对照才发现，而在软件渲染（CI / 无头浏览器）上永远复现不出来。
 *
 * 整数运算没有这个自由度：uint 的乘法溢出、移位、异或在 GLSL ES 3.00 里都是逐位
 * 定义好的，任何设备算出来的是同一张噪声图。
 *
 * 只接整数格点（调用方传的都是 floor 之后的值）。负坐标靠 int 转 uint 的补码位形转换，
 * 规范里保证是 mod 2^32，不丢信息。
 */
uvec2 uhash(uvec2 x) {
  x = x * 1664525u + 1013904223u;
  x.x += x.y * 1664525u;
  x.y += x.x * 1664525u;
  x ^= x >> 16u;
  x.x += x.y * 1664525u;
  x.y += x.x * 1664525u;
  x ^= x >> 16u;
  return x;
}

vec2 hash2(vec2 p) {
  return vec2(uhash(uvec2(ivec2(p)))) * (1.0 / 4294967296.0);
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

/**
 * 自检的判据：**墨糊成一层滤镜了吗？**
 *
 * 换成整数 hash 之后，「同一段 shader 在不同显卡上算出不同噪声」这一类原因已经堵掉。
 * 但显卡这么多，谁也不敢说以后不会再有别的算法在某台机器上退化——而退化的后果不是
 * 报错，是首页被一层暖橙盖住、正文变灰，本地和 CI 都复现不出来。所以留一道运行时自检：
 * 画完第一帧读回来看看，糊了就把这层撤掉，回到底下那张纯 CSS 静态底。
 *
 * 判据取「平均不透明度 ÷ 设定浓度」。除以浓度是为了跟着 `intensity` 走，调浓淡不用改阈值。
 * 正常的墨有大片留白，这个比值在 0.2 上下；整片糊住时逼近 1。
 *
 * 不用「明暗差」做判据：`veil` 本身带一条上浓下淡的竖直渐变，就算 f 处处相同也会有差值，
 * 那条判据永远不会红——形状 8，拿一个不成立的证据当证明。
 */
export const INK_FIELD_SATURATION_CEILING = 0.45;

export function isInkFieldSaturated(alphas: readonly number[], intensity: number): boolean {
  if (alphas.length === 0 || !(intensity > 0)) return false;
  let sum = 0;
  for (const a of alphas) sum += a;
  return sum / alphas.length / 255 / intensity > INK_FIELD_SATURATION_CEILING;
}

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
    let dropped = false;

    /**
     * 画完第一帧读回来量一次。糊了就把这层整个撤掉——底下的 StaticBackdrop 就是降级形态，
     * 撤掉之后页面回到改版前的样子，不会开天窗。
     *
     * 只在第一帧做一次，之后不再读回（readPixels 会等 GPU，逐帧做等于自己给自己加同步点）。
     * 取五条横扫描线而不是整帧：`veil` 带竖直渐变，均匀铺开的几条能代表整帧，
     * 而整帧读回在 1.5 DPR 下是十几 MB。
     */
    const selfCheck = () => {
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      if (w < 4 || h < 8) return;
      const alphas: number[] = [];
      const row = new Uint8Array(w * 4);
      for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        gl.readPixels(0, Math.floor(h * frac), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        // 每行抽样，不必逐像素——同一行的噪声已经足够代表这一档高度
        for (let x = 0; x < w; x += 8) alphas.push(row[x * 4 + 3]);
      }
      if (!isInkFieldSaturated(alphas, propsRef.current.intensity)) return;

      dropped = true;
      stop();
      gl.canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      // 说出来。静默降级的话，这台机器上的人只会觉得「首页有时候淡有时候浓」，
      // 而没有任何线索可查（本地和 CI 都复现不出来，正是这条自检存在的理由）。
      console.warn('[InkFieldBackdrop] 这台设备算出的墨场糊成了一片，已撤掉该层，回落到静态背景');
    };

    // 时间以**本次挂载**为原点，不用 rAF 那个「从导航开始算」的时间戳。
    // 两个原因：一是同一份页面每次打开相位一致，截图/视觉回归才可复现；二是噪声的
    // 坐标里带着 t，t 一直涨会把 `floor`/整数 hash 的取值推到很大的量级去。
    let t0 = 0;
    let checked = false;
    const draw = (ms: number) => {
      if (dropped) return;
      raf = requestAnimationFrame(draw);
      if (t0 === 0) t0 = ms;
      const u = program.uniforms;
      u.uTime.value = (ms - t0) * 0.001;
      u.uColorA.value = toRgb(propsRef.current.colors[0]);
      u.uColorB.value = toRgb(propsRef.current.colors[1]);
      u.uColorC.value = toRgb(propsRef.current.colors[2]);
      u.uIntensity.value = propsRef.current.intensity;
      const cur = u.uPointer.value as number[];
      cur[0] += (target.x - cur[0]) * 0.035;
      cur[1] += (target.y - cur[1]) * 0.035;
      renderer.render({ scene: mesh });
      if (!checked) { checked = true; selfCheck(); }
    };

    const start = () => { if (!running && !reduceMotion) { running = true; raf = requestAnimationFrame(draw); } };
    const stop = () => { if (running) { running = false; cancelAnimationFrame(raf); } };

    if (reduceMotion) {
      // 静止一帧：仍然是一片墨，不是空白。降级不该降成"什么都没有"
      program.uniforms.uTime.value = 12.0;
      renderer.render({ scene: mesh });
      // 这条路也要自检：静止的一帧糊住了，就是永远糊着，比动的那条更该撤
      selfCheck();
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
