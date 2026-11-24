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
  /** 缩略图用：画布上那张裁剪版，小图列表里看得清内容。 */
  src: string;
  /**
   * 合成预览用：**满幅**那一版（没裁过时与 src 同值）。
   *
   * 预览把每层铺满同一个框来叠，这个「铺满」只有在每层都是满幅、
   * 彼此坐标系一致时才成立。喂裁剪版进去，覆盖 9.5% 的那层会被放大居中，
   * 预览与画布、与导出三方对不上——而这块的承诺恰恰是「改一处这里立刻变」。
   * 同一条不变量的第四个出口（Codex PR #1363 P1）。
   */
  compositeSrc: string;
  /** 生成中的占位层：没有图，只占位子。 */
  pending?: boolean;
  failed?: boolean;
  hidden?: boolean;
  /** 0–1。 */
  opacity: number;
};

export type SemanticLayerPanelProps = {
  /**
   * 距画布右缘多远（px）。
   *
   * 这一页右侧其实有**两个浮层**：对话（absolute right-3，宽 420，z-30）和这块面板
   * （z-40）。两个都锚在右边、面板层级更高，于是面板直接盖住对话——用户截图里
   * 「Hi，我是你的 AI 设计师」被切掉半句就是这么来的。
   *
   * 所以这个值不是留白，是**让位**：调用方按对话浮层的实际占位算出来传进来。
   * 写死在这里等于把对话的几何抄第二份，改一边忘一边（判据分裂）。
   */
  rightInset?: number;
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
  /**
   * 摆放方式。默认 stacked：各部件叠回原位，画面看起来和原图一样，只是每块能单独挪。
   * spread 只是「想逐块看看」时的临时视图，不该是默认——摊开等于让用户自己再拼一次。
   */
  layoutMode?: 'stacked' | 'spread';
  onLayoutModeChange?: (mode: 'stacked' | 'spread') => void;
  onLayerCountChange: (value: number) => void;
  /**
   * 用自己的话说想怎么拆。这是主入口，层数是次要提示——
   * 「我就想把人物和风景分开」用数字表达不了（2026-08-10 用户原话）。
   */
  intent?: string;
  onIntentChange?: (value: string) => void;
  /** 上一次分层落到的模型或能力标识；拿不到就不显示，绝不编一个。 */
  usedModel?: string;
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
/**
 * 这串是能力标识还是模型名？
 *
 * 分层走「按能力路由」：MAP 只认 image-layering 这个稳定标识，真实上游由网关决定。
 * 两者长得都像一串 id，含义却完全不同——把能力当模型名显示，等于给用户一个
 * 他无法据以判断的假事实。
 */
export function isCapabilityId(value: string): boolean {
  return /^image-layering$/i.test(String(value ?? '').trim());
}

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
  rightInset = 16,
  layers,
  sourceSrc,
  title,
  aspectRatio,
  busy,
  busyText,
  layerCount,
  requestedLayerCount,
  layoutMode = 'stacked',
  onLayoutModeChange,
  onLayerCountChange,
  intent = '',
  onIntentChange,
  usedModel,
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
      className="absolute top-4 bottom-4 z-40 w-[300px] flex flex-col rounded-[14px] overflow-hidden"
      style={{
        // right 由调用方给（见 rightInset 的注释）：面板要给右侧的对话浮层让位。
        right: rightInset,
        // 让位之后面板离左边更近了。窗口很窄时（可用宽 < rightInset + 316）宁可让它变窄，
        // 也不要溢出被 stage 的 overflow-hidden 悄悄切掉半截——切掉是看不出原因的，
        // 变窄至少是能看见的退化。
        maxWidth: `calc(100% - ${rightInset + 16}px)`,
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
              layer.compositeSrc && !layer.hidden ? (
                <img
                  key={`composite_${layer.key}`}
                  src={layer.compositeSrc}
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
                  title="单独下载这一层的透明 PNG（已裁成最小非透明矩形）"
                  data-testid="layer-download"
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
        {/* 摆放方式：默认原位叠放，想逐块检视再切平铺 */}
        {onLayoutModeChange && (
          <div className="h-7 flex items-center gap-1.5 text-[11px] pb-1" style={{ color: 'var(--text-secondary)' }}>
            <span className="shrink-0">摆放</span>
            {(['stacked', 'spread'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className="h-6 px-2 rounded-[6px] text-[11px] font-semibold transition-colors hover-bg-soft disabled:opacity-40"
                style={{
                  color: layoutMode === mode ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: layoutMode === mode ? 'rgba(var(--accent-primary-rgb), 0.18)' : 'transparent',
                  border: `1px solid ${layoutMode === mode ? 'rgba(var(--accent-primary-rgb), 0.45)' : 'var(--border-subtle)'}`,
                }}
                disabled={!!busy}
                title={mode === 'stacked' ? '各部件叠在原位，画面与原图一致' : '铺开成一排，逐块检视'}
                onClick={() => onLayoutModeChange(mode)}
              >
                {mode === 'stacked' ? '原位叠放' : '平铺展开'}
              </button>
            ))}
          </div>
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
        {/* 主入口：用自己的话说想怎么拆。
            层数是个很难做的决定——「我想把人物和风景分开」翻译成数字很可能拆出
            「人物 + 冰淇淋」（2026-08-10 用户原话）。所以这里放在层数**上面**，
            留空就交给模型自己判断，不强迫用户先想清楚要几层。 */}
        <div className="flex flex-col gap-1">
          <input
            type="text"
            value={intent}
            maxLength={200}
            disabled={!!busy}
            placeholder="想怎么拆？例如：把人物和风景分开（可留空）"
            className="h-8 px-2 rounded-[8px] text-[11px] outline-none disabled:opacity-40"
            style={{
              color: 'var(--text-primary)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-default)',
            }}
            onChange={(event) => onIntentChange?.(event.target.value)}
          />
          {/* 有根才写。这里拿到的多半是**能力标识**而不是模型名——分层的真实上游由独立网关
              按健康度路由，MAP 按设计不感知（capability-is-not-model）。所以只能如实说
              「走了哪条能力」，不能把 image-layering 这种 id 摆出来冒充模型名
              （2026-08-11 用户截图里就是「本组由 image-layering 拆分」，等于没说）。 */}
          {usedModel ? (
            <div className="text-[10px] leading-4 truncate" style={{ color: 'var(--text-muted)' }} title={usedModel}>
              {isCapabilityId(usedModel)
                ? `本组走「${usedModel}」能力路由，具体模型由网关决定`
                : `本组由 ${usedModel} 拆分`}
            </div>
          ) : null}
        </div>
        {/* 层数退居次要提示：仍可调，但它不再是唯一的表达方式 */}
        <div className="h-7 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          <span className="shrink-0">期望拆</span>
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
            title="按当前拆法再拆一次，结果落在右边新的一份副本上，不覆盖这一份"
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
