/**
 * Agent Switcher 浮层组件 v7.0
 *
 * 宇宙粒子网络背景 + 强化发光效果：
 * - WebGL2 着色器粒子背景
 * - 选中卡片多层发光
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  useAgentSwitcherStore,
  AGENT_DEFINITIONS,
  type AgentDefinition,
} from '@/stores/agentSwitcherStore';

/** 图标 URL 映射 */
const ICON_URLS: Record<string, string> = {
  'prd-agent': 'https://i.pa.759800.com/icon/backups/agent/prd-agent.png',
  'visual-agent': 'https://i.pa.759800.com/icon/backups/agent/visual-agent.png',
  'literary-agent': 'https://i.pa.759800.com/icon/backups/agent/literary-agent.png',
  'defect-agent': 'https://i.pa.759800.com/icon/backups/agent/defect-agent.png',
};

/** Agent 主题色 */
const AGENT_GLOW_COLORS: Record<string, string> = {
  'prd-agent': '#3b82f6',
  'visual-agent': '#a855f7',
  'literary-agent': '#22c55e',
  'defect-agent': '#f97316',
};

/** WebGL Vertex Shader */
const VERTEX_SHADER = `#version 300 es
layout (location=0) in vec2 point;
void main() {
  gl_Position = vec4(point.x, point.y, 0.0, 1.0);
}`;

/** WebGL Fragment Shader - 宇宙粒子网络 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

float N21(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

vec2 N22(vec2 p) {
  float n = N21(p);
  return vec2(n, N21(p + n));
}

vec2 getPos(vec2 id, vec2 offset, float iTime) {
  vec2 n = N22(id + offset);
  float x = cos(iTime * n.x);
  float y = sin(iTime * n.y);
  return vec2(x, y) * 0.4 + offset;
}

float distanceToLine(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return length(pa - t * ba);
}

float getLine(vec2 p, vec2 a, vec2 b, vec2 iResolution) {
  float distance = distanceToLine(p, a, b);
  float dx = 15./iResolution.y;
  return smoothstep(dx, 0., distance) * smoothstep(1.2, 0.3, length(a - b));
}

float layer(vec2 st, float iTime, vec2 iResolution) {
  float m = 0.;
  vec2 gv = fract(st) - 0.5;
  vec2 id = floor(st);
  float dx=15./iResolution.y;

  vec2 p[9];
  int i = 0;
  for (float x = -1.; x <= 1.; x++) {
    for (float y = -1.; y <= 1.; y++) {
      p[i++] = getPos(id, vec2(x, y), iTime);
    }
  }

  for (int j = 0; j <= 8; j++) {
    m += getLine(gv, p[4], p[j], iResolution);
    vec2 temp = (gv - p[j]) * 20.;
    m += 1./dot(temp, temp) * (sin(10. * iTime + fract(p[j].x) * 20.) * 0.5 + 0.5);
  }

  m += getLine(gv, p[1], p[3], iResolution);
  m += getLine(gv, p[1], p[5], iResolution);
  m += getLine(gv, p[3], p[7], iResolution);
  m += getLine(gv, p[5], p[7], iResolution);

  return m;
}

uniform float iTime;
uniform vec2 iResolution;
out vec4 fragColor;

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;
  float m = 0.;

  float theta = iTime * 0.1;
  mat2 rot = mat2(cos(theta), -sin(theta), sin(theta), cos(theta));
  vec2 gradient = uv;
  uv = rot * uv;

  for (float i = 0.; i < 1.0 ; i += 0.25) {
    float depth = fract(i + iTime * 0.1);
    m += layer(uv * mix(10., 0.5, depth) + i * 20., iTime, iResolution) * smoothstep(0., 0.2, depth) * smoothstep(1., 0.8, depth);
  }

  // 使用蓝紫色调
  vec3 baseColor = vec3(0.2, 0.4, 0.8) + vec3(0.3, 0.2, 0.4) * sin(iTime * 0.3);

  vec3 col = (m - gradient.y * 0.5) * baseColor * 0.6;
  fragColor = vec4(col, 1.0);
}`;

/** WebGL 宇宙背景组件 */
function CosmicBackground({ isVisible }: { isVisible: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!isVisible || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const gl = canvas.getContext('webgl2');
    if (!gl) return;

    // 设置 canvas 尺寸
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);

    // 编译着色器
    const vertexShader = gl.createShader(gl.VERTEX_SHADER)!;
    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!;

    gl.shaderSource(vertexShader, VERTEX_SHADER);
    gl.shaderSource(fragmentShader, FRAGMENT_SHADER);

    gl.compileShader(vertexShader);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
      console.error('Vertex shader error:', gl.getShaderInfoLog(vertexShader));
      return;
    }
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      console.error('Fragment shader error:', gl.getShaderInfoLog(fragmentShader));
      return;
    }

    // 创建程序
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return;
    }

    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);

    // 创建顶点缓冲
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    // 创建索引缓冲
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([1, 0, 2, 3]), gl.STATIC_DRAW);

    // Uniforms
    const uResolution = gl.getUniformLocation(program, 'iResolution');
    const uTime = gl.getUniformLocation(program, 'iTime');

    gl.uniform2f(uResolution, canvas.width, canvas.height);

    startTimeRef.current = performance.now();

    // 渲染循环
    const render = () => {
      const elapsed = (performance.now() - startTimeRef.current) / 1000;
      gl.uniform1f(uTime, elapsed);
      gl.uniform2f(uResolution, canvas.width, canvas.height);

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.drawElements(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_SHORT, 0);

      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationRef.current);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0"
      style={{ background: '#030408' }}
    />
  );
}

