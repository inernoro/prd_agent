import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import {
  loadDesignSystemSample,
  type DesignSystemSampleFormat,
} from '@/services/real/designSystems';

/**
 * 风格的真实缩略图：把该风格对应设计系统的样张（它自己的 tokens.css + 共享样张模板）
 * 放进 sandbox="" 的 iframe，按固定画布尺寸渲染，再用 CSS scale 缩到容器宽度。
 * 看到的就是这个风格真实的样子，不是手画的色块。
 *
 * - 懒加载：卡片进入视口（含 200px 预读）才去取样张；取回之前显示样张形状的骨架。
 * - 失败：写清原因并给重试，不静默留白。
 * - 设计系统不在 OpenDesign 目录里：直接说明没有真实样张，不拿别的风格顶替。
 */

export type StyleThumbnailSize = 'thumb' | 'preview';

/** 样张画布尺寸：网页按 1200x760 的首屏排版，封面按 16:9 的 1280x720。 */
export const SAMPLE_FRAME_REGISTRY: Record<DesignSystemSampleFormat, { width: number; height: number }> = {
  page: { width: 1200, height: 760 },
  slides: { width: 1280, height: 720 },
};

/** 两档尺寸：容器宽度量不到时（首帧、不支持 ResizeObserver）用的兜底宽度与圆角。 */
export const THUMBNAIL_SIZE_REGISTRY: Record<StyleThumbnailSize, { fallbackWidth: number; radius: number }> = {
  thumb: { fallbackWidth: 240, radius: 10 },
  preview: { fallbackWidth: 640, radius: 14 },
};

/** 画布缩放比：容器宽 / 画布宽；量不到宽度时按该档兜底宽度算。 */
export function sampleScale(containerWidth: number, format: DesignSystemSampleFormat, size: StyleThumbnailSize): number {
  const width = containerWidth > 0 ? containerWidth : THUMBNAIL_SIZE_REGISTRY[size].fallbackWidth;
  return width / SAMPLE_FRAME_REGISTRY[format].width;
}

/** 失败文案：把取样张时的错误翻成一句用户能看懂的话。 */
export function sampleFailureText(error: unknown): string {
  const reason = error instanceof Error && error.message.trim() ? error.message.trim() : '请稍后重试。';
  return `样张没加载出来：${reason}`;
}

export const SAMPLE_UNAVAILABLE_TEXT = '这套风格对应的设计系统不在 OpenDesign 目录里，没有真实样张。';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; html: string }
  | { status: 'failed'; message: string };

export interface StyleThumbnailProps {
  /** OpenDesign 设计系统编号；null 表示这套风格没有真实样张（设计系统不在目录里）。 */
  designSystemId: string | null;
  /** 样张大标题（通常是用户正在生成的网页标题）；为空时后端用示例标题。 */
  title?: string;
  size?: StyleThumbnailSize;
  format?: DesignSystemSampleFormat;
  /** 读屏用的名称，例如「编辑刊物风格样张」。 */
  label?: string;
  className?: string;
  /**
   * scaled：固定画布等比缩小（画廊缩略图）。
   * fill：铺满父容器、按真实宽度排版、可滚动（预览区大图）——手机上缩成一小条、
   * 下面大片留白的样张，用户看不出「这套风格在我这屏上长什么样」。
   */
  fit?: 'scaled' | 'fill';
}

export function StyleThumbnail({
  designSystemId,
  title,
  size = 'thumb',
  format = 'page',
  label,
  className,
  fit = 'scaled',
}: StyleThumbnailProps) {
  const fill = fit === 'fill';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const frame = SAMPLE_FRAME_REGISTRY[format];
  const { radius } = THUMBNAIL_SIZE_REGISTRY[size];

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setVisible(true);
            observer.disconnect();
          }
        },
        { rootMargin: '200px' },
      );
      observer.observe(node);
      return () => observer.disconnect();
    }
    return undefined;
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === 'number') setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !designSystemId) return;
    let cancelled = false;
    setState({ status: 'loading' });
    loadDesignSystemSample(designSystemId, { title, format })
      .then((html) => {
        if (!cancelled) setState({ status: 'ready', html });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'failed', message: sampleFailureText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [visible, designSystemId, title, format, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const scale = sampleScale(width, format, size);

  return (
    <div
      ref={containerRef}
      className={`relative w-full overflow-hidden ${fill ? 'h-full' : ''} ${className ?? ''}`}
      style={{
        ...(fill ? {} : { aspectRatio: `${frame.width} / ${frame.height}` }),
        borderRadius: radius,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-tertiary)',
      }}
      data-design-system={designSystemId ?? ''}
      data-sample-state={designSystemId ? state.status : 'unavailable'}
    >
      {!designSystemId && <SampleNotice text={SAMPLE_UNAVAILABLE_TEXT} />}
      {designSystemId && state.status === 'ready' && (
        <iframe
          title={label ?? `${designSystemId} 风格样张`}
          sandbox=""
          loading="lazy"
          srcDoc={state.html}
          tabIndex={fill ? undefined : -1}
          aria-hidden={fill ? undefined : true}
          style={fill
            ? { width: '100%', height: '100%', border: 0, display: 'block' }
            : {
              width: frame.width,
              height: frame.height,
              border: 0,
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              pointerEvents: 'none',
              display: 'block',
            }}
        />
      )}
      {designSystemId && (state.status === 'idle' || state.status === 'loading') && <SampleSkeleton format={format} />}
      {designSystemId && state.status === 'failed' && (
        <SampleNotice text={state.message}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              retry();
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-token-secondary hover-bg-soft"
            style={{ border: '1px solid var(--border-subtle)' }}
          >
            <RotateCw size={11} />重试
          </button>
        </SampleNotice>
      )}
    </div>
  );
}

function SampleNotice({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center" role="status">
      <span className="text-[11px] leading-relaxed text-token-muted">{text}</span>
      {children}
    </div>
  );
}

/** 骨架与样张同构：顶部导航、标题两行、导语、指标列与三张卡片，等待时看到的是「页面的形状」。 */
function SampleSkeleton({ format }: { format: DesignSystemSampleFormat }) {
  const block = (style: CSSProperties) => (
    <span className="block rounded-sm" style={{ background: 'var(--border-subtle)', ...style }} />
  );
  return (
    <div className="absolute inset-0 flex animate-pulse flex-col gap-[6%] p-[5%]" aria-label="样张加载中" role="status">
      {format === 'page' && (
        <div className="flex items-center justify-between">
          {block({ width: '18%', height: 6 })}
          {block({ width: '36%', height: 5 })}
        </div>
      )}
      <div className="flex flex-1 gap-[6%]">
        <div className="flex flex-[1.35] flex-col gap-[8%]">
          {block({ width: '40%', height: 4 })}
          {block({ width: '90%', height: 12 })}
          {block({ width: '70%', height: 12 })}
          {block({ width: '85%', height: 5 })}
        </div>
        {format === 'page' && (
          <div className="flex flex-1 flex-col gap-[8%]">
            {block({ height: 16 })}
            {block({ height: 16 })}
            {block({ height: 16 })}
          </div>
        )}
      </div>
      <div className="flex gap-[4%]">
        {block({ flex: 1, height: 22 })}
        {block({ flex: 1, height: 22 })}
        {block({ flex: 1, height: 22 })}
      </div>
    </div>
  );
}
