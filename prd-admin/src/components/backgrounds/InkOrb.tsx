import { useEffect, useRef } from 'react';
import { Renderer, Program, Mesh, Geometry, Camera, Transform } from 'ogl';
import type { OGLRenderingContext } from 'ogl';

/**
 * InkOrb —— 首屏那团会呼吸的墨（真 3D：透视相机 + 顶点位移的球面点云）。
 *
 * 和 `InkFieldBackdrop` 分工：那个是整页的底，这个是首屏的**焦点物**。首页原来
 * 从上到下全是「标题 + 面板」，一个能转的实体都没有，所以怎么排都像模板。
 *
 * 怎么做的：
 *   - 斐波那契球面（黄金角螺旋）撒九千个点，用 gl.POINTS 画成球壳点云
 *   - 顶点沿法线按三维正弦叠加位移 → 缓慢变形的墨团，不是死球
 *   - 加色混合（SRC_ALPHA, ONE）：粒子越密的地方越亮，暗底上自然发光
 *   - 随指针做极小幅度的视差转动（±0.18 弧度），有反应但不追着鼠标跑
 *
 * **为什么是点云不是实心球**：第一版画的是带菲涅尔边缘光的实心球，结果三个毛病一起来 ——
 * 前后两层都开着 alpha 混合，中间糊成一团；两支色相在表面拼出橙蓝斑块，像迷彩；
 * 位移后的轮廓能一眼看见多边形棱角。而墨本来就不是一个实体：**它是散开的**。
 * 换成点云之后这三个毛病同时消失，因为球壳根本没有"面"。
 *
 * 性能纪律同 `AuroraBackground` / `InkFieldBackdrop`，多一条：
 *   - **滚出视口就停**（IntersectionObserver）。首屏之下还有八千多像素，
 *     用户读到尾部时这颗球不该还在后台转。
 */

const VERT = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in float seed;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uAmp;
uniform float uPointScale;

out float vLump;
out float vFade;

/** 两组三维正弦相乘 —— 比引一份 3D simplex 便宜得多，肉眼一样是「有机地鼓包」 */
float lumps(vec3 p, float t) {
  float a = sin(p.x * 2.6 + t * 0.85) * sin(p.y * 2.2 - t * 0.65) * sin(p.z * 2.9 + t * 0.55);
  float b = sin(p.x * 5.1 - t * 0.45) * sin(p.y * 4.7 + t * 0.75) * sin(p.z * 5.3 - t * 0.35);
  return a * 0.62 + b * 0.24;
}

