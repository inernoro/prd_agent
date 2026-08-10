import { useMemo } from 'react';
import { ArrowDown, ArrowUp, Download, Eye, EyeOff, Image as ImageIcon, Layers, Minus, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';

import { LAYER_COUNT_MAX, LAYER_COUNT_MIN } from '@/lib/aiLayerNaming';

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
  /** 主标题：序号，任何情况下都能相互区分。 */
  name: string;
  /** 副标题：来源提示词，可截断，不承担分辨职责。 */
  subtitle?: string;
  /** 附注：这一层被判成了什么（近乎空层 / 整张原图）。普通图层为空串。 */
  note?: string;
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
  /** 下次拆几层（2-8）。层数写死会让只拆得出两三层的图多出空层。 */
  layerCount: number;
  /**
   * 本次实际请求的层数。层数是「期望」不是「保证」——模型可能给得更少。
   * 不把它显示出来，用户就会看到「下次拆 2 层」旁边站着 3 个图层，三个数字互相打架
   * 却没人解释（2026-08-10 实测截图）。
   */
  requestedLayerCount?: number;
  onLayerCountChange: (value: number) => void;
  onResplit: () => void;
  selectedKey?: string;
  onSelect: (key: string) => void;
  onToggleHidden: (key: string) => void;
  onOpacityChange: (key: string, opacity: number) => void;
  onMove: (key: string, direction: 'up' | 'down') => void;
  onDownloadLayer: (key: string) => void;
  onExportPsd: () => void;
  onExportComposite: () => void;
  onExportZip: () => void;
  onSelfCheck: () => void;
  onClose: () => void;
};

/**
 * 每行第二行显示什么。
 *
 * 抽成纯函数是为了它可测：这一行的职责是「把各图层区分开」，
 * 上一版把只有一个值的来源文本放进来，三行显示同一串字，等于白占一行。
 */
export function layerRowSecondaryText(layer: SemanticLayerPanelLayer): string {
  if (layer.pending) return '生成中';
  if (layer.failed) return '未生成';
  return layer.note || layer.subtitle || `不透明度 ${Math.round(layer.opacity * 100)}%`;
}

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
  layerCount,
  requestedLayerCount,
  onLayerCountChange,
  onResplit,
  selectedKey,
  onSelect,
  onToggleHidden,
  onOpacityChange,
  onMove,
  onDownloadLayer,
  onExportPsd,
  onExportComposite,
  onExportZip,
  onSelfCheck,
  onClose,
}: SemanticLayerPanelProps) {
  // 面板从上往下读 = 从最上层往下读，和 Photoshop 一致；数组本身保持「底层在前」。
  const topDown = useMemo(() => [...layers].reverse(), [layers]);
  const visibleCount = layers.filter((layer) => !layer.hidden && !layer.pending && !layer.failed).length;
  const ratio = aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const nothingToExport = visibleCount === 0;
  // 还有占位层在生成时，layers.length 只是「已铺了几个位子」，不是模型的最终答案。
  // 拿它去下「模型实际给出 N 层」的结论，是在报一个还没发生的事（冒烟实测截到）。
  // 注意不能用 busy：那是导出忙标志，分层进行中它是 false。
  const stillGenerating = layers.some((layer) => layer.pending);

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
                  <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }} title={layer.subtitle || undefined}>
                    {layerRowSecondaryText(layer)}
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
        {/* 层数是期望不是保证：请求 N 层但模型只给 M 层时必须说清楚，否则页面上会出现
            三个互相矛盾的数字而无人解释。相等时不占地方。
            **生成中不能显示**——那会儿只铺了占位卡，写「模型实际给出 1 层」是在报一个
            还没发生的结论（冒烟截图实测）。 */}
        {!stillGenerating && typeof requestedLayerCount === 'number' && requestedLayerCount > 0 && requestedLayerCount !== layers.length && (
          <div className="text-[10px] leading-4 pb-1" style={{ color: 'var(--text-muted)' }}>
            {`本次请求 ${requestedLayerCount} 层，模型实际给出 ${layers.length} 层（层数由模型决定，只能是期望值）`}
          </div>
        )}
        {/* 层数就地可调：不为一个参数开配置面板（奥卡姆），但也不写死 4 */}
        <div className="h-7 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          <span className="shrink-0">下次拆</span>
          <button
            type="button"
            className="w-5 h-5 rounded-[5px] inline-flex items-center justify-center hover-bg-soft disabled:opacity-30"
            style={{ border: '1px solid var(--border-default)' }}
            disabled={!!busy || layerCount <= LAYER_COUNT_MIN}
            title="减少一层"
            onClick={() => onLayerCountChange(layerCount - 1)}
          >
            <Minus size={11} />
          </button>
          <span className="w-6 text-center font-semibold" style={{ color: 'var(--text-primary)' }}>{layerCount}</span>
          <button
            type="button"
            className="w-5 h-5 rounded-[5px] inline-flex items-center justify-center hover-bg-soft disabled:opacity-30"
            style={{ border: '1px solid var(--border-default)' }}
            disabled={!!busy || layerCount >= LAYER_COUNT_MAX}
            title="增加一层"
            onClick={() => onLayerCountChange(layerCount + 1)}
          >
            <Plus size={11} />
          </button>
          <span className="shrink-0">层</span>
          <button
            type="button"
            className="ml-auto h-6 px-2 rounded-[6px] inline-flex items-center gap-1 hover-bg-soft disabled:opacity-40"
            style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
            disabled={!!busy}
            title="用当前层数重新拆一次"
            onClick={onResplit}
          >
            <RefreshCw size={11} />
            重新拆分
          </button>
        </div>

        {/* 导出前先问一句「读得到吗」：不做这步，跨域读不到时只会在下载到一半时
            抛一句没头没尾的 Failed to fetch，谁也不知道是哪一层出的问题。 */}
        <button
          type="button"
          className="h-7 rounded-[8px] inline-flex items-center justify-center gap-1.5 text-[11px] hover-bg-soft disabled:opacity-40"
          style={{ color: 'var(--text-secondary)', border: '1px dashed var(--border-default)' }}
          disabled={!!busy || layers.every((layer) => !layer.src)}
          title="逐个确认原图与每个图层真的读得到，读不到会说清是哪一层、什么原因"
          onClick={onSelfCheck}
        >
          <ShieldCheck size={12} />
          导出前自检
        </button>
        <div className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>
          {sourceSrc ? '导出以原图尺寸对齐，隐藏层仍写进 PSD' : '缺少原图，导出可能失败'}
        </div>
      </div>
    </div>
  );
}

export default SemanticLayerPanel;
