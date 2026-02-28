import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

interface StarfieldBackgroundProps {
  className?: string;
  /** RGB color for theme tint, e.g. [168, 85, 247] for purple */
  themeColor?: [number, number, number];
}

/**
 * WebGL Universe Background - Connected particles with depth layers
 * Adapted from 背景-粒子-我的宇宙.html, converted to WebGL 1.0
 */
export function StarfieldBackground({ className, themeColor }: StarfieldBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const colorUniformRef = useRef<WebGLUniformLocation | null>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) {
      console.error('WebGL not supported');
      return;
    }

    const isMobile = /Android|webOS|iPhone|iPad|BlackBerry|Windows Phone/i.test(navigator.userAgent);
    const layerCount = isMobile ? 3 : 4;
    const targetFps = 30;
    const frameInterval = 1000 / targetFps;

    const vertexSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // WebGL 1.0 compatible universe shader
    const fragmentSource = `
      precision mediump float;

      uniform float iTime;
      uniform vec2 iResolution;
      uniform vec3 uThemeColor; // RGB 0-1 range

      float N21(vec2 p) {
        p = fract(p * vec2(233.34, 851.73));
        p += dot(p, p + 23.45);
        return fract(p.x * p.y);
      }

      vec2 N22(vec2 p) {
        float n = N21(p);
        return vec2(n, N21(p + n));
      }

      vec2 getPos(vec2 id, vec2 offset) {
        vec2 n = N22(id + offset);
        float x = cos(iTime * n.x);
        float y = sin(iTime * n.y);
        return vec2(x, y) * 0.4 + offset;
      }

      float distanceToLine(vec2 p, vec2 a, vec2 b) {
        vec2 pa = p - a;
        vec2 ba = b - a;
        float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - t * ba);
      }

      float getLine(vec2 p, vec2 a, vec2 b) {
        float d = distanceToLine(p, a, b);
        float dx = 15.0 / iResolution.y;
        return smoothstep(dx, 0.0, d) * smoothstep(1.2, 0.3, length(a - b));
      }

      float layer(vec2 st) {
        float m = 0.0;
        vec2 gv = fract(st) - 0.5;
        vec2 id = floor(st);
        float dx = 15.0 / iResolution.y;

        // Get 9 neighbor positions (WebGL 1.0: manual unroll)
        vec2 p0 = getPos(id, vec2(-1.0, -1.0));
        vec2 p1 = getPos(id, vec2(-1.0,  0.0));
        vec2 p2 = getPos(id, vec2(-1.0,  1.0));
        vec2 p3 = getPos(id, vec2( 0.0, -1.0));
        vec2 p4 = getPos(id, vec2( 0.0,  0.0));
        vec2 p5 = getPos(id, vec2( 0.0,  1.0));
        vec2 p6 = getPos(id, vec2( 1.0, -1.0));
        vec2 p7 = getPos(id, vec2( 1.0,  0.0));
        vec2 p8 = getPos(id, vec2( 1.0,  1.0));

        // Lines from center to all neighbors
        m += getLine(gv, p4, p0);
        m += getLine(gv, p4, p1);
        m += getLine(gv, p4, p2);
        m += getLine(gv, p4, p3);
        m += getLine(gv, p4, p5);
        m += getLine(gv, p4, p6);
        m += getLine(gv, p4, p7);
        m += getLine(gv, p4, p8);

        // Cross connections
        m += getLine(gv, p1, p3);
        m += getLine(gv, p1, p5);
        m += getLine(gv, p3, p7);
        m += getLine(gv, p5, p7);

        // Glowing points
        vec2 t0 = (gv - p0) * 20.0; m += 1.0 / dot(t0, t0) * (sin(10.0 * iTime + fract(p0.x) * 20.0) * 0.5 + 0.5);
        vec2 t1 = (gv - p1) * 20.0; m += 1.0 / dot(t1, t1) * (sin(10.0 * iTime + fract(p1.x) * 20.0) * 0.5 + 0.5);
        vec2 t2 = (gv - p2) * 20.0; m += 1.0 / dot(t2, t2) * (sin(10.0 * iTime + fract(p2.x) * 20.0) * 0.5 + 0.5);
        vec2 t3 = (gv - p3) * 20.0; m += 1.0 / dot(t3, t3) * (sin(10.0 * iTime + fract(p3.x) * 20.0) * 0.5 + 0.5);
        vec2 t4 = (gv - p4) * 20.0; m += 1.0 / dot(t4, t4) * (sin(10.0 * iTime + fract(p4.x) * 20.0) * 0.5 + 0.5);
        vec2 t5 = (gv - p5) * 20.0; m += 1.0 / dot(t5, t5) * (sin(10.0 * iTime + fract(p5.x) * 20.0) * 0.5 + 0.5);
        vec2 t6 = (gv - p6) * 20.0; m += 1.0 / dot(t6, t6) * (sin(10.0 * iTime + fract(p6.x) * 20.0) * 0.5 + 0.5);
        vec2 t7 = (gv - p7) * 20.0; m += 1.0 / dot(t7, t7) * (sin(10.0 * iTime + fract(p7.x) * 20.0) * 0.5 + 0.5);
        vec2 t8 = (gv - p8) * 20.0; m += 1.0 / dot(t8, t8) * (sin(10.0 * iTime + fract(p8.x) * 20.0) * 0.5 + 0.5);

        return m;
      }

      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;

        float m = 0.0;
        float theta = iTime * 0.1;
        mat2 rot = mat2(cos(theta), -sin(theta), sin(theta), cos(theta));
        vec2 gradient = uv;
        uv = rot * uv;

        // Multiple depth layers (unrolled for WebGL 1.0)
        for (int i = 0; i < ${layerCount}; i++) {
          float fi = float(i) * 0.25;
          float depth = fract(fi + iTime * 0.1);
          float fade = smoothstep(0.0, 0.2, depth) * smoothstep(1.0, 0.8, depth);
          m += layer(uv * mix(10.0, 0.5, depth) + fi * 20.0) * fade;
        }

        // Use theme color if provided, otherwise use indigo
        vec3 defaultColor = vec3(0.39, 0.40, 0.95);
        vec3 themeBase = length(uThemeColor) > 0.1 ? uThemeColor : defaultColor;

        // Create color variations
        vec3 themeBright = themeBase * 1.3;
        vec3 themeDark = themeBase * 0.7;

        float colorMix = sin(iTime * 0.3) * 0.5 + 0.5;
        vec3 baseColor = mix(themeDark, themeBright, colorMix);

        vec3 col = (m - gradient.y * 0.5) * baseColor;

        // Tone mapping
        col = col / (col + 0.8);

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    const compileShader = (source: string, type: number): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader error:', gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };

    const vertexShader = compileShader(vertexSource, gl.VERTEX_SHADER);
    const fragmentShader = compileShader(fragmentSource, gl.FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return;
    }

    gl.useProgram(program);

    const vertexData = new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]);
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

    const positionHandle = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionHandle);
    gl.vertexAttribPointer(positionHandle, 2, gl.FLOAT, false, 0, 0);

    const timeHandle = gl.getUniformLocation(program, 'iTime');
    const resolutionHandle = gl.getUniformLocation(program, 'iResolution');
    const colorHandle = gl.getUniformLocation(program, 'uThemeColor');
    colorUniformRef.current = colorHandle;
    glRef.current = gl;

    // Set initial theme color
    if (themeColor) {
      gl.uniform3f(colorHandle, themeColor[0] / 255, themeColor[1] / 255, themeColor[2] / 255);
    } else {
      gl.uniform3f(colorHandle, 0, 0, 0); // Will use default indigo in shader
    }

    const resize = () => {
      const dpr = 1; // Keep DPR low for performance
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(resolutionHandle, canvas.width, canvas.height);
    };

    resize();
    window.addEventListener('resize', resize);

    const draw = (timestamp: number) => {
      animationRef.current = requestAnimationFrame(draw);

      const elapsed = timestamp - lastFrameRef.current;
      if (elapsed < frameInterval) return;

      lastFrameRef.current = timestamp - (elapsed % frameInterval);
      timeRef.current += 0.022; // Slowed down by 1/3

      gl.uniform1f(timeHandle, timeRef.current);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    animationRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationRef.current);
      window.removeEventListener('resize', resize);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteBuffer(vertexBuffer);
    };
  }, []);

  // Update theme color when it changes
  useEffect(() => {
    const gl = glRef.current;
    const colorHandle = colorUniformRef.current;
    if (gl && colorHandle) {
      if (themeColor) {
        gl.uniform3f(colorHandle, themeColor[0] / 255, themeColor[1] / 255, themeColor[2] / 255);
      } else {
        gl.uniform3f(colorHandle, 0, 0, 0);
      }
    }
  }, [themeColor]);

  return (
    <canvas
      ref={canvasRef}
      className={cn('absolute inset-0 w-full h-full', className)}
      style={{ pointerEvents: 'none' }}
    />
  );
}
