import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

interface StarfieldBackgroundProps {
  className?: string;
}

/**
 * WebGL Starfield Background - Multi-layer parallax star animation
 * Adapted from thirdparty/ref/星空背景.html with gold color theme
 */
export function StarfieldBackground({ className }: StarfieldBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const animationRef = useRef<number>(0);
  const timeRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Initialize WebGL
    const gl = canvas.getContext('webgl');
    if (!gl) {
      console.error('WebGL not supported');
      return;
    }
    glRef.current = gl;

    // Detect mobile for performance adjustment
    const isMobile = /Android|webOS|iPhone|BlackBerry|Windows Phone/i.test(navigator.userAgent);
    const layers = isMobile ? 6 : 3;

    // Vertex shader
    const vertexSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // Fragment shader with gold-tinted starfield
    const fragmentSource = `
      precision highp float;

      uniform float width;
      uniform float height;
      uniform float time;

      vec2 resolution;

      float random(vec2 par) {
        return fract(sin(dot(par.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }

      vec2 random2(vec2 par) {
        float rand = random(par);
        return vec2(rand, random(par + rand));
      }

      float getGlow(float dist, float radius, float intensity) {
        return pow(radius / dist, intensity);
      }

      void main() {
        resolution = vec2(width, height);
        float t = 1.0 + time * 0.05;
        const float layers = float(${layers});
        float scale = 32.0;
        float depth;
        float phase;
        float rotationAngle = time * -0.08;
        float size;
        float glow;
        const float del = 1.0 / layers;

        vec2 uv;
        vec2 fl;
        vec2 local_uv;
        vec2 index;
        vec2 pos;
        vec2 seed;
        vec2 centre;
        vec2 cell;
        vec2 rot = vec2(cos(t), sin(t));

        mat2 rotation = mat2(
          cos(rotationAngle), -sin(rotationAngle),
          sin(rotationAngle), cos(rotationAngle)
        );

        vec3 col = vec3(0);
        vec3 tone;

        // Gold-based color palette
        vec3 goldCore = vec3(0.96, 0.89, 0.72);    // #f4e2b8
        vec3 goldMid = vec3(0.84, 0.70, 0.42);     // #d6b26a
        vec3 goldWarm = vec3(0.95, 0.84, 0.61);    // #f2d59b
        vec3 purple = vec3(0.55, 0.23, 0.93);      // #8b3aed
        vec3 blue = vec3(0.23, 0.51, 0.96);        // #3b82f6

        for (float i = 0.0; i <= 1.0; i += del) {
          depth = fract(i + t);
          centre = rot * 0.2 * depth + 0.5;
          uv = centre - gl_FragCoord.xy / resolution.x;
          uv *= rotation;
          uv *= mix(scale, 0.0, depth);
          fl = floor(uv);
          local_uv = uv - fl - 0.5;

          for (float j = -1.0; j <= 1.0; j++) {
            for (float k = -1.0; k <= 1.0; k++) {
              cell = vec2(j, k);
              index = fl + cell;
              seed = 128.0 * i + index;

              pos = cell + 0.9 * (random2(seed) - 0.5);
              phase = 128.0 * random(seed);

              // Mix gold tones with occasional purple/blue accents
              float colorSelect = random(seed + 0.5);
              if (colorSelect < 0.5) {
                tone = goldCore;
              } else if (colorSelect < 0.75) {
                tone = goldMid;
              } else if (colorSelect < 0.88) {
                tone = goldWarm;
              } else if (colorSelect < 0.94) {
                tone = purple;
              } else {
                tone = blue;
              }

              size = (0.1 + 0.5 + 0.5 * sin(phase * t)) * depth;
              glow = size * getGlow(length(local_uv - pos), 0.09, 2.0);

              // White core with colored glow
              col += 5.0 * vec3(0.025 * glow) + tone * glow;
            }
          }
        }

        // Tone mapping
        col = 1.0 - exp(-col);

        // Add subtle vignette
        vec2 vUv = gl_FragCoord.xy / resolution;
        float vignette = 1.0 - length((vUv - 0.5) * 1.2);
        vignette = smoothstep(0.0, 0.7, vignette);
        col *= vignette * 0.9 + 0.1;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    // Compile shaders
    const compileShader = (source: string, type: number): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };

    const vertexShader = compileShader(vertexSource, gl.VERTEX_SHADER);
    const fragmentShader = compileShader(fragmentSource, gl.FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) return;

    // Create program
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
    programRef.current = program;

    // Set up geometry (full-screen quad)
    const vertexData = new Float32Array([
      -1.0, 1.0,
      -1.0, -1.0,
      1.0, 1.0,
      1.0, -1.0,
    ]);

    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

    const positionHandle = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionHandle);
    gl.vertexAttribPointer(positionHandle, 2, gl.FLOAT, false, 2 * 4, 0);

    // Get uniform locations
    const timeHandle = gl.getUniformLocation(program, 'time');
    const widthHandle = gl.getUniformLocation(program, 'width');
    const heightHandle = gl.getUniformLocation(program, 'height');

    // Resize handler
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

    // Animation loop
    const dt = 0.015;
    const draw = () => {
      timeRef.current += dt;
      gl.uniform1f(timeHandle, timeRef.current);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

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
