import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Paintbrush, Eraser, RotateCcw, Check, X, Minus, Plus } from 'lucide-react';
import { glassOverlay } from '@/lib/glassStyles';

export interface MaskPaintCanvasProps {
  /** 原图 src（用作底图显示） */
  imageSrc: string;
  /** 原图自然宽度 */
  imageWidth: number;
  /** 原图自然高度 */
  imageHeight: number;
  /** 确认回调：返回蒙版的 data URI（白色=重绘区域，黑色=保持） */
  onConfirm: (maskDataUri: string) => void;
  /** 取消回调 */
  onCancel: () => void;
}

type Tool = 'brush' | 'eraser';

const BRUSH_SIZES = [10, 20, 40, 60, 80];
const DEFAULT_BRUSH_IDX = 2; // 40px

/**
 * 蒙版绘制画布组件（局部重绘用）
 * - 在原图上叠加半透明红色涂层作为蒙版预览
 * - 导出时生成黑白蒙版图（白色=重绘区域）
 */
export function MaskPaintCanvas({
  imageSrc,
  imageWidth,
  imageHeight,
  onConfirm,
  onCancel,
}: MaskPaintCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>('brush');
  const [brushIdx, setBrushIdx] = useState(DEFAULT_BRUSH_IDX);
  const [isDrawing, setIsDrawing] = useState(false);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const brushSize = BRUSH_SIZES[brushIdx];

  // 计算显示尺寸（适配容器，保持宽高比）
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !imageWidth || !imageHeight) return;

    const observe = () => {
      const maxW = container.clientWidth - 32; // padding
      const maxH = container.clientHeight - 120; // 留出工具栏
      if (maxW <= 0 || maxH <= 0) return;

      const scale = Math.min(maxW / imageWidth, maxH / imageHeight, 1);
      setDisplaySize({
        w: Math.round(imageWidth * scale),
        h: Math.round(imageHeight * scale),
      });
    };

    observe();
    const ro = new ResizeObserver(observe);
    ro.observe(container);
    return () => ro.disconnect();
  }, [imageWidth, imageHeight]);

  // 初始化画布（全透明 = 无蒙版）
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs || !displaySize.w || !displaySize.h) return;
    cvs.width = displaySize.w;
    cvs.height = displaySize.h;
    const ctx = cvs.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, cvs.width, cvs.height);
  }, [displaySize.w, displaySize.h]);

  /** 获取画布坐标 */
  const getPos = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const cvs = canvasRef.current;
      if (!cvs) return null;
      const rect = cvs.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0]?.clientX ?? 0 : e.clientX;
      const clientY = 'touches' in e ? e.touches[0]?.clientY ?? 0 : e.clientY;
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
      };
    },
    []
  );

  /** 绘制圆形笔刷/橡皮 */
  const drawAt = useCallback(
    (x: number, y: number) => {
      const cvs = canvasRef.current;
      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      if (!ctx) return;

      ctx.beginPath();
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);

      if (tool === 'brush') {
        // 半透明红色（预览层）
        ctx.fillStyle = 'rgba(255, 60, 60, 0.45)';
        ctx.globalCompositeOperation = 'source-over';
      } else {
        // 橡皮：擦除
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,1)';
      }
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    },
    [tool, brushSize]
  );

  /** 在两点间插值绘制（避免快速移动时断点） */
  const drawLine = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.ceil(dist / (brushSize / 4)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        drawAt(from.x + dx * t, from.y + dy * t);
      }
    },
    [drawAt, brushSize]
  );

  const handleStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      const pos = getPos(e);
      if (!pos) return;
      setIsDrawing(true);
      lastPosRef.current = pos;
      drawAt(pos.x, pos.y);
    },
    [getPos, drawAt]
  );

  const handleMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!isDrawing) return;
      e.preventDefault();
      const pos = getPos(e);
      if (!pos) return;
      if (lastPosRef.current) {
        drawLine(lastPosRef.current, pos);
      }
      lastPosRef.current = pos;
    },
    [isDrawing, getPos, drawLine]
  );

  const handleEnd = useCallback(() => {
    setIsDrawing(false);
    lastPosRef.current = null;
  }, []);

  /** 清空蒙版 */
  const handleClear = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, cvs.width, cvs.height);
  }, []);

  /** 导出黑白蒙版图 */
  const handleConfirm = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    // 创建输出画布（原图尺寸）
    const out = document.createElement('canvas');
    out.width = imageWidth;
    out.height = imageHeight;
    const outCtx = out.getContext('2d');
    if (!outCtx) return;

    // 全黑底色（保持不变的区域）
    outCtx.fillStyle = '#000000';
    outCtx.fillRect(0, 0, imageWidth, imageHeight);

    // 读取绘制画布的像素数据
    const srcData = ctx.getImageData(0, 0, cvs.width, cvs.height);

    // 缩放到原图尺寸：有涂层的像素 → 白色
    const scaleX = imageWidth / cvs.width;
    const scaleY = imageHeight / cvs.height;

    const outData = outCtx.getImageData(0, 0, imageWidth, imageHeight);
    for (let y = 0; y < imageHeight; y++) {
      for (let x = 0; x < imageWidth; x++) {
        const sx = Math.min(Math.floor(x / scaleX), cvs.width - 1);
        const sy = Math.min(Math.floor(y / scaleY), cvs.height - 1);
        const srcIdx = (sy * cvs.width + sx) * 4;
        // alpha > 0 表示有涂层 → 白色（重绘区域）
        if (srcData.data[srcIdx + 3] > 10) {
          const dstIdx = (y * imageWidth + x) * 4;
          outData.data[dstIdx] = 255;     // R
          outData.data[dstIdx + 1] = 255; // G
          outData.data[dstIdx + 2] = 255; // B
          outData.data[dstIdx + 3] = 255; // A
        }
      }
    }
    outCtx.putImageData(outData, 0, 0);

    const dataUri = out.toDataURL('image/png');
    onConfirm(dataUri);
  }, [imageWidth, imageHeight, onConfirm]);

  const decreaseBrush = () => setBrushIdx((i) => Math.max(0, i - 1));
  const increaseBrush = () => setBrushIdx((i) => Math.min(BRUSH_SIZES.length - 1, i + 1));

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
      style={glassOverlay}
    >
      {/* 工具栏 */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 rounded-xl mb-3"
        style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
      >
        {/* 画笔 */}
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{
            background: tool === 'brush' ? 'rgba(239,68,68,0.3)' : 'transparent',
            color: tool === 'brush' ? '#fca5a5' : 'rgba(255,255,255,0.6)',
            border: tool === 'brush' ? '1px solid rgba(239,68,68,0.4)' : '1px solid transparent',
          }}
          onClick={() => setTool('brush')}
        >
          <Paintbrush size={14} />
          画笔
        </button>

        {/* 橡皮 */}
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{
            background: tool === 'eraser' ? 'rgba(255,255,255,0.15)' : 'transparent',
            color: tool === 'eraser' ? '#e5e7eb' : 'rgba(255,255,255,0.6)',
            border: tool === 'eraser' ? '1px solid rgba(255,255,255,0.2)' : '1px solid transparent',
          }}
          onClick={() => setTool('eraser')}
        >
          <Eraser size={14} />
          橡皮
        </button>

        {/* 分隔线 */}
        <div className="w-px h-5" style={{ background: 'rgba(255,255,255,0.15)' }} />

        {/* 笔刷大小 */}
        <div className="flex items-center gap-1.5">
          <button
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
            style={{ color: 'rgba(255,255,255,0.6)' }}
            onClick={decreaseBrush}
          >
            <Minus size={12} />
          </button>
          <div
            className="flex items-center justify-center rounded-full border"
            style={{
              width: Math.max(16, brushSize * 0.5),
              height: Math.max(16, brushSize * 0.5),
              borderColor: 'rgba(255,255,255,0.3)',
              background: tool === 'brush' ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.15)',
            }}
          />
          <button
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
            style={{ color: 'rgba(255,255,255,0.6)' }}
            onClick={increaseBrush}
          >
            <Plus size={12} />
          </button>
          <span className="text-[10px] tabular-nums" style={{ color: 'rgba(255,255,255,0.4)' }}>
            {brushSize}px
          </span>
        </div>

        {/* 分隔线 */}
        <div className="w-px h-5" style={{ background: 'rgba(255,255,255,0.15)' }} />

        {/* 清空 */}
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:bg-white/10"
          style={{ color: 'rgba(255,255,255,0.6)' }}
          onClick={handleClear}
        >
          <RotateCcw size={13} />
          清空
        </button>

        {/* 分隔线 */}
        <div className="w-px h-5" style={{ background: 'rgba(255,255,255,0.15)' }} />

        {/* 确认 */}
        <button
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
          style={{
            background: 'rgba(34,197,94,0.25)',
            color: '#86efac',
            border: '1px solid rgba(34,197,94,0.35)',
          }}
          onClick={handleConfirm}
        >
          <Check size={14} />
          确认蒙版
        </button>

        {/* 取消 */}
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:bg-white/10"
          style={{ color: 'rgba(255,255,255,0.5)' }}
          onClick={onCancel}
        >
          <X size={14} />
          取消
        </button>
      </div>

      {/* 提示文字 */}
      <div className="text-xs mb-2" style={{ color: 'rgba(255,255,255,0.4)' }}>
        在图片上涂抹需要重绘的区域（红色部分），然后点击"确认蒙版"
      </div>

      {/* 画布区域 */}
      {displaySize.w > 0 && displaySize.h > 0 && (
        <div className="relative" style={{ width: displaySize.w, height: displaySize.h }}>
          {/* 底图 */}
          <img
            src={imageSrc}
            alt="原图"
            className="absolute inset-0 rounded-lg pointer-events-none select-none"
            style={{ width: displaySize.w, height: displaySize.h, objectFit: 'contain' }}
            draggable={false}
          />
          {/* 蒙版画布（叠加在图上） */}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 rounded-lg"
            style={{
              width: displaySize.w,
              height: displaySize.h,
              cursor: 'crosshair',
              touchAction: 'none',
            }}
            onMouseDown={handleStart}
            onMouseMove={handleMove}
            onMouseUp={handleEnd}
            onMouseLeave={handleEnd}
            onTouchStart={handleStart}
            onTouchMove={handleMove}
            onTouchEnd={handleEnd}
          />
        </div>
      )}
    </div>
  );
}
