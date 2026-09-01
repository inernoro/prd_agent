import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ImageOff, Images, Settings2, X } from 'lucide-react';
import {
  ROTATION_DAYS,
  daysUntilRotation,
  nextRotationAt,
  pickBackdrop,
  type BackdropAsset,
} from '@/lib/backdropRotation';

/**
 * 首页背景的轮换与设置。
 *
 * 素材从哪来：**用户自己项目的封面图**，不是随包发的一组风景照。
 * 三个理由——(1) 我手上没有真实素材，编不出来也不该编；
 * (2) 「适合我们自己风格」最硬的解释就是它本来就是我们自己的产出；
 * (3) 像 Photos 的地方正在于此：放的是你自己的图，不是壁纸市场的图。
 *
 * 偏好存 localStorage：纯 UI 偏好、设备本地、发版后用旧值无害，
 * 符合 no-localstorage 规则的例外清单（服务器权威数据仍然禁止进这里）。
 */

const PREF_KEY = 'visualAgent.backdrop.mode';

/** 'auto' 跟随轮换；'off' 关掉背景；其余值是被钉住的那张素材 id。 */
export type BackdropMode = 'auto' | 'off' | (string & {});

export function readBackdropMode(): BackdropMode {
  try {
    return (localStorage.getItem(PREF_KEY) as BackdropMode) || 'auto';
  } catch {
    // 隐私模式 / 禁用站点数据时读取会抛，此时按默认走，不能让首页崩。
    return 'auto';
  }
}

function writeBackdropMode(mode: BackdropMode) {
  try {
    localStorage.setItem(PREF_KEY, mode);
  } catch {
    /* 存不下就只在本次会话生效，不打断用户 */
  }
}

/** 按偏好解析出「现在该显示哪张」。mode 是钉住的 id 但素材已不在池里时，退回轮换。 */
export function resolveBackdrop(
  assets: readonly BackdropAsset[],
  mode: BackdropMode,
  at: number | Date = Date.now(),
): BackdropAsset | null {
  if (mode === 'off') return null;
  if (mode !== 'auto') {
    const pinned = assets.find((a) => a.id === mode);
    if (pinned) return pinned;
  }
  return pickBackdrop(assets, at);
}

export function BackdropSettings(props: {
  assets: readonly BackdropAsset[];
  mode: BackdropMode;
  onModeChange: (mode: BackdropMode) => void;
}) {
  const { assets, mode, onModeChange } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = useMemo(() => resolveBackdrop(assets, mode), [assets, mode]);
  const rotating = mode === 'auto';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const pick = (next: BackdropMode) => {
    onModeChange(next);
    writeBackdropMode(next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="backdrop-settings-trigger"
        aria-label="背景设置"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 hover-bg-soft"
        style={{
          minHeight: 36,
          padding: '0 10px',
          borderRadius: 7,
          border: 0,
          background: 'transparent',
          color: 'var(--text-secondary)',
          fontSize: 11,
          cursor: 'pointer',
        }}
        title="背景设置"
      >
        <Settings2 size={14} />
        背景
      </button>

      {open && (
        <div
          data-testid="backdrop-settings-panel"
          className="absolute right-0 z-50 mt-1.5"
          style={{
            top: '100%',
            width: 300,
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background: 'var(--panel-solid)',
            boxShadow: 'var(--shadow-glass-dropdown)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <div
            className="flex items-center justify-between"
            style={{ padding: '11px 12px', borderBottom: '1px solid var(--border-faint)' }}
          >
            <strong style={{ color: 'var(--text-primary)', fontSize: 12 }}>背景</strong>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => setOpen(false)}
              className="grid place-items-center hover-bg-soft"
              style={{ width: 22, height: 22, borderRadius: 4, border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              <X size={12} />
            </button>
          </div>

          <div style={{ padding: '10px 12px' }}>
            {/* 说清「现在是哪张、下一张什么时候来」。没有这两行，自动轮换对用户就是「它自己变了」。 */}
            <div style={{ color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.7 }}>
              {assets.length === 0 ? (
                <span data-testid="backdrop-empty">
                  还没有可用素材。背景取自你自己项目的封面，先创建一个项目并出一张图。
                </span>
              ) : mode === 'off' ? (
                <span>背景已关闭，页面只保留潜像场。</span>
              ) : rotating ? (
                <span data-testid="backdrop-rotation-hint">
                  每 {ROTATION_DAYS} 天自动换一张，取自你自己项目的封面。
                  <br />
                  当前「{current?.name || '未命名'}」·{' '}
                  {daysUntilRotation()} 天后换下一张（{nextRotationAt().toLocaleDateString()}）
                </span>
              ) : (
                <span>已钉住「{current?.name || '未命名'}」，不再自动更换。</span>
              )}
            </div>

            <div className="mt-2.5 flex items-center gap-1.5">
              <ModeChip active={rotating} disabled={assets.length === 0} onClick={() => pick('auto')} icon={<Images size={12} />} label="自动轮换" />
              <ModeChip active={mode === 'off'} onClick={() => pick('off')} icon={<ImageOff size={12} />} label="不用背景" />
            </div>

            {assets.length > 0 && (
              <>
                <div className="mt-3 mb-1.5" style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                  或钉住一张
                </div>
                <div
                  className="grid grid-cols-4 gap-1.5 overflow-y-auto"
                  style={{ maxHeight: 168 }}
                >
                  {assets.map((a) => {
                    const pinned = mode === a.id;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => pick(a.id)}
                        title={a.note ? `${a.name} · ${a.note}` : a.name}
                        className="relative overflow-hidden"
                        style={{
                          aspectRatio: '1',
                          borderRadius: 6,
                          border: 0,
                          padding: 0,
                          cursor: 'pointer',
                          background: 'var(--bg-secondary)',
                          boxShadow: pinned ? 'inset 0 0 0 2px var(--accent-primary)' : undefined,
                        }}
                      >
                        <img src={a.url} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        {pinned && (
                          <span
                            className="absolute grid place-items-center"
                            style={{ right: 3, bottom: 3, width: 15, height: 15, borderRadius: 999, background: 'var(--accent-primary-solid)', color: 'var(--accent-on-solid)' }}
                          >
                            <Check size={9} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModeChip(props: { active: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  const { active, disabled, onClick, icon, label } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 hover-bg-soft disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        minHeight: 30,
        padding: '0 9px',
        borderRadius: 6,
        border: 0,
        fontSize: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: active ? 'var(--bg-card)' : 'var(--bg-secondary)',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        boxShadow: active ? 'inset 0 0 0 1px var(--accent-primary), var(--shadow-card-sm)' : undefined,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
