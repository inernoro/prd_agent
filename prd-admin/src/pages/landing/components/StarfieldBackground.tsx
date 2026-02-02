import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

interface StarfieldBackgroundProps {
  className?: string;
}

/**
 * WebGL Starfield Background - Optimized for performance
 * - 30fps cap (background doesn't need 60fps)
 * - Reduced DPR (1.0 for background)
 * - Simplified shader with fewer layers
 */
export function StarfieldBackground({ className }: StarfieldBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      console.error('WebGL not supported');
      return;
    }

    // Performance settings
    const isMobile = /Android|webOS|iPhone|iPad|BlackBerry|Windows Phone/i.test(navigator.userAgent);
    const layers = isMobile ? 2 : 4; // Reduced layers
    const targetFps = 30;
    const frameInterval = 1000 / targetFps;

    const vertexSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // Optimized fragment shader (WebGL 1.0 compatible)
    const fragmentSource = `
      precision mediump float;

      uniform float width;
      uniform float height;
      uniform float time;

      float random(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      vec3 getStarColor(float r) {
        if (r < 0.33) return vec3(0.96, 0.89, 0.72);  // gold core
        if (r < 0.66) return vec3(0.84, 0.70, 0.42);  // gold mid
        return vec3(0.55, 0.23, 0.93);                 // purple accent
      }

      void main() {
        vec2 resolution = vec2(width, height);
        float t = 1.0 + time * 0.03;
        float scale = 24.0;
        float rotAngle = time * -0.05;

        mat2 rot = mat2(cos(rotAngle), -sin(rotAngle), sin(rotAngle), cos(rotAngle));
        vec2 center = vec2(cos(t), sin(t)) * 0.15 + 0.5;

        vec3 col = vec3(0.0);

        // Unrolled loop for WebGL 1.0 compatibility (${layers} layers)
        for (int i = 0; i < ${layers}; i++) {
          float layer = float(i) / float(${layers});
          float depth = fract(layer + t * 0.1);
          vec2 uv = (center - gl_FragCoord.xy / resolution.x) * rot;
          uv *= mix(scale, 2.0, depth);

          vec2 gridId = floor(uv);
          vec2 gridUv = fract(uv) - 0.5;

          vec2 seed = gridId + layer * 100.0;
          float rand = random(seed);
          vec2 offset = vec2(random(seed + 1.0), random(seed + 2.0)) - 0.5;
          offset *= 0.8;

          float dist = length(gridUv - offset);
          float pulse = 0.5 + 0.5 * sin(rand * 20.0 + time * 2.0);
          float brightness = depth * pulse * 0.015 / (dist * dist + 0.001);

          col += getStarColor(rand) * brightness * 0.4;
        }

        col = col / (col + 0.5);

        vec2 vUv = gl_FragCoord.xy / resolution - 0.5;
        float vig = 1.0 - dot(vUv, vUv) * 0.8;
        col *= vig;

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

    const timeHandle = gl.getUniformLocation(program, 'time');
    const widthHandle = gl.getUniformLocation(program, 'width');
    const heightHandle = gl.getUniformLocation(program, 'height');

    const resize = () => {
      // Use DPR of 1 for background (no need for retina)
      const dpr = 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(widthHandle, canvas.width);
      gl.uniform1f(heightHandle, canvas.height);
    };

    resize();
    window.addEventListener('resize', resize);

    // 30fps capped animation loop
    const draw = (timestamp: number) => {
      animationRef.current = requestAnimationFrame(draw);

      const elapsed = timestamp - lastFrameRef.current;
      if (elapsed < frameInterval) return;

      lastFrameRef.current = timestamp - (elapsed % frameInterval);
      timeRef.current += 0.033; // ~30fps time step

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

  return (
    <canvas
      ref={canvasRef}
      className={cn('absolute inset-0 w-full h-full', className)}
      style={{ pointerEvents: 'none' }}
    />
  );
}