/** Agent 卡片组件 */
function AgentCard({
  agent,
  index,
  isSelected,
  onClick,
  onMouseEnter,
  delay,
}: {
  agent: AgentDefinition;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  delay: number;
}) {
  const iconUrl = ICON_URLS[agent.key];
  const glowColor = AGENT_GLOW_COLORS[agent.key];

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="group relative outline-none focus:outline-none"
      style={{
        animation: `cardFloat 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) ${delay}ms both`,
      }}
    >
      {/* 选中时的外层大光晕 */}
      {isSelected && (
        <div
          className="absolute -inset-4 rounded-[32px] pointer-events-none"
          style={{
            background: `radial-gradient(ellipse at center, ${glowColor}40 0%, transparent 70%)`,
            animation: 'glowPulse 2s ease-in-out infinite',
          }}
        />
      )}

      {/* 主卡片 */}
      <div
        className="relative w-[140px] h-[160px] rounded-[24px] flex flex-col items-center justify-center gap-4 transition-all duration-300 ease-out overflow-hidden"
        style={{
          background: isSelected
            ? 'rgba(20, 24, 40, 0.85)'
            : 'rgba(15, 18, 30, 0.7)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: isSelected
            ? `1.5px solid ${glowColor}70`
            : '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: isSelected
            ? `0 0 30px ${glowColor}50, 0 0 60px ${glowColor}25, 0 20px 40px -10px rgba(0,0,0,0.5)`
            : '0 4px 24px -4px rgba(0,0,0,0.4)',
          transform: isSelected ? 'translateY(-8px) scale(1.05)' : 'translateY(0) scale(1)',
        }}
      >
        {/* 顶部光线 */}
        <div
          className="absolute top-0 left-0 right-0 h-[2px]"
          style={{
            background: isSelected
              ? `linear-gradient(90deg, transparent, ${glowColor}, transparent)`
              : 'linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent)',
            boxShadow: isSelected ? `0 0 20px ${glowColor}` : 'none',
          }}
        />

        {/* 图标 */}
        <div
          className="relative w-[72px] h-[72px] transition-all duration-300 ease-out"
          style={{
            transform: isSelected ? 'scale(1.15)' : 'scale(1)',
            filter: isSelected
              ? `drop-shadow(0 0 25px ${glowColor}80) drop-shadow(0 0 50px ${glowColor}40)`
              : 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))',
          }}
        >
          <img
            src={iconUrl}
            alt={agent.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>

        {/* 名称 */}
        <span
          className="text-[14px] font-medium tracking-wide transition-all duration-300"
          style={{
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.6)',
            textShadow: isSelected ? `0 0 20px ${glowColor}` : 'none',
          }}
        >
          {agent.name}
        </span>

        {/* 快捷键角标 */}
        <div
          className="absolute top-3 right-3 w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold transition-all duration-300"
          style={{
            background: isSelected ? `${glowColor}40` : 'rgba(255, 255, 255, 0.08)',
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.4)',
            border: isSelected ? `1px solid ${glowColor}60` : '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: isSelected ? `0 0 15px ${glowColor}50` : 'none',
          }}
        >
          {index + 1}
        </div>
      </div>
    </button>
  );
}

