import { useEffect, useRef } from 'react';
import { Renderer, Program, Mesh, Color, Triangle } from 'ogl';

/**
 * AuroraBackground — 流动极光氛围背景（WebGL 片元着色器）。
 *
 * 改编自 ReactBits Aurora（https://reactbits.dev/backgrounds/aurora, MIT）。
 * MAP 驯化（性能纪律，对齐首页"零失控动画"底线）：
 * - 标签页隐藏 / 容器滚出视口时自动暂停 rAF，回来再续
 * - prefers-reduced-motion 或 speed=0 时只渲染一帧（静态极光），不开动画循环
 * - DPR 封顶 1.5；WebGL 不可用时静默渲染为空（graceful degrade）
 * - 只做局部顶带氛围，不整页铺；调用方负责 mask 渐隐与透明度
 */

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ),
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop {
  vec3 color;
  float position;
};

#define COLOR_RAMP(colors, factor, finalColor) {              \\
  int index = 0;                                            \\
  for (int i = 0; i < 2; i++) {                               \\
     ColorStop currentColor = colors[i];                    \\
     bool isInBetween = currentColor.position <= factor;    \\
     index = int(mix(float(index), float(i), float(isInBetween))); \\
  }                                                         \\
  ColorStop currentColor = colors[index];                   \\
  ColorStop nextColor = colors[index + 1];                  \\
  float range = nextColor.position - currentColor.position; \\
  float lerpFactor = (factor - currentColor.position) / range; \\
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \\
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);

  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);

  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;

  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);

  vec3 auroraColor = intensity * rampColor;

  fragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
}
`;

interface AuroraBackgroundProps {
  /** 三段色，沿 x 轴渐变（想突出右上角就把最亮的放最后一段） */
  colorStops?: [string, string, string];
  /** 波形起伏幅度 */
  amplitude?: number;
  /** 边缘柔化 */
  blend?: number;
  /** 流速；0 = 只渲染一帧的静态极光 */
  speed?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function AuroraBackground({
  colorStops = ['#3B3470', '#6E56CF', '#4B7ED6'],
  amplitude = 1.0,
  blend = 0.55,
  speed = 0.4,
  className,
  style,
}: AuroraBackgroundProps) {
  const propsRef = useRef({ colorStops, amplitude, blend, speed });
  propsRef.current = { colorStops, amplitude, blend, speed };
  const ctnDom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctn = ctnDom.current;
    if (!ctn) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        dpr: Math.min(window.devicePixelRatio || 1, 1.5),
      });
    } catch {
      return; // WebGL 不可用：氛围层静默缺席，页面功能不受影响
    }
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.canvas.style.backgroundColor = 'transparent';
    gl.canvas.style.width = '100%';
    gl.canvas.style.height = '100%';
    gl.canvas.style.display = 'block';

    const geometry = new Triangle(gl);
    if (geometry.attributes.uv) delete geometry.attributes.uv;

    const toStops = (stops: [string, string, string]) =>
      stops.map((hex) => {
        const c = new Color(hex);
        return [c.r, c.g, c.b];
      });

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: amplitude },
        uColorStops: { value: toStops(propsRef.current.colorStops) },
        uResolution: { value: [1, 1] },
        uBlend: { value: blend },
      },
    });
    const mesh = new Mesh(gl, { geometry, program });
    ctn.appendChild(gl.canvas);

    const resize = () => {
      const width = ctn.offsetWidth;
      const height = ctn.offsetHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height);
      program.uniforms.uResolution.value = [gl.canvas.width, gl.canvas.height];
    };
    window.addEventListener('resize', resize);
    resize();

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const renderFrame = (timeSec: number) => {
      program.uniforms.uTime.value = timeSec;
      program.uniforms.uAmplitude.value = propsRef.current.amplitude;
      program.uniforms.uBlend.value = propsRef.current.blend;
      program.uniforms.uColorStops.value = toStops(propsRef.current.colorStops);
      renderer.render({ scene: mesh });
    };

    let animateId = 0;
    let running = false;
    const loop = (t: number) => {
      animateId = requestAnimationFrame(loop);
      renderFrame(t * 0.001 * 0.1 * (propsRef.current.speed || 0));
    };
    const start = () => {
      if (running) return;
      running = true;
      animateId = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(animateId);
    };

    const isStatic = reduceMotion || (propsRef.current.speed ?? 0) === 0;
    if (isStatic) {
      // 静态极光：固定相位渲染一帧，山脊形态仍在，零持续开销
      renderFrame(8.2);
    } else {
      start();
    }

    // 标签页隐藏 / 滚出视口 → 暂停
    const onVisibility = () => {
      if (isStatic) return;
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const io = new IntersectionObserver(([entry]) => {
      if (isStatic) return;
      if (entry.isIntersecting) start();
      else stop();
    });
    io.observe(ctn);

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      if (gl.canvas.parentNode === ctn) ctn.removeChild(gl.canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // amplitude/blend/colorStops/speed 走 propsRef 热更新，不重建 WebGL 上下文
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ctnDom} className={className} style={style} aria-hidden />;
}
