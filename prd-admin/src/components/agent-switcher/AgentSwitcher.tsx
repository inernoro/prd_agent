/**
 * Agent Switcher 浮层组件 v3.0
 *
 * 高级视觉效果版本：
 * - WebGL 星空背景 Shader
 * - 自定义 3D 图标
 * - 3D 卡片倾斜效果
 * - 脉冲发光动画
 * - 优化的进入/退出动效
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

/** WebGL 星空背景组件 */
function StarfieldBackground({ isVisible }: { isVisible: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const animationRef = useRef<number>(0);
  const timeRef = useRef(0);

  useEffect(() => {
    if (!isVisible || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const gl = canvas.getContext('webgl');
    if (!gl) return;

    glRef.current = gl;

    // 设置 canvas 尺寸
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);

    // Shader 源码
    const vertexSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fragmentSource = `
      precision highp float;
      uniform float width;
      uniform float height;
      uniform float time;

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
        vec2 resolution = vec2(width, height);
        float t = 1.0 + time * 0.03;
        const float layers = 4.0;
        float scale = 28.0;
        float rotationAngle = time * -0.08;

        mat2 rotation = mat2(
          cos(rotationAngle), -sin(rotationAngle),
          sin(rotationAngle), cos(rotationAngle)
        );

        vec3 col = vec3(0);
        vec2 rot = vec2(cos(t), sin(t));

        for (float i = 0.0; i <= 1.0; i += 1.0 / layers) {
          float depth = fract(i + t);
          vec2 centre = rot * 0.15 * depth + 0.5;
          vec2 uv = centre - gl_FragCoord.xy / resolution.x;
          uv *= rotation;
          uv *= mix(scale, 0.0, depth);

          vec2 fl = floor(uv);
          vec2 local_uv = uv - fl - 0.5;

          for (float j = -1.0; j <= 1.0; j++) {
            for (float k = -1.0; k <= 1.0; k++) {
              vec2 cell = vec2(j, k);
              vec2 index = fl + cell;
              vec2 seed = 128.0 * i + index;
              vec2 pos = cell + 0.9 * (random2(seed) - 0.5);
              float phase = 128.0 * random(seed);

              // 金色/蓝色/紫色色调
              vec3 tone = mix(
                vec3(0.85, 0.7, 0.4),  // 金色
                vec3(0.4, 0.6, 1.0),   // 蓝色
                random(seed + 3.0)
              );
              tone = mix(tone, vec3(0.7, 0.5, 1.0), random(seed + 5.0) * 0.3); // 紫色点缀

              float size = (0.1 + 0.4 + 0.4 * sin(phase * t)) * depth;
              float glow = size * getGlow(length(local_uv - pos), 0.08, 2.2);
              col += 4.0 * vec3(0.015 * glow) + tone * glow * 0.8;
            }
          }
        }

        col = 1.0 - exp(-col);
        gl_FragColor = vec4(col, 1.0);
      }
    `;

    // 编译 Shader
    const compileShader = (source: string, type: number) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };

    const vertexShader = compileShader(vertexSource, gl.VERTEX_SHADER);
    const fragmentShader = compileShader(fragmentSource, gl.FRAGMENT_SHADER);

    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.useProgram(program);
    programRef.current = program;

    // 顶点数据
    const vertexData = new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    // Uniforms
    const timeHandle = gl.getUniformLocation(program, 'time');
    const widthHandle = gl.getUniformLocation(program, 'width');
    const heightHandle = gl.getUniformLocation(program, 'height');

    gl.uniform1f(widthHandle, canvas.width);
    gl.uniform1f(heightHandle, canvas.height);

    // 动画循环
    const draw = () => {
      timeRef.current += 0.016;
      gl.uniform1f(timeHandle, timeRef.current);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      animationRef.current = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationRef.current);
    };
  }, [isVisible]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ opacity: isVisible ? 1 : 0, transition: 'opacity 0.5s ease-out' }}
    />
  );
}

