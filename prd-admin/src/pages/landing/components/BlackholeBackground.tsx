import { useRef, useEffect } from 'react';

interface BlackholeBackgroundProps {
  className?: string;
}

// Vertex shader
const vertexShaderSource = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader - Droste vortex effect with procedural noise
const fragmentShaderSource = `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;

#define PI 3.141592653589793
#define TAU 6.283185307179586

// Configuration
float r1 = 0.2;
float r2 = 0.9;

// Complex number operations
vec2 cCis(float r) {
  return vec2(cos(r), sin(r));
}
vec2 cExp(vec2 c) {
  return exp(c.x) * cCis(c.y);
}
vec2 cConj(vec2 c) {
  return vec2(c.x, -c.y);
}
float cAbs(vec2 c) {
  return length(c);
}
float cArg(vec2 c) {
  return atan(c.y, c.x);
}
vec2 cInv(vec2 c) {
  return cConj(c) / dot(c, c);
}
vec2 cLog(vec2 c) {
  return vec2(log(cAbs(c)), cArg(c));
}
vec2 cMul(vec2 a, vec2 b) {
  return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x);
}
vec2 cDiv(vec2 a, vec2 b) {
  return cMul(a, cInv(b));
}

// Procedural noise functions (replacing texture-based noise)
float hash(vec2 p) {
  float h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float noise3D(vec3 p) {
  vec2 p2 = p.xy + vec2(37.0, 17.0) * p.z;
  return noise(p2);
}

// FBM noise
float fbm(vec2 st) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));

  for (int i = 0; i < 3; i++) {
    v += a * noise3D(vec3(st, 1.0));
    st = rot * st * 2.0 + vec2(100.0);
    a *= 0.4;
  }
  return v;
}

// Pattern function
float pattern(vec2 uv, float time, out vec2 q, out vec2 r) {
  q = vec2(
    fbm(uv + vec2(0.0, 0.0)),
    fbm(uv + vec2(5.2, 1.3))
  );

  r = vec2(
    fbm(uv + 4.0 * q + vec2(1.7 - time / 2.0, 9.2)),
    fbm(uv + 4.0 * q + vec2(8.3 - time / 2.0, 2.8))
  );

  return fbm(uv + 4.0 * r);
}

// HSB to RGB
vec3 hsb2rgb(vec3 c) {
  vec3 rgb = clamp(
    abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
    0.0,
    1.0
  );
  rgb = rgb * rgb * (3.0 - 2.0 * rgb);
  return c.z * mix(vec3(1.0), rgb, c.y);
}

// Droste transformation
vec2 Droste(vec2 uv, float time) {
  // Take the tiled strips back to ordinary space
  uv = cLog(uv);
  // Scale and rotate the strips
  float scale = log(r2 / r1);
  float angle = atan(scale / TAU);
  uv = cDiv(uv, cExp(vec2(0.0, angle)) * cos(angle));
  // Zoom animation
  uv -= time * 0.2;
  // Tile the strips
  uv.x = mod(uv.x, log(r2 / r1));
  // Take the annulus to a strip
  uv = cExp(uv) * r1;

  return uv;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.y, u_resolution.x);
  uv *= 2.0;
  vec2 _uv = uv;
  vec2 polar = vec2(length(_uv), atan(uv.y, uv.x));

  // Apply Droste transformation
  uv = Droste(uv, u_time);

  float rInv = 1.0 / length(uv);
  uv = uv * rInv - vec2(rInv, 1.0);

  vec2 p;
  vec2 q;
  float pat = pattern(uv * 5.0, u_time * 5.0, p, q);

  // Gold/amber color scheme matching the site theme
  vec3 fragColor = mix(
    mix(
      vec3(0.9, 0.7, 0.0),
      vec3(1.0, 0.55, 0.1),
      abs(q.x * p.y) * 20.0
    ),
    vec3(0.5, 0.3, 0.0),
    pat
  );

  fragColor -= smoothstep(-0.1, 0.9, p.x) * 0.5;
  fragColor += smoothstep(-0.1, 0.5, p.y) * 0.5;

  fragColor += (1.0 - length(_uv * 2.0)) * 0.5;
  float lcol = clamp(length(_uv * 4.0) - 0.2, 0.0, 1.0);

  // Ray noise effect
  float raynoise = fbm(polar * 10.0 - u_time * 2.0);

  fragColor = mix(
    fragColor,
    vec3(sin(p.y * 10.0), cos(q.y * 10.0), pat * 2.0) * 0.5 + 1.5,
    clamp(
      abs(sin(polar.y * 50.0)) * 1.0 / length(_uv * _uv * 3.0) * raynoise - 0.2,
      0.0,
      1.0
    ) * 0.2
  );

  // White center
  fragColor = mix(vec3(1.0), fragColor, lcol);

  gl_FragColor = vec4(fragColor, 1.0);
}
`;

export function BlackholeBackground({ className = '' }: BlackholeBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return;

    // Create shaders
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) return;

    gl.shaderSource(vertexShader, vertexShaderSource);
    gl.compileShader(vertexShader);
    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      console.error('Vertex shader error:', gl.getShaderInfoLog(vertexShader));
      return;
    }

    gl.shaderSource(fragmentShader, fragmentShaderSource);
    gl.compileShader(fragmentShader);
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      console.error('Fragment shader error:', gl.getShaderInfoLog(fragmentShader));
      return;
    }

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

    // Create fullscreen quad
    const positions = new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]);
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // Get uniform locations
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const timeLocation = gl.getUniformLocation(program, 'u_time');

    // Resize handler
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 1.0); // Limit DPR for performance
      const width = canvas.clientWidth * dpr;
      const height = canvas.clientHeight * dpr;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    // Animation loop - 24fps for performance
    let lastFrame = 0;
    const frameInterval = 1000 / 24;
    startTimeRef.current = -11000 + Date.now() * 0.0005;

    const render = (timestamp: number) => {
      if (timestamp - lastFrame >= frameInterval) {
        lastFrame = timestamp;
        resize();

        const time = -11000 + Date.now() * 0.0003; // Slow down animation
        gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
        gl.uniform1f(timeLocation, time);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      animationRef.current = requestAnimationFrame(render);
    };

    animationRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationRef.current);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteBuffer(positionBuffer);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full ${className}`}
      style={{ display: 'block' }}
    />
  );
}
