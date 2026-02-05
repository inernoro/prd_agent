import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

/**
 * 黑洞漩涡背景 - 基于 thirdparty/ref/背景-黑洞漩涡.html
 * WebGL Shader 实现的 Droste 效果递归缩放漩涡
 */

// 本地噪声纹理（从 CDN 下载到 public/textures/ 目录）
const NOISE_TEXTURE_URL = '/textures/noise.png';

const vertexShader = `
void main() {
  gl_Position = vec4(position, 1.0);
}
`;

const fragmentShader = `
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;
uniform sampler2D u_noise;

#define PI 3.141592653589793
#define TAU 6.283185307179586

const int octaves = 2;
const float seed = 43758.5453123;

float r1 = 0.2;
float r2 = 0.9;

vec2 cCis(float r) {
  return vec2(cos(r), sin(r));
}
vec2 cExp(vec2 c) {
  return exp(c.x) * cCis(c.y);
}
vec2 cConj(vec2 c) {
  return vec2(c.x, -c.y);
}
vec2 cInv(vec2 c) {
  return cConj(c) / dot(c, c);
}
vec2 cLog(vec2 c) {
  return vec2(log(length(c)), atan(c.y, c.x));
}
vec2 cMul(vec2 a, vec2 b) {
  return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x);
}
vec2 cDiv(vec2 a, vec2 b) {
  return cMul(a, cInv(b));
}

float noiseLUT(in vec3 x) {
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = f*f*(3.0-2.0*f);
  vec2 uv = (p.xy + vec2(37.0, 17.0)*p.z) + f.xy;
  vec2 rg = texture2D(u_noise, (uv + 0.5)/256.0).yx - 0.5;
  return mix(rg.x, rg.y, f.z);
}

float fbm1(in vec2 _st, float seed) {
  float v = 0.0;
  float a = 0.5;
  vec2 shift = vec2(100.0);
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.50));
  for (int i = 0; i < octaves; ++i) {
    v += a * noiseLUT(vec3(_st, 1.0));
    _st = rot * _st * 2.0 + shift;
    a *= 0.4;
  }
  return v;
}

float pattern(vec2 uv, float seed, float time, inout vec2 q, inout vec2 r) {
  q = vec2(fbm1(uv + vec2(0.0, 0.0), seed), fbm1(uv + vec2(5.2, 1.3), seed));
  r = vec2(fbm1(uv + 4.0*q + vec2(1.7 - time/2.0, 9.2), seed), fbm1(uv + 4.0*q + vec2(8.3 - time/2.0, 2.8), seed));
  return fbm1(uv + 4.0*r, seed);
}

vec3 hsb2rgb(in vec3 c) {
  vec3 rgb = clamp(abs(mod(c.x*6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  rgb = rgb*rgb*(3.0 - 2.0*rgb);
  return c.z * mix(vec3(1.0), rgb, c.y);
}

vec2 Droste(vec2 uv) {
  uv = cLog(uv);
  float scale = log(r2/r1);
  float angle = atan(scale/(2.0*PI));
  uv = cDiv(uv, cExp(vec2(0, angle))*cos(angle));
  uv -= u_time * 0.2;
  uv.x = mod(uv.x, log(r2/r1));
  uv = cExp(uv)*r1;
  return uv;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.y, u_resolution.x);
  uv *= 2.0;
  vec2 _uv = uv;
  vec2 polar = vec2(length(_uv), atan(uv.y, uv.x));

  uv = Droste(uv);

  float rInv = 1.0/length(uv);
  uv = uv * rInv - vec2(rInv, 1.0);

  vec2 p;
  vec2 q;
  float pat = pattern(uv * 5.0, seed, u_time * 5.0, p, q);

  vec3 fragcolour = mix(
    mix(
      vec3(0.9, 0.7, 0.0),
      vec3(1.0, 0.55, 0.1),
      abs(q.x*p.y)*20.0),
    vec3(0.5, 0.3, 0.0),
    pat
  );
  fragcolour -= smoothstep(-0.1, 0.9, p.x) * 0.5;
  fragcolour += smoothstep(-0.1, 0.5, p.y) * 0.5;

  fragcolour += (1.0 - length(_uv * 2.0)) * 0.5;
  float lcol = clamp(length(_uv * 4.0) - 0.2, 0.0, 1.0);

  float raynoise = fbm1(polar*10.0 - u_time*2.0, seed);

  fragcolour = mix(
    fragcolour,
    vec3(sin(p.y * 10.0), cos(q.y * 10.0), pat * 2.0) * 0.5 + 1.5,
    clamp(
      abs(sin(polar.y * 50.0)) * 1.0 / length(_uv * _uv * 3.0) * raynoise - 0.2,
      0.0,
      1.0) * 0.2);

  fragcolour = mix(vec3(1.0), fragcolour, lcol);

  gl_FragColor = vec4(fragcolour, 1.0);
}
`;

interface BlackHoleVortexProps {
  className?: string;
}

export function BlackHoleVortex({ className }: BlackHoleVortexProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    let isDisposed = false;

    // 加载本地噪声纹理
    const loader = new THREE.TextureLoader();

    loader.load(NOISE_TEXTURE_URL, (texture) => {
      if (isDisposed) {
        texture.dispose();
        return;
      }

      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = THREE.LinearFilter;

      // 设置场景
      const camera = new THREE.Camera();
      camera.position.z = 1;

      const scene = new THREE.Scene();
      const geometry = new THREE.PlaneGeometry(2, 2);

      const uniforms = {
        u_time: { value: 0.0 },
        u_resolution: { value: new THREE.Vector2() },
        u_mouse: { value: new THREE.Vector2() },
        u_noise: { value: texture },
      };

      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
      });

      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      rendererRef.current = renderer;

      container.appendChild(renderer.domElement);

      // 设置尺寸
      const updateSize = () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        renderer.setSize(width, height);
        uniforms.u_resolution.value.set(width * window.devicePixelRatio, height * window.devicePixelRatio);
      };
      updateSize();

      const resizeObserver = new ResizeObserver(updateSize);
      resizeObserver.observe(container);

      // 鼠标事件
      const handleMouseMove = (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const ratio = rect.height / rect.width;
        uniforms.u_mouse.value.x = ((e.clientX - rect.left) / rect.width - 0.5) / ratio;
        uniforms.u_mouse.value.y = -((e.clientY - rect.top) / rect.height - 0.5);
      };
      container.addEventListener('mousemove', handleMouseMove);

      // 动画循环
      const startTime = performance.now();
      const animate = () => {
        if (isDisposed) return;
        const delta = performance.now() - startTime;
        uniforms.u_time.value = -11000 + delta * 0.0005;
        renderer.render(scene, camera);
        frameRef.current = requestAnimationFrame(animate);
      };
      animate();

      // 保存清理函数
      const cleanup = () => {
        isDisposed = true;
        cancelAnimationFrame(frameRef.current);
        resizeObserver.disconnect();
        container.removeEventListener('mousemove', handleMouseMove);
        renderer.dispose();
        geometry.dispose();
        material.dispose();
        texture.dispose();
        if (container.contains(renderer.domElement)) {
          container.removeChild(renderer.domElement);
        }
      };

      // 存储到 ref 以便清理
      (containerRef.current as HTMLDivElement & { _cleanup?: () => void })._cleanup = cleanup;
    });

    return () => {
      isDisposed = true;
      cancelAnimationFrame(frameRef.current);
      const el = containerRef.current as HTMLDivElement & { _cleanup?: () => void } | null;
      if (el?._cleanup) {
        el._cleanup();
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        background: '#000',
      }}
    />
  );
}

export default BlackHoleVortex;
