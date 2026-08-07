import { useMemo } from 'react';
import { ArrowDown, ArrowUp, Download, Eye, EyeOff, Image as ImageIcon, Layers, X } from 'lucide-react';

import { MapSpinner } from '@/components/ui/VideoLoader';

/**
 * AI 分层的「组装台」。
 *
 * 画布上的分层 Frame 负责「单层能选中、能编辑、能挪」，但自由画布看不出叠放关系——
 * 谁压着谁、关掉哪层会怎样、最终拍平长什么样，都要在这里回答。所以这块面板是 Photoshop
 * 心智：上面一块实时合成预览，下面一列图层（顶部即最上层），显隐 / 不透明度 / 次序改完
 * 预览立刻跟着变，而且下载出去的 PSD 与合成 PNG 就是预览的那个状态。
 *
 * 透明区一律铺棋盘格：RGBA 图层直接放在深色画布上看着就是一张黑图，
 * 分不出「这是透明的一层」还是「模型给了张糊图」。
 */

export type SemanticLayerPanelLayer = {
  key: string;
  name: string;
  src: string;
  /** 生成中的占位层：没有图，只占位子。 */
  pending?: boolean;
  failed?: boolean;
  hidden?: boolean;
  /** 0–1。 */
  opacity: number;
};

export type SemanticLayerPanelProps = {
  /** 从下到上排好序的图层（数组末尾 = 最上层）。 */
  layers: SemanticLayerPanelLayer[];
  sourceSrc: string;
  title: string;
  /** 合成预览按原图比例摆放，拿不到就退回 1:1。 */
  aspectRatio?: number;
  busy?: boolean;
  busyText?: string;
  selectedKey?: string;
  onSelect: (key: string) => void;
  onToggleHidden: (key: string) => void;
  onOpacityChange: (key: string, opacity: number) => void;
  onMove: (key: string, direction: 'up' | 'down') => void;
  onDownloadLayer: (key: string) => void;
  onExportPsd: () => void;
  onExportComposite: () => void;
  onExportZip: () => void;
  onClose: () => void;
};

const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(128,128,128,0.28) 25%, transparent 25%),'
    + 'linear-gradient(-45deg, rgba(128,128,128,0.28) 25%, transparent 25%),'
    + 'linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.28) 75%),'
    + 'linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.28) 75%)',
  backgroundSize: '14px 14px',
  backgroundPosition: '0 0, 0 7px, 7px -7px, -7px 0px',
  backgroundColor: 'var(--bg-tertiary)',
};

