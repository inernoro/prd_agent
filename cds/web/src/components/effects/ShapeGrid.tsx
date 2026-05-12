import { useEffect, useRef } from 'react';
import './ShapeGrid.css';

type ShapeGridDirection = 'diagonal' | 'up' | 'right' | 'down' | 'left';
type ShapeGridShape = 'square' | 'hexagon' | 'circle' | 'triangle';

export interface ShapeGridProps {
  direction?: ShapeGridDirection;
  speed?: number;
  borderColor?: string;
  squareSize?: number;
  hoverFillColor?: string;
  shape?: ShapeGridShape;
  hoverTrailAmount?: number;
  className?: string;
}

export default function ShapeGrid({
  direction = 'diagonal',
  speed = 0.18,
  borderColor = 'hsl(var(--foreground) / 0.08)',
  squareSize = 38,
  hoverFillColor = 'hsl(var(--foreground) / 0.045)',
  shape = 'square',
  hoverTrailAmount = 0,
  className = '',
}: ShapeGridProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const requestRef = useRef<number | null>(null);
  const gridOffset = useRef({ x: 0, y: 0 });
  const hoveredSquare = useRef<{ x: number; y: number } | null>(null);
  const trailCells = useRef<Array<{ x: number; y: number }>>([]);
  const cellOpacities = useRef(new Map<string, number>());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isHex = shape === 'hexagon';
    const isTri = shape === 'triangle';
    const hexHoriz = squareSize * 1.5;
    const hexVert = squareSize * Math.sqrt(3);

    const resizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.offsetWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.offsetHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const drawHex = (cx: number, cy: number, size: number) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i;
        const vx = cx + size * Math.cos(angle);
        const vy = cy + size * Math.sin(angle);
        if (i === 0) ctx.moveTo(vx, vy);
        else ctx.lineTo(vx, vy);
      }
      ctx.closePath();
    };

    const drawCircle = (cx: number, cy: number, size: number) => {
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.closePath();
    };

    const drawTriangle = (cx: number, cy: number, size: number, flip: boolean) => {
      ctx.beginPath();
      if (flip) {
        ctx.moveTo(cx, cy + size / 2);
        ctx.lineTo(cx + size / 2, cy - size / 2);
        ctx.lineTo(cx - size / 2, cy - size / 2);
      } else {
        ctx.moveTo(cx, cy - size / 2);
        ctx.lineTo(cx + size / 2, cy + size / 2);
        ctx.lineTo(cx - size / 2, cy + size / 2);
      }
      ctx.closePath();
    };

    const updateCellOpacities = () => {
      const targets = new Map<string, number>();

      if (hoveredSquare.current) {
        targets.set(`${hoveredSquare.current.x},${hoveredSquare.current.y}`, 1);
      }

      if (hoverTrailAmount > 0) {
        for (let i = 0; i < trailCells.current.length; i += 1) {
          const t = trailCells.current[i];
          const key = `${t.x},${t.y}`;
          if (!targets.has(key)) {
            targets.set(key, (trailCells.current.length - i) / (trailCells.current.length + 1));
          }
        }
      }

      for (const [key] of targets) {
        if (!cellOpacities.current.has(key)) cellOpacities.current.set(key, 0);
      }

      for (const [key, opacity] of cellOpacities.current) {
        const target = targets.get(key) || 0;
        const next = opacity + (target - opacity) * 0.15;
        if (next < 0.005) cellOpacities.current.delete(key);
        else cellOpacities.current.set(key, next);
      }
    };

    const drawGrid = () => {
      const width = canvas.offsetWidth;
      const height = canvas.offsetHeight;
      ctx.clearRect(0, 0, width, height);

      if (isHex) {
        const colShift = Math.floor(gridOffset.current.x / hexHoriz);
        const offsetX = ((gridOffset.current.x % hexHoriz) + hexHoriz) % hexHoriz;
        const offsetY = ((gridOffset.current.y % hexVert) + hexVert) % hexVert;
        const cols = Math.ceil(width / hexHoriz) + 3;
        const rows = Math.ceil(height / hexVert) + 3;

        for (let col = -2; col < cols; col += 1) {
          for (let row = -2; row < rows; row += 1) {
            const cx = col * hexHoriz + offsetX;
            const cy = row * hexVert + ((col + colShift) % 2 !== 0 ? hexVert / 2 : 0) + offsetY;
            const alpha = cellOpacities.current.get(`${col},${row}`);
            if (alpha) {
              ctx.globalAlpha = alpha;
              drawHex(cx, cy, squareSize);
              ctx.fillStyle = hoverFillColor;
              ctx.fill();
              ctx.globalAlpha = 1;
            }
            drawHex(cx, cy, squareSize);
            ctx.strokeStyle = borderColor;
            ctx.stroke();
          }
        }
      } else if (isTri) {
        const halfW = squareSize / 2;
        const colShift = Math.floor(gridOffset.current.x / halfW);
        const rowShift = Math.floor(gridOffset.current.y / squareSize);
        const offsetX = ((gridOffset.current.x % halfW) + halfW) % halfW;
        const offsetY = ((gridOffset.current.y % squareSize) + squareSize) % squareSize;
        const cols = Math.ceil(width / halfW) + 4;
        const rows = Math.ceil(height / squareSize) + 4;

        for (let col = -2; col < cols; col += 1) {
          for (let row = -2; row < rows; row += 1) {
            const cx = col * halfW + offsetX;
            const cy = row * squareSize + squareSize / 2 + offsetY;
            const flip = ((col + colShift + row + rowShift) % 2 + 2) % 2 !== 0;
            const alpha = cellOpacities.current.get(`${col},${row}`);
            if (alpha) {
              ctx.globalAlpha = alpha;
              drawTriangle(cx, cy, squareSize, flip);
              ctx.fillStyle = hoverFillColor;
              ctx.fill();
              ctx.globalAlpha = 1;
            }
            drawTriangle(cx, cy, squareSize, flip);
            ctx.strokeStyle = borderColor;
            ctx.stroke();
          }
        }
      } else {
        const offsetX = ((gridOffset.current.x % squareSize) + squareSize) % squareSize;
        const offsetY = ((gridOffset.current.y % squareSize) + squareSize) % squareSize;
        const cols = Math.ceil(width / squareSize) + 3;
        const rows = Math.ceil(height / squareSize) + 3;

        for (let col = -2; col < cols; col += 1) {
          for (let row = -2; row < rows; row += 1) {
            const x = col * squareSize + offsetX;
            const y = row * squareSize + offsetY;
            const cx = x + squareSize / 2;
            const cy = y + squareSize / 2;
            const alpha = cellOpacities.current.get(`${col},${row}`);
            if (alpha) {
              ctx.globalAlpha = alpha;
              ctx.fillStyle = hoverFillColor;
              if (shape === 'circle') {
                drawCircle(cx, cy, squareSize);
                ctx.fill();
              } else {
                ctx.fillRect(x, y, squareSize, squareSize);
              }
              ctx.globalAlpha = 1;
            }
            if (shape === 'circle') drawCircle(cx, cy, squareSize);
            else ctx.beginPath();
            ctx.strokeStyle = borderColor;
            if (shape === 'circle') ctx.stroke();
            else ctx.strokeRect(x, y, squareSize, squareSize);
          }
        }
      }

      const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.sqrt(width ** 2 + height ** 2) / 2);
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradient.addColorStop(0.72, 'rgba(0, 0, 0, 0.12)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    };

    const updateAnimation = () => {
      const effectiveSpeed = reducedMotion ? 0 : Math.max(speed, 0.02);
      const wrapX = isHex ? hexHoriz * 2 : squareSize;
      const wrapY = isHex ? hexVert : isTri ? squareSize * 2 : squareSize;

      if (direction === 'right') gridOffset.current.x = (gridOffset.current.x - effectiveSpeed + wrapX) % wrapX;
      if (direction === 'left') gridOffset.current.x = (gridOffset.current.x + effectiveSpeed + wrapX) % wrapX;
      if (direction === 'up') gridOffset.current.y = (gridOffset.current.y + effectiveSpeed + wrapY) % wrapY;
      if (direction === 'down') gridOffset.current.y = (gridOffset.current.y - effectiveSpeed + wrapY) % wrapY;
      if (direction === 'diagonal') {
        gridOffset.current.x = (gridOffset.current.x - effectiveSpeed + wrapX) % wrapX;
        gridOffset.current.y = (gridOffset.current.y - effectiveSpeed + wrapY) % wrapY;
      }

      updateCellOpacities();
      drawGrid();
      requestRef.current = requestAnimationFrame(updateAnimation);
    };

    const handleMouseMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const offsetX = ((gridOffset.current.x % squareSize) + squareSize) % squareSize;
      const offsetY = ((gridOffset.current.y % squareSize) + squareSize) % squareSize;
      const col = Math.floor((mouseX - offsetX) / squareSize);
      const row = Math.floor((mouseY - offsetY) / squareSize);
      if (!hoveredSquare.current || hoveredSquare.current.x !== col || hoveredSquare.current.y !== row) {
        if (hoveredSquare.current && hoverTrailAmount > 0) {
          trailCells.current.unshift({ ...hoveredSquare.current });
          if (trailCells.current.length > hoverTrailAmount) trailCells.current.length = hoverTrailAmount;
        }
        hoveredSquare.current = { x: col, y: row };
      }
    };

    const handleMouseLeave = () => {
      if (hoveredSquare.current && hoverTrailAmount > 0) {
        trailCells.current.unshift({ ...hoveredSquare.current });
        if (trailCells.current.length > hoverTrailAmount) trailCells.current.length = hoverTrailAmount;
      }
      hoveredSquare.current = null;
    };

    resizeCanvas();
    const resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);
    window.addEventListener('resize', resizeCanvas);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    requestRef.current = requestAnimationFrame(updateAnimation);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      resizeObserver.disconnect();
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      if (requestRef.current !== null) cancelAnimationFrame(requestRef.current);
    };
  }, [borderColor, direction, hoverFillColor, hoverTrailAmount, shape, speed, squareSize]);

  return <canvas ref={canvasRef} className={`shapegrid-canvas ${className}`} aria-hidden="true" />;
}