void main() {
  float n = lumps(position, uTime);
  vec3 pos = position + normal * n * uAmp;
  vLump = n;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  /*
   * 背面的粒子压暗：没有深度写入，全靠这个把前后分开，球才有体积。
   * 区间必须罩住 mv.z 的真实取值 —— 相机在 +z，看向 -z，所以顶点的 mv.z 落在
   * 「-(相机距离+最大半径) .. -(相机距离-最大半径)」= 约 -6.8 .. -3.6。
   * 第一版写成 smoothstep(-1.9, 1.2, mv.z)，整个区间都在下界之外，vFade 恒为 0，
   * 于是七千个粒子全部按"最暗的背面"画，屏幕上几乎什么都看不见。
   * 改这里要连着下面 camera.position.z 与球半径一起改。
   */
  vFade = smoothstep(-6.8, -3.6, mv.z);
  gl_Position = projectionMatrix * mv;
  // 透视点径：近大远小，否则整团像贴纸
  // 每颗点粒径略有出入（0.72..1.28），整团才有颗粒感而不是印刷网点
  gl_PointSize = uPointScale * (0.72 + 0.56 * seed) / max(-mv.z, 0.1);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;

in float vLump;
in float vFade;

out vec4 fragColor;

void main() {
  // 方点抠成圆点，边缘再羽化一档 —— 方粒子一眼就看出是 gl.POINTS
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float soft = smoothstep(0.5, 0.12, r);

  // 两支色按鼓包程度渐变。实心球上这么配会拼成斑块，点云上则是弥散的过渡
  vec3 col = mix(uColorA, uColorB, smoothstep(-0.5, 0.55, vLump));
  float alpha = soft * (0.05 + 0.66 * vFade) * uOpacity;
  fragColor = vec4(col * (0.30 + 1.45 * vFade), alpha);
}
`;

/**
 * 斐波那契球面（黄金角螺旋）：把 count 个点均匀撒在球壳上。
 *
 * 不用 ogl 自带的 `Sphere`：那是 UV 球，顶点按经纬排列，画成点云时**能一眼看见
 * 行列条纹**，两极还挤成两坨。黄金角螺旋没有极点、没有行列，每点占的立体角几乎相等，
 * 这是点云球唯一正确的撒点方式。
 *
 * 顺带每点带一个 0..1 的 seed，喂给顶点着色器做粒径抖动。
 */
function fibonacciSphere(gl: OGLRenderingContext, count: number, radius: number) {
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    normal[i * 3] = x; normal[i * 3 + 1] = y; normal[i * 3 + 2] = z;
    position[i * 3] = x * radius; position[i * 3 + 1] = y * radius; position[i * 3 + 2] = z * radius;
    // 确定性伪随机：同一颗点每次刷新粒径一致，不会闪
    seed[i] = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  }
  return new Geometry(gl, {
    position: { size: 3, data: position },
    normal: { size: 3, data: normal },
    seed: { size: 1, data: seed },
  });
}

function toRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export interface InkOrbProps {
  /** 两支墨色：鼓起来的地方一支，凹下去的地方一支 */
  colors: [string, string];
  /** 位移幅度，默认 0.22。超过 0.35 球壳会自穿插，点云糊成一团 */
  amplitude?: number;
  opacity?: number;
  className?: string;
}

export function InkOrb({ colors, amplitude = 0.22, opacity = 1, className }: InkOrbProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ colors, amplitude, opacity });
  propsRef.current = { colors, amplitude, opacity };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({ alpha: true, antialias: true, dpr: Math.min(window.devicePixelRatio || 1, 1.5) });
    } catch {
      return; // 完全没有 WebGL：这块就是空的，首屏文案本身不依赖它
    }
    // 只有 WebGL1 的设备同样得空着：ogl 会静默退回 webgl1，而这里的 shader 是 GLSL ES 3，
    // 编译失败只进 console 不抛异常 —— 不挡的话就是「转着一个什么都不画的渲染循环」
    if (!renderer.isWebgl2) return;
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    // 加色混合：粒子叠在一起越叠越亮，暗底上自成辉光。常规 alpha 混合会把它压成一团灰
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    host.appendChild(gl.canvas);
    gl.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';

    const camera = new Camera(gl, { fov: 34 });
    camera.position.set(0, 0, 5.2);
    const scene = new Transform();

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      transparent: true,
      cullFace: null, // 点云没有面，剔除无意义；关掉省一次状态切换
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: propsRef.current.amplitude },
        uPointScale: { value: 240 },
        uOpacity: { value: propsRef.current.opacity },
        uColorA: { value: toRgb(propsRef.current.colors[0]) },
        uColorB: { value: toRgb(propsRef.current.colors[1]) },
      },
    });

    /*
     * 半径 1.25 + 幅度 0.22：相机 z=5.2、fov=34 时可视高度约 3.18，
     * 最大直径 2.5+0.38 还留得下边距。第一版 1.55/0.30 直接顶出容器。
     */
    const mesh = new Mesh(gl, {
      geometry: fibonacciSphere(gl, 9000, 1.25),
      program,
      mode: gl.POINTS,
    });
    mesh.setParent(scene);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h);
      camera.perspective({ aspect: w / h });
      /*
       * 点径跟着画布**设备像素**高度走（gl_PointSize 的单位就是设备像素），
       * 这样换 DPR 时颗粒粗细看起来一致。系数 0.055 是按「七千个点铺满球面投影后
       * 互相略有重叠」推的：再大就糊成实心球，再小就散成沙。
       * 从 0.055 提到 0.075 是因为换成均匀分布后没有了两极的堆积，整团亮度掉了一档。
       */
      program.uniforms.uPointScale.value = gl.canvas.height * 0.075;
    };
    resize();
    window.addEventListener('resize', resize);

    const target = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      target.x = (e.clientY / window.innerHeight - 0.5) * 0.36;
      target.y = (e.clientX / window.innerWidth - 0.5) * 0.36;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let running = false;
    let onScreen = true;

    const draw = (ms: number) => {
      raf = requestAnimationFrame(draw);
      const t = ms * 0.001;
      program.uniforms.uTime.value = t;
      program.uniforms.uAmp.value = propsRef.current.amplitude;
      program.uniforms.uOpacity.value = propsRef.current.opacity;
      program.uniforms.uColorA.value = toRgb(propsRef.current.colors[0]);
      program.uniforms.uColorB.value = toRgb(propsRef.current.colors[1]);
      mesh.rotation.y += 0.0016;
      mesh.rotation.x += (target.x - mesh.rotation.x) * 0.035;
      mesh.rotation.z += ((target.y * 0.4) - mesh.rotation.z) * 0.035;
      renderer.render({ scene, camera });
    };

    const start = () => {
      if (running || reduceMotion || !onScreen || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(draw);
    };
    const stop = () => { if (running) { running = false; cancelAnimationFrame(raf); } };

    if (reduceMotion) {
      program.uniforms.uTime.value = 6.0;
      renderer.render({ scene, camera });
    } else {
      start();
    }

    /* 滚出首屏就停：底下还有八千像素，没必要一直转 */
    const io = new IntersectionObserver(
      ([entry]) => { onScreen = entry.isIntersecting; if (onScreen) start(); else stop(); },
      { threshold: 0 },
    );
    io.observe(host);

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointer);
      gl.canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <div ref={hostRef} aria-hidden className={className} />;
}