/** 主浮层组件 */
export function AgentSwitcher() {
  const navigate = useNavigate();
  const [isClosing, setIsClosing] = useState(false);

  const {
    isOpen,
    selectedIndex,
    close,
    setSelectedIndex,
    moveSelection,
    addRecentVisit,
  } = useAgentSwitcherStore();

  const navigateToAgent = useCallback(
    (agent: AgentDefinition) => {
      addRecentVisit({
        agentKey: agent.key,
        agentName: agent.name,
        title: '首页',
        path: agent.route,
      });
      setIsClosing(true);
      setTimeout(() => {
        close();
        setIsClosing(false);
        navigate(agent.route);
      }, 200);
    },
    [navigate, close, addRecentVisit]
  );

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      close();
      setIsClosing(false);
    }, 200);
  }, [close]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(e.key)) {
        e.preventDefault();
      }

      switch (e.key) {
        case 'Escape':
          handleClose();
          break;
        case 'ArrowLeft':
          moveSelection('left');
          break;
        case 'ArrowRight':
          moveSelection('right');
          break;
        case 'Enter': {
          const agent = AGENT_DEFINITIONS[selectedIndex];
          if (agent) navigateToAgent(agent);
          break;
        }
        case '1':
        case '2':
        case '3':
        case '4': {
          const idx = parseInt(e.key, 10) - 1;
          const agent = AGENT_DEFINITIONS[idx];
          if (agent) navigateToAgent(agent);
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, handleClose, moveSelection, navigateToAgent]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) handleClose();
    },
    [handleClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onClick={handleBackdropClick}
      style={{
        animation: isClosing ? 'fadeOut 0.2s ease-out both' : 'fadeIn 0.3s ease-out both',
      }}
    >
      {/* WebGL 宇宙粒子背景 */}
      <CosmicBackground isVisible={!isClosing} />

      {/* 半透明遮罩增强对比 */}
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(0, 0, 0, 0.3)',
        }}
      />

      {/* 内容区域 */}
      <div
        className="relative"
        style={{
          animation: isClosing ? 'contentOut 0.2s ease-in both' : 'contentIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
        role="dialog"
        aria-modal="true"
      >
        {/* 标题 */}
        <div className="text-center mb-10">
          <h2
            className="text-[28px] font-semibold tracking-wide"
            style={{
              color: 'rgba(255, 255, 255, 0.95)',
              textShadow: '0 0 40px rgba(100, 150, 255, 0.4)',
            }}
          >
            选择 Agent
          </h2>
          <p
            className="mt-3 text-[13px] font-light"
            style={{ color: 'rgba(255, 255, 255, 0.45)' }}
          >
            按 1-4 快速切换 · ESC 关闭
          </p>
        </div>

        {/* Agent 卡片 */}
        <div className="flex gap-5 justify-center">
          {AGENT_DEFINITIONS.map((agent, index) => (
            <AgentCard
              key={agent.key}
              agent={agent}
              index={index}
              isSelected={selectedIndex === index}
              onClick={() => navigateToAgent(agent)}
              onMouseEnter={() => setSelectedIndex(index)}
              delay={isClosing ? 0 : 100 + index * 70}
            />
          ))}
        </div>

        {/* 底部提示 */}
        <div className="mt-10 flex justify-center gap-6">
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'rgba(255, 255, 255, 0.4)' }}
          >
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
              }}
            >
              ←
            </span>
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
              }}
            >
              →
            </span>
            <span className="ml-1">导航</span>
          </div>
          <div
            className="flex items-center gap-2 text-[12px]"
            style={{ color: 'rgba(255, 255, 255, 0.4)' }}
          >
            <span
              className="px-2 py-1 rounded-md"
              style={{
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
              }}
            >
              ↵
            </span>
            <span className="ml-1">确认</span>
          </div>
        </div>
      </div>

      {/* 动画样式 */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes contentIn {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        @keyframes contentOut {
          from {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          to {
            opacity: 0;
            transform: scale(0.98) translateY(-5px);
          }
        }
        @keyframes cardFloat {
          from {
            opacity: 0;
            transform: translateY(24px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes glowPulse {
          0%, 100% {
            opacity: 0.6;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.08);
          }
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