/** 3D 卡片组件 */
function Agent3DCard({
  agent,
  index,
  isSelected,
  onClick,
  onHover,
}: {
  agent: AgentDefinition;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onHover: (index: number | null) => void;
}) {
  const cardRef = useRef<HTMLButtonElement>(null);
  const [transform, setTransform] = useState({ rotateX: 0, rotateY: 0 });
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });
  const iconUrl = ICON_URLS[agent.key];

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    setTransform({
      rotateX: ((y - centerY) / centerY) * -15,
      rotateY: ((x - centerX) / centerX) * 15,
    });
    setMousePos({ x: (x / rect.width) * 100, y: (y / rect.height) * 100 });
  };

  const handleMouseLeave = () => {
    setTransform({ rotateX: 0, rotateY: 0 });
    setMousePos({ x: 50, y: 50 });
    onHover(null);
  };

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={handleMouseLeave}
      className="group relative outline-none focus:outline-none"
      style={{ perspective: '1000px' }}
    >
      {/* 外层光晕 */}
      <div
        className="absolute -inset-3 rounded-[32px] transition-all duration-500 pointer-events-none"
        style={{
          opacity: isSelected ? 1 : 0,
          background: `radial-gradient(circle at 50% 50%, ${agent.color.text}50 0%, transparent 70%)`,
          filter: 'blur(20px)',
          animation: isSelected ? 'pulse-glow 2.5s ease-in-out infinite' : 'none',
        }}
      />

      {/* 主卡片 */}
      <div
        className="relative w-[140px] h-[160px] rounded-[28px] flex flex-col items-center justify-center gap-2 transition-all duration-300 ease-out overflow-hidden"
        style={{
          transform: `rotateX(${transform.rotateX}deg) rotateY(${transform.rotateY}deg) scale(${isSelected ? 1.08 : 1})`,
          transformStyle: 'preserve-3d',
          background: isSelected
            ? `linear-gradient(145deg, ${agent.color.bg} 0%, rgba(15, 15, 18, 0.95) 100%)`
            : 'linear-gradient(145deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)',
          border: `1.5px solid ${isSelected ? agent.color.border : 'rgba(255, 255, 255, 0.1)'}`,
          boxShadow: isSelected
            ? `0 25px 50px -12px ${agent.color.text}40, 0 0 0 1px ${agent.color.border}, inset 0 1px 0 rgba(255,255,255,0.15)`
            : '0 8px 32px -8px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)',
        }}
      >
        {/* Spotlight 光效 */}
        <div
          className="absolute inset-0 rounded-[28px] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{
            background: `radial-gradient(circle at ${mousePos.x}% ${mousePos.y}%, rgba(255,255,255,0.2) 0%, transparent 50%)`,
          }}
        />

        {/* 渐变边框 */}
        {isSelected && (
          <div
            className="absolute -inset-[1.5px] rounded-[28px] pointer-events-none"
            style={{
              background: `conic-gradient(from 0deg, ${agent.color.text}80, transparent 40%, ${agent.color.text}60, transparent 80%, ${agent.color.text}80)`,
              animation: 'border-spin 4s linear infinite',
              mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
              maskComposite: 'exclude',
              WebkitMaskComposite: 'xor',
              padding: '1.5px',
            }}
          />
        )}

        {/* 图标 */}
        <div
          className="relative w-[72px] h-[72px] transition-all duration-300"
          style={{
            transform: `translateZ(30px) scale(${isSelected ? 1.1 : 1})`,
            filter: isSelected ? `drop-shadow(0 0 20px ${agent.color.text}80)` : 'none',
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
        <div
          className="text-[15px] font-semibold transition-all duration-300"
          style={{
            color: isSelected ? '#fff' : 'rgba(255,255,255,0.7)',
            transform: 'translateZ(15px)',
            textShadow: isSelected ? `0 0 30px ${agent.color.text}` : 'none',
          }}
        >
          {agent.name}
        </div>

        {/* 快捷键 */}
        <div
          className="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center text-[12px] font-bold transition-all duration-300"
          style={{
            background: isSelected ? `${agent.color.text}30` : 'rgba(255, 255, 255, 0.1)',
            color: isSelected ? agent.color.text : 'rgba(255,255,255,0.5)',
            boxShadow: isSelected ? `0 0 15px ${agent.color.text}50` : 'none',
            transform: 'translateZ(20px)',
            backdropFilter: 'blur(8px)',
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
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
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
      // 先播放退出动画
      setIsClosing(true);
      setTimeout(() => {
        close();
        setIsClosing(false);
        navigate(agent.route);
      }, 250);
    },
    [navigate, close, addRecentVisit]
  );

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      close();
      setIsClosing(false);
    }, 250);
  }, [close]);

  const handleHover = useCallback(
    (index: number | null) => {
      setHoveredIndex(index);
      if (index !== null) setSelectedIndex(index);
    },
    [setSelectedIndex]
  );

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

  const activeAgent = AGENT_DEFINITIONS[hoveredIndex ?? selectedIndex];
  const activeColor = activeAgent?.color.text || '#60A5FA';

  return createPortal(
    <div
      className={`fixed inset-0 z-[200] flex items-center justify-center ${isClosing ? 'animate-fade-out' : 'animate-fade-in'}`}
      onClick={handleBackdropClick}
    >
      {/* WebGL 星空背景 */}
      <StarfieldBackground isVisible={!isClosing} />

      {/* 暗角遮罩 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 100% 100% at 50% 50%, transparent 30%, rgba(0,0,0,0.7) 100%)`,
        }}
      />

      {/* 动态颜色光晕 */}
      <div
        className="absolute inset-0 pointer-events-none transition-all duration-700"
        style={{
          background: `radial-gradient(ellipse 60% 40% at 50% 40%, ${activeColor}20 0%, transparent 70%)`,
        }}
      />

      {/* 主内容 */}
      <div
        className={`relative flex flex-col items-center ${isClosing ? 'animate-content-out' : 'animate-content-in'}`}
        role="dialog"
        aria-modal="true"
      >
        {/* 标题 */}
        <div className="mb-10 text-center">
          <h2
            className="text-[28px] font-bold tracking-tight"
            style={{
              color: '#fff',
              textShadow: '0 4px 30px rgba(0,0,0,0.8)',
            }}
          >
            选择 Agent
          </h2>
          <p className="mt-3 text-[14px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
            按 <kbd className="px-2 py-1 rounded-md bg-white/10 text-[12px] font-mono text-white/70">1-4</kbd> 快速跳转
            · <kbd className="px-2 py-1 rounded-md bg-white/10 text-[12px] font-mono text-white/70">ESC</kbd> 关闭
          </p>
        </div>

        {/* Agent 卡片 */}
        <div className="flex gap-5">
          {AGENT_DEFINITIONS.map((agent, index) => (
            <div
              key={agent.key}
              style={{
                animation: isClosing
                  ? `card-pop-out 250ms cubic-bezier(0.4, 0, 1, 1) ${index * 30}ms both`
                  : `card-pop-in 500ms cubic-bezier(0.34, 1.56, 0.64, 1) ${150 + index * 80}ms both`,
              }}
            >
              <Agent3DCard
                agent={agent}
                index={index}
                isSelected={selectedIndex === index}
                onClick={() => navigateToAgent(agent)}
                onHover={handleHover}
              />
            </div>
          ))}
        </div>
      </div>

      {/* 动画样式 */}
      <style>{`
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fade-out {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        .animate-fade-in {
          animation: fade-in 400ms ease-out both;
        }
        .animate-fade-out {
          animation: fade-out 250ms ease-in both;
        }

        @keyframes content-in {
          from {
            opacity: 0;
            transform: scale(0.9) translateY(20px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        @keyframes content-out {
          from {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          to {
            opacity: 0;
            transform: scale(0.95) translateY(-10px);
          }
        }
        .animate-content-in {
          animation: content-in 400ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        .animate-content-out {
          animation: content-out 200ms ease-in both;
        }

        @keyframes card-pop-in {
          from {
            opacity: 0;
            transform: scale(0.7) translateY(30px) rotateX(-15deg);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0) rotateX(0);
          }
        }
        @keyframes card-pop-out {
          from {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          to {
            opacity: 0;
            transform: scale(0.8) translateY(-20px);
          }
        }

        @keyframes pulse-glow {
          0%, 100% {
            opacity: 0.6;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.08);
          }
        }

        @keyframes border-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