export function SemanticLayerPanel({
  layers,
  sourceSrc,
  title,
  aspectRatio,
  busy,
  busyText,
  selectedKey,
  onSelect,
  onToggleHidden,
  onOpacityChange,
  onMove,
  onDownloadLayer,
  onExportPsd,
  onExportComposite,
  onExportZip,
  onClose,
}: SemanticLayerPanelProps) {
  // 面板从上往下读 = 从最上层往下读，和 Photoshop 一致；数组本身保持「底层在前」。
  const topDown = useMemo(() => [...layers].reverse(), [layers]);
  const visibleCount = layers.filter((layer) => !layer.hidden && !layer.pending && !layer.failed).length;
  const ratio = aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const nothingToExport = visibleCount === 0;

  return (
    <div
      className="absolute right-4 top-4 bottom-4 z-40 w-[300px] flex flex-col rounded-[14px] overflow-hidden"
      style={{
        background: 'var(--panel-solid)',
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-glass-toast)',
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div
        className="shrink-0 h-11 px-3 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Layers size={15} style={{ color: 'var(--text-primary)' }} />
        <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }} title={title}>
          AI 分层
        </span>
        <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
          {layers.length} 层
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 w-7 h-7 rounded-[7px] inline-flex items-center justify-center hover-bg-soft"
          style={{ color: 'var(--text-secondary)' }}
          title="收起图层面板"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      {/* 合成预览：改一处这里立刻变，用户不用先导出再看对不对 */}
      <div className="shrink-0 px-3 pt-3">
        <div className="text-[11px] mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
          合成预览
          <span style={{ color: 'var(--text-muted)' }}>· {visibleCount}/{layers.length} 层可见</span>
        </div>
        <div className="relative w-full rounded-[10px] overflow-hidden" style={{ ...CHECKERBOARD, aspectRatio: String(ratio) }}>
          {nothingToExport ? (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[11px]"
              style={{ color: 'var(--text-muted)' }}
            >
              <ImageIcon size={22} />
              全部图层已隐藏
            </div>
          ) : (
            layers.map((layer) => (
              layer.src && !layer.hidden ? (
                <img
                  key={`composite_${layer.key}`}
                  src={layer.src}
                  alt={layer.name}
                  className="absolute inset-0 w-full h-full"
                  style={{ objectFit: 'contain', opacity: layer.opacity }}
                />
              ) : null
            ))
          )}
        </div>
      </div>

      <div
        className="flex-1 mt-3 px-2"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {topDown.map((layer, indexFromTop) => {
          const active = layer.key === selectedKey;
          return (
            <div
              key={layer.key}
              role="button"
              tabIndex={0}
              className="mb-1.5 rounded-[10px] px-2 py-2 cursor-pointer transition-colors"
              style={{
                background: active ? 'rgba(var(--accent-primary-rgb), 0.14)' : 'var(--bg-card)',
                border: active
                  ? '1px solid rgba(var(--accent-primary-rgb), 0.55)'
                  : '1px solid var(--border-subtle)',
                opacity: layer.hidden ? 0.55 : 1,
              }}
              onClick={() => onSelect(layer.key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(layer.key);
                }
              }}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="shrink-0 w-6 h-6 rounded-[6px] inline-flex items-center justify-center hover-bg-soft"
                  style={{ color: layer.hidden ? 'var(--text-muted)' : 'var(--text-primary)' }}
                  title={layer.hidden ? '显示该图层' : '隐藏该图层'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleHidden(layer.key);
                  }}
                >
                  {layer.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>

                <div
                  className="shrink-0 w-11 h-11 rounded-[7px] overflow-hidden relative"
                  style={{ ...CHECKERBOARD, border: '1px solid var(--border-subtle)' }}
                >
                  {layer.src ? (
                    <img
                      src={layer.src}
                      alt={layer.name}
                      className="absolute inset-0 w-full h-full"
                      style={{ objectFit: 'contain' }}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      {layer.failed ? (
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>失败</span>
                      ) : (
                        <MapSpinner size={14} />
                      )}
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12px] font-medium truncate"
                    style={{ color: 'var(--text-primary)' }}
                    title={layer.name}
                  >
                    {layer.name}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {layer.pending ? '生成中' : layer.failed ? '未生成' : `不透明度 ${Math.round(layer.opacity * 100)}%`}
                  </div>
                </div>

                <div className="shrink-0 flex flex-col">
                  <button
                    type="button"
                    className="w-6 h-5 rounded-[5px] inline-flex items-center justify-center hover-bg-soft disabled:opacity-30"
                    style={{ color: 'var(--text-secondary)' }}
                    title="上移一层"
                    disabled={indexFromTop === 0}
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(layer.key, 'up');
                    }}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="w-6 h-5 rounded-[5px] inline-flex items-center justify-center hover-bg-soft disabled:opacity-30"
                    style={{ color: 'var(--text-secondary)' }}
                    title="下移一层"
                    disabled={indexFromTop === topDown.length - 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(layer.key, 'down');
                    }}
                  >
                    <ArrowDown size={12} />
                  </button>
                </div>

                <button
                  type="button"
                  className="shrink-0 w-6 h-6 rounded-[6px] inline-flex items-center justify-center hover-bg-soft disabled:opacity-30"
                  style={{ color: 'var(--text-secondary)' }}
                  title="单独下载这一层的透明 PNG"
                  disabled={!layer.src}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDownloadLayer(layer.key);
                  }}
                >
                  <Download size={13} />
                </button>
              </div>

              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(layer.opacity * 100)}
                className="mt-2 w-full"
                aria-label={`${layer.name} 不透明度`}
                disabled={!layer.src}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onOpacityChange(layer.key, Number(event.target.value) / 100)}
              />
            </div>
          );
        })}

        {layers.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            这张图还没有拆分图层。
            <br />
            选中图片后点快捷栏的「AI 分层」。
          </div>
        ) : null}
      </div>

      <div
        className="shrink-0 p-2.5 flex flex-col gap-1.5"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        {busy ? (
          <div className="h-8 flex items-center justify-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <MapSpinner size={14} />
            {busyText || '正在导出'}
          </div>
        ) : (
          <>
            <button
              type="button"
              className="h-8 rounded-[8px] inline-flex items-center justify-center gap-1.5 text-[12px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                color: 'var(--text-primary)',
                background: 'rgba(var(--accent-primary-rgb), 0.16)',
                border: '1px solid rgba(var(--accent-primary-rgb), 0.42)',
              }}
              disabled={nothingToExport}
              title={nothingToExport ? '至少要有一个可见图层' : '按当前顺序与显隐写一个分层 PSD'}
              onClick={onExportPsd}
            >
              <Download size={13} />
              导出分层 PSD
            </button>
            <div className="flex gap-1.5">
              <button
                type="button"
                className="flex-1 h-8 rounded-[8px] inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold hover-bg-soft disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
                disabled={nothingToExport}
                title="把当前预览拍平成一张 PNG"
                onClick={onExportComposite}
              >
                合成 PNG
              </button>
              <button
                type="button"
                className="flex-1 h-8 rounded-[8px] inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold hover-bg-soft disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
                disabled={layers.every((layer) => !layer.src)}
                title="所有图层的透明 PNG 打包下载"
                onClick={onExportZip}
              >
                全部 ZIP
              </button>
            </div>
          </>
        )}
        <div className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
          {sourceSrc ? '导出以原图尺寸对齐，隐藏层仍写进 PSD' : '缺少原图，导出可能失败'}
        </div>
      </div>
    </div>
  );
}

export default SemanticLayerPanel;
