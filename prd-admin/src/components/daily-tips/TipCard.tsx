import type { ReactNode } from 'react';
import { X, ChevronRight, Check } from 'lucide-react';

/**
 * 通用教程卡片组件 —— 给「每日小贴士抽屉」和「文学创作锚点教程气泡」共用。
 *
 * 样式参考文学创作页面原有的锚点教程气泡:玻璃面板 + 左侧图标 accent,
 * 正文支持「条目式说明」(被 renderBody 外部构造),底部 CTA + 可选关闭。
 */
export interface TipCardProps {
  /** 左上角图标(如 MapPin / Sparkles / BookOpen) */
  icon?: ReactNode;
  /** accent 主色,默认绿(参考文学版教程),也可传红(isTargeted)或紫(默认 tip) */
  accent?: string;
  /** 标题 */
  title: string;
  /** 正文(字符串或自定义节点,支持多行 pre-wrap) */
  body?: ReactNode;
  /** 是否显示「为你」徽章(定向推送) */
  targeted?: boolean;
  /** CTA 按钮文案(默认「去看看」);不传则不显示 */
  ctaText?: string;
  /** CTA 点击 */
  onCta?: () => void;
  /** 右上角关闭按钮点击(dismiss 等);不传则不显示 */
  onClose?: () => void;
  /** 变体:'bubble' = 独立浮动气泡(绝对定位的外壳);'card' = 列表里的卡片 */
  variant?: 'bubble' | 'card';
  /** 「知道啦」图标模式(CTA 带 Check 图标,而不是默认的 ChevronRight) */
  ack?: boolean;
  /** 额外 style 覆盖 */
  style?: React.CSSProperties;
  /** className 透传 */
  className?: string;
}

const DEFAULT_ACCENT = 'rgba(52, 211, 153, 0.95)'; // 文学教程的绿色

export function TipCard({
  icon,
  accent = DEFAULT_ACCENT,
  title,
  body,
  targeted,
  ctaText,
  onCta,
  onClose,
  variant = 'card',
  ack = false,
  style,
  className,
}: TipCardProps) {
  const baseStyle: React.CSSProperties =
    variant === 'bubble'
      ? {
          background:
            'linear-gradient(180deg, rgba(22,22,30,0.96), rgba(14,15,20,0.98))',
          border: `1px solid ${accent.replace(/,\s*0?\.\d+\)/, ', 0.3)')}`,
          borderRadius: 14,
          padding: '14px 16px',
          boxShadow:
            '0 24px 60px -12px rgba(10,10,14,0.55), 0 0 0 1px rgba(255,255,255,0.04)',
          backdropFilter: 'blur(20px) saturate(160%)',
          WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        }
      : {
          background: targeted
            ? `linear-gradient(135deg, ${accent.replace(/,\s*0?\.\d+\)/, ', 0.14)')}, rgba(168,85,247,0.08))`
            : 'linear-gradient(135deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015))',
          border: targeted
            ? `1px solid ${accent.replace(/,\s*0?\.\d+\)/, ', 0.45)')}`
            : '1px solid rgba(255,255,255,0.06)',
          borderRadius: 14,
          padding: '13px 14px',
          position: 'relative',
          boxShadow: targeted
            ? `0 6px 20px -10px ${accent.replace(/,\s*0?\.\d+\)/, ', 0.35)')}`
            : '0 2px 8px -4px rgba(0,0,0,0.3)',
        };

  return (
    <div className={className} style={{ ...baseStyle, ...style, position: 'relative' }}>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            border: 'none',
            background: 'transparent',
            color: 'rgba(255,255,255,0.35)',
            cursor: 'pointer',
            padding: 2,
            display: 'inline-flex',
            borderRadius: 4,
          }}
        >
          <X size={12} />
        </button>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          marginBottom: body ? 6 : 8,
        }}
      >
        {icon && (
          <span
            style={{
              color: accent,
              flexShrink: 0,
              marginTop: 2,
              display: 'inline-flex',
            }}
          >
            {icon}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0, paddingRight: onClose ? 18 : 0 }}>
          {targeted && (
            <div
              style={{
                display: 'inline-block',
                fontSize: 10,
                fontWeight: 600,
                color: '#fff',
                background: 'linear-gradient(135deg, #f43f5e, #a855f7)',
                borderRadius: 999,
                padding: '1px 7px',
                marginBottom: 6,
                letterSpacing: '0.04em',
              }}
            >
              为你
            </div>
          )}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-primary, #fff)',
              lineHeight: 1.35,
            }}
          >
            {title}
          </div>
        </div>
      </div>

      {body && (
        <div
          style={{
            fontSize: 12,
            color: 'rgba(255,255,255,0.66)',
            lineHeight: 1.6,
            marginBottom: ctaText ? 10 : 0,
            whiteSpace: typeof body === 'string' ? 'pre-wrap' : undefined,
          }}
        >
          {body}
        </div>
      )}

      {ctaText && onCta && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCta}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              background: ack ? accent : 'transparent',
              color: ack ? '#0b1020' : accent,
              cursor: 'pointer',
              padding: ack ? '5px 12px' : 0,
              borderRadius: ack ? 8 : 0,
            }}
          >
            {ack ? <Check size={12} strokeWidth={3} /> : null}
            {ctaText}
            {!ack && <ChevronRight size={12} />}
          </button>
        </div>
      )}
    </div>
  );
}
